/**
 * Boustrophedon ("ox-turning") infill: converts a filled region into the
 * back-and-forth scribble path the pen follows while colouring it in.
 *
 * Used by both the fill animation and the erase animation -- erase is the same
 * sweep at a different angle with a wider brush.
 */

import { makeStroke } from './geometry.js';

/**
 * @typedef {Object} Region
 * @property {Float64Array[]} rings  outer ring first, then holes; each packed [x,y,...]
 */

/** Deterministic PRNG. All scribble jitter is baked at compile time with a
 *  seeded generator so `renderFrame(t)` never calls Math.random. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Cheap string hash, for deriving a stable seed from clip + stroke identity. */
export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Interior spans of `rings` along the horizontal line y, as [xStart, xEnd] pairs.
 *
 * The edge test is deliberately half-open in y: `(y0 <= y) === (y1 <= y)`.
 * That single condition rejects horizontal edges and counts a vertex lying
 * exactly on the scan line exactly once, so the crossing count is always even
 * and even-odd pairing is well defined. The intuitive `y0 < y && y < y1` form
 * produces odd counts on vertex hits, pairs a crossing against nothing, and
 * the visible symptom at 1080p is a stray horizontal streak of colour across
 * the frame.
 *
 * Even-odd also means hole rings need no special handling and their winding
 * direction does not matter.
 */
export function spansAt(rings, y, out = []) {
  out.length = 0;
  const xs = [];
  for (const r of rings) {
    const n = r.length >> 1;
    if (n < 2) continue;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const y0 = r[2 * i + 1];
      const y1 = r[2 * j + 1];
      if ((y0 <= y) === (y1 <= y)) continue;
      const x0 = r[2 * i];
      const x1 = r[2 * j];
      xs.push(x0 + ((y - y0) * (x1 - x0)) / (y1 - y0));
    }
  }
  xs.sort((a, b) => a - b);
  for (let i = 0; i + 1 < xs.length; i += 2) {
    if (xs[i + 1] - xs[i] > 1e-9) out.push([xs[i], xs[i + 1]]);
  }
  return out;
}

function rotateRings(rings, cos, sin) {
  return rings.map((r) => {
    const o = new Float64Array(r.length);
    for (let i = 0; i < r.length; i += 2) {
      o[i] = r[i] * cos - r[i + 1] * sin;
      o[i + 1] = r[i] * sin + r[i + 1] * cos;
    }
    return o;
  });
}

function ringsBounds(rings) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rings) {
    for (let i = 0; i < r.length; i += 2) {
      if (r[i] < x0) x0 = r[i];
      if (r[i] > x1) x1 = r[i];
      if (r[i + 1] < y0) y0 = r[i + 1];
      if (r[i + 1] > y1) y1 = r[i + 1];
    }
  }
  return [x0, y0, x1, y1];
}

/**
 * Group spans into connected cells.
 *
 * A U-shaped region yields two disjoint spans on the same scan line; a naive
 * serpentine would teleport between the arms. Spans on adjacent scan lines are
 * linked when their x-intervals overlap by more than `overlapMin`, and each
 * connected component becomes a cell that gets swept in full before the next
 * one starts -- which is what produces the "fill one arm of the U, come back,
 * fill the other" motion a person actually makes.
 *
 * The overlap threshold (rather than any-touch) stops a single-pixel corner
 * contact from fusing two arms into one cell.
 *
 * @param {Array<Array<[number,number]>>} lines spans per scan line
 * @returns {Array<Array<{line:number, span:[number,number]}>>}
 */
export function decomposeCells(lines, overlapMin) {
  const id = lines.map((l) => new Array(l.length).fill(-1));
  const parent = [];
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };

  for (let k = 0; k < lines.length; k++) {
    for (let i = 0; i < lines[k].length; i++) {
      id[k][i] = parent.length;
      parent.push(parent.length);
    }
  }
  for (let k = 1; k < lines.length; k++) {
    for (let i = 0; i < lines[k].length; i++) {
      const [a0, a1] = lines[k][i];
      for (let j = 0; j < lines[k - 1].length; j++) {
        const [b0, b1] = lines[k - 1][j];
        if (Math.min(a1, b1) - Math.max(a0, b0) > overlapMin) union(id[k - 1][j], id[k][i]);
      }
    }
  }

  const byRoot = new Map();
  for (let k = 0; k < lines.length; k++) {
    for (let i = 0; i < lines[k].length; i++) {
      const root = find(id[k][i]);
      if (!byRoot.has(root)) byRoot.set(root, []);
      byRoot.get(root).push({ line: k, span: lines[k][i] });
    }
  }
  const cells = [...byRoot.values()];
  // top-to-bottom, then left-to-right -- reading order, so the fill progresses
  // the same way the outline did.
  cells.sort((a, b) => (a[0].line - b[0].line) || (a[0].span[0] - b[0].span[0]));
  return cells;
}

