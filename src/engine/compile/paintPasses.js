/**
 * Colour groups -> the ordered strokes a pen actually walks.
 *
 * One pass: the pen covers the artwork and the real pixels appear under it,
 * either as one zig-zag sweep across the whole picture or group by group in
 * colour order.
 *
 * There is no pencil stencil before it any more; see `doc.md` for why it went.
 *
 * Coverage is never left to the brush. Each stroke may carry a `closure` -- the
 * exact pixels it is responsible for having revealed by the time it finishes --
 * and the union of every closure is the whole image. See `pixels.js`.
 */

import { makeStroke } from './geometry.js';
import { travelStroke } from './order.js';
import { hashSeed, scribbleRegion } from './scribble.js';
import { orderGroups } from './pixels.js';

/**
 * Points per stroke when a long scribble is cut up.
 *
 * `scribbleRegion` hands back one polyline for a whole region, and a single
 * stroke is committed to the raster all at once -- so an undivided sweep across
 * a full page would stay in the "in progress" layer for the entire clip and be
 * redrawn from its first vertex every frame. Cutting it into strokes restores
 * the committed/active split that makes rendering O(1) per frame. Consecutive
 * chunks share their joining vertex, so the path is continuous and the seam is
 * invisible.
 */
const CHUNK_POINTS = 120;

/** Mask colour. Every stroke lays coverage, never pigment. */
export const MASK = '#ffffff';

/** The image's own rectangle, as a single ring for the zig-zag sweep. */
const rectRing = (w, h) => Float64Array.from([0, 0, w, 0, w, h, 0, h]);

/**
 * Which way a zig-zag sweep runs.
 *
 * `scribbleRegion` always scans from the low side of the rotated frame and
 * starts each cell moving left to right, so the four corners are reached by
 * turning the sweep around (add half a turn) and by mirroring x.
 */
const SWEEP_FROM = {
  topLeft: { flip: false, mirror: false },
  topRight: { flip: false, mirror: true },
  bottomLeft: { flip: true, mirror: true },
  bottomRight: { flip: true, mirror: false },
};

const mirrorRings = (rings) => rings.map((r) => {
  const o = new Float64Array(r.length);
  for (let i = 0; i < r.length; i += 2) { o[i] = -r[i]; o[i + 1] = r[i + 1]; }
  return o;
});

/**
 * Cut a polyline into strokes of a manageable length.
 *
 * @param {number[]} pts packed [x,y,...]
 * @param {number} [size=CHUNK_POINTS] points per chunk. The ink pass cuts
 *   finer: its strokes are long simplified centrelines with few vertices
 *   spanning a lot of ground, so the same vertex count is a much longer piece
 *   of drawing sitting in the active layer.
 * @returns {Array<number[]>} chunks, each sharing its first point with the
 *   previous chunk's last
 */
export function chunkPolyline(pts, size = CHUNK_POINTS) {
  const n = pts.length / 2;
  if (n < 2) return [];
  const chunks = [];
  for (let start = 0; start < n - 1; start += size) {
    const end = Math.min(n - 1, start + size);
    const c = [];
    for (let i = start; i <= end; i++) c.push(pts[i * 2], pts[i * 2 + 1]);
    if (c.length >= 4) chunks.push(c);
  }
  return chunks;
}

/**
 * One zig-zag sweep over the whole picture.
 *
 * The mask is the brush here rather than a per-group blit, because there are no
 * groups to blit -- the sweep crosses colours freely, which is the point of the
 * mode. Adjacent passes are guaranteed to overlap (`MAX_COVERAGE_RATIO` in
 * `scribble.js`), so coverage is complete on its own; the full-image closure
 * hung on the last stroke is a backstop, not the mechanism, and on a sound
 * sweep it paints nothing that is not already painted.
 */
function zigzagStrokes(analysis, params, closure) {
  const { flip, mirror } = SWEEP_FROM[params.sweepFrom] || SWEEP_FROM.topLeft;
  const angle = (params.sweepAngle ?? -45) + (flip ? 180 : 0);
  const width = params.fillBrushWidth ?? 14;

  let rings = [rectRing(analysis.width, analysis.height)];
  if (mirror) rings = mirrorRings(rings);

  const { pts } = scribbleRegion(rings, {
    brushWidth: width,
    angleDeg: angle,
    seed: hashSeed(`${params.seedKey || 'zigzag'}|${angle}|${width}`),
  });
  if (mirror) for (let i = 0; i < pts.length; i += 2) pts[i] = -pts[i];

  const strokes = chunkPolyline(pts).map((c) => makeStroke(c, {
    kind: 'FILL', width, color: MASK,
  }));
  if (strokes.length) strokes[strokes.length - 1].closure = closure;
  return strokes;
}

