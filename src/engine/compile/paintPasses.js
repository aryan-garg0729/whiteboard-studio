/**
 * Colour groups -> the ordered strokes a pen actually walks.
 *
 * One pass: the pen covers the artwork and the real pixels appear under it,
 * either as one zig-zag sweep across the whole picture or group by group in
 * colour order.
 *
 * There used to be a pencil stencil first -- the group boundaries sketched in
 * grey, then rubbed out by `composite()` as paint landed over them. It is gone.
 * A sketch that gets erased is a detour: it spends a third of the clip drawing
 * something that is not the artwork and is guaranteed to disappear, and on a
 * picture whose boundaries are already its linework it drew a second, greyer
 * outline just inside the real one. Artwork that wants its outline drawn first
 * now has `draw.inkPaint`, which inks the *real* line and leaves it there.
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
    kind: 'FILL', width, color: '#ffffff',
  }));
  if (strokes.length) strokes[strokes.length - 1].closure = closure;
  return strokes;
}

/**
 * Group by group, in colour order, each closed by its own exact pixel mask.
 *
 * A group whose shapes were all too small to scribble still owns pixels, so its
 * closure is carried forward and hung on the next stroke that exists -- the same
 * trick the old fill used for regions it declined to scribble, and the reason
 * "no scribble" never means "no coverage".
 */
function colorGroupStrokes(analysis, params, closure) {
  const base = params.fillBrushWidth ?? 14;
  const angle = params.sweepAngle ?? -45;
  const ordered = orderGroups(analysis.groups, params.groupOrder);

  // A wider brush for a bigger area, which is both what a person does and the
  // only thing that keeps the clip's pacing honest. Scribble length grows with
  // area / spacing, so at one fixed width a flat background costs time in
  // proportion to its area -- and a picture on white spent half its clip
  // colouring white onto white paper, with nothing whatever appearing to
  // happen. Scaling the brush by the square root of the area makes the time a
  // group takes grow with its *diameter* instead, so a large wash is laid in
  // broad strokes and the detail still gets its share of the clip.
  const mean = analysis.groups.reduce((s, g) => s + g.area, 0)
    / Math.max(1, analysis.groups.length);
  const widthFor = (g) =>
    base * Math.max(1, Math.min(5, Math.sqrt(g.area / Math.max(1, mean))));

  const strokes = [];
  let pending = [];
  let pen = null;

  for (const group of ordered) {
    const mine = { rects: group.rects, sx: analysis.mask.sx, sy: analysis.mask.sy };
    if (!group.rings.length) { pending.push(mine); continue; }
    const width = widthFor(group);

    const { pts } = scribbleRegion(group.rings, {
      brushWidth: width,
      angleDeg: angle,
      seed: hashSeed(`${params.seedKey || 'paint'}|${group.label}`),
    });
    const chunks = chunkPolyline(pts);
    if (!chunks.length) { pending.push(mine); continue; }

    if (pen) {
      const gap = Math.hypot(chunks[0][0] - pen[0], chunks[0][1] - pen[1]);
      if (gap > width * 2) strokes.push(travelStroke(pen, [chunks[0][0], chunks[0][1]]));
    }
    for (const c of chunks) {
      strokes.push(makeStroke(c, { kind: 'FILL', width, color: '#ffffff',
        regionId: group.label }));
    }
    const last = chunks[chunks.length - 1];
    pen = [last[last.length - 2], last[last.length - 1]];

    strokes[strokes.length - 1].closure = [...pending, mine];
    pending = [];
  }

  if (strokes.length) {
    // Anything still pending, plus the whole-image backstop, lands on the very
    // last stroke -- so `u = 1` is the complete picture no matter what.
    const last = strokes[strokes.length - 1];
    last.closure = [...(last.closure || []), ...pending, ...closure];
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

  return params.mode === 'colorGroups'
    ? colorGroupStrokes(analysis, params, everything)
    : zigzagStrokes(analysis, params, everything);
}
