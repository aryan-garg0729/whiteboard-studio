/**
 * Whiteboard artwork -> ink the linework, then colour the shapes.
 *
 * The counterpart to `paintPasses.js`, for artwork that was drawn the way a
 * whiteboard illustration is drawn: shapes outlined in black, filled flat. That
 * assumption buys two things the general pipeline cannot have.
 *
 *   1. **The outline is drawn, not filled.** The dark neutral groups are one
 *      shape -- the linework -- and the pen runs down its centreline the way a
 *      person inks a drawing, rather than scribbling back and forth inside a
 *      3px line. What *appears* is the line at its real thickness; see
 *      `centerline.js` for why those are two different things.
 *   2. **Colour goes on one shape at a time.** A colour is not a place: every
 *      red pixel is one group, but the shirt and the two shoes are three
 *      shapes, and a hand fills one and then moves to the next.
 *
 * Coverage is never left to the brush, exactly as in `paintPasses.js`: each
 * stroke carries the pixels it is responsible for having revealed, and the
 * union over all strokes is the whole image. The animation is exact at `u = 1`
 * whatever the centreline did or did not manage to trace.
 */

import { makeStroke } from './geometry.js';
import { orderStrokes, travelStroke } from './order.js';
import { hashSeed, scribbleRegion } from './scribble.js';
import { chunkPolyline } from './paintPasses.js';
import { encodeRectsMulti, orderGroups, pickInkLabels } from './pixels.js';
import { assignOwners, centerlines, maskFromRects, seedPolyline } from './centerline.js';

/** Mask colour. Every stroke in both passes lays coverage, never pigment. */
const MASK = '#ffffff';

/**
 * Where the ink pass gets cut into strokes.
 *
 * Same reason as `paintPasses.js`: a stroke is committed to the raster in one
 * go, so an uncut 4000px outline would sit in the active layer for the whole
 * phase and be redrawn from its first vertex every frame.
 */
const INK_CHUNK = 90;

/**
 * Assemble the ink pass: centrelines, ordered, chunked, each owning its slab.
 *
 * The ordering matters as much as the geometry. `orderStrokes` is what makes
 * this read as drawing rather than plotting -- it groups contours by
 * containment, sequences them roughly in reading order, picks where to break
 * into a closed loop and arcs the pen up and over between them. Feeding the
 * centrelines through it means the ink pass inherits all of that for free.
 *
 * Coverage is assigned *after* ordering and chunking, from each final stroke's
 * own points. That is deliberate: `orderStrokes` is free to reverse a path or
 * rotate a loop to a better seam, and reading the geometry back off the strokes
 * it produced means no bookkeeping has to survive those rewrites.
 */
function inkStrokes(analysis, params) {
  const labels = pickInkLabels(analysis.groups, params);
  if (!labels.length) return { strokes: [], labels };

  const { width: W, height: H, sx, sy } = analysis.mask;
  const byLabel = new Map(analysis.groups.map((g) => [g.label, g]));
  const mask = maskFromRects(labels.map((l) => byLabel.get(l).rects), W, H);

  const { paths, scale } = centerlines(mask, W, H);
  if (!paths.length) return { strokes: [], labels };

  // Skeleton grid -> object space, in one step, so nothing downstream has to
  // remember there were ever three coordinate systems.
  const toObject = (pts) => {
    const out = new Float64Array(pts.length);
    for (let i = 0; i < pts.length; i += 2) {
      out[i] = pts[i] * scale * sx;
      out[i + 1] = pts[i + 1] * scale * sy;
    }
    return out;
  };
  const nib = (w) => Math.max(1, w * scale * ((sx + sy) / 2) * (params.inkWidthGain ?? 1));

  const subpaths = paths.map((p) => {
    const pts = toObject(p.pts);
    const closed = pts.length >= 6
      && pts[0] === pts[pts.length - 2] && pts[1] === pts[pts.length - 1];
    return { pts, closed, width: nib(p.width), color: MASK };
  });

  const ordered = orderStrokes(subpaths, {
    style: params.orderStyle || 'natural',
    travelMinGap: Math.max(4, (params.fillBrushWidth ?? 14) * 0.5),
  });

  // Chunk after ordering, so the travel arcs stay where `orderStrokes` put them.
  const strokes = [];
  for (const st of ordered) {
    if (st.lift) { strokes.push(st); continue; }
    const chunks = chunkPolyline(Array.from(st.pts), INK_CHUNK);
    if (!chunks.length) { strokes.push(st); continue; }
    for (const c of chunks) {
      strokes.push(makeStroke(c, { kind: 'OUTLINE', width: st.width, color: MASK }));
    }
  }

  // Now that the stroke list is final, hand every ink pixel to the stroke whose
  // centreline is nearest it, and give each stroke the rectangles for its own.
  const seeds = new Int32Array(W * H).fill(-1);
  const inv = 1 / scale;
  strokes.forEach((st, i) => {
    if (st.lift) return;
    const grid = new Float64Array(st.pts.length);
    for (let k = 0; k < st.pts.length; k += 2) {
      grid[k] = (st.pts[k] / sx) * inv;
      grid[k + 1] = (st.pts[k + 1] / sy) * inv;
    }
    seedPolyline(seeds, W, H, grid, i, scale);
  });

  const remainder = strokes.length;
  const owner = assignOwners(mask, seeds, W, H, remainder);
  // One pass for every stroke's rectangles, not one pass each: a detailed
  // drawing runs to thousands of strokes and the grid is a couple of million
  // pixels, so the difference is a minute against milliseconds.
  const byStroke = encodeRectsMulti(owner, W, H, remainder + 1);
  for (let i = 0; i < strokes.length; i++) {
    if (strokes[i].lift) continue;
    if (byStroke[i].length) strokes[i].closure = [{ rects: byStroke[i], sx, sy }];
  }
  // Ink the centreline could not reach -- specks that vanished on the coarser
  // skeleton grid. They belong to no stroke in particular, so the pass closes
  // them at its end rather than pretending some stroke drew them.
  const left = byStroke[remainder];
  if (left.length) {
    for (let i = strokes.length - 1; i >= 0; i--) {
      if (strokes[i].lift) continue;
      strokes[i].closure = [...(strokes[i].closure || []), { rects: left, sx, sy }];
      break;
    }
  }
  return { strokes, labels };
}

