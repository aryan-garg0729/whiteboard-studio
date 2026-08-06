/**
 * Text animation: the letters appear left to right while the hand oscillates
 * over the reveal frontier.
 *
 * This is what reference whiteboard products actually do, and it is a different
 * idea from `draw.handwrite`. That one walks a character-level handwriting
 * guide; this mode instead sweeps whole words. Both retain the real filled
 * glyph outline, so the final type is exactly the selected font.
 *
 * The hand is not tracing anything. It jiggles up and down over the frontier,
 * which at playback speed reads as writing far better than a pen crawling
 * accurately around the bowl of an 'a'.
 *
 * Nothing here draws colour: the reveal is a mask on `sf.fill`, and
 * `ClipSurfaces.composite()` intersects it with `art` to produce true pixels.
 * That machinery is shared with the image animation and is not touched.
 */

import { makePhase } from '../compile/geometry.js';
import { hashSeed } from '../compile/scribble.js';
import { register } from './registry.js';
import { easeEnds } from './penStrokes.js';

/**
 * Horizontal travel per loop of the hand, as a fraction of the band height.
 * Roughly one loop per letter: faster reads as a vibration, slower as the hand
 * losing interest.
 */
const OSCILLATION_PERIOD = 0.55;

/**
 * How far the hand swings either side of the line's middle, as a fraction of
 * the band height. The full sweep is twice this.
 *
 * Exported because it is the only honest thing to write a test against: the
 * assertion is that the hand moves about as far as this says, not that it
 * clears some number chosen when the constant happened to be larger.
 */
export const OSCILLATION_REACH = 0.105;

/**
 * Width of the pen's loop, as a multiple of the forward travel per radian.
 *
 * This is what turns a zigzag into cursive. With a pure vertical sine the nib
 * traces /\/\ -- it only ever moves forward, so every stroke is a straight
 * diagonal and the whole thing reads as a machine. A real hand writing `eee`
 * loops: the nib swings *backward* over what it just wrote at the top of each
 * stroke. Adding a horizontal sine in quadrature makes the path an ellipse
 * dragged forward -- a prolate trochoid -- and it only forms closed loops when
 * the ellipse is wider than the drift, i.e. when this is > 1.
 */
const LOOP_GAIN = 1.75;

/**
 * Forward lean of each loop, as a fraction of its height. Upright loops read as
 * bubbles; real cursive slants with the direction of travel.
 */
const LOOP_SLANT = -0.34;

/**
 * How much the loop height varies, and how fast relative to the loop itself.
 *
 * Identical loops are still mechanical, just curved. The ratio is deliberately
 * irrational-ish so the variation never lines up with the loop and the pattern
 * does not visibly repeat.
 */
export const LOOP_VARY = 0.17;
const LOOP_VARY_RATE = 0.37;

/** Ragged-edge amplitude, as a fraction of the band height. */
const EDGE_WOBBLE = 0.045;

/** Vertical segments the ragged edge is drawn with. */
const EDGE_STEPS = 12;

/** How far the mask extends above and below the ink, as a fraction of the band. */
const BAND_PAD = 0.16;

const TAU = Math.PI * 2;

/**
 * A word crossed with the pen up costs this fraction of its width in progress.
 * Not zero -- a hand that teleports between words looks broken -- but well
 * under 1, because nothing is being written and dwelling there reads as a stall.
 */
const GAP_DISCOUNT = 0.35;

/** Progress spent hopping to the next line, as a fraction of the band height. */
const LINE_BREAK_COST = 0.9;

/**
 * Flatten the layout into an ordered list of segments the pen walks through.
 *
 * Words and the gaps between them are the same kind of thing here, differing
 * only in whether ink is laid and how much progress they cost. Doing this once
 * at compile time keeps `advance` a simple walk, and keeps the awkward cases --
 * blank lines, a line of nothing but spaces, trailing whitespace -- out of the
 * per-frame path entirely.
 *
 * @returns {{li:number, x0:number, x1:number, ink:boolean, len:number}[]}
 */
