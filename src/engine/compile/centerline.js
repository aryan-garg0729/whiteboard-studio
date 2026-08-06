/**
 * A filled shape -> the strokes a hand would draw it with, and what each one
 * reveals.
 *
 * This exists for one shape of artwork: a whiteboard illustration, where the
 * black linework is a *drawn line* rather than a filled area that happens to be
 * thin. Colouring such a line with a zig-zag is wrong twice -- it looks like
 * hatching rather than drawing, and a 3px line has no room for a zig-zag
 * anyway. A person draws a line by running the pen down the middle of it.
 *
 * The whole module turns on separating two things that are easy to conflate:
 *
 *   - **the path** -- where the hand goes. A one-pixel centreline, thinned from
 *     the shape, chained into polylines, pruned and simplified. Purely
 *     cosmetic: nothing about the finished picture depends on it.
 *   - **the reveal** -- what appears. The *whole* shape, at its real thickness,
 *     partitioned among the strokes so that each one uncovers the slab of line
 *     it runs down the middle of.
 *
 * Deriving the second from the first is the obvious move and it is wrong. A nib
 * as wide as the line rounds every corner, spills at every junction and blooms
 * at every end, so the outline comes out fatter and softer than the source --
 * and the promise this pipeline is built on is that the last frame *is* the
 * source. So coverage is assigned per pixel instead: every pixel of the shape
 * goes to whichever stroke's centreline is nearest. That partitions the shape
 * exactly, no pixel counted twice and none left out, however the paths were
 * pruned or simplified.
 *
 * Deterministic throughout: raster-order scans, integer distances, no
 * randomness, and no iteration over anything whose order is not fixed.
 */

/** Longest edge of the grid the centreline is thinned on. */
export const SKELETON_MAX_DIM = 640;

/** Neighbour offsets, in the order Zhang-Suen's P2..P9 wants them. */
const DX = [-1, 0, 1, -1, 1, -1, 0, 1];
const DY = [-1, -1, -1, 0, 0, 1, 1, 1];

/**
 * A spur is dropped when it is shorter than this times the local line
 * half-thickness.
 *
 * Thinning a rectangle-ended stroke always throws off short branches towards
 * the corners -- they are artefacts of the algorithm, not features of the
 * drawing, and their length scales with how thick the line is. Judging them
 * against the local thickness rather than an absolute length is what makes one
 * constant work for a 3px outline and a 40px one.
 */
const SPUR_FACTOR = 2.2;

/** Douglas-Peucker tolerance, in skeleton-grid pixels. */
const SIMPLIFY_EPS = 0.75;

// ── masks ─────────────────────────────────────────────────────────────

/**
 * Rebuild a pixel mask from the coverage rectangles it was encoded to.
 *
 * `analyzeArtwork` hands back `rects` rather than the label grid, and this is
 * the exact inverse of `encodeRects` -- so the ink pass can work from the same
 * published data as everything else instead of needing a private channel back
 * into the analysis.
 *
 * Takes a *list* of rectangle sets and unions them, because linework is
 * regularly more than one colour group and it has to be thinned as the single
 * connected shape it visually is. Skeletonising two shades of black separately
 * would put two centrelines down the middle of one line.
 *
 * @param {Int32Array[]} rectSets
 */
export function maskFromRects(rectSets, w, h) {
  const mask = new Uint8Array(w * h);
  for (const rects of rectSets) {
    for (let i = 0; i < rects.length; i += 4) {
      for (let y = rects[i + 1]; y < rects[i + 3]; y++) {
        mask.fill(1, y * w + rects[i], y * w + rects[i + 2]);
      }
    }
  }
  return mask;
}

/**
 * Shrink a mask, keeping a cell set if *any* source pixel in it is set.
 *
 * OR and not a majority vote, because the thing being shrunk is linework: a
 * one-pixel line under a majority rule disappears, and a shape with no pixels
 * has no centreline and is never drawn. Erring towards thicker only ever costs
 * a slightly fatter skeleton, which the reveal does not depend on anyway.
 */
