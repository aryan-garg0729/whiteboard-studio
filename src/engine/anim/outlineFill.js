/**
 * The image animation required by req.md: a high-level outline is drawn first,
 * then colour arrives via zig-zag scribbling.
 *
 * Explicitly NOT a zig-zag wipe of the finished artwork -- the outline is a
 * real traced contour pass, and the fill is a separate scribble pass whose
 * mask reveals the artwork's true colours underneath.
 */

import { makePhase, locate, tangentAt, makeStroke } from '../compile/geometry.js';
import { orderStrokes } from '../compile/order.js';
import { scribbleRegion, hashSeed } from '../compile/scribble.js';
import { register } from './registry.js';

/** Fraction of the clip spent on the outline pass. */
export const DEFAULT_OUTLINE_SHARE = 0.45;

/** Regions smaller than this many spacing-squared can't hold a scribble pass. */
const MIN_SCRIBBLE_AREA = 6;

const bboxArea = (b) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);

/**
 * Ease only the first and last few percent of a phase, so the pen doesn't
 * start and stop with infinite jerk. The middle stays linear -- constant pen
 * speed is the entire point of arc-length pacing, and easing the whole phase
 * would undo it.
 */
export function easeEnds(u, edge = 0.04) {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  if (edge <= 0) return u;
  const smooth = (t) => t * t * (3 - 2 * t);
  if (u < edge) return smooth(u / edge) * edge;
  if (u > 1 - edge) return 1 - edge + smooth((u - (1 - edge)) / edge) * edge;
  return u;
}

/**
 * Draw a stroke from its first vertex up to `vertex`+`frac`.
 *
 * Rebuilding a truncated path beats setLineDash/lineDashOffset here:
 * dash phase is computed in device space after the CTM, so a dash array
 * authored in object units drifts as the camera zooms; the phase accumulates
 * float error over the 200k+ px paths a full-page vector reaches; and the hand
 * rig needs the exact tip position anyway, so the dash route would compute the
 * reveal front twice in two code paths that eventually disagree by a pixel.
 */
export function strokePartial(ctx, st, vertex, frac) {
  if (st.pts.length < 4) return;
  ctx.beginPath();
  ctx.moveTo(st.pts[0], st.pts[1]);
  for (let i = 1; i <= vertex; i++) ctx.lineTo(st.pts[2 * i], st.pts[2 * i + 1]);
  const x = st.pts[2 * vertex] + (st.pts[2 * vertex + 2] - st.pts[2 * vertex]) * frac;
  const y = st.pts[2 * vertex + 1] + (st.pts[2 * vertex + 3] - st.pts[2 * vertex + 1]) * frac;
  ctx.lineTo(x, y);
  ctx.stroke();
}

export function strokeWhole(ctx, st) {
  if (st.pts.length < 4) return;
  ctx.beginPath();
  ctx.moveTo(st.pts[0], st.pts[1]);
  for (let i = 1; i < st.pts.length >> 1; i++) ctx.lineTo(st.pts[2 * i], st.pts[2 * i + 1]);
  ctx.stroke();
}

function applyBrush(ctx, st, color) {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = st.width;
  ctx.strokeStyle = color || st.color;
}

