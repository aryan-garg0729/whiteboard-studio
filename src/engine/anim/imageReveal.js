/**
 * Image animation: the pen reveals the artwork itself.
 *
 * `draw.outlineFill` draws a *surrogate* -- traced contours in pen ink at a
 * width chosen to read as drawing -- and then crossfades it away to the real
 * asset once the clip ends. Two things follow from that, and both are what this
 * animation exists to remove:
 *
 *   - the swap is visible. What you watched being drawn is not what you are
 *     left with, and the changeover lands 0.35s after the pen stops.
 *   - the artwork is only ever shown intersected with the pen's marks, so any
 *     pixel no brush happened to touch is gone from the finished picture for
 *     good. A region too thin to hold a scribble pass left a white slash
 *     through solid black, permanently.
 *
 * Here there is no surrogate. Every stroke paints into `sf.fill` as a white
 * mask and `ClipSurfaces.composite()` intersects that with `art`, so what
 * appears under the nib is the real artwork from the first frame. Reaching
 * `u = 1` means the mask covers the asset, which makes the finished frame the
 * asset -- there is nothing left to settle to, and `settles: false` says so.
 *
 * That only works because the artwork carries a real alpha channel: see
 * `render/artAlpha.js`. With paper knocked out, a mask can be as generous as it
 * likes, which is what lets `revealGain` widen every stroke and lets each
 * region close with its own exact polygon (`paintClosure`).
 *
 * Ordering, pacing, scribble geometry and the hand rig are all shared with
 * `outlineFill` -- see `compileDrawPlan`.
 */

import { register } from './registry.js';
import { locate, tangentAt } from '../compile/geometry.js';
import {
  DEFAULT_OUTLINE_SHARE, applyBrush, compileDrawPlan, easeEnds,
  paintClosure, strokePartial, strokeWhole,
} from './outlineFill.js';

/**
 * How much wider than the traced line the reveal brush runs.
 *
 * A centreline carries one *mean* width for the whole stroke, so a line that
 * thickens anywhere along its length is under-covered by a brush of exactly
 * that width -- and under a reveal, under-covered means the artwork's own edge
 * never appears. Overshoot costs nothing: the spill lands on transparent paper.
 */
const REVEAL_GAIN = 1.35;

/** The same, for scribble passes, where the geometry is already generous. */
const FILL_REVEAL_GAIN = 1.12;

/** Bounds of everything this plan will reveal, for the eraser to sweep. */
function revealBbox(plan) {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  const grow = (ax0, ay0, ax1, ay1) => {
    if (ax0 < x0) x0 = ax0;
    if (ay0 < y0) y0 = ay0;
    if (ax1 > x1) x1 = ax1;
    if (ay1 > y1) y1 = ay1;
  };

  for (const st of plan.strokes) {
    // Fill strokes are deliberately ragged: they overshoot their region by a
    // third of a pass and are stroked with a brush wider still, so their own
    // extent says more about the pen than about the artwork. The region bbox
    // below is the honest bound, and it is where the ink actually is.
    if (st.lift || st.kind === 'FILL') continue;
    const half = (st.width * REVEAL_GAIN) / 2;
    for (let i = 0; i < st.pts.length; i += 2) {
      grow(st.pts[i] - half, st.pts[i + 1] - half, st.pts[i] + half, st.pts[i + 1] + half);
    }
  }
  // Regions too small to scribble are revealed by their closure alone, so they
  // are outside every stroke's extent and would otherwise be left off.
  for (const region of plan.regions) {
    if (region.bbox) grow(region.bbox[0], region.bbox[1], region.bbox[2], region.bbox[3]);
  }

  // `plan.bbox` includes the drawable's paper margin, so it is the wrong
  // fallback for a sweep -- but an empty plan has nothing better.
  return Number.isFinite(x0) ? [x0, y0, x1, y1] : plan.bbox;
}