export function shrinkMask(mask, w, h, outW, outH) {
  if (outW === w && outH === h) return mask;
  const out = new Uint8Array(outW * outH);
  for (let y = 0; y < outH; y++) {
    const y0 = Math.floor((y * h) / outH);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * h) / outH));
    for (let x = 0; x < outW; x++) {
      const x0 = Math.floor((x * w) / outW);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * w) / outW));
      let hit = 0;
      for (let sy = y0; sy < y1 && !hit; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          if (mask[sy * w + sx]) { hit = 1; break; }
        }
      }
      out[y * outW + x] = hit;
    }
  }
  return out;
}

// ── thinning ──────────────────────────────────────────────────────────

/**
 * Zhang-Suen thinning: erode to a one-pixel skeleton that keeps connectivity.
 *
 * Two subiterations per pass, each removing boundary pixels from opposite sides
 * so the line does not drift off its own middle. A pixel goes only when it has
 * between two and six neighbours (not an endpoint, not interior), exactly one
 * 0->1 transition around it (removing it cannot disconnect anything), and the
 * subiteration's corner test passes.
 *
 * Runs to a fixed point, so the iteration count is a property of the picture
 * and not a tuning knob -- a line of thickness `t` needs about `t/2` passes.
 */
export function thin(src, w, h) {
  const mask = Uint8Array.from(src);
  const doomed = [];
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : mask[y * w + x]);

  for (;;) {
    let changed = false;
    for (let step = 0; step < 2; step++) {
      doomed.length = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (!mask[y * w + x]) continue;
          // P2..P9 clockwise from north, which is the order DX/DY encode.
          const p = [
            at(x, y - 1), at(x + 1, y - 1), at(x + 1, y), at(x + 1, y + 1),
            at(x, y + 1), at(x - 1, y + 1), at(x - 1, y), at(x - 1, y - 1),
          ];
          let b = 0;
          let a = 0;
          for (let i = 0; i < 8; i++) {
            b += p[i];
            if (!p[i] && p[(i + 1) % 8]) a++;
          }
          if (b < 2 || b > 6 || a !== 1) continue;
          const ok = step === 0
            ? (p[0] * p[2] * p[4]) === 0 && (p[2] * p[4] * p[6]) === 0
            : (p[0] * p[2] * p[6]) === 0 && (p[0] * p[4] * p[6]) === 0;
          if (ok) doomed.push(y * w + x);
        }
      }
      for (const i of doomed) mask[i] = 0;
      if (doomed.length) changed = true;
    }
    if (!changed) break;
  }
  return mask;
}

/**
 * Chamfer distance to the nearest pixel outside the mask.
 *
 * Two sweeps with 3-4 integer weights, which is a good enough approximation of
 * Euclidean distance for what it is used for: sizing the nib the hand appears
 * to hold, and scaling the spur test. Both are cosmetic, so exactness would buy
 * nothing. Values are in thirds of a pixel.
 */
export function distanceTransform(mask, w, h) {
  const D = new Int32Array(w * h);
  const BIG = 1 << 28;
  for (let i = 0; i < D.length; i++) D[i] = mask[i] ? BIG : 0;

  const near = (v, d) => (v + d);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!D[i]) continue;
      let m = D[i];
      if (y > 0) {
        if (x > 0) m = Math.min(m, near(D[i - w - 1], 4));
        m = Math.min(m, near(D[i - w], 3));
        if (x < w - 1) m = Math.min(m, near(D[i - w + 1], 4));
      }
      if (x > 0) m = Math.min(m, near(D[i - 1], 3));
      D[i] = m;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!D[i]) continue;
      let m = D[i];
      if (y < h - 1) {
        if (x < w - 1) m = Math.min(m, near(D[i + w + 1], 4));
        m = Math.min(m, near(D[i + w], 3));
        if (x > 0) m = Math.min(m, near(D[i + w - 1], 4));
      }
      if (x < w - 1) m = Math.min(m, near(D[i + 1], 3));
      D[i] = m;
    }
  }
  return D;
}

