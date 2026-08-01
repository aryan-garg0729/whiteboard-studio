/**
 * Stroke sequencing: decide the order in which subpaths get drawn, and insert
 * the pen-up travel moves between them.
 *
 * This is where "looks like a person drew it" and "looks like a script emitted
 * it" diverge. None of it is objectively correct -- the weights below are
 * tuned by eye and exposed as presets rather than hardcoded.
 */

import { makeStroke } from './geometry.js';

/** Ordering presets. `natural` blends reading order with a size bias. */
export const ORDER_STYLES = {
  natural: { wy: 1.0, wx: 0.35, wArea: 0.45, lambdaUp: 0.6 },
  topDown: { wy: 1.0, wx: 0.15, wArea: 0.0, lambdaUp: 0.9 },
  outsideIn: { wy: 0.3, wx: 0.3, wArea: 1.2, lambdaUp: 0.3 },
};

/** Axis-aligned bounds of a packed polyline. */
export function bounds(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    if (pts[i] < x0) x0 = pts[i];
    if (pts[i] > x1) x1 = pts[i];
    if (pts[i + 1] < y0) y0 = pts[i + 1];
    if (pts[i + 1] > y1) y1 = pts[i + 1];
  }
  return [x0, y0, x1, y1];
}

const boxArea = (b) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
const contains = (a, b) => a[0] <= b[0] && a[1] <= b[1] && a[2] >= b[2] && a[3] >= b[3];

/**
 * Group subpaths into visual units: an outer contour plus any contours nested
 * inside it (holes, interior detail). A unit is always drawn consecutively,
 * which stops the pen jumping to a distant shape and back mid-figure.
 *
 * @param {Array<{pts:Float64Array}>} subpaths
 * @returns {Array<{members:number[], bbox:number[]}>}
 */
export function groupUnits(subpaths) {
  const boxes = subpaths.map((s) => bounds(s.pts));
  const order = subpaths.map((_, i) => i).sort((a, b) => boxArea(boxes[b]) - boxArea(boxes[a]));

  const parent = new Array(subpaths.length).fill(-1);
  for (let i = 0; i < order.length; i++) {
    const child = order[i];
    // smallest enclosing box among the strictly larger contours
    for (let j = i - 1; j >= 0; j--) {
      const cand = order[j];
      if (contains(boxes[cand], boxes[child])) { parent[child] = cand; break; }
    }
  }

  const roots = new Map();
  const rootOf = (i) => { while (parent[i] !== -1) i = parent[i]; return i; };
  for (let i = 0; i < subpaths.length; i++) {
    const r = rootOf(i);
    if (!roots.has(r)) roots.set(r, []);
    roots.get(r).push(i);
  }

  return [...roots.entries()].map(([r, members]) => {
    let bbox = boxes[r].slice();
    for (const m of members) {
      bbox = [Math.min(bbox[0], boxes[m][0]), Math.min(bbox[1], boxes[m][1]),
              Math.max(bbox[2], boxes[m][2]), Math.max(bbox[3], boxes[m][3])];
    }
    return { members, bbox };
  });
}

/**
 * Reading-order score for a unit. Lower sorts earlier.
 *
 * Pure largest-first looks arbitrary; pure top-to-bottom scatters a logo into
 * confetti. Blending the two is what reads as intentional.
 */
function unitScore(bbox, docBox, totalArea, w) {
  const h = Math.max(1e-6, docBox[3] - docBox[1]);
  const wd = Math.max(1e-6, docBox[2] - docBox[0]);
  return w.wy * ((bbox[1] - docBox[1]) / h)
       + w.wx * ((bbox[0] - docBox[0]) / wd)
       - w.wArea * (boxArea(bbox) / Math.max(1e-6, totalArea));
}

const endPoint = (pts, at) =>
  at === 'start' ? [pts[0], pts[1]] : [pts[pts.length - 2], pts[pts.length - 1]];

function reversed(pts) {
  const n = pts.length;
  const o = new Float64Array(n);
  for (let i = 0; i < n; i += 2) {
    o[n - 2 - i] = pts[i];
    o[n - 1 - i] = pts[i + 1];
  }
  return o;
}

/** Rotate a closed ring so it begins at vertex `k`. */
function rotateRing(pts, k) {
  const n = pts.length >> 1;
  const o = new Float64Array(pts.length + 2);
  for (let i = 0; i <= n; i++) {
    const j = (k + i) % n;
    o[2 * i] = pts[2 * j];
    o[2 * i + 1] = pts[2 * j + 1];
  }
  return o; // closed: last vertex repeats the first
}

/**
 * Cost of moving the pen from `from` to a candidate start point. The
 * anti-gravity term penalises reaching back *up* the page, which humans
 * rarely do.
 */
