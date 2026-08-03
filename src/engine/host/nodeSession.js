/**
 * Build a renderable session from a project document, under Node.
 *
 * This is the headless authoring seam: normalise -> compile every clip ->
 * load the hand sprites -> make surfaces -> install the artwork the reveal
 * uncovers. What comes back is everything `renderFrame` needs and nothing it
 * does not.
 *
 * It exists because that sequence was previously only reachable by running
 * `scripts/render-project.js` as a program. The CLI now calls this, so the
 * frame an MCP client looks at and the frame the CLI encodes are built by the
 * same code -- which is the only way they can be guaranteed identical.
 *
 * There is a sibling in `src/ui/engineHost.js` with the same name and the same
 * return shape. The two cannot be merged: that one rebuilds from the prepared
 * IPC payload (geometry already traced in the main process, images as data
 * URLs) and paints into `OffscreenCanvas`, while this one reads files and
 * drives the sidecar itself. Keeping the shapes identical is what lets callers
 * treat them interchangeably.
 */

import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import opentype from 'opentype.js';

import { compileErase } from '../anim/erase.js';
import { getAnimation } from '../anim/registry.js';
import { isAppear } from '../anim/appear.js';
import { parseSvg } from '../compile/svgDoc.js';
import { outlineText, traceText } from '../compile/text.js';
import { styleIdsFor } from '../hand/styles.js';
import { normalizeProject, projectFrames } from '../model/project.js';
import { knockOutPaper, wantsPaperKnockout } from '../render/artAlpha.js';
import { createSession, ensureSurfaces } from '../render/renderFrame.js';
import { setSurfaceFactory } from '../render/surfaces.js';
import { paintVectorArt } from '../render/vectorArt.js';
import { toAsset } from '../sidecar/client.js';

// Imported for their registration side effect; `getAnimation` only knows what
// has been registered, and `listAnimations()` only lists it. Dropping any of
// these turns every clip using it into "unknown animation type" at compile.
import '../anim/outlineFill.js';
import '../anim/imageReveal.js';
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
 * the clip's own `animId` exactly as it is in the app -- the pre-reveal default
 * is kept for documents written before there was a choice.
 */
const drawableAnim = (clip) => getAnimation(clip.animId ?? 'draw.outlineFill');

/** Brush widths are authored in screen terms, so they divide out the scale. */
const brushOpts = (clip) => ({
  brushWidth: Math.max(1.5, 2.4 / clip.transform.scale),
  fillBrushWidth: Math.max(8, 15 / clip.transform.scale),
  ...clip.params,
});

/**
 * Content-addressed cache key for a trace.
 *
 * The sidecar has had an atomic disk cache behind `vectorize` all along
 * (`src/sidecar/server.py`), but it no-ops without a key and no caller passed
 * one -- so every rebuild re-traced every image, seconds at a time. Hashing the
 * file bytes rather than its path means an edited image invalidates itself and
 * two copies of the same picture share one entry.
 */
export function traceKey(bytes, opts) {
  return createHash('sha256')
    .update(bytes)
    .update(JSON.stringify(opts || {}))
    .digest('hex')
    .slice(0, 16);
}

/**
 * Vectors skip the sidecar: the geometry is already exact, so tracing it would
 * only throw information away.
 */
async function buildVectorClip(clip, asset, { rel }) {
  const parsed = parseSvg(readFileSync(rel(asset.src), 'utf8'), { eps: 0.2 });
  if (!parsed.subpaths.length) throw new Error(`${asset.src}: no drawable geometry`);
  const plan = await drawableAnim(clip).compile(toAsset(clip.assetId, parsed), brushOpts(clip));
  return { plan, traced: parsed, vector: parsed };
}

async function buildImageClip(clip, asset, { rel, sidecar }) {
  const path = rel(asset.src);
  if (!sidecar) throw new Error(`${asset.src}: tracing an image needs the Python sidecar`);
  const opts = asset.trace || {};
  const traced = await sidecar.vectorize(path, opts, traceKey(readFileSync(path), opts));
  const plan = await drawableAnim(clip).compile(toAsset(clip.assetId, traced), brushOpts(clip));
  return { plan, traced, artSrc: path };
}

async function buildTextClip(clip, asset, { rel, root }) {
  const fontPath = rel(asset.font || join(root, DEFAULT_FONT));
  const buf = readFileSync(fontPath);
  // loadSync is deprecated in opentype.js and silently returns undefined.
  const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

  const opts = {
    fontSize: asset.fontSize ?? 120,
    penWidth: asset.penWidth ?? Math.max(2, (asset.fontSize ?? 120) * 0.045),
    color: asset.color,
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
 * @param {import('../sidecar/client.js').Sidecar|null} o.sidecar may be null
 *   when no clip needs tracing -- vector and text compile without Python
 * @param {(p: string) => string} [o.rel] resolve an asset path; defaults to
 *   identity, which is right for the absolute paths a host stores
 * @param {(clipId: string) => void} [o.onClip] progress, per compiled clip
 * @returns {Promise<{session, project, frames, bboxes, handStyleId, styles}>}
 */
export async function buildNodeSession(raw, { root, sidecar, rel = (p) => p, onClip } = {}) {
  const project = normalizeProject(raw);

  // The chosen hand plus every tool style: renderFrame resolves the erase
  // sweep's hand by scanning these, so loading only the pen hand is what leaves
  // an erase running with no hand on screen.
  const styles = styleIdsFor(project.meta.handStyleId).map((id) =>
    JSON.parse(readFileSync(join(root, `assets/hands/${id}.json`), 'utf8')));
  const images = new Map();
  for (const style of styles) {
    for (const src of style.sources) {
      if (!images.has(src.file)) images.set(src.file, await loadImage(join(root, src.file)));
    }
  }

  const session = createSession({
    hands: new Map(styles.map((s) => [s.id, s])),
    resolveImage: (src) => images.get(src.file),
  });

  // Build every clip's plan up front so a bad asset fails before we render.
  const artwork = [];
  for (const clip of project.clips) {
    const asset = project.assets[clip.assetId];
    onClip?.(clip.id, asset);
    const built = await compileClip(clip, asset, { root, sidecar, rel });

    session.plans.set(clip.id, built.plan);
    if (clip.erase) session.erasePlans.set(clip.id, compileErase(built.plan, { id: clip.id }));
    if (built.artSrc) artwork.push({ clipId: clip.id, src: built.artSrc, traced: built.traced });
    if (built.vector) artwork.push({ clipId: clip.id, vector: built.vector });
  }

  // Surfaces first, then the source pixels the fill scribble reveals. Asked for
  // directly rather than conjured by rendering a warm-up frame: a clip on a page
  // that frame does not show would get no surfaces and no artwork.
  ensureSurfaces(session, project);
  for (const { clipId, src, traced, vector } of artwork) {
    const sf = session.surfaces.get(clipId);
    if (!sf) continue;
    const surface = sf.ensureArt();
    if (vector) {
      // No raster to reveal, so the vector's own fills and strokes are both
      // the reveal artwork and what the clip settles to.
      paintVectorArt(surface.ctx, vector.regions, vector.subpaths);
    } else {
      surface.ctx.drawImage(await loadImage(src), 0, 0, traced.width, traced.height);
      // The paper is knocked out of line art so the artwork carries its own
      // silhouette; see render/artAlpha.js.
      if (wantsPaperKnockout(traced.mode)) knockOutPaper(surface, sf.w, sf.h);
    }
  }

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
  };
}