export function buildSegments(lines) {
  const out = [];
  let prevX = null;
  let prevY = null;

  lines.forEach((line, li) => {
    if (!line.spans.length) return;         // a blank line has nothing to write
    const mid = (line.y0 + line.y1) / 2;

    if (prevX !== null) {
      // The hop down to this line.
      const nextX = line.spans[0][0];
      const nextY = mid;
      const h = Math.max(1, line.y1 - line.y0);
      const dy = nextY - prevY;
      const dx = nextX - prevX;
      const dist = Math.hypot(dx, dy);
      out.push({
        li,
        x0: prevX,
        y0: prevY,
        x1: nextX,
        y1: nextY,
        ink: false,
        len: Math.max(h * LINE_BREAK_COST, dist * GAP_DISCOUNT),
      });
      prevX = nextX;
      prevY = nextY;
    } else {
      // First line, first span: initialize
      prevX = line.spans[0][0];
      prevY = mid;
    }

    line.spans.forEach(([x0, x1], si) => {
      if (si > 0) {
        const gapFrom = line.spans[si - 1][1];
        out.push({
          li,
          x0: gapFrom,
          y0: mid,
          x1: x0,
          y1: mid,
          ink: false,
          len: (x0 - gapFrom) * GAP_DISCOUNT,
        });
      }
      out.push({
        li,
        x0,
        y0: mid,
        x1,
        y1: mid,
        ink: true,
        len: x1 - x0,
      });
      prevX = x1;
      prevY = mid;
    });
  });

  return out;
}

export function locateFrontier(segments, s) {
  let left = s;
  let inkDone = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (left <= seg.len || i === segments.length - 1) {
      const f = seg.len > 0 ? Math.min(1, left / seg.len) : 1;
      const dx = seg.x1 - seg.x0;
      const dy = seg.y1 - seg.y0;

      let x = seg.x0 + dx * f;
      let y = seg.y0 + dy * f;

      if (!seg.ink) {
        // Pen-up travel bulge (lift the pen vertically along a quadratic arc)
        const dist = Math.hypot(dx, dy);
        const bulge = dist * 0.18;
        y -= f * (1 - f) * 4 * bulge; // subtract because y is y-down
      }

      return {
        index: i,
        x,
        y,
        li: seg.li,
        ink: seg.ink,
        inkDone: inkDone + (seg.ink ? (seg.x1 - seg.x0) * f : 0),
        frac: f,
      };
    }
    left -= seg.len;
    if (seg.ink) inkDone += seg.x1 - seg.x0;
  }
  const last = segments[segments.length - 1];
  return { index: segments.length - 1, x: last.x1, y: last.y1, li: last.li, ink: false, inkDone, frac: 1 };
}

/** Vertical band the mask covers for a line, padded a little past the ink. */
function bandOf(line) {
  const h = Math.max(1, line.y1 - line.y0);
  const pad = h * BAND_PAD;
  return { top: line.y0 - pad, bottom: line.y1 + pad, height: h };
}

/**
 * Fill a span from `x0` to `x`, with a soft ragged right edge.
 *
 * A hard rectangle edge reads as a curtain being drawn rather than as ink being
 * laid. Two constraints shape the displacement, and both exist because the mask
 * must never retreat -- a scanline whose edge moves back is ink visibly
 * un-drawing itself:
 *
 *   - it is a function of y and the baked phase only, never of x, so the comb
 *     translates rigidly with the frontier instead of sliding along it;
 *   - it only ever lags, never leads. A displacement centred on the frontier
 *     puts some rows ahead of it, and those rows jump backwards the moment the
 *     word finishes and the edge squares off.
 *
 * Either way it stays a pure function of `u`, which the determinism rules
 * require.
 */
function fillSpan(ctx, line, x0, x, phase, ragged) {
  const b = bandOf(line);
  if (x <= x0) return;
  ctx.beginPath();
  ctx.moveTo(x0, b.top);
  if (!ragged) {
    ctx.lineTo(x, b.top);
    ctx.lineTo(x, b.bottom);
  } else {
    const amp = b.height * EDGE_WOBBLE;
    for (let i = 0; i <= EDGE_STEPS; i++) {
      const y = b.top + ((b.bottom - b.top) * i) / EDGE_STEPS;
      ctx.lineTo(x - amp * 0.5 * (1 + Math.sin(y * 0.09 + phase)), y);
    }
  }
  ctx.lineTo(x0, b.bottom);
  ctx.closePath();
  ctx.fill();
}

