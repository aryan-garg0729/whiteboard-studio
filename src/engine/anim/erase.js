/**
 * Erase animation.
 *
 * Reuses the scribble generator, but as a *modifier* on an already-drawn clip
 * rather than as an animation type of its own -- that way it works identically
 * for images and text without either knowing about it, since both produce the
 * same ClipSurfaces.
 *
 * Two deliberate differences from the colour fill:
 *  - the sweep is horizontal, top to bottom. A 45-degree scribble reads as
 *    colouring in; erasing is a coarser, more mechanical motion.
 *  - the mask is never applied to the ink layers directly. It accumulates on
 *    its own layer and is composited with `destination-out`, so scrubbing
 *    backward does not require re-rendering the entire draw phase.
 */

import { makePhase, locate, tangentAt, makeStroke } from '../compile/geometry.js';
import { scribbleRegion, hashSeed } from '../compile/scribble.js';
import { easeEnds, strokePartial, strokeWhole } from './outlineFill.js';

/** Eraser head is much wider than a pen nib. */
export const ERASER_WIDTH_FACTOR = 6;

/** True when the plan lays no ink at all, so there is nothing to erase. */
export function hasInk(plan) {
  return plan.strokes.some((st) => !st.lift && st.pts.length >= 4);
}

/** Union of the bounding boxes of the strokes that actually lay ink. */
export function inkExtent(plan) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const st of plan.strokes) {
    if (st.lift) continue;
    const half = st.width / 2;
    for (let i = 0; i < st.pts.length; i += 2) {
      if (st.pts[i] - half < x0) x0 = st.pts[i] - half;
      if (st.pts[i] + half > x1) x1 = st.pts[i] + half;
      if (st.pts[i + 1] - half < y0) y0 = st.pts[i + 1] - half;
      if (st.pts[i + 1] + half > y1) y1 = st.pts[i + 1] + half;
    }
  }
  if (!Number.isFinite(x0)) return plan.bbox;
  return [x0, y0, x1, y1];
}

/**
 * Build the erase sweep for a compiled plan.
 * @param {Object} plan a DrawPlan from any animation type
 * @param {Object} [params]
 */
export function compileErase(plan, params = {}) {
  const penWidth = params.penWidth
    ?? (plan.strokes.find((s) => !s.lift)?.width ?? 3);
  const width = params.eraserWidth ?? penWidth * ERASER_WIDTH_FACTOR;

  // Erasing nothing must do nothing. Without this the degenerate bbox still
  // gets padded by the eraser width and produces a small sweep over empty
  // space, complete with a hand.
  if (!hasInk(plan)) {
    return { strokes: [], width, bbox: plan.bbox, phase: makePhase([], 0, 0, 'FILL') };
  }

  const [x0, y0, x1, y1] = inkExtent(plan);
  const pad = width * 0.5;
  const rings = [Float64Array.from([
    x0 - pad, y0 - pad, x1 + pad, y0 - pad, x1 + pad, y1 + pad, x0 - pad, y1 + pad,
  ])];

  const { pts } = scribbleRegion(rings, {
    brushWidth: width,
    angleDeg: params.angleDeg ?? 0,
    overlap: params.overlap ?? 0.45,
    // Erasing genuinely overshoots more than colouring does.
    overshoot: params.overshoot ?? 0.6,
    wobble: params.wobble ?? 0.12,
    seed: hashSeed(`${params.id ?? 'erase'}:sweep`),
  });

  const strokes = pts.length >= 4
    ? [makeStroke(pts, { kind: 'FILL', width, color: '#000000' })]
    : [];

  return {
    strokes,
    width,
    bbox: [x0 - pad, y0 - pad, x1 + pad, y1 + pad],
    phase: makePhase(strokes, 0, strokes.length, 'FILL'),
  };
}

/**
 * Advance the erase mask to progress `u` and report where the eraser is.
 * @returns {import('./registry.js').PenState}
 */
export function advanceErase(sf, ep, u) {
  if (!ep.phase.length) {
    return { x: 0, y: 0, tangent: 0, down: false, active: false, tool: 'eraser' };
  }

  const s = easeEnds(u) * ep.phase.length;
  const at = locate(ep.strokes, ep.phase, s);

  const brush = (ctx, st) => {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = st.width;
    // Only alpha matters; the mask is applied with destination-out.
    ctx.strokeStyle = '#000000';
  };

  sf.erase.commitRange(ep.phase.i0, at.strokeIndex, (ctx, i) => {
    brush(ctx, ep.strokes[i]);
    strokeWhole(ctx, ep.strokes[i]);
  });

  sf.erase.clearActive();
  const st = ep.strokes[at.strokeIndex];
  brush(sf.erase.active.ctx, st);
  strokePartial(sf.erase.active.ctx, st, at.vertex, at.frac);
  sf.erase.markUsed();

  return {
    x: at.x,
    y: at.y,
    tangent: tangentAt(ep.strokes, ep.phase, s),
    down: true,
    active: true,
    tool: 'eraser',
  };
}