/**
 * Scribble a list of regions one at a time, each closed by its own pixel mask.
 *
 * The shared body of both colour passes: `draw.stencilPaint` hands it colour
 * groups, `draw.inkPaint` hands it the connected shapes those groups split
 * into. The sequencing is the same either way and so are the two rules that
 * matter -- a region too small to scribble still owns pixels, so its closure is
 * carried forward onto the next stroke that exists, and the very last stroke
 * takes the whole-image backstop so `u = 1` is complete no matter what.
 *
 * A wider brush for a bigger area, which is both what a person does and the
 * only thing that keeps the clip's pacing honest. Scribble length grows with
 * area / spacing, so at one fixed width a flat background costs time in
 * proportion to its area -- and a picture on white spent half its clip
 * colouring white onto white paper, with nothing whatever appearing to happen.
 * Scaling the brush by the square root of the area makes the time a region
 * takes grow with its *diameter* instead, so a large wash is laid in broad
 * strokes and the detail still gets its share of the clip.
 *
 * @param {Array} regions each `{rings, rects, area}` plus whatever `seedOf` and
 *   `regionId` need; already in the order they should be painted
 * @param {Object} o
 * @param {{sx:number, sy:number}} o.mask scale from mask grid to object space
 * @param {(r:Object) => string} o.seedOf stable seed key per region
 * @param {(r:Object) => number} o.regionId what to tag the strokes with
 * @param {Array} o.backstop closure hung on the final stroke
 */
export function scribbleRegions(regions, { mask, params, seedOf, regionId, backstop }) {
  const base = params.fillBrushWidth ?? 14;
  const angle = params.sweepAngle ?? -45;

  const mean = regions.reduce((s, r) => s + r.area, 0) / Math.max(1, regions.length);
  const widthFor = (r) =>
    base * Math.max(1, Math.min(5, Math.sqrt(r.area / Math.max(1, mean))));

  const strokes = [];
  let pending = [];
  let pen = null;

  for (const region of regions) {
    const mine = { rects: region.rects, sx: mask.sx, sy: mask.sy };
    if (!region.rings.length) { pending.push(mine); continue; }
    const width = widthFor(region);

    const { pts } = scribbleRegion(region.rings, {
      brushWidth: width,
      angleDeg: angle,
      seed: hashSeed(seedOf(region)),
    });
    const chunks = chunkPolyline(pts);
    if (!chunks.length) { pending.push(mine); continue; }

    if (pen) {
      const gap = Math.hypot(chunks[0][0] - pen[0], chunks[0][1] - pen[1]);
      if (gap > width * 2) strokes.push(travelStroke(pen, [chunks[0][0], chunks[0][1]]));
    }
    for (const c of chunks) {
      strokes.push(makeStroke(c, {
        kind: 'FILL', width, color: MASK, regionId: regionId(region),
      }));
    }
    const last = chunks[chunks.length - 1];
    pen = [last[last.length - 2], last[last.length - 1]];

    strokes[strokes.length - 1].closure = [...pending, mine];
    pending = [];
  }

  if (strokes.length) {
    const last = strokes[strokes.length - 1];
    last.closure = [...(last.closure || []), ...pending, ...backstop];
  }
  return strokes;
}

/**
 * Build the stroke list for one piece of artwork.
 *
 * @param {ReturnType<import('./pixels.js').analyzeArtwork>} analysis
 * @param {Object} params see `draw.stencilPaint`'s paramSchema
 * @returns {Array} the paint strokes, in order
 */
export function buildPasses(analysis, params = {}) {
  // The backstop closure: every group's pixels, hung on the final stroke.
  const everything = analysis.groups.map((g) => ({
    rects: g.rects, sx: analysis.mask.sx, sy: analysis.mask.sy,
  }));

  if (params.mode !== 'colorGroups') return zigzagStrokes(analysis, params, everything);
  return scribbleRegions(orderGroups(analysis.groups, params.groupOrder), {
    mask: analysis.mask,
    params,
    seedOf: (g) => `${params.seedKey || 'paint'}|${g.label}`,
    regionId: (g) => g.label,
    backstop: everything,
  });
}
