/**
 * Build a renderable session from a project document, under Node.
 *
 * This is the headless authoring seam: normalise -> load the hand sprites ->
 * compile every clip -> make surfaces -> install the artwork the reveal
 * uncovers. What comes back is everything `renderFrame` needs and nothing it
 * does not.
 *
 * `buildNodeSession` is the cold case of `updateNodeSession`, which is what the
 * MCP server actually calls: it re-derives a session after every mutating tool,
 * and recompiling a whole document each time is what made authoring quadratic.
 * Both go through one description of how a document becomes a session, so a
 * reconciled session and a freshly built one cannot drift.
 *
 * It exists because that sequence was previously only reachable by running
 * `scripts/render-project.js` as a program. The CLI now calls this, so the
 * frame an MCP client looks at and the frame the CLI encodes are built by the
 * same code -- which is the only way they can be guaranteed identical.
 *
 * There is a sibling in `src/ui/engineHost.js` with the same name and the same
 * return shape. The two cannot be merged: that one rebuilds from the prepared
 * IPC payload (geometry already traced in the main process, images as data
 * URLs) and paints into `OffscreenCanvas`, while this one reads and decodes the
 * files itself. Keeping the shapes identical is what lets callers treat them
 * interchangeably.
 */

import { createCanvas, loadImage } from '@napi-rs/canvas';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { compileErase } from '../anim/erase.js';
import { getAnimation } from '../anim/registry.js';
import { isAppear } from '../anim/appear.js';
import { parseFont } from '../compile/font.js';
import { parseSvg } from '../compile/svgDoc.js';
import { outlineText, traceText } from '../compile/text.js';
import { styleIdsFor } from '../hand/styles.js';
import { migrateAnimation, normalizeProject, projectFrames } from '../model/project.js';
// Shared with the editor's host, so the two can never disagree about which
// edits are visible. See model/fingerprint.js.
import { clipKeys, sessionKey, staleClips } from '../model/fingerprint.js';
import { penScale } from '../model/transform.js';
import { createSession, ensureSurfaces } from '../render/renderFrame.js';
import { imagePixels, vectorPixels } from '../render/rasterize.js';
import { setSurfaceFactory } from '../render/surfaces.js';
import { paintVectorArt } from '../render/vectorArt.js';

// Imported for their registration side effect; `getAnimation` only knows what
// has been registered, and `listAnimations()` only lists it. Dropping any of
// these turns every clip using it into "unknown animation type" at compile.
import '../anim/stencilPaint.js';
import '../anim/inkPaint.js';
import '../anim/appear.js';
import '../anim/handwrite.js';
import textReveal from '../anim/textReveal.js';

/** The font a text asset gets when it does not name one. */
export const DEFAULT_FONT = 'assets/fonts/Caveat.ttf';

/**
 * Point the engine's surface allocator at node canvases.
 *
 * Explicit rather than an import side effect: tests install their own factory,
 * and a module that silently repointed it on import would make the order of
 * imports load-bearing.
 */
export function installNodeSurfaces() {
  setSurfaceFactory((w, h) => {
    const canvas = createCanvas(w, h);
    return { canvas, ctx: canvas.getContext('2d') };
  });
}

/**
 * Which animation draws this clip. Preview and export must agree, so this is
 * the clip's own `animId` exactly as it is in the app.
 *
 * Migrated here even though `buildNodeSession` normalises first, because
 * `compileClip` is exported and is reached *without* normalising: measuring a
 * clip is what a host does before it can place one, so a caller hands over a
 * clip straight out of a document. `examples/svg.project.json` still names
 * `draw.outlineFill`, and `test/nodeSession.test.js` compiles it directly.
 *
 * `src/ui/engineHost.js` deliberately does not do this: its input has always
 * been through `normalizeProject`, so an unmigrated id there would be a bug
 * worth surfacing rather than papering over.
 */
const drawableAnim = (clip) =>
  getAnimation(migrateAnimation(clip.animId ?? 'draw.stencilPaint').animId);

