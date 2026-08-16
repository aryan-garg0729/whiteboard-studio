/**
 * Browser-side host for the engine.
 *
 * Turns the main process's JSON-safe "prepared" payload back into compiled
 * plans and a render session. The engine itself is untouched — it only needs a
 * surface factory, which here is backed by OffscreenCanvas.
 */

import { setSurfaceFactory } from '../engine/render/surfaces.js';
import { createSession, ensureSurfaces, renderFrame } from '../engine/render/renderFrame.js';
import { compileErase } from '../engine/anim/erase.js';
import { getAnimation } from '../engine/anim/registry.js';
import { paintVectorArt } from '../engine/render/vectorArt.js';
import { imagePixels, vectorPixels } from '../engine/render/rasterize.js';
import { penScale } from '../engine/model/transform.js';
// Shared with the node host, so the editor and the MCP server can never
// disagree about which edits are visible. See model/fingerprint.js.
import { clipKeys, sessionKey, staleClips } from '../engine/model/fingerprint.js';
// Imported for their registration side effect as much as for their exports:
// `getAnimation` can only hand back what has been registered.
import '../engine/anim/stencilPaint.js';
import '../engine/anim/inkPaint.js';
import { isAppear } from '../engine/anim/appear.js';
import handwrite from '../engine/anim/handwrite.js';
import textReveal from '../engine/anim/textReveal.js';

setSurfaceFactory((w, h) => {
  const canvas = new OffscreenCanvas(w, h);
  return { canvas, ctx: canvas.getContext('2d') };
});

const f64 = (a) => Float64Array.from(a);

/** Font bytes arrive base64 because the prepared payload has to stay JSON-safe. */
export function base64Bytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Parse the subtitle face, loading the font parser only if there is one.
 *
 * A static import would pull opentype.js into the main bundle -- 267 kB for a
 * feature most projects do not use, parsed at startup by every window whether
 * or not it ever shows a subtitle. The renderer had no opentype dependency at
 * all before subtitles existed; this keeps it that way until a transcript turns
 * up, at which point the cost is paid during a prepare that is already async.
 */
async function subtitleFontFrom(b64) {
  if (!b64) return null;
  const { parseFont } = await import('../engine/compile/font.js');
  return parseFont(base64Bytes(b64));
}

function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('image failed to load'));
    img.src = src;
  });
}

/**
 * @param {Object} loaded the payload from `studio.openProject()`
 * @param {Object} [previous] the session this one replaces, if any. Clips whose
 *   `clipKey` is unchanged keep its compiled plan *and* its surfaces, artwork
 *   and accumulated ink included -- so an edit costs one clip's work rather than
 *   the whole project's. Anything it holds that the new document does not carry
 *   over is disposed here rather than left for the collector; canvas memory is
 *   native and would otherwise sit at two full sessions' worth for a while.
 * @returns {Promise<{session, project, frames, hand, bboxes, keys}>}
 */