// ── chaining ──────────────────────────────────────────────────────────

/**
 * Chain skeleton pixels into polylines, cut at endpoints and junctions.
 *
 * Every edge is walked exactly once, tracked as a (pixel, direction) pair
 * marked from both ends, so a junction can be entered as many times as it has
 * branches without any branch being drawn twice. Nodes -- endpoints and
 * junctions -- are taken in raster order, so the polyline list is the same on
 * every run. Whatever is left once every node has been exhausted is a closed
 * loop with no node on it at all (a circle, an `O`), which is picked up in a
 * second pass.
 *
 * @returns {Array<number[]>} polylines, packed [x,y,...] in grid coordinates
 */
export function chainSkeleton(skel, w, h) {
  const deg = new Int8Array(w * h);
  /**
   * Neighbours, with redundant diagonals suppressed.
   *
   * A diagonal step is redundant when the same two pixels are already joined by
   * two orthogonal ones. Without this every right-angle corner is a triangle:
   * the corner pixel and its two arms are mutually adjacent, so all three come
   * out as degree-3 junctions with a two-pixel cycle between them, and a plain
   * rectangle chains into a dozen stubs instead of one loop. Suppressing the
   * shortcut leaves the corner a simple path, which is what it looks like.
   */
  const neighbours = (i) => {
    const x = i % w;
    const y = (i - x) / w;
    const out = [];
    for (let d = 0; d < 8; d++) {
      const nx = x + DX[d];
      const ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (!skel[ny * w + nx]) continue;
      if (DX[d] && DY[d]
        && (skel[y * w + nx] || skel[ny * w + x])) continue;
      out.push(d);
    }
    return out;
  };
  for (let i = 0; i < skel.length; i++) if (skel[i]) deg[i] = neighbours(i).length;

  const used = new Set();
  // Opposite of direction d is 7-d: DX/DY are arranged antisymmetrically.
  const mark = (i, d) => {
    used.add(i * 8 + d);
    used.add((i + DY[d] * w + DX[d]) * 8 + (7 - d));
  };

  const paths = [];
  const walk = (start, d0) => {
    const pts = [start % w, (start - (start % w)) / w];
    let cur = start;
    let d = d0;
    for (;;) {
      mark(cur, d);
      cur = cur + DY[d] * w + DX[d];
      pts.push(cur % w, (cur - (cur % w)) / w);
      if (deg[cur] !== 2) break;                 // reached a node: stop
      const next = neighbours(cur).find((nd) => !used.has(cur * 8 + nd));
      if (next === undefined) break;             // closed back on itself
      d = next;
    }
    if (pts.length >= 4) paths.push(pts);
  };

  for (let i = 0; i < skel.length; i++) {
    if (!skel[i] || deg[i] === 2) continue;
    for (const d of neighbours(i)) {
      if (!used.has(i * 8 + d)) walk(i, d);
    }
  }
  // Loops with no endpoint and no junction anywhere on them.
  for (let i = 0; i < skel.length; i++) {
    if (!skel[i] || deg[i] !== 2) continue;
    const d = neighbours(i).find((nd) => !used.has(i * 8 + nd));
    if (d !== undefined) walk(i, d);
  }
  return paths;
}

/**
 * Drop the short branches thinning leaves behind at corners and line ends.
 *
 * Only branches with a free end are eligible -- a segment joining two junctions
 * is part of the drawing however short it is, while a stub hanging off one is
 * an artefact of the erosion. Length is judged against the local half-thickness
 * from the distance transform, because the artefact scales with the line.
 *
 * Iterated to a fixed point, since removing one spur can leave its junction
 * with degree two and expose another. Coverage is untouched by any of this:
 * the pixels under a pruned spur are still owned by whichever stroke ends up
 * nearest.
 */