export const imageReveal = register({
  id: 'draw.imageReveal',
  label: 'Draw (the artwork appears)',

  // The artwork is already on screen; a crossfade to it would only composite it
  // over itself, which is not the no-op it looks like -- source-over of an
  // image onto itself raises every partial alpha, so antialiased edges and soft
  // greys would visibly thicken over the settle window.
  settles: false,

  paramSchema: {
    outlineShare: { type: 'number', min: 0.1, max: 0.9, step: 0.05,
                    default: DEFAULT_OUTLINE_SHARE, label: 'Outline share' },
    brushWidth: { type: 'number', min: 1, max: 24, step: 0.5, default: 3, label: 'Pen width' },
    fillBrushWidth: { type: 'number', min: 2, max: 64, step: 1, default: 14, label: 'Fill brush' },
    scribbleAngle: { type: 'number', min: -90, max: 90, step: 5, default: -45, label: 'Scribble angle' },
    orderStyle: { type: 'enum', options: ['natural', 'topDown', 'outsideIn'],
                  default: 'natural', label: 'Draw order' },
  },

  async compile(asset, params = {}) {
    const plan = await compileDrawPlan(asset, params, {
      // Nothing may be skipped for being small: under a reveal a region with no
      // mask is a hole in the result, where under outlineFill it was only a
      // patch the pen did not bother to colour.
      minScribbleArea: 0,
      closeMask: true,
    });
    plan.reveal = true;
    plan.revealGain = REVEAL_GAIN;
    plan.fillRevealGain = FILL_REVEAL_GAIN;
    plan.penWidth = params.brushWidth ?? 3;
    plan.inkBbox = revealBbox(plan);
    return plan;
  },

  advance(sf, plan, u) {
    const share = plan.outlineShare;
    const inOutline = u < share || plan.phases.fill.length === 0;
    const phase = inOutline ? plan.phases.outline : plan.phases.fill;

    if (phase.length === 0) {
      return { x: 0, y: 0, tangent: 0, down: false, active: true, tool: 'pen' };
    }

    const local = inOutline
      ? easeEnds(share > 0 ? u / share : 1)
      : easeEnds(share < 1 ? (u - share) / (1 - share) : 1);
    const s = local * phase.length;
    const at = locate(plan.strokes, phase, s);

    // Both phases share one layer, which is only safe because they are
    // contiguous ranges of the same stroke list: committing the outline as
    // [0, fill.i0) leaves `committedUpTo` exactly where the fill range starts,
    // so nothing is skipped and nothing is stamped twice. A backward seek into
    // the outline hits `commitRange(0, k)` with k < committedUpTo, which is the
    // replay path.
    const layer = sf.fill;
    const gain = (st) => (st.kind === 'FILL' ? plan.fillRevealGain : plan.revealGain);

    const drawWhole = (ctx, i) => {
      const st = plan.strokes[i];
      if (!st.lift) {
        applyBrush(ctx, st, '#ffffff', gain(st));
        strokeWhole(ctx, st);
      }
      // The stroke's shapes join the mask the moment it finishes, so coverage
      // closes progressively rather than popping at the end of the clip.
      if (st.closure) paintClosure(ctx, st.closure);
    };

    if (!inOutline) layer.commitRange(0, plan.phases.outline.i1, drawWhole);
    layer.commitRange(phase.i0, at.strokeIndex, drawWhole);

    layer.clearActive();
    const st = plan.strokes[at.strokeIndex];
    const ctx = layer.active.ctx;
    if (!st.lift) {
      applyBrush(ctx, st, '#ffffff', gain(st));
      strokePartial(ctx, st, at.vertex, at.frac);
    }
    // The final stroke of a phase is never committed -- `locate` clamps to the
    // last index and `commitRange`'s bound is exclusive -- so its closure has
    // to be painted here or the last region would be the one hole left in an
    // otherwise complete picture.
    if (local >= 1 && st.closure) paintClosure(ctx, st.closure);
    // commitRange only marks the layer used when it actually commits a stroke,
    // so the opening frames -- where everything is still in `active` -- would
    // otherwise composite as an empty clip.
    layer.markUsed();

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

export default imageReveal;