function moveCost(from, to, lambdaUp) {
  const d = Math.hypot(to[0] - from[0], to[1] - from[1]);
  return d + lambdaUp * Math.max(0, from[1] - to[1]);
}

/**
 * Order the subpaths within one unit and orient each of them.
 *
 * For closed rings the *seam* is also chosen -- the ring is rotated to begin
 * at whichever vertex is cheapest to reach. This single detail removes most of
 * the teleport-y feel, because a closed contour no longer insists on starting
 * at whatever vertex the source file happened to list first.
 */
function chainUnit(subpaths, members, from, w) {
  const remaining = new Set(members);
  const out = [];
  let pen = from;

  while (remaining.size) {
    let best = null;
    for (const idx of remaining) {
      const sp = subpaths[idx];
      if (sp.closed) {
        const n = sp.pts.length >> 1;
        for (let k = 0; k < n; k++) {
          const c = moveCost(pen, [sp.pts[2 * k], sp.pts[2 * k + 1]], w.lambdaUp);
          if (!best || c < best.cost) best = { cost: c, idx, seam: k, reverse: false };
        }
      } else {
        const cs = moveCost(pen, endPoint(sp.pts, 'start'), w.lambdaUp);
        if (!best || cs < best.cost) best = { cost: cs, idx, seam: -1, reverse: false };
        const ce = moveCost(pen, endPoint(sp.pts, 'end'), w.lambdaUp);
        if (ce < best.cost) best = { cost: ce, idx, seam: -1, reverse: true };
      }
    }

    const sp = subpaths[best.idx];
    let pts = sp.pts;
    if (sp.closed) pts = rotateRing(pts, best.seam);
    else if (best.reverse) pts = reversed(pts);

    out.push({ ...sp, pts });
    pen = endPoint(pts, 'end');
    remaining.delete(best.idx);
  }
  return { ordered: out, pen };
}

/**
 * A pen-up move from a to b, bulged perpendicular to the direct line so the
 * hand arcs up and over the artwork instead of sliding through it.
 */
function travelStroke(a, b, bulge = 0.18) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const gap = Math.hypot(dx, dy);
  const mx = (a[0] + b[0]) / 2 - (dy / gap) * gap * bulge;
  const my = (a[1] + b[1]) / 2 + (dx / gap) * gap * bulge;
  const pts = [];
  const steps = 8;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    pts.push(u * u * a[0] + 2 * u * t * mx + t * t * b[0],
             u * u * a[1] + 2 * u * t * my + t * t * b[1]);
  }
  return makeStroke(pts, { kind: 'TRAVEL', lift: true, width: 0 });
}

/**
 * Sequence subpaths into a drawable stroke list.
 *
 * @param {Array<{pts:Float64Array, closed:boolean, color?:string, width?:number}>} subpaths
 * @param {Object} [opts]
 * @param {keyof ORDER_STYLES|Object} [opts.style='natural']
 * @param {number} [opts.travelMinGap] gaps below this are not worth a pen lift
 * @returns {import('./geometry.js').Stroke[]}
 */
export function orderStrokes(subpaths, opts = {}) {
  if (!subpaths.length) return [];
  const w = typeof opts.style === 'object' ? opts.style
    : ORDER_STYLES[opts.style || 'natural'] || ORDER_STYLES.natural;

  const units = groupUnits(subpaths);
  let docBox = units[0].bbox.slice();
  let totalArea = 0;
  for (const u of units) {
    docBox = [Math.min(docBox[0], u.bbox[0]), Math.min(docBox[1], u.bbox[1]),
              Math.max(docBox[2], u.bbox[2]), Math.max(docBox[3], u.bbox[3])];
    totalArea += boxArea(u.bbox);
  }
  units.sort((a, b) => unitScore(a.bbox, docBox, totalArea, w)
                     - unitScore(b.bbox, docBox, totalArea, w));

  const travelMinGap = opts.travelMinGap ?? 2 * (subpaths[0].width ?? 3);
  const strokes = [];
  let pen = [docBox[0], docBox[1]]; // start from the top-left of the artwork

  for (const unit of units) {
    const { ordered, pen: after } = chainUnit(subpaths, unit.members, pen, w);
    for (const sp of ordered) {
      const start = endPoint(sp.pts, 'start');
      if (strokes.length && Math.hypot(start[0] - pen[0], start[1] - pen[1]) > travelMinGap) {
        strokes.push(travelStroke(pen, start));
      }
      strokes.push(makeStroke(sp.pts, {
        kind: 'OUTLINE',
        width: sp.width ?? 3,
        color: sp.color ?? '#111111',
      }));
      pen = endPoint(sp.pts, 'end');
    }
    pen = after;
  }
  return strokes;
}