export function pruneSpurs(paths, dist, w, h) {
  let live = paths.slice();
  for (;;) {
    const endpoints = new Map();       // packed pixel -> how many paths end there
    const bump = (p) => endpoints.set(p, (endpoints.get(p) || 0) + 1);
    for (const pts of live) {
      bump(pts[1] * w + pts[0]);
      bump(pts[pts.length - 1] * w + pts[pts.length - 2]);
    }

    const keep = live.filter((pts) => {
      const head = pts[1] * w + pts[0];
      const tail = pts[pts.length - 1] * w + pts[pts.length - 2];
      // A free end is one no other path also ends at.
      const freeHead = endpoints.get(head) === 1;
      const freeTail = endpoints.get(tail) === 1;
      if (!freeHead && !freeTail) return true;
      if (freeHead && freeTail) return true;      // an island, not a spur
      let len = 0;
      for (let i = 2; i < pts.length; i += 2) {
        len += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
      }
      const anchor = freeHead ? tail : head;
      return len >= (dist[anchor] / 3) * SPUR_FACTOR;
    });

    if (keep.length === live.length) return live;
    live = keep;
    if (!live.length) return live;
  }
}

/**
 * Rejoin branches that meet end to end, so the pen draws lines and not pieces.
 *
 * `chainSkeleton` has to cut at every junction -- it cannot know which way a
 * line continues -- and `pruneSpurs` then deletes branches, routinely leaving a
 * junction with only two survivors. Nothing there is a junction any more, but
 * the cut remains, and the artefact is severe: the bundled scribble icon chains
 * into 1192 fragments averaging seven pixels, which the pen would stab at one
 * by one instead of drawing the scribble as the single gesture it is.
 *
 * Two rounds, both greedy and both order-independent by construction:
 *
 *   1. **Degree two.** Exactly two ends meet and they belong to different
 *      paths: not a junction, just a cut. Always rejoin.
 *   2. **The straightest way through.** At a real crossing, take the pair whose
 *      directions most nearly continue each other, if they are within
 *      `MAX_JOIN_TURN`. This is what a person does at a crossing -- carry on
 *      through it -- and it is why a figure of eight comes out as one stroke
 *      rather than four.
 *
 * Endpoints are keyed on exact integer grid coordinates, so "meet" needs no
 * tolerance. Candidate pairs are considered in index order and each end is
 * consumed once, so the result does not depend on which merge happened first.
 */
export function stitchPaths(paths) {
  const key = (p, end) => (end ? `${p[p.length - 2]},${p[p.length - 1]}` : `${p[0]},${p[1]}`);
  /** Direction arriving at an end, normalised. */
  const inbound = (p, end) => {
    const n = p.length;
    const [ax, ay, bx, by] = end
      ? [p[n - 2], p[n - 1], p[n - 4], p[n - 3]]
      : [p[0], p[1], p[2], p[3]];
    const dx = ax - bx; const dy = ay - by;
    const len = Math.hypot(dx, dy) || 1;
    return [dx / len, dy / len];
  };
  const joined = (a, aEnd, b, bEnd) => {
    // Orient so a runs into the shared point and b runs away from it.
    const head = aEnd ? a : reversed(a);
    const tail = bEnd ? reversed(b) : b;
    return head.concat(tail.slice(2));
  };

  let live = paths.map((p) => p.slice());
  for (let round = 0; round < 2; round++) {
    for (;;) {
      const ends = new Map();
      live.forEach((p, i) => {
        for (const end of [0, 1]) {
          const k = key(p, end);
          if (!ends.has(k)) ends.set(k, []);
          ends.get(k).push({ i, end });
        }
      });

      const dead = new Set();
      const merged = [];
      // Sorted so the sweep never depends on Map insertion order.
      for (const k of [...ends.keys()].sort()) {
        const at = ends.get(k).filter((e) => !dead.has(e.i));
        if (at.length < 2) continue;
        let pick = null;
        if (round === 0) {
          // A cut, not a crossing: exactly two ends and two different paths.
          if (at.length === 2 && at[0].i !== at[1].i) pick = [at[0], at[1], 0];
        } else {
          let best = -MAX_JOIN_TURN;
          for (let x = 0; x < at.length; x++) {
            for (let y = x + 1; y < at.length; y++) {
              if (at[x].i === at[y].i) continue;
              const u = inbound(live[at[x].i], at[x].end);
              const v = inbound(live[at[y].i], at[y].end);
              // Both point into the shared vertex, so carrying straight through
              // means they are opposed: the more negative the dot, the
              // straighter the join.
              const dot = u[0] * v[0] + u[1] * v[1];
              if (dot < best) { best = dot; pick = [at[x], at[y], dot]; }
            }
          }
        }
        if (!pick) continue;
        const [a, b] = pick;
        dead.add(a.i); dead.add(b.i);
        merged.push(joined(live[a.i], a.end, live[b.i], b.end));
      }
      if (!merged.length) break;
      live = live.filter((_, i) => !dead.has(i)).concat(merged);
    }
  }
  return live;
}