/**
 * Flatten groups into the shapes the colour pass actually fills.
 *
 * Each piece becomes a unit carrying its group's colour and lightness, so
 * `orderGroups` sequences pieces by exactly the rules it already sequences
 * groups by. The synthetic `label` is a running index rather than the group's,
 * because every comparator there falls back to `label` to make the order total
 * and two pieces of one colour would otherwise tie.
 *
 * Pieces are indexed largest first, which is what that tiebreak then resolves
 * to under the default `darkFirst`: every piece of one colour has the same
 * lightness, so without it the order is whatever the flood fill happened to
 * number them. The bulb icon put its one big yellow body last and filled it in
 * the closing seconds after fifty little rays, which is not how anyone colours
 * anything -- the main shape goes in first and the details follow.
 */
function paintUnits(analysis, inkLabels) {
  const skip = new Set(inkLabels);
  const units = [];
  for (const g of analysis.groups) {
    if (skip.has(g.label)) continue;            // already inked, at full thickness
    const pieces = (g.pieces
      || [{ id: 0, area: g.area, bbox: g.bbox, rings: g.rings, rects: g.rects }])
      .slice()
      .sort((a, b) => (b.area - a.area) || (a.id - b.id));
    for (const p of pieces) {
      units.push({
        label: units.length,
        group: g.label,
        luma: g.luma,
        area: p.area,
        bbox: p.bbox,
        rings: p.rings,
        rects: p.rects,
      });
    }
  }
  return units;
}

/**
 * The colour pass: one connected shape at a time, each closed by its own mask.
 *
 * A shape whose rings were too small to scribble still owns pixels, so its
 * closure is carried forward and hung on the next stroke that does exist --
 * "no scribble" never means "no coverage".
 */
function paintStrokes(analysis, params, units, backstop) {
  const base = params.fillBrushWidth ?? 14;
  const angle = params.sweepAngle ?? -45;
  const ordered = orderGroups(units, params.groupOrder ?? 'largestFirst');

  // Brush scaled by the square root of area, for the reason `paintPasses.js`
  // records: at one fixed width the time a shape takes grows with its area, so
  // a big flat background spends half the clip painting white onto white.
  const mean = units.reduce((s, u) => s + u.area, 0) / Math.max(1, units.length);
  const widthFor = (u) => base * Math.max(1, Math.min(5, Math.sqrt(u.area / Math.max(1, mean))));

  const strokes = [];
  let pending = [];
  let pen = null;

  for (const unit of ordered) {
    const mine = { rects: unit.rects, sx: analysis.mask.sx, sy: analysis.mask.sy };
    if (!unit.rings.length) { pending.push(mine); continue; }
    const width = widthFor(unit);

    const { pts } = scribbleRegion(unit.rings, {
      brushWidth: width,
      angleDeg: angle,
      seed: hashSeed(`${params.seedKey || 'ink'}|${unit.group}|${unit.label}`),
    });
    const chunks = chunkPolyline(pts);
    if (!chunks.length) { pending.push(mine); continue; }

    if (pen) {
      const gap = Math.hypot(chunks[0][0] - pen[0], chunks[0][1] - pen[1]);
      if (gap > width * 2) strokes.push(travelStroke(pen, [chunks[0][0], chunks[0][1]]));
    }
    for (const c of chunks) {
      strokes.push(makeStroke(c, { kind: 'FILL', width, color: MASK, regionId: unit.group }));
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
 * Build both passes for one piece of artwork.
 *
 * @param {ReturnType<import('./pixels.js').analyzeArtwork>} analysis compiled
 *   with `{palette:'flat', pieces:true}`
 * @param {Object} params see `draw.inkPaint`'s paramSchema
 * @returns {{ink:Array, paint:Array, inkLabels:number[]}}
 */
export function buildInkPasses(analysis, params = {}) {
  // The backstop: every group's pixels, hung on the very last stroke, so `u = 1`
  // is the complete picture however either pass behaved.
  const backstop = analysis.groups.map((g) => ({
    rects: g.rects, sx: analysis.mask.sx, sy: analysis.mask.sy,
  }));

  const { strokes: ink, labels } = inkStrokes(analysis, params);
  const units = paintUnits(analysis, ink.length ? labels : []);
  const paint = paintStrokes(analysis, params, units, backstop);

  // Nothing to colour -- artwork that is linework and nothing else. The ink
  // pass then has to carry the backstop, or the last frame is missing whatever
  // the centreline never reached.
  if (!paint.length && ink.length) {
    for (let i = ink.length - 1; i >= 0; i--) {
      if (ink[i].lift) continue;
      ink[i].closure = [...(ink[i].closure || []), ...backstop];
      break;
    }
  }
  return { ink, paint, inkLabels: labels };
}