export async function buildSession(loaded, previous = null) {
  const { project, prepared, hand, subtitleFont } = loaded;
  const reusable = previous?.session;

  const images = new Map();
  for (const [file, url] of Object.entries(hand.images)) {
    images.set(file, await loadImage(url));
  }

  const session = createSession({
    // Every style, not just the chosen hand: a non-pen tool is resolved by
    // scanning this map, and a missing eraser silently draws no hand at all.
    hands: new Map((hand.styles || [hand.style]).map((s) => [s.id, s])),
    resolveImage: (src) => images.get(src.file),
    // The renderer lays subtitles out itself, from the face the main process
    // sent, so changing their size or wording repaints without a round trip.
    // A null `subtitleFont` beside a non-null id means main knows we already
    // parsed the right face and did not send it again.
    subtitleFont: (!subtitleFont && loaded.subtitleFontId)
      ? reusable?.subtitleFont ?? null
      : await subtitleFontFrom(subtitleFont),
  });

  const artJobs = [];
  for (const clip of project.clips) {
    const p = prepared[clip.id];

    // Not re-prepared, so nothing about its geometry moved: take the compiled
    // plan and the surfaces whole. The surfaces are the valuable half -- they
    // carry the artwork already painted into them and the ink already laid
    // down, neither of which this rebuild would otherwise have any way to keep.
    if (!p && reusable?.plans.has(clip.id)) {
      const plan = reusable.plans.get(clip.id);
      session.plans.set(clip.id, plan);
      const sf = reusable.surfaces.get(clip.id);
      if (sf) session.surfaces.set(clip.id, sf);
      // Recomputed from the current document rather than carried across: an
      // erase sweep can be added or removed without touching the clip's key,
      // since it changes no compiled geometry of the clip itself.
      if (clip.erase) {
        session.erasePlans.set(clip.id,
          reusable.erasePlans.get(clip.id) ?? compileErase(plan, { id: clip.id }));
      }
      continue;
    }

    if (!p) {
      // Main was asked to skip this clip on the strength of a plan the previous
      // session turned out not to have. Rendering on would silently drop the
      // clip; failing here names the one thing that can cause it.
      throw new Error(`${clip.id}: not prepared and no plan to reuse`);
    }

    let plan;

    if (p.kind === 'text') {
      // Both the reveal and the entrances draw filled letterforms; only the
      // reveal needs the line/span layout to walk a frontier along.
      plan = p.mode === 'trace'
        ? await handwrite.compile({ layout: {
          bbox: p.bbox, inkBbox: p.inkBbox, regions: p.regions,
          guides: p.guides.map((g) => ({ ...g, pts: f64(g.pts) })),
        } })
        : isAppear(clip.animId)
        ? await getAnimation(clip.animId).compile({
          id: clip.id, bbox: p.bbox, inkBbox: p.inkBbox, penWidth: p.penWidth,
        })
        : await textReveal.compile({
          id: clip.id,
          layout: {
            lines: p.lines,
            bbox: p.bbox,
            inkBbox: p.inkBbox,
            penWidth: p.penWidth,
          },
        });
      // Both text drawing modes are masks over the actual glyph outlines.
      artJobs.push({ clipId: clip.id, prepared: p });
    } else {
      // Both artwork kinds are planned from pixels. A vector is rasterised from
      // the geometry the main process parsed; a raster is simply decoded. This
      // is the twin of `buildVectorClip`/`buildImageClip` in `nodeSession.js`,
      // and the two must keep agreeing or preview and export drift.
      let vector = null;
      let decoded = null;
      let image;
      if (p.kind === 'vector') {
        vector = {
          width: p.width,
          height: p.height,
          subpaths: p.subpaths.map((s) => ({
            pts: f64(s.pts), closed: s.closed, stroke: s.stroke, strokeWidth: s.strokeWidth,
          })),
          regions: p.regions.map((r) => ({ rings: r.rings.map(f64), color: r.color })),
        };
        image = vectorPixels(vector);
      } else {
        decoded = await loadImage(p.art);
        image = imagePixels(decoded, decoded.width, decoded.height);
      }

      plan = await getAnimation(clip.animId)
        .compile({ id: clip.assetId, image }, {
          // Pen widths are chosen so the stroke is a constant width *on screen*.
          // An entrance has no pen and ignores them. `penScale` folds in the
          // per-axis stretch, which `transform.scale` alone does not see.
          fillBrushWidth: Math.max(8, 15 / penScale(clip.transform)),
          ...clip.params,
        });
      artJobs.push({ clipId: clip.id, vector, decoded });
    }

    session.plans.set(clip.id, plan);
    if (clip.erase) session.erasePlans.set(clip.id, compileErase(plan, { id: clip.id }));
  }

  // Surfaces must exist before the source artwork can be installed into them.
  // Asked for directly rather than conjured by rendering a frame: a clip on a
  // page the warm-up frame does not show would otherwise get no surfaces, and
  // its artwork would silently never be installed.
  ensureSurfaces(session, project);

  for (const { clipId, prepared: p, vector, decoded } of artJobs) {
    const sf = session.surfaces.get(clipId);
    if (!sf) continue;
    const art = sf.ensureArt().ctx;
    if (decoded) {
      // At source resolution and otherwise untouched: the finished frame has to
      // be this image, so nothing is resampled and no paper is knocked out.
      art.drawImage(decoded, 0, 0, decoded.width, decoded.height);
    } else if (vector) {
      // A vector has no raster of its own, so its fills and strokes *are* the
      // artwork the pen uncovers.
      paintVectorArt(art, vector.regions, vector.subpaths);
    } else if (p) {
      // Glyph outlines are regions with no separate stroked subpaths. The
      // 'evenodd' fill paintVectorArt already uses is what keeps counters open.
      paintVectorArt(art, p.regions, p.subpaths ?? []);
    }
  }

  // Anything the old session held that this one did not adopt -- a deleted clip,
  // or one whose artwork changed and was rebuilt from scratch. Its canvases are
  // native memory the collector is in no hurry to reclaim, and on a project of
  // any size that is the difference between a rebuild costing nothing and it
  // holding two full sets of surfaces until a GC happens to run.
  for (const [id, sf] of reusable?.surfaces ?? []) {
    if (session.surfaces.get(id) !== sf) sf.dispose();
  }

  // Local-space bounds per clip, so the editor can draw selection boxes and
  // hit-test without reaching into the compiled plans itself.
  const bboxes = new Map();
  for (const [id, plan] of session.plans) bboxes.set(id, plan.bbox);

  return {
    session,
    project,
    frames: loaded.frames,
    hand: hand.style,
    bboxes,
    // What the next rebuild diffs against to decide what it can keep.
    keys: clipKeys(project),
    sessionKey: sessionKey(project),
    // The face `session.subtitleFont` was parsed from, so the next prepare can
    // tell main not to send it again.
    subtitleFontId: loaded.subtitleFontId ?? null,
  };
}

export { renderFrame, clipKeys, sessionKey, staleClips };