export const textReveal = register({
  id: 'draw.textReveal',
  label: 'Write text',

  paramSchema: {
    color: { type: 'color', default: '#1a1a1a', label: 'Ink' },
  },

  /**
   * Layout is done by `outlineText` in compile/text.js, which needs a parsed
   * font; the host passes the result through as `asset.layout`, exactly as
   * handwrite does, so this stays a pure assembly step.
   *
   * @param {{id?:string, layout:{lines:Array, bbox:number[], inkBbox:number[]}}} asset
   */
  async compile(asset) {
    const { lines, bbox, inkBbox } = asset.layout;
    const segments = buildSegments(lines);
    const total = segments.reduce((n, seg) => n + seg.len, 0);

    return {
      lines,
      segments,
      bbox,
      inkBbox,
      total,
      // The band height stands in for the font size, which is not otherwise
      // known here, and is what the eraser sizes itself from.
      penWidth: asset.layout.penWidth
        ?? Math.max(2, (lines.find((l) => l.spans.length)?.y1 ?? 0)
                     - (lines.find((l) => l.spans.length)?.y0 ?? 0)) * 0.09,
      // Baked once so the ragged edge is deterministic without a runtime PRNG:
      // renderFrame forbids Math.random below its line.
      phase: (hashSeed(`${asset.id ?? 'text'}:reveal`) % 1000) / 1000 * TAU,
      // No strokes at all -- the artwork is the glyph fill. `strokes` is kept as
      // an empty array because the erase modifier scans it; it falls back to
      // `inkBbox`, which is why that is carried here.
      strokes: [],
      outlineShare: 0,
      phases: {
        outline: makePhase([], 0, 0, 'OUTLINE'),
        fill: makePhase([], 0, 0, 'FILL'),
      },
    };
  },

  advance(sf, plan, u) {
    const { lines, segments, total, phase } = plan;
    if (!total) return { x: 0, y: 0, tangent: 0, down: false, active: false, tool: 'pen' };

    const s = easeEnds(u) * total;
    const at = locateFrontier(segments, s);

    // The whole mask is redrawn from `u` every frame rather than accumulated.
    // It is a handful of filled shapes, so this costs nothing next to a stroke
    // replay -- and it makes a backward seek exact by construction, because
    // there is no history to invalidate.
    const ctx = sf.fill.active.ctx;
    sf.fill.clearActive();
    ctx.fillStyle = '#ffffff';        // the fill layer is alpha, never colour
    ctx.globalAlpha = 1;

    for (let i = 0; i <= at.index; i++) {
      const seg = segments[i];
      if (!seg.ink) continue;
      // Everything behind the frontier is fully revealed; only a word actually
      // mid-stroke gets the ragged edge. A finished word with a wavy right edge
      // keeps a permanent bite out of its last letter -- and `at.frac`, not the
      // index, is what says finished: the frontier never rolls past the final
      // segment, so at u=1 the last word of the text is still `at.index` and
      // would otherwise stay chewed for as long as it is on screen.
      if (i < at.index) fillSpan(ctx, lines[seg.li], seg.x0, seg.x1, phase, false);
      else fillSpan(ctx, lines[seg.li], seg.x0, at.x, phase, at.frac < 1);
    }
    // Layer.used is only set by commitRange, and this animation never commits.
    sf.fill.markUsed();

    // The hand rides the frontier, sweeping the band. Driven by distance
    // written rather than by time, so the jiggle keeps pace with the writing
    // however the clip is retimed -- and holds its phase across a hop, when
    // nothing is being written at all.
    const b = bandOf(lines[at.li]);
    const period = Math.max(1, b.height * OSCILLATION_PERIOD);
    const theta = (at.inkDone / period) * TAU;

    // Harmonic writing variation
    const vary = 1 - LOOP_VARY + LOOP_VARY * Math.sin(theta * LOOP_VARY_RATE + phase);

    // Add small high-frequency components to simulate individual handwriting details
    const theta1 = theta;
    const theta2 = theta * 2;
    const theta3 = theta * 3;
    const h2 = Math.sin(theta * 0.15 + phase) * 0.22;
    const h3 = Math.cos(theta * 0.23 + phase) * 0.08;

    const waveY = Math.cos(theta1) + h2 * Math.sin(theta2) + h3 * Math.cos(theta3);
    const dy = b.height * OSCILLATION_REACH * vary * (waveY / 1.15);

    const waveX = Math.sin(theta1) + h3 * Math.cos(theta2);
    const dx = (period / TAU) * LOOP_GAIN * waveX + LOOP_SLANT * dy;

    return {
      // The nib leads the reveal around the loop; the mask frontier itself
      // stays monotonic, so swinging back over finished letters is only the
      // hand moving, never ink being un-drawn.
      x: at.ink ? at.x + dx : at.x,
      // Between words the pen is off the paper and travelling, so it rides the
      // bulged travel arc (at.y) rather than continuing to scrub or instantly jumping.
      y: at.ink ? at.y + dy : at.y,
      // Deliberately fixed, not derived from the sweep.
      //
      // Taking the tangent of the oscillation looks right on paper -- the shaft
      // follows the stroke -- but the sweep is near-vertical and reverses twice
      // per letter, so the tangent slams between roughly +78 and -78 degrees.
      // The rig scales that by alignFactor into a +/-12 degree rock about the
      // nib, and the hand visibly wags left and right as it writes. A real hand
      // holds its pose and moves from the wrist; the pen angle is what stays
      // still. This is the same failure the serpentine scribble fill hit, and
      // there the fix was to stop following the raw tangent too.
      tangent: 0,
      down: at.ink,
      active: true,
      tool: 'pen',
    };
  },
});

export default textReveal;