/**
 * Brush widths are authored in screen terms, so they divide out the scale.
 *
 * `penScale` rather than `transform.scale`: a squeezed clip has no single
 * on-screen scale, and its geometric mean is the closest thing to one.
 */
const brushOpts = (clip) => ({
  fillBrushWidth: Math.max(8, 15 / penScale(clip.transform)),
  ...clip.params,
});

/**
 * A vector is rasterised and then analysed exactly like a raster.
 *
 * Its own geometry is still what gets *painted* -- `vector` here is what
 * `paintVectorArt` installs as the artwork -- but what the pen is planned
 * against is pixels, so an SVG and a PNG draw the same way. See
 * `render/rasterize.js` for why that raster is at one pixel per user unit.
 */
async function buildVectorClip(clip, asset, { rel }) {
  const parsed = parseSvg(readFileSync(rel(asset.src), 'utf8'), { eps: 0.2 });
  if (!parsed.subpaths.length) throw new Error(`${asset.src}: no drawable geometry`);
  const image = vectorPixels(parsed);
  const plan = await drawableAnim(clip)
    .compile({ id: clip.assetId, image }, brushOpts(clip));
  return { plan, vector: parsed };
}

async function buildImageClip(clip, asset, { rel }) {
  const path = rel(asset.src);
  let decoded;
  try {
    decoded = await loadImage(path);
  } catch (err) {
    // The decoder's own message is "Invalid URL", which names neither the file
    // nor the project it came from.
    throw new Error(`${asset.src}: could not be read (${err.message})`);
  }
  const image = imagePixels(decoded, decoded.width, decoded.height);
  const plan = await drawableAnim(clip)
    .compile({ id: clip.assetId, image }, brushOpts(clip));
  return { plan, artSrc: path, artWidth: decoded.width, artHeight: decoded.height };
}

async function buildTextClip(clip, asset, { rel, root }) {
  const fontPath = rel(asset.font || join(root, DEFAULT_FONT));
  const font = parseFont(readFileSync(fontPath));

  const opts = {
    fontSize: asset.fontSize ?? 120,
    penWidth: asset.penWidth ?? Math.max(2, (asset.fontSize ?? 120) * 0.045),
    color: asset.color,
    bold: !!asset.bold,
    // Undefined is meaningful: `placeGlyphs` applies DEFAULT_TEXT_ALIGN, so a
    // document that never mentions alignment gets the default rather than a
    // value this layer guessed.
    align: asset.align,
  };

  // Same branch as electron/prepare.js: both drawing modes retain real glyph
  // outlines, while trace adds semantic writing guides.
  if (clip.animId !== 'draw.handwrite') {
    const layout = outlineText(font, asset.text, opts);
    const plan = isAppear(clip.animId)
      ? await getAnimation(clip.animId).compile({
        id: clip.id, bbox: layout.bbox, inkBbox: layout.inkBbox, penWidth: opts.penWidth,
      })
      : await textReveal.compile({ id: clip.id, layout });
    return { plan, layout, vector: layout };
  }

  const layout = traceText(font, asset.text, opts);
  return { plan: await getAnimation('draw.handwrite').compile({ layout }), layout, vector: layout };
}

/**
 * The face the burned-in narration is set in.
 *
 * Parsed once per session rather than per clip, and into an instance of its
 * own: `outlineText` applies the weight axis to the font object it is handed
 * and memoises a bold mode onto it, so a font shared between a subtitle track
 * and a text clip at different weights would lay out differently depending on
 * which was compiled first.
 *
 * Returns null rather than throwing when there is nothing to set: a project
 * with subtitles turned off must not fail to build because a font it never uses
 * is missing.
 */
export function loadSubtitleFont(project, { root, rel = (p) => p }) {
  const subs = project.subtitles;
  if (!subs?.enabled || !subs.words?.length) return null;
  return parseFont(readFileSync(rel(join(root, subs.font))));
}