export const outlineFill = register({
  id: 'draw.outlineFill',
  label: 'Draw outline, then colour in',

  paramSchema: {
    outlineShare: { type: 'number', min: 0.1, max: 0.9, step: 0.05,
                    default: DEFAULT_OUTLINE_SHARE, label: 'Outline share' },
    brushWidth: { type: 'number', min: 1, max: 24, step: 0.5, default: 3, label: 'Pen width' },
    fillBrushWidth: { type: 'number', min: 2, max: 64, step: 1, default: 14, label: 'Fill brush' },
    scribbleAngle: { type: 'number', min: -90, max: 90, step: 5, default: -45, label: 'Scribble angle' },
    orderStyle: { type: 'enum', options: ['natural', 'topDown', 'outsideIn'],
                  default: 'natural', label: 'Draw order' },
  },

  /**
   * @param {{subpaths:Array, regions:Array, bbox:number[], id:string}} asset
   *   `subpaths` are outline contours; `regions` are {rings, color} for filling.
   */
  async compile(asset, params = {}) {
    const p = { outlineShare: DEFAULT_OUTLINE_SHARE, brushWidth: 3, fillBrushWidth: 14,
                scribbleAngle: -45, orderStyle: 'natural', ...params };

    // A centreline carries the thickness of the line it replaces, so the pen
    // reproduces the original weight instead of a uniform brush. Contours have
    // no meaningful width of their own and fall back to the brush.
    const outline = orderStrokes(
      asset.subpaths.map((s) => ({
        ...s,
        width: s.width ? Math.max(p.brushWidth, s.width) : p.brushWidth,
      })),
      { style: p.orderStyle, travelMinGap: p.brushWidth * 2 },
    );

    const fill = [];
    const spacing = p.fillBrushWidth * 0.65;
    // Fill in the same reading order the outline used, so colour arrives
    // top-to-bottom rather than in whatever order the vectorizer emitted
    // regions. Indices are kept for stable jitter seeds.
    const regions = (asset.regions || [])
      .map((region, i) => ({ region, i }))
      .sort((a, b) => {
        const ba = a.region.bbox || asset.bbox;
        const bb = b.region.bbox || asset.bbox;
        return (ba[1] - bb[1]) || (ba[0] - bb[0]);
      });

    regions.forEach(({ region, i }) => {
      // Tiny regions can't hold even one scribble pass; filling them anyway
      // turns the fill phase into thousands of one-frame twitches.
      if (bboxArea(region.bbox || asset.bbox) < MIN_SCRIBBLE_AREA * spacing * spacing) return;
      const { pts } = scribbleRegion(region.rings, {
        brushWidth: p.fillBrushWidth,
        angleDeg: p.scribbleAngle,
        // Jitter is baked here, at compile time, with a seed derived from
        // stable identity -- the runtime never calls Math.random, which is
        // what keeps renderFrame(t) reproducible.
        seed: hashSeed(`${asset.id}:fill:${i}`),
      });
      if (pts.length >= 4) {
        fill.push(makeStroke(pts, {
          kind: 'FILL', width: p.fillBrushWidth, color: region.color, regionId: i,
        }));
      }
    });

    const strokes = [...outline, ...fill];
    return {
      strokes,
      regions: asset.regions || [],
      bbox: asset.bbox,
      outlineShare: p.outlineShare,
      phases: {
        outline: makePhase(strokes, 0, outline.length, 'OUTLINE'),
        fill: makePhase(strokes, outline.length, strokes.length, 'FILL'),
      },
    };
  },

  /**
   * @param {import('../render/surfaces.js').ClipSurfaces} sf
   * @param {number} u normalised clip progress
   */
  advance(sf, plan, u) {
    const share = plan.outlineShare;
    const inOutline = u < share || plan.phases.fill.length === 0;
    const phase = inOutline ? plan.phases.outline : plan.phases.fill;
    const layer = inOutline ? sf.ink : sf.fill;

    if (phase.length === 0) {
      return { x: 0, y: 0, tangent: 0, down: false, active: true, tool: 'pen' };
    }

    const local = inOutline
      ? easeEnds(share > 0 ? u / share : 1)
      : easeEnds(share < 1 ? (u - share) / (1 - share) : 1);
    const s = local * phase.length;
    const at = locate(plan.strokes, phase, s);

    // Once the outline pass is done it must stay fully drawn while the fill
    // runs, so commit the whole outline phase rather than only the strokes the
    // fill pass has walked past.
    if (!inOutline) {
      sf.ink.commitRange(plan.phases.outline.i0, plan.phases.outline.i1, (ctx, i) => {
        const st = plan.strokes[i];
        if (st.lift) return;
        applyBrush(ctx, st);
        strokeWhole(ctx, st);
      });
      sf.ink.clearActive();
    }

    layer.commitRange(phase.i0, at.strokeIndex, (ctx, i) => {
      const st = plan.strokes[i];
      if (st.lift) return;
      applyBrush(ctx, st, layer === sf.fill ? '#ffffff' : undefined);
      strokeWhole(ctx, st);
    });

    layer.clearActive();
    const st = plan.strokes[at.strokeIndex];
    if (!st.lift) {
      const ctx = layer.active.ctx;
      // The region clip belongs on the mask, not on `reveal` and not on the
      // page: clipping downstream applies antialiasing twice and leaves a
      // visibly thin dark rim at 1080p.
      applyBrush(ctx, st, layer === sf.fill ? '#ffffff' : undefined);
      strokePartial(ctx, st, at.vertex, at.frac);
    }

    return {
      x: at.x,
      y: at.y,
      tangent: tangentAt(plan.strokes, phase, s),
      down: !st.lift,
      active: true,
      tool: 'pen',
    };
  },
});

export default outlineFill;
