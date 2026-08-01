/**
 * Text animation: the letters appear left to right while the hand oscillates
 * over the reveal frontier.
 *
 * This is what reference whiteboard products actually do, and it is a different
 * idea from `draw.handwrite`. That one traces a centreline through each letter,
 * which means the letters are only ever as good as the skeleton -- on any face
 * that is not near-monoline, a constant-width stroke down the middle of a
 * modulated letterform simply does not look like that letter. Here the artwork
 * is the real filled glyph outline and the animation only decides *how much of
 * it is visible*, so the type is exactly the type.
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
import { easeEnds } from './outlineFill.js';

/**
 * Horizontal travel per up-down cycle of the hand, as a fraction of the font
 * size. Roughly one stroke per letter: faster reads as a vibration, slower as
 * the hand losing interest.
 */
const OSCILLATION_PERIOD = 0.55;

/** How much of the line band the hand sweeps, as a fraction of its height. */
const OSCILLATION_REACH = 0.42;

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
  let prev = null;                          // last line index that had ink

  lines.forEach((line, li) => {
    if (!line.spans.length) return;         // a blank line has nothing to write
    if (prev !== null) {
      // The hop down to this line. It has no width of its own, so it is priced
      // off the band height instead.
      const h = Math.max(1, line.y1 - line.y0);
      out.push({ li, x0: line.spans[0][0], x1: line.spans[0][0], ink: false,
                 len: h * LINE_BREAK_COST });
    }
    line.spans.forEach(([x0, x1], si) => {
      if (si > 0) {
        const gapFrom = line.spans[si - 1][1];
        out.push({ li, x0: gapFrom, x1: x0, ink: false,
                   len: (x0 - gapFrom) * GAP_DISCOUNT });
      }
      out.push({ li, x0, x1, ink: true, len: x1 - x0 });
    });
    prev = li;
  });

  return out;
}

/**
 * Locate the reveal frontier at distance `s` along the segment list.
 *
 * `inkDone` counts only the distance actually written, so the hand's
 * oscillation holds its phase across a hop instead of jumping forward while the
 * pen is off the paper.
 *
 * @returns {{index:number, x:number, li:number, ink:boolean, inkDone:number}}
 */
export function locateFrontier(segments, s) {
  let left = s;
  let inkDone = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (left <= seg.len || i === segments.length - 1) {
      const f = seg.len > 0 ? Math.min(1, left / seg.len) : 1;
      return {
        index: i,
        x: seg.x0 + (seg.x1 - seg.x0) * f,
        li: seg.li,
        ink: seg.ink,
        inkDone: inkDone + (seg.ink ? (seg.x1 - seg.x0) * f : 0),
      };
    }
    left -= seg.len;
    if (seg.ink) inkDone += seg.x1 - seg.x0;
  }
  return { index: 0, x: 0, li: 0, ink: false, inkDone: 0 };
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
 * laid. The displacement is a function of both y and the frontier itself, so the
 * pattern travels with the edge instead of sitting there like a fixed comb --
 * and it stays a pure function of `u`, which the determinism rules require.
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
      ctx.lineTo(x + amp * Math.sin(y * 0.09 + x * 0.02 + phase), y);
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
      // Everything behind the frontier is fully revealed; only the word being
      // written gets the ragged edge. A completed word with a wavy right edge
      // would leave a permanent bite out of its last letter.
      if (i < at.index) fillSpan(ctx, lines[seg.li], seg.x0, seg.x1, phase, false);
      else fillSpan(ctx, lines[seg.li], seg.x0, at.x, phase, true);
    }
    // Layer.used is only set by commitRange, and this animation never commits.
    sf.fill.markUsed();

    // The hand rides the frontier, sweeping the band. Driven by distance
    // written rather than by time, so the jiggle keeps pace with the writing
    // however the clip is retimed -- and holds its phase across a hop, when
    // nothing is being written at all.
    const b = bandOf(lines[at.li]);
    const mid = (b.top + b.bottom) / 2;
    const period = Math.max(1, b.height * OSCILLATION_PERIOD);
    const theta = (at.inkDone / period) * TAU;
    const reach = b.height * OSCILLATION_REACH;

    return {
      x: at.x,
      // Between words the pen is off the paper and travelling, so it rides flat
      // rather than continuing to scrub at nothing.
      y: at.ink ? mid + reach * Math.sin(theta) : mid,
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