/**
 * Compile one clip to a plan, without touching a session.
 *
 * Exposed on its own because a headless host needs a clip's bounding box
 * *before* it can decide where to put the clip -- a drawable's origin is its
 * bbox corner, so centring it in frame is not possible until it has been
 * compiled. The UI solves the same problem with a second pass once the traced
 * geometry arrives from the main process; here it is one call.
 */
export async function compileClip(clip, asset, ctx) {
  if (asset.kind === 'vector') return buildVectorClip(clip, asset, ctx);
  if (asset.kind === 'image') return buildImageClip(clip, asset, ctx);
  return buildTextClip(clip, asset, ctx);
}

/**
 * @param {Object} raw project document; normalised here, so callers may pass
 *   either a raw file or an already-normalised document
 * @param {Object} o
 * @param {string} o.root repo root, for bundled fonts and hand manifests
 * @param {(p: string) => string} [o.rel] resolve an asset path; defaults to
 *   identity, which is right for the absolute paths a host stores
 * @param {(clipId: string) => void} [o.onClip] progress, per compiled clip
 * @returns {Promise<{session, project, frames, bboxes, handStyleId, styles}>}
 */
export async function buildNodeSession(raw, opts = {}) {
  return updateNodeSession(null, raw, opts);
}

/**
 * The chosen hand plus every tool style, and their sprites.
 *
 * Every style, not just the pen: `renderFrame` resolves the erase sweep's hand
 * by scanning these, so loading only the drawing hand is what leaves an erase
 * running with no hand on screen.
 */
async function loadHand(project, root) {
  const styles = styleIdsFor(project.meta.handStyleId).map((id) =>
    JSON.parse(readFileSync(join(root, `assets/hands/${id}.json`), 'utf8')));
  const images = new Map();
  for (const style of styles) {
    for (const src of style.sources) {
      if (!images.has(src.file)) images.set(src.file, await loadImage(join(root, src.file)));
    }
  }
  return { styles, resolveImage: (src) => images.get(src.file) };
}

/**
 * Compile one clip and register it on a session, returning its artwork job.
 *
 * Split out so the incremental path recompiles a clip in exactly the way a full
 * build does. The alternative -- a second copy of this in `updateNodeSession` --
 * is precisely how a preview starts to differ from an export.
 */
async function compileInto(session, project, clip, { root, rel, onClip }) {
  const asset = project.assets[clip.assetId];
  onClip?.(clip.id, asset);
  const built = await compileClip(clip, asset, { root, rel });

  session.plans.set(clip.id, built.plan);
  if (clip.erase) session.erasePlans.set(clip.id, compileErase(built.plan, { id: clip.id }));

  if (built.vector) return { clipId: clip.id, vector: built.vector };
  if (built.artSrc) {
    return { clipId: clip.id, src: built.artSrc,
      artWidth: built.artWidth, artHeight: built.artHeight };
  }
  return null;
}

/**
 * Make the surfaces, then paint the source pixels the fill scribble reveals.
 *
 * Surfaces are asked for directly rather than conjured by rendering a warm-up
 * frame: a clip on a page that frame does not show would get no surfaces and no
 * artwork.
 */
async function finishSession(session, project, artwork) {
  ensureSurfaces(session, project);
  for (const job of artwork) {
    if (!job) continue;
    const sf = session.surfaces.get(job.clipId);
    if (!sf) continue;
    const surface = sf.ensureArt();
    if (job.vector) {
      // No raster to reveal, so the vector's own fills and strokes are both
      // the reveal artwork and what the pen uncovers.
      paintVectorArt(surface.ctx, job.vector.regions, job.vector.subpaths);
    } else {
      // At source resolution and otherwise untouched. Nothing is resampled and
      // no paper is knocked out: the finished frame has to be this image.
      surface.ctx.drawImage(await loadImage(job.src), 0, 0, job.artWidth, job.artHeight);
    }
  }
}

