/**
 * Browser-side host for the engine.
 *
 * Turns the main process's JSON-safe "prepared" payload back into compiled
 * plans and a render session. The engine itself is untouched — it only needs a
 * surface factory, which here is backed by OffscreenCanvas.
 */

import { setSurfaceFactory } from '../engine/render/surfaces.js';
import { createSession, ensureSurfaces, renderFrame } from '../engine/render/renderFrame.js';
import { makeStroke } from '../engine/compile/geometry.js';
import { compileErase } from '../engine/anim/erase.js';
import { paintVectorArt } from '../engine/render/vectorArt.js';
import outlineFill from '../engine/anim/outlineFill.js';
import handwrite from '../engine/anim/handwrite.js';
import textReveal from '../engine/anim/textReveal.js';

setSurfaceFactory((w, h) => {
  const canvas = new OffscreenCanvas(w, h);
  return { canvas, ctx: canvas.getContext('2d') };
});

const f64 = (a) => Float64Array.from(a);

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
 * @returns {Promise<{session, project, frames, hand}>}
 */
export async function buildSession(loaded) {
  const { project, prepared, hand } = loaded;

  const images = new Map();
  for (const [file, url] of Object.entries(hand.images)) {
    images.set(file, await loadImage(url));
  }

  const session = createSession({
    // Every style, not just the chosen hand: a non-pen tool is resolved by
    // scanning this map, and a missing eraser silently draws no hand at all.
    hands: new Map((hand.styles || [hand.style]).map((s) => [s.id, s])),
    resolveImage: (src) => images.get(src.file),
  });

  const artJobs = [];
  for (const clip of project.clips) {
    const p = prepared[clip.id];
    let plan;

    if (p.kind === 'text' && p.mode === 'reveal') {
      plan = await textReveal.compile({
        id: clip.id,
        layout: {
          lines: p.lines,
          bbox: p.bbox,
          inkBbox: p.inkBbox,
          penWidth: p.penWidth,
        },
      });
      // The reveal is a mask, so unlike handwriting it needs artwork underneath
      // to reveal -- the filled letterforms.
      artJobs.push({ clipId: clip.id, prepared: p });
    } else if (p.kind === 'text') {
      const strokes = p.strokes.map((s) => makeStroke(f64(s.pts), {
        kind: s.lift ? 'TRAVEL' : 'OUTLINE',
        width: s.width, color: s.color, lift: s.lift,
      }));
      plan = await handwrite.compile({ layout: { strokes, bbox: p.bbox } });
    } else {
      const asset = {
        id: clip.assetId,
        bbox: p.bbox,
        subpaths: p.subpaths.map((s) => ({
          pts: f64(s.pts), closed: s.closed, width: s.width, color: s.color,
        })),
        regions: p.regions.map((r) => ({
          rings: r.rings.map(f64), color: r.color, bbox: r.bbox,
        })),
      };
      plan = await outlineFill.compile(asset, {
        brushWidth: Math.max(1.5, 2.4 / clip.transform.scale),
        fillBrushWidth: Math.max(8, 15 / clip.transform.scale),
        ...clip.params,
      });
      artJobs.push({ clipId: clip.id, prepared: p });
    }

    session.plans.set(clip.id, plan);
    if (clip.erase) session.erasePlans.set(clip.id, compileErase(plan, { id: clip.id }));
  }

  // Surfaces must exist before the source artwork can be installed into them.
  // Asked for directly rather than conjured by rendering a frame: a clip on a
  // page the warm-up frame does not show would otherwise get no surfaces, and
  // its artwork would silently never be installed.
  ensureSurfaces(session, project);

  for (const { clipId, prepared: p } of artJobs) {
    const sf = session.surfaces.get(clipId);
    if (!sf) continue;
    const art = sf.ensureArt().ctx;
    if (p.art) art.drawImage(await loadImage(p.art), 0, 0, p.width, p.height);
    // Glyph outlines are regions with no separate stroked subpaths. The
    // 'evenodd' fill paintVectorArt already uses is what keeps counters open.
    else paintVectorArt(art, p.regions, p.subpaths ?? []);
  }

  // Local-space bounds per clip, so the editor can draw selection boxes and
  // hit-test without reaching into the compiled plans itself.
  const bboxes = new Map();
  for (const [id, plan] of session.plans) bboxes.set(id, plan.bbox);

  return { session, project, frames: loaded.frames, hand: hand.style, bboxes };
}

export { renderFrame };