/**
 * Generate the scribble polyline for one region.
 *
 * @param {Float64Array[]} rings outer ring first, then holes, in object space
 * @param {Object} opts
 * @param {number} opts.brushWidth
 * @param {number} [opts.angleDeg=-45]  sweep direction; -45 reads as colouring,
 *                                      0 reads as erasing
 * @param {number} [opts.overlap=0.35]  fraction of brush width overlapped per pass.
 *                                      Below ~0.25 you get moire banding at 1080p
 *                                      over high-contrast art; above ~0.5 you pay
 *                                      extra passes for no visible gain.
 * @param {number} [opts.seed=1]
 * @param {number} [opts.wobble=0.15]   perpendicular wander, as a fraction of spacing
 * @param {number} [opts.overshoot=0.35] turn-around overrun, as a fraction of spacing
 * @returns {{pts:number[], spacing:number, cells:number}}
 */
export function scribbleRegion(rings, opts = {}) {
  const brushWidth = opts.brushWidth ?? 8;
  const angle = ((opts.angleDeg ?? -45) * Math.PI) / 180;
  const overlap = opts.overlap ?? 0.35;
  const wobble = opts.wobble ?? 0.15;
  const overshoot = opts.overshoot ?? 0.35;
  const rand = mulberry32(opts.seed ?? 1);

  const d = Math.max(1e-6, brushWidth * (1 - overlap));

  // Work in a frame where scan lines are horizontal.
  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);
  const rot = rotateRings(rings, cos, sin);
  const [, minY, , maxY] = ringsBounds(rot);

  // Half-step offset so an axis-aligned rectangle never samples exactly on its
  // own top/bottom edge.
  const lines = [];
  const ys = [];
  for (let y = minY + d * 0.5; y < maxY; y += d) {
    const s = spansAt(rot, y);
    if (s.length) { lines.push(s); ys.push(y); }
  }
  if (!lines.length) return { pts: [], spacing: d, cells: 0 };

  const cells = decomposeCells(lines, d * 0.25);

  const out = [];
  for (const cell of cells) {
    // group this cell's spans by scan line, preserving global line order
    const byLine = new Map();
    for (const item of cell) {
      if (!byLine.has(item.line)) byLine.set(item.line, []);
      byLine.get(item.line).push(item.span);
    }
    const lineKeys = [...byLine.keys()].sort((a, b) => a - b);

    let dir = 1; // +1 sweeps left-to-right, -1 right-to-left
    for (const lk of lineKeys) {
      const y = ys[lk];
      const spans = byLine.get(lk).slice().sort((a, b) => (dir > 0 ? a[0] - b[0] : b[0] - a[0]));
      for (const span of spans) {
        let xa = dir > 0 ? span[0] : span[1];
        let xb = dir > 0 ? span[1] : span[0];

        // Ragged ends: a person colouring does not stop exactly on the
        // boundary every pass. Overshoot is safe because the mask is clipped
        // to the region at render time.
        xa -= dir * (rand() - 0.5) * 0.24 * d;
        xb += dir * (overshoot * d + (rand() - 0.5) * 0.24 * d);

        // Low-frequency perpendicular wander, so passes are not perfectly
        // straight machine hatching.
        const amp = wobble * d;
        const freq = 0.8 + rand() * 0.8;
        const phase = rand() * Math.PI * 2;
        const steps = 6;
        for (let i = 0; i <= steps; i++) {
          const u = i / steps;
          const x = xa + (xb - xa) * u;
          const yy = y + amp * Math.sin(2 * Math.PI * freq * u + phase);
          out.push(x * cos + yy * sin, -x * sin + yy * cos); // rotate back
        }
      }
      dir = -dir;
    }
  }

  return { pts: out, spacing: d, cells: cells.length };
}

/** Convenience: scribble a region straight into a FILL Stroke. */
export function scribbleStroke(rings, opts = {}) {
  const { pts } = scribbleRegion(rings, opts);
  return makeStroke(pts, {
    kind: opts.kind ?? 'FILL',
    width: opts.brushWidth ?? 8,
    color: opts.color ?? '#000000',
    regionId: opts.regionId ?? -1,
  });
}