/** Cosine ceiling for carrying a stroke through a crossing: about 75 degrees. */
const MAX_JOIN_TURN = 0.26;

function reversed(p) {
  const out = [];
  for (let i = p.length - 2; i >= 0; i -= 2) out.push(p[i], p[i + 1]);
  return out;
}

/** Douglas-Peucker. Cosmetic: it moves the hand, never the reveal. */
export function simplify(pts, eps = SIMPLIFY_EPS) {
  const n = pts.length / 2;
  if (n < 3) return pts;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const ax = pts[a * 2]; const ay = pts[a * 2 + 1];
    const bx = pts[b * 2]; const by = pts[b * 2 + 1];
    const dx = bx - ax; const dy = by - ay;
    const len = Math.hypot(dx, dy);
    let worst = -1; let worstD = eps;
    for (let i = a + 1; i < b; i++) {
      const px = pts[i * 2]; const py = pts[i * 2 + 1];
      const d = len === 0
        ? Math.hypot(px - ax, py - ay)
        : Math.abs(dy * px - dx * py + bx * ay - by * ax) / len;
      if (d > worstD) { worstD = d; worst = i; }
    }
    if (worst < 0) continue;
    keep[worst] = 1;
    stack.push([a, worst], [worst, b]);
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i * 2], pts[i * 2 + 1]);
  return out;
}

// ── coverage ──────────────────────────────────────────────────────────

/**
 * Give every pixel of the shape to the nearest seeded stroke.
 *
 * A breadth-first flood from every stroke's own pixels at once, staying inside
 * the mask. Because all seeds start at distance zero and the frontier advances
 * one step at a time, a pixel is reached first by the stroke nearest it in
 * path-distance *through the shape* -- which is what should own it. Going
 * through the shape rather than straight-line matters at a junction: pixels in
 * one arm are reached along that arm rather than across the gap from another.
 *
 * The flood only reaches a connected piece that holds a seed, and not every
 * piece does: the centreline is thinned on a coarser grid, so a speck a couple
 * of pixels across can vanish there and leave its pixels with no stroke
 * anywhere near them. Those go to `remainder` rather than staying unowned,
 * which is what makes the partition total no matter what the thinning did.
 * Handing them to a stroke that is nowhere near them would be a lie about who
 * drew them; leaving them out would be a hole in the finished picture. A
 * remainder the caller closes at the end of the pass is neither.
 *
 * The result therefore partitions the shape exactly -- nothing double-owned,
 * nothing missed -- which is what lets the ink strokes' closures add up to the
 * whole outline.
 *
 * @param {Uint8Array} mask the shape, on the grid coverage is judged on
 * @param {Int32Array} seeds one stroke index per pixel, `-1` where unseeded
 * @param {number} [remainder=-1] index given to mask pixels no seed reaches
 * @returns {Int32Array} one stroke index per pixel, `-1` outside the mask
 */