/** The shape both build paths return. */
function sessionResult(session, project, { styles }) {
  // Local-space bounds per clip, so a host can draw selection boxes, hit-test,
  // or place a clip in frame without reaching into the compiled plans itself.
  const bboxes = new Map();
  for (const [id, plan] of session.plans) bboxes.set(id, plan.bbox);

  return {
    session,
    project,
    frames: projectFrames(project),
    bboxes,
    handStyleId: styles[0].id,
    styles,
    // What the next update diffs against to decide what it can keep.
    keys: clipKeys(project),
    sessionKey: sessionKey(project),
  };
}

/**
 * Rebuild only what an edit actually changed.
 *
 * The server re-derives a session after every mutating tool call, and doing that
 * from scratch is what made authoring quadratic: adding the N-th clip recompiled
 * all N, so a 56-clip document spent 13.4s per edit. Almost none of that work is
 * ever needed -- retiming a clip, moving it, breaking a page, nudging the camera
 * and rewording one caption all leave the other clips' geometry untouched.
 *
 * Reuse is decided by `clipKey`, the same fingerprint the editor uses, so both
 * hosts agree about which edits are visible. A clip that survives keeps its
 * compiled plan *and* its surfaces, artwork already painted included.
 *
 * `buildNodeSession` is this with no previous session, which is what makes the
 * two provably consistent: there is one description of how a document becomes a
 * session, and a cold build is the case where every clip is stale.
 *
 * The hand sprites and the subtitle face are reloaded when `sessionKey` says
 * they moved. That is deliberately *not* a reason to recompile anything --
 * changing the drawing hand cannot affect a single stroke, and rebuilding the
 * project for it cost 25s on a 108-clip document.
 *
 * @param {Object|null} previous the result of a former build
 * @param {Object} raw the edited document
 */
export async function updateNodeSession(previous, raw, { root, rel = (p) => p, onClip } = {}) {
  const project = normalizeProject(raw);
  const old = previous?.session ?? null;

  // Reloaded only when they actually changed; otherwise the previous session's
  // decoded sprites and parsed font are carried straight across.
  const reload = !previous || sessionKey(project) !== previous.sessionKey;
  const hand = reload ? await loadHand(project, root) : null;
  const styles = hand ? hand.styles : previous.styles;
  const subtitleFont = reload ? loadSubtitleFont(project, { root, rel }) : old.subtitleFont;

  const restage = new Set(staleClips(project, previous?.keys).stale);

  // A *new* session holding the old one's work, rather than the old one edited
  // in place. An export is a background job that captured its session in a
  // closure and is part way through encoding it; mutating that session would
  // change the video halfway through, and disposing a restaged clip's surfaces
  // would blank the frames it has left to render. Sharing the plans and
  // surfaces of unchanged clips is safe because rendering only ever accumulates
  // ink that `renderFrame` can replay, and it is where the saving is anyway.
  //
  // Nothing is disposed here for the same reason: this session does not own the
  // canvases it is dropping, and the collector can have them once whoever else
  // is holding them is done.
  const session = createSession({
    hands: new Map(styles.map((s) => [s.id, s])),
    resolveImage: hand ? hand.resolveImage : old.resolveImage,
    subtitleFont,
  });

  const artwork = [];
  for (const clip of project.clips) {
    if (restage.has(clip.id)) {
      artwork.push(await compileInto(session, project, clip, { root, rel, onClip }));
      continue;
    }
    // Kept as it is, surfaces included -- they carry the artwork already painted
    // into them, which is the half a rebuild cannot otherwise recover.
    session.plans.set(clip.id, old.plans.get(clip.id));
    const sf = old.surfaces.get(clip.id);
    if (sf) session.surfaces.set(clip.id, sf);
    // The erase plan is reconsidered rather than carried: a sweep can be added
    // or removed without touching the clip's key, because it changes no
    // compiled geometry of the clip itself.
    if (clip.erase) {
      session.erasePlans.set(clip.id,
        old.erasePlans.get(clip.id) ?? compileErase(session.plans.get(clip.id), { id: clip.id }));
    }
  }

  await finishSession(session, project, artwork);
  return sessionResult(session, project, { styles });
}
