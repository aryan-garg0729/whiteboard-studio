/**
 * Polyline geometry: bezier flattening, arc-length tables, and the arc-length
 * lookup that every animation uses to find where the pen is at time t.
 *
 * Everything here is pure and allocation-conscious -- these run at compile
 * time over tens of thousands of vertices, and `locate` runs once per frame
 * per active clip.
 */

/**
 * @typedef {Object} Stroke
 * @property {'OUTLINE'|'FILL'|'TRAVEL'} kind
 * @property {Float64Array} pts   packed [x0,y0,x1,y1,...] in object-local space
 * @property {Float64Array} cum   cum[i] = arc length up to vertex i; cum[0] = 0
 * @property {number} length      total arc length (= cum[n-1])
 * @property {number} width       brush width, object-local units
 * @property {string} color
 * @property {number} regionId    -1 for outline strokes
 * @property {boolean} lift       true = pen up (hand travels, lays no ink)
 */

/** Pen-up travel is discounted so lifts feel quick rather than languid. */
export const TRAVEL_SPEED_FACTOR = 0.25;

/**
 * Number of line segments needed to flatten a cubic bezier within `eps`.
 *
 * Wang's formula -- closed form, no recursion, no per-segment allocation.
 * `eps` must be expressed in the space you actually measure error in: pass
 * object-local units scaled by the maximum device scale the object will reach,
 * or curves go visibly faceted once the camera zooms in.
 */
export function cubicSegments(x0, y0, x1, y1, x2, y2, x3, y3, eps) {
  const ax = x0 - 2 * x1 + x2;
  const ay = y0 - 2 * y1 + y2;
  const bx = x1 - 2 * x2 + x3;
  const by = y1 - 2 * y2 + y3;
  const l = Math.max(Math.hypot(ax, ay), Math.hypot(bx, by));
  if (!(l > 0)) return 1;
  // n = ceil(sqrt(3 * L / (4 * eps))) for a cubic (degree 3 -> n(n-1)/8 = 3/4)
  return Math.max(1, Math.ceil(Math.sqrt((3 * l) / (4 * eps))));
}

/** Append a flattened cubic to `out` (an array of numbers), excluding the start point. */
export function flattenCubic(out, x0, y0, x1, y1, x2, y2, x3, y3, eps) {
  const n = cubicSegments(x0, y0, x1, y1, x2, y2, x3, y3, eps);
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    out.push(a * x0 + b * x1 + c * x2 + d * x3,
             a * y0 + b * y1 + c * y2 + d * y3);
  }
}

/** Append a flattened quadratic by degree-elevating to a cubic. */
export function flattenQuadratic(out, x0, y0, cx, cy, x1, y1, eps) {
  flattenCubic(out,
    x0, y0,
    x0 + (2 / 3) * (cx - x0), y0 + (2 / 3) * (cy - y0),
    x1 + (2 / 3) * (cx - x1), y1 + (2 / 3) * (cy - y1),
    x1, y1, eps);
}

/**
 * Cumulative arc length per vertex. Computed once at compile time; the runtime
 * never recomputes it.
 * @param {Float64Array|number[]} pts packed xy pairs
 * @returns {Float64Array} length n (one entry per vertex)
 */
export function arcLengths(pts) {
  const n = pts.length >> 1;
  const cum = new Float64Array(n);
  let acc = 0;
  for (let i = 1; i < n; i++) {
    acc += Math.hypot(pts[2 * i] - pts[2 * i - 2], pts[2 * i + 1] - pts[2 * i - 1]);
    cum[i] = acc;
  }
  return cum;
}

/** Build a Stroke from packed points, filling in the derived arc-length fields. */
export function makeStroke(pts, opts = {}) {
  const packed = pts instanceof Float64Array ? pts : Float64Array.from(pts);
  const cum = arcLengths(packed);
  return {
    kind: opts.kind || 'OUTLINE',
    pts: packed,
    cum,
    length: cum.length ? cum[cum.length - 1] : 0,
    width: opts.width ?? 3,
    color: opts.color ?? '#111111',
    regionId: opts.regionId ?? -1,
    lift: opts.lift ?? false,
  };
}

/**
 * Largest index i with a[i] <= v, over a sorted array. Returns 0 when v is
 * below a[0]; returns a.length-1 when v is at or past the end.
 */
export function floorIndex(a, v, len = a.length) {
  let lo = 0;
  let hi = len - 1;
  if (v <= a[0]) return 0;
  if (v >= a[hi]) return hi;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (a[mid] <= v) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/**
 * A phase is a contiguous run of strokes drawn as one unit (the outline pass,
 * or the fill pass). `cumStroke[k]` is the phase-local arc length at which
 * stroke `i0 + k` begins, with travel strokes discounted.
 *
 * @param {Stroke[]} strokes
 * @param {number} i0 inclusive
 * @param {number} i1 exclusive
 */
export function makePhase(strokes, i0, i1, kind) {
  const cumStroke = new Float64Array(i1 - i0 + 1);
  let acc = 0;
  for (let k = 0; k < i1 - i0; k++) {
    cumStroke[k] = acc;
    const st = strokes[i0 + k];
    acc += st.lift ? st.length * TRAVEL_SPEED_FACTOR : st.length;
  }
  cumStroke[i1 - i0] = acc;
  return { kind, i0, i1, cumStroke, length: acc };
}

/**
 * Where the pen is at phase-local arc length `s`.
 *
 * Mapping progress through *arc length* rather than stroke or vertex index is
 * what gives constant pen speed; index-based interpolation makes the pen race
 * through short strokes and crawl through long ones.
 *
 * @returns {{strokeIndex:number, vertex:number, frac:number, x:number, y:number}}
 */
export function locate(strokes, phase, s) {
  const n = phase.i1 - phase.i0;
  const sc = Math.min(Math.max(s, 0), phase.length);
  const k = Math.min(floorIndex(phase.cumStroke, sc, n + 1), n - 1);
  const st = strokes[phase.i0 + k];

  let local = sc - phase.cumStroke[k];
  if (st.lift) local /= TRAVEL_SPEED_FACTOR;
  local = Math.min(local, st.length);

  const last = (st.pts.length >> 1) - 1;
  if (last <= 0) {
    return { strokeIndex: phase.i0 + k, vertex: 0, frac: 0, x: st.pts[0], y: st.pts[1] };
  }
  const j = Math.min(floorIndex(st.cum, local), last - 1);
  const seg = st.cum[j + 1] - st.cum[j];
  const f = seg > 1e-12 ? (local - st.cum[j]) / seg : 0;
  return {
    strokeIndex: phase.i0 + k,
    vertex: j,
    frac: f,
    x: st.pts[2 * j] + (st.pts[2 * j + 2] - st.pts[2 * j]) * f,
    y: st.pts[2 * j + 1] + (st.pts[2 * j + 3] - st.pts[2 * j + 1]) * f,
  };
}

/**
 * Stroke tangent at phase-local arc length `s`, smoothed over a fixed
 * *arc-length* window.
 *
 * The window must be over arc length, never over frames: any IIR filter
 * (`a += (target - a) * k`) carries state between frames, which breaks seeking
 * and makes export non-reproducible. Sampling at s +/- delta is a pure
 * function of s, hence of t.
 */
export function tangentAt(strokes, phase, s, delta = 18) {
  const a = locate(strokes, phase, Math.max(0, s - delta));
  const b = locate(strokes, phase, Math.min(phase.length, s + delta));
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return 0;
  return Math.atan2(dy, dx);
}