export function assignOwners(mask, seeds, w, h, remainder = -1) {
  const owner = new Int32Array(w * h).fill(-1);
  const queue = new Int32Array(w * h);
  let head = 0;
  let tail = 0;

  for (let i = 0; i < mask.length; i++) {
    if (mask[i] && seeds[i] >= 0) { owner[i] = seeds[i]; queue[tail++] = i; }
  }
  while (head < tail) {
    const p = queue[head++];
    const x = p % w;
    const o = owner[p];
    if (x > 0 && mask[p - 1] && owner[p - 1] < 0) { owner[p - 1] = o; queue[tail++] = p - 1; }
    if (x < w - 1 && mask[p + 1] && owner[p + 1] < 0) { owner[p + 1] = o; queue[tail++] = p + 1; }
    if (p >= w && mask[p - w] && owner[p - w] < 0) { owner[p - w] = o; queue[tail++] = p - w; }
    if (p + w < mask.length && mask[p + w] && owner[p + w] < 0) {
      owner[p + w] = o; queue[tail++] = p + w;
    }
  }
  if (remainder >= 0) {
    for (let i = 0; i < mask.length; i++) if (mask[i] && owner[i] < 0) owner[i] = remainder;
  }
  return owner;
}

/**
 * Stamp a polyline's pixels into a seed grid, so its stroke can claim them.
 *
 * Walks each segment at half-pixel steps, which is dense enough that no cell is
 * stepped over. Later strokes do not overwrite earlier ones, so where two
 * paths cross, the pixel goes to whichever was drawn first -- the same pixel
 * cannot be owed by two strokes, or the closures would double-count it.
 *
 * @param {Int32Array} seeds mutated in place
 */
export function seedPolyline(seeds, w, h, pts, index, scale = 1) {
  const put = (x, y) => {
    const ix = Math.round(x * scale);
    const iy = Math.round(y * scale);
    if (ix < 0 || iy < 0 || ix >= w || iy >= h) return;
    const i = iy * w + ix;
    if (seeds[i] < 0) seeds[i] = index;
  };
  for (let i = 2; i < pts.length; i += 2) {
    const x0 = pts[i - 2]; const y0 = pts[i - 1];
    const x1 = pts[i]; const y1 = pts[i + 1];
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * scale * 2));
    for (let s = 0; s <= steps; s++) put(x0 + ((x1 - x0) * s) / steps, y0 + ((y1 - y0) * s) / steps);
  }
}

/**
 * The whole path side: a shape's mask -> centreline polylines and their widths.
 *
 * Thinning happens on a grid of its own, coarser than the one coverage is
 * judged on. The centreline is a path the hand follows, so resolution buys it
 * nothing but cost, and the reveal -- which is the part that has to be exact --
 * is computed separately at full mask resolution.
 *
 * @returns {{paths:Array<{pts:number[], width:number}>, scale:number}} `pts` in
 *   skeleton-grid coordinates; `scale` multiplies them back to mask-grid ones
 */
export function centerlines(mask, w, h, opts = {}) {
  const maxDim = opts.maxDim ?? SKELETON_MAX_DIM;
  const longest = Math.max(w, h);
  const k = longest <= maxDim ? 1 : maxDim / longest;
  const sw = Math.max(1, Math.round(w * k));
  const sh = Math.max(1, Math.round(h * k));

  const small = shrinkMask(mask, w, h, sw, sh);
  const dist = distanceTransform(small, sw, sh);
  const skel = thin(small, sw, sh);

  const chains = stitchPaths(pruneSpurs(chainSkeleton(skel, sw, sh), dist, sw, sh));
  const paths = [];
  for (const raw of chains) {
    const pts = simplify(raw);
    if (pts.length < 4) continue;
    // Median half-thickness along the branch, doubled: the nib matches the line
    // it is running down. The median rather than the mean so one fat junction
    // does not swell a whole thin branch.
    const samples = [];
    for (let i = 0; i < raw.length; i += 2) samples.push(dist[raw[i + 1] * sw + raw[i]] / 3);
    samples.sort((a, b) => a - b);
    paths.push({ pts, width: Math.max(1, samples[samples.length >> 1] * 2) });
  }
  return { paths, scale: sw > 0 ? w / sw : 1 };
}
