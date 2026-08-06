/**
 * Raster artwork -> colour groups, boundaries and exact coverage masks.
 *
 * This replaces the Python vectorizer, and the reason it exists is a promise
 * the old pipeline could not keep: **the finished frame is the source image**.
 *
 * The vectorizer downscaled to 1600px, k-means quantised to 6 colours, threw
 * the background cluster away, morphologically opened the result, dropped every
 * contour under a minimum area and Douglas-Peucker simplified the rest. The
 * animation then drew *that*, and the artwork was only ever shown where the pen
 * had been -- so anything the tracer dropped was missing from the finished
 * picture for good.
 *
 * Here nothing is dropped. Every pixel is assigned to exactly one group, each
 * group carries a rectangle mask of the pixels it owns, and painting a group
 * blits that mask. The union of the groups is the whole image, so at u = 1 the
 * mask covers everything and `art ∩ everything` is `art`. Exactness is a
 * property of the decomposition, not of how well the brush happens to cover.
 *
 * Two resolutions, deliberately:
 *
 *   - the **mask** grid (`MASK_MAX_DIM`) is what coverage is judged on, so it
 *     is fine;
 *   - the **shape** grid (`SHAPE_MAX_DIM`) is what the pen's path and the
 *     centreline are built from, so it is coarse -- scribbling a boundary
 *     traced at full resolution costs a great deal and looks no different, and
 *     the mask is what guarantees the result either way.
 *
 * Everything here is deterministic: a fixed-cut palette rather than k-means, no
 * `Math.random`, no floating-point iteration order that depends on a Map's
 * insertion history. The same image compiles to the same plan every time, which
 * is what `renderFrame`'s purity rests on.
 */

/** Longest edge of the grid coverage is judged on. */
export const MASK_MAX_DIM = 1400;

/** Longest edge of the grid pen paths are traced from. */
export const SHAPE_MAX_DIM = 512;

/** Default number of colour groups. */
export const DEFAULT_COLORS = 8;

/**
 * Default distance below which two colours are treated as one, for
 * `flatPalette`. In the weighted metric `labelPixels` uses, not raw RGB units:
 * a uniform shift of `d` in all three channels measures about `0.67 * d`, so
 * this absorbs roughly a +-20/255 wobble per channel. Enough for JPEG ringing
 * and a fill that was never quite flat, well short of merging two colours a
 * person drew as different.
 */
export const DEFAULT_TOLERANCE = 14;

/**
 * Ceiling on distinct colours from `flatPalette`.
 *
 * A guard, not a control, and deliberately not in any `paramSchema`: whiteboard
 * artwork has well under a dozen colours, so this only ever binds when the mode
 * is pointed at something it was not designed for. A photograph then comes out
 * coarse instead of compiling tens of thousands of groups and one stroke each.
 */
export const MAX_FLAT_COLORS = 48;

/**
 * Share of the image a bin must hold to anchor a colour of its own.
 *
 * This is what separates a flat fill from a step in an antialiasing ramp, and
 * it works because the two differ by orders of magnitude rather than by a
 * little: the smallest flat fill worth colouring separately still covers whole
 * percents of the picture, while a ramp spreads its pixels over hundreds of
 * bins so no single step comes near this. Only the first anchor is exempt --
 * an image has to have at least one colour.
 */
const MIN_ANCHOR_SHARE = 0.0012;

/**
 * Lightness at or below which a neutral group is taken for linework.
 *
 * Set from the bundled icons: their outlines measure 0.01 to 0.14, while the
 * darkest thing that is plainly a *fill* rather than a line -- the plane
 * trail's grey -- measures 0.267. Sitting between the two is the whole job.
 */
export const DEFAULT_INK_LUMA = 0.25;

/**
 * Channel spread above which a dark group is a colour, not linework.
 *
 * Lightness alone cannot tell a black outline from a navy shirt -- both are
 * dark -- so neutrality does the real work here. Measured against the bundled
 * icons: their outlines spread 7 to 26, while the plane trail's dark purple
 * spreads 45 and is plainly a fill. 36 sits between, and being strict costs
 * little: a dark colour wrongly left out of the ink pass is simply painted in
 * the colour pass, where it belongs.
 */
export const DEFAULT_INK_CHROMA = 0.14;

/**
 * Below this alpha a pixel is treated as absent rather than as a colour.
 *
 * One, not a comfortable threshold like 8: a pixel with *any* alpha is part of
 * the picture and has to end up owned by some group, because a group's mask is
 * the only thing that ever reveals it. Leave a fringe of alpha-3 pixels unowned
 * and no mask covers them, so they never appear and the finished frame is not
 * the source image -- which is the one guarantee this pipeline exists to make.
 * They are nearly invisible either way; what matters is that nothing is
 * unowned.
 */
const ALPHA_FLOOR = 1;

/**
 * Smallest ring, in shape-grid pixels squared, that is worth giving to the pen.
 *
 * The one place anything is discarded, and it costs nothing: `rings` only
 * decides *where the nib travels*, while coverage
 * comes from `rects`, which is complete. An antialiased edge quantises into a
 * confetti of single-pixel islands -- a 1600px icon produced 4400 rings, nearly
 * all of them four points around one pixel -- and scribbling those would cost a
 * great deal and be invisible. Their pixels are still painted, by the run mask,
 * exactly like every other pixel.
 *
 * This distinction is the whole reason "no pruning" holds while the pen still
 * behaves: prune the *path*, never the *coverage*.
 */
const MIN_RING_AREA = 6;

/**
 * Smallest connected piece, in mask-grid pixels, worth filling as its own shape.
 *
 * The same "prune the path, never the coverage" rule as `MIN_RING_AREA`, one
 * level up. A piece below this is a speck thrown off by an antialiased edge,
 * not a shape a person would fill; it keeps every one of its pixels, it just
 * does not get its own trip of the pen.
 */
const MIN_PIECE_AREA = 24;

/**
 * Ceiling on separately-drawn pieces per colour.
 *
 * Bounds compile time on artwork this mode was not designed for, where the
 * piece count can run to five figures. Whiteboard artwork is nowhere near it.
 */
const MAX_DRAWN_PIECES = 256;

// ── resampling ────────────────────────────────────────────────────────

/**
 * Box-filter `src` down to fit `maxDim`, or hand it back untouched.
 *
 * A box filter rather than nearest: the palette is chosen from this, and
 * point-sampling a photograph picks up whatever happened to land on the grid.
 * Alpha-weighted, so a transparent PNG's fringe does not drag its colours
 * toward whatever the transparent pixels happen to hold.
 *
 * @param {{width:number, height:number, data:Uint8ClampedArray}} src
 * @returns {{width:number, height:number, data:Uint8ClampedArray}}
 */
export function resample(src, maxDim) {
  const longest = Math.max(src.width, src.height);
  if (longest <= maxDim) return src;

  const scale = maxDim / longest;
  const w = Math.max(1, Math.round(src.width * scale));
  const h = Math.max(1, Math.round(src.height * scale));
  const out = new Uint8ClampedArray(w * h * 4);

  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * src.height) / h);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * src.height) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * src.width) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * src.width) / w));
      let r = 0; let g = 0; let b = 0; let a = 0; let peak = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * src.width + sx) * 4;
          const av = src.data[i + 3];
          r += src.data[i] * av; g += src.data[i + 1] * av; b += src.data[i + 2] * av;
          a += av;
          if (av > peak) peak = av;
        }
      }
      const o = (y * w + x) * 4;
      if (a > 0) {
        out[o] = r / a; out[o + 1] = g / a; out[o + 2] = b / a;
      }
      // Colour is the alpha-weighted mean, but alpha is the *maximum* over the
      // box, and that asymmetry is load-bearing. Coverage is decided on this
      // grid: a cell that averages to alpha 0 owns no pixels, gets no mask, and
      // any source pixel inside it is never revealed. One nearly-transparent
      // pixel among four averages to zero and vanishes -- which is precisely
      // the class of silent loss this pipeline replaced. Taking the maximum
      // means a cell is present whenever *anything* in it is, so every source
      // pixel with any alpha at all ends up owned.
      out[o + 3] = peak;
    }
  }
  return { width: w, height: h, data: out };
}

// ── palette ───────────────────────────────────────────────────────────

/**
 * Choose a palette by median cut over a 5-bit-per-channel histogram.
 *
 * Median cut and not k-means, for two reasons that both matter more than
 * cluster quality: it needs no seeding, so there is no randomness to make
 * deterministic after the fact, and it terminates in a fixed number of steps
 * rather than iterating to a tolerance. Colour fidelity is not the job anyway --
 * the palette only decides *what gets painted together and in what order*, and
 * the pixels revealed are always the original ones.
 *
 * @returns {Array<{r:number,g:number,b:number}>} at least one entry
 */
export function buildPalette(img, colors = DEFAULT_COLORS) {
  const BITS = 5;
  const SIDE = 1 << BITS;
  const shift = 8 - BITS;
  const hist = new Map();                     // packed bin -> {n, r, g, b}

  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3] < ALPHA_FLOOR) continue;
    const r = img.data[i] >> shift;
    const g = img.data[i + 1] >> shift;
    const b = img.data[i + 2] >> shift;
    const key = (r * SIDE + g) * SIDE + b;
    const e = hist.get(key);
    if (e) { e.n++; e.r += img.data[i]; e.g += img.data[i + 1]; e.b += img.data[i + 2]; }
    else hist.set(key, { n: 1, r: img.data[i], g: img.data[i + 1], b: img.data[i + 2] });
  }
  if (!hist.size) return [{ r: 0, g: 0, b: 0 }];

  // Sorted by bin index, so the starting order never depends on the Map's
  // insertion history and two runs cut in the same places.
  const bins = [...hist.entries()]
    .map(([key, e]) => ({
      n: e.n, r: e.r / e.n, g: e.g / e.n, b: e.b / e.n, key,
    }))
    .sort((p, q) => p.key - q.key);

  let boxes = [bins];
  const want = Math.max(1, Math.min(64, Math.round(colors)));
  while (boxes.length < want) {
    // Split the box with the largest weighted spread. Ties go to the earlier
    // box, which keeps the choice independent of sort stability.
    let pick = -1; let best = 0;
    let axis = 'r';
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      if (box.length < 2) continue;
      let count = 0;
      const lo = { r: 255, g: 255, b: 255 };
      const hi = { r: 0, g: 0, b: 0 };
      for (const e of box) {
        count += e.n;
        for (const k of ['r', 'g', 'b']) {
          if (e[k] < lo[k]) lo[k] = e[k];
          if (e[k] > hi[k]) hi[k] = e[k];
        }
      }
      // Perceptual-ish weights, so a green ramp is not split as eagerly as a
      // blue one at equal numeric spread.
      const spread = Math.max(
        (hi.r - lo.r) * 0.30, (hi.g - lo.g) * 0.59, (hi.b - lo.b) * 0.11);
      const score = spread * Math.cbrt(count);
      if (score > best) {
        best = score;
        pick = i;
        axis = (hi.r - lo.r) * 0.30 >= (hi.g - lo.g) * 0.59
          ? ((hi.r - lo.r) * 0.30 >= (hi.b - lo.b) * 0.11 ? 'r' : 'b')
          : ((hi.g - lo.g) * 0.59 >= (hi.b - lo.b) * 0.11 ? 'g' : 'b');
      }
    }
    if (pick < 0) break;                       // nothing left worth splitting

    const box = boxes[pick].slice().sort((p, q) => (p[axis] - q[axis]) || (p.key - q.key));
    const half = box.reduce((s, e) => s + e.n, 0) / 2;
    let acc = 0; let cut = 0;
    while (cut < box.length - 1 && acc + box[cut].n < half) { acc += box[cut].n; cut++; }
    if (cut < 1) cut = 1;
    boxes = boxes.slice(0, pick)
      .concat([box.slice(0, cut), box.slice(cut)], boxes.slice(pick + 1));
  }

  return boxes.map((box) => {
    let n = 0; let r = 0; let g = 0; let b = 0;
    for (const e of box) { n += e.n; r += e.r * e.n; g += e.g * e.n; b += e.b * e.n; }
    return n
      ? { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) }
      : { r: 0, g: 0, b: 0 };
  });
}

/**
 * Choose a palette by anchoring on the artwork's flat colours.
 *
 * `buildPalette` cuts the colour space into a fixed number of boxes, which is
 * the right thing when you know nothing about the picture. On artwork drawn for
 * a whiteboard -- a black outline and a handful of flat fills -- it is the wrong
 * thing twice over: it splits one flat fill across two boxes when that fill
 * happens to span a cut, and it merges two fills that happen to share one. The
 * number of colours is not a property of the request, it is a property of the
 * drawing.
 *
 * So: take the most populous bins as anchors, and let everything else fall to
 * whichever anchor is nearest. A flat fill is by definition a large pile of
 * pixels in one bin, so it becomes an anchor. Antialiasing is a *ramp* --
 * hundreds of bins with a few pixels each -- so no step of it is ever populous
 * enough to anchor, and `labelPixels` then assigns each of those pixels to the
 * flat colour it is closest to. The fringe around a black outline joins the
 * outline or the fill it is blending into, which is exactly where it belongs.
 *
 * Two bins are the same colour when they are within `tolerance` under the same
 * weighted metric `labelPixels` uses, so "slight variation" -- a JPEG's ringing,
 * a gradient that is meant to read as one colour -- is one group.
 *
 * @param {{width:number, height:number, data:Uint8ClampedArray}} img
 * @param {Object} [opts]
 * @param {number} [opts.tolerance=DEFAULT_TOLERANCE] distance below which two
 *   colours are the same, in the weighted metric (not raw RGB units)
 * @param {number} [opts.maxColors=MAX_FLAT_COLORS] hard ceiling, a guard against
 *   a photograph rather than a control
 * @returns {Array<{r:number,g:number,b:number}>} at least one entry
 */
export function flatPalette(img, opts = {}) {
  const tolerance = opts.tolerance ?? DEFAULT_TOLERANCE;
  const maxColors = Math.max(1, Math.round(opts.maxColors ?? MAX_FLAT_COLORS));
  const BITS = 5;
  const SIDE = 1 << BITS;
  const shift = 8 - BITS;
  const hist = new Map();

  let total = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3] < ALPHA_FLOOR) continue;
    total++;
    const key = ((img.data[i] >> shift) * SIDE + (img.data[i + 1] >> shift)) * SIDE
      + (img.data[i + 2] >> shift);
    const e = hist.get(key);
    if (e) { e.n++; e.r += img.data[i]; e.g += img.data[i + 1]; e.b += img.data[i + 2]; }
    else hist.set(key, { n: 1, r: img.data[i], g: img.data[i + 1], b: img.data[i + 2] });
  }
  if (!hist.size) return [{ r: 0, g: 0, b: 0 }];

  // Most populous first; ties by bin index, so the order never depends on the
  // Map's insertion history and two runs anchor on the same bins.
  const bins = [...hist.entries()]
    .map(([key, e]) => ({ n: e.n, r: e.r / e.n, g: e.g / e.n, b: e.b / e.n, key }))
    .sort((p, q) => (q.n - p.n) || (p.key - q.key));

  const limit = tolerance * tolerance;
  const floor = total * MIN_ANCHOR_SHARE;
  const anchors = [];
  for (const bin of bins) {
    if (anchors.length >= maxColors) break;
    // A bin too sparse to be a flat fill is a step in a ramp. It still gets
    // painted -- `labelPixels` gives it to the nearest anchor -- it just does
    // not get to define a colour of its own.
    if (anchors.length && bin.n < floor) break;
    let near = false;
    for (const a of anchors) {
      const dr = (bin.r - a.r) * 0.30;
      const dg = (bin.g - a.g) * 0.59;
      const db = (bin.b - a.b) * 0.11;
      if (dr * dr + dg * dg + db * db < limit) { near = true; break; }
    }
    if (!near) {
      anchors.push({ r: Math.round(bin.r), g: Math.round(bin.g), b: Math.round(bin.b) });
    }
  }
  // `bins` is non-empty, but every bin can fall below the floor when the image
  // is a smooth ramp with no flat colour anywhere. The most populous one still
  // has to anchor, or there is no palette at all.
  return anchors.length ? anchors
    : [{ r: Math.round(bins[0].r), g: Math.round(bins[0].g), b: Math.round(bins[0].b) }];
}

/**
 * Label every pixel with the nearest palette entry.
 *
 * `-1` means "no ink here": a pixel below the alpha floor belongs to no group
 * and has nothing to reveal, which is the *only* thing this pipeline ever
 * leaves out and is not a loss -- there is no colour there to show.
 *
 * @returns {Int16Array} one label per pixel
 */
export function labelPixels(img, palette) {
  const n = img.width * img.height;
  const labels = new Int16Array(n);
  const k = palette.length;
  const pr = new Float64Array(k); const pg = new Float64Array(k); const pb = new Float64Array(k);
  for (let i = 0; i < k; i++) { pr[i] = palette[i].r; pg[i] = palette[i].g; pb[i] = palette[i].b; }

  for (let p = 0; p < n; p++) {
    const i = p * 4;
    if (img.data[i + 3] < ALPHA_FLOOR) { labels[p] = -1; continue; }
    const r = img.data[i]; const g = img.data[i + 1]; const b = img.data[i + 2];
    let bestI = 0; let bestD = Infinity;
    for (let c = 0; c < k; c++) {
      const dr = (r - pr[c]) * 0.30;
      const dg = (g - pg[c]) * 0.59;
      const db = (b - pb[c]) * 0.11;
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) { bestD = d; bestI = c; }
    }
    labels[p] = bestI;
  }
  return labels;
}

// ── coverage masks ────────────────────────────────────────────────────

/**
 * Encode one label's pixels as axis-aligned rectangles.
 *
 * The format is a flat `Int32Array` of `[x0, y0, x1, y1]` quadruples, upper
 * bounds exclusive, which the renderer replays as `fillRect`. Flat and typed
 * because there is one of these per group and it is blitted straight into the
 * mask.
 *
 * Row spans are merged downward when they line up exactly, which costs one
 * comparison per span and turns a solid area from one rectangle per scan line
 * into a single rectangle -- worth doing, because a photograph's background
 * would otherwise be tens of thousands of `fillRect` calls in the one frame
 * that commits it.
 *
 * This is the exactness guarantee made concrete: whatever the brush did or did
 * not cover, blitting this covers precisely the pixels the group owns.
 */
export function encodeRects(labels, w, h, label) {
  const rects = [];
  /** spans still growing downward, as [x0, x1, yStart] */
  let open = [];

  for (let y = 0; y <= h; y++) {
    const spans = [];
    if (y < h) {
      const row = y * w;
      let x = 0;
      while (x < w) {
        while (x < w && labels[row + x] !== label) x++;
        if (x >= w) break;
        const x0 = x;
        while (x < w && labels[row + x] === label) x++;
        spans.push([x0, x]);
      }
    }
    // Both lists are in ascending x, so one walk pairs them up.
    const next = [];
    let i = 0; let j = 0;
    while (i < open.length || j < spans.length) {
      const o = open[i]; const s = spans[j];
      if (o && s && o[0] === s[0] && o[1] === s[1]) { next.push(o); i++; j++; }
      else if (o && (!s || o[0] < s[0])) { rects.push(o[0], o[2], o[1], y); i++; }
      else { next.push([s[0], s[1], y]); j++; }
    }
    open = next;
  }
  return Int32Array.from(rects);
}

/**
 * `encodeRects` for every id at once, in a single pass over the grid.
 *
 * Same algorithm, same output per id -- but the loop is inverted. Calling
 * `encodeRects` once per id costs a full scan of the grid each time, and the
 * animations that plan from pixels want coverage per *stroke*, of which a
 * detailed drawing has thousands: the bundled scribble icon compiled 1498
 * strokes over a 1400-square grid, which is three billion comparisons and took
 * a minute. One pass takes milliseconds, and compile time matters because
 * nothing caches it -- it is re-run on every session build.
 *
 * Negative ids and ids at or past `count` are skipped, so an owner grid can use
 * `-1` for "not mine" without a second array.
 *
 * @returns {Int32Array[]} `out[id]` is exactly `encodeRects(labels, w, h, id)`
 */
export function encodeRectsMulti(labels, w, h, count) {
  const out = Array.from({ length: count }, () => []);
  /** id -> spans still growing downward, as [x0, x1, yStart], ascending x */
  let open = new Map();

  for (let y = 0; y <= h; y++) {
    const spans = new Map();
    if (y < h) {
      const row = y * w;
      let x = 0;
      while (x < w) {
        const id = labels[row + x];
        const x0 = x;
        while (x < w && labels[row + x] === id) x++;
        if (id >= 0 && id < count) {
          const list = spans.get(id);
          if (list) list.push([x0, x]);
          else spans.set(id, [[x0, x]]);
        }
      }
    }

    const next = new Map();
    for (const id of new Set([...open.keys(), ...spans.keys()])) {
      const o = open.get(id) || [];
      const s = spans.get(id) || [];
      const rects = out[id];
      const grown = [];
      let i = 0; let j = 0;
      // Both lists are in ascending x, so one walk pairs them up.
      while (i < o.length || j < s.length) {
        const a = o[i]; const b = s[j];
        if (a && b && a[0] === b[0] && a[1] === b[1]) { grown.push(a); i++; j++; }
        else if (a && (!b || a[0] < b[0])) { rects.push(a[0], a[2], a[1], y); i++; }
        else { grown.push([b[0], b[1], y]); j++; }
      }
      if (grown.length) next.set(id, grown);
    }
    open = next;
  }
  return out.map((r) => Int32Array.from(r));
}

// ── boundaries ────────────────────────────────────────────────────────

/**
 * Trace the boundary of a label as closed rings on the pixel lattice.
 *
 * Not marching squares: every boundary *edge* of every owned pixel is emitted
 * as a unit directed segment with the interior on its left, and the segments
 * are then chained head-to-tail. That is exact -- the rings follow the pixel
 * boundary rather than an isoline through it -- it produces holes and
 * disconnected pieces without any special cases, and the winding direction
 * falls out of the orientation, so an outer ring and a hole are distinguishable
 * without a containment test.
 *
 * Vertices land on integer lattice points, so chaining is an integer hash
 * lookup with no tolerance to tune. Where four cells meet in a checkerboard a
 * vertex has two outgoing edges; taking the sharpest right turn keeps the two
 * touching pieces separate, which is what stops a diagonal seam fusing regions
 * that only meet at a corner.
 *
 * Collinear runs are merged, which is exact and turns a long straight edge from
 * hundreds of unit steps into two points.
 *
 * @returns {Float64Array[]} rings, packed [x,y,...] in grid coordinates
 */
export function traceLabel(labels, w, h, label) {
  const inside = (x, y) => x >= 0 && y >= 0 && x < w && y < h && labels[y * w + x] === label;
  const stride = w + 1;

  // Directed unit edges keyed by their start vertex. Interior on the left,
  // with y running down: top edges go +x, right edges +y, bottom -x, left -y.
  /** @type {Map<number, number[]>} start vertex -> end vertices */
  const out = new Map();
  const addEdge = (x0, y0, x1, y1) => {
    const a = y0 * stride + x0;
    const list = out.get(a);
    if (list) list.push(y1 * stride + x1);
    else out.set(a, [y1 * stride + x1]);
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (labels[y * w + x] !== label) continue;
      if (!inside(x, y - 1)) addEdge(x, y, x + 1, y);              // top
      if (!inside(x + 1, y)) addEdge(x + 1, y, x + 1, y + 1);      // right
      if (!inside(x, y + 1)) addEdge(x + 1, y + 1, x, y + 1);      // bottom
      if (!inside(x - 1, y)) addEdge(x, y + 1, x, y);              // left
    }
  }

  const rings = [];
  const vx = (v) => v % stride;
  const vy = (v) => (v - (v % stride)) / stride;

  for (const start of [...out.keys()].sort((a, b) => a - b)) {
    while (out.get(start)?.length) {
      const pts = [];
      let cur = start;
      let prev = -1;
      // Walk until the loop closes. Every edge is consumed exactly once, so
      // this terminates even on a checkerboard.
      for (;;) {
        const list = out.get(cur);
        if (!list || !list.length) break;
        let pick = 0;
        if (list.length > 1 && prev >= 0) {
          // Sharpest right turn relative to how we arrived.
          const ix = vx(cur) - vx(prev);
          const iy = vy(cur) - vy(prev);
          let bestTurn = -Infinity;
          for (let i = 0; i < list.length; i++) {
            const ox = vx(list[i]) - vx(cur);
            const oy = vy(list[i]) - vy(cur);
            // cross < 0 is a right turn with y down; rank right over straight
            // over left, and never take the reversal unless it is all there is.
            const cross = ix * oy - iy * ox;
            const dot = ix * ox + iy * oy;
            const turn = cross < 0 ? 2 : (cross > 0 ? 0 : (dot > 0 ? 1 : -1));
            if (turn > bestTurn) { bestTurn = turn; pick = i; }
          }
        }
        const next = list.splice(pick, 1)[0];
        pts.push(vx(cur), vy(cur));
        prev = cur;
        cur = next;
        if (cur === start) break;
      }
      if (pts.length >= 6) rings.push(Float64Array.from(mergeCollinear(pts)));
    }
  }
  return rings;
}

/** Drop interior points of straight runs. Exact -- no tolerance involved. */
function mergeCollinear(pts) {
  const n = pts.length / 2;
  if (n < 3) return pts;
  const out = [];
  for (let i = 0; i < n; i++) {
    const px = pts[((i - 1 + n) % n) * 2]; const py = pts[((i - 1 + n) % n) * 2 + 1];
    const cx = pts[i * 2]; const cy = pts[i * 2 + 1];
    const nx = pts[((i + 1) % n) * 2]; const ny = pts[((i + 1) % n) * 2 + 1];
    if ((cx - px) * (ny - cy) !== (cy - py) * (nx - cx)) out.push(cx, cy);
  }
  return out.length >= 6 ? out : pts;
}

// ── connected pieces ──────────────────────────────────────────────────

/**
 * Split one label's pixels into 4-connected pieces.
 *
 * A colour is not a place. Every red pixel in a drawing is one *group*, but the
 * shirt, the left shoe and the right shoe are three *shapes*, and a hand
 * colouring them fills one and then moves to the next rather than scribbling
 * across the whole picture at once. This is what makes that difference
 * available to the paint pass.
 *
 * Four-connected rather than eight, so two regions touching only at a corner
 * stay separate -- the same choice `traceLabel` makes when it takes the
 * sharpest right turn at a checkerboard vertex, and for the same reason.
 *
 * Flood filled in raster order from an explicit stack, so piece ids run roughly
 * top-left to bottom-right and never depend on recursion depth or on iteration
 * order of anything.
 *
 * @returns {{ids:Int32Array, count:number}} `-1` where the pixel is not `label`
 */
export function connectedPieces(labels, w, h, label) {
  const ids = new Int32Array(w * h).fill(-1);
  const stack = new Int32Array(w * h);
  let count = 0;

  for (let seed = 0; seed < ids.length; seed++) {
    if (labels[seed] !== label || ids[seed] !== -1) continue;
    const id = count++;
    let top = 0;
    stack[top++] = seed;
    ids[seed] = id;
    while (top > 0) {
      const p = stack[--top];
      const x = p % w;
      const y = (p - x) / w;
      if (x > 0 && labels[p - 1] === label && ids[p - 1] === -1) { ids[p - 1] = id; stack[top++] = p - 1; }
      if (x < w - 1 && labels[p + 1] === label && ids[p + 1] === -1) { ids[p + 1] = id; stack[top++] = p + 1; }
      if (y > 0 && labels[p - w] === label && ids[p - w] === -1) { ids[p - w] = id; stack[top++] = p - w; }
      if (y < h - 1 && labels[p + w] === label && ids[p + w] === -1) { ids[p + w] = id; stack[top++] = p + w; }
    }
  }
  return { ids, count };
}

/**
 * Resample an id image by point sampling, for tracing at a coarser resolution.
 *
 * Point sampling and not anything cleverer, because ids are nominal -- there is
 * no meaningful average of piece 3 and piece 7. A piece too thin to survive the
 * sampling simply gets no rings, which costs it nothing: rings decide where the
 * pen travels, `rects` decide what is revealed, and `rects` are always computed
 * at full mask resolution. Prune the path, never the coverage.
 */
export function sampleIds(ids, w, h, outW, outH) {
  const out = new Int32Array(outW * outH);
  for (let y = 0; y < outH; y++) {
    const sy = Math.min(h - 1, Math.floor((y * h) / outH));
    for (let x = 0; x < outW; x++) {
      const sx = Math.min(w - 1, Math.floor((x * w) / outW));
      out[y * outW + x] = ids[sy * w + sx];
    }
  }
  return out;
}

/**
 * Which groups, if any, are the drawing's linework.
 *
 * The premise of this whole mode is artwork drawn the way a whiteboard
 * illustration is drawn: shapes outlined in black, filled flat. The outline is
 * the darkest thing in the picture and it is neutral -- black, or close enough
 * that calling it black is not a lie.
 *
 * **All** qualifying groups, not just the darkest, because a hand-drawn or
 * exported black outline is routinely not one colour. The bundled lightbulb
 * icon inks its outline in two shades that measure 15.3 apart -- just past the
 * default merge tolerance -- so `flatPalette` rightly keeps them separate and
 * taking only the darkest would ink a thin, broken core and leave the rest of
 * the line to be coloured in as though it were a fill.
 *
 * What stops this swallowing a dark *fill* is the chroma test, not the
 * lightness one: a navy shirt or a deep green leaf is dark but nowhere near
 * neutral. A genuinely dark grey fill would be taken for linework, which is the
 * known cost of the assumption this whole animation is built on, and `inkLuma`
 * is the way out of it.
 *
 * Empty when nothing qualifies -- artwork with no outline at all. The caller
 * then has no ink pass and colours the whole picture, rather than failing.
 *
 * @param {number} [opts.inkLuma=0.25] lightness ceiling
 * @param {number} [opts.inkChroma=0.14] max channel spread, as a fraction of 255
 * @returns {number[]} labels, darkest first, then by label so the order is total
 */
export function pickInkLabels(groups, opts = {}) {
  const maxLuma = opts.inkLuma ?? DEFAULT_INK_LUMA;
  const maxChroma = (opts.inkChroma ?? DEFAULT_INK_CHROMA) * 255;
  return groups
    .filter((g) => {
      if (g.luma > maxLuma) return false;
      const c = parseHex(g.color);
      return Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b) <= maxChroma;
    })
    .sort((a, b) => (a.luma - b.luma) || (a.label - b.label))
    .map((g) => g.label);
}

const parseHex = (s) => ({
  r: parseInt(s.slice(1, 3), 16),
  g: parseInt(s.slice(3, 5), 16),
  b: parseInt(s.slice(5, 7), 16),
});

// ── the whole analysis ────────────────────────────────────────────────

/** Signed area of a packed ring; negative is a hole with y running down. */
function ringArea(r) {
  let a = 0;
  for (let i = 0; i < r.length; i += 2) {
    const j = (i + 2) % r.length;
    a += r[i] * r[j + 1] - r[j] * r[i + 1];
  }
  return a / 2;
}

const hex = (c) => `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

/** Perceptual lightness, for ordering groups dark-first. */
const luma = (c) => (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;

/**
 * Decompose artwork into the groups an animation paints.
 *
 * @param {{width:number, height:number, data:Uint8ClampedArray}} img at whatever
 *   resolution the host decoded it; the *artwork* is never resampled, only this
 *   analysis is.
 * @param {Object} [opts]
 * @param {'medianCut'|'flat'} [opts.palette='medianCut'] how colours are chosen.
 *   `medianCut` takes a fixed `colors` count and suits any picture; `flat`
 *   anchors on the artwork's own flat fills and discovers the count, which is
 *   right when the drawing genuinely has flat fills and wrong otherwise.
 * @param {number} [opts.colors=DEFAULT_COLORS] `medianCut` only
 * @param {number} [opts.tolerance=DEFAULT_TOLERANCE] `flat` only
 * @param {boolean} [opts.pieces=false] also split each group into 4-connected
 *   shapes, as `groups[].pieces`
 * @param {number} [opts.maskMaxDim=MASK_MAX_DIM]
 * @param {number} [opts.shapeMaxDim=SHAPE_MAX_DIM]
 * @returns {{width:number, height:number, groups:Array, mask:{width:number,
 *            height:number, sx:number, sy:number}}}
 *   `groups[].rings` are in *object* coordinates (source pixels); `groups[].rects`
 *   are in mask-grid coordinates, with `mask.sx`/`sy` the scale back to object
 *   space.
 */
export function analyzeArtwork(img, opts = {}) {
  const colors = opts.colors ?? DEFAULT_COLORS;
  const maskImg = resample(img, opts.maskMaxDim ?? MASK_MAX_DIM);
  const shapeImg = resample(maskImg, opts.shapeMaxDim ?? SHAPE_MAX_DIM);

  // One palette, chosen on the small grid and applied to both, so a group's
  // rings and its coverage mask always describe the same set of pixels.
  const palette = opts.palette === 'flat'
    ? flatPalette(shapeImg, { tolerance: opts.tolerance })
    : buildPalette(shapeImg, colors);
  const maskLabels = labelPixels(maskImg, palette);
  const shapeLabels = labelPixels(shapeImg, palette);

  const sx = img.width / maskImg.width;
  const sy = img.height / maskImg.height;
  const rx = img.width / shapeImg.width;
  const ry = img.height / shapeImg.height;

  const groups = [];
  for (let label = 0; label < palette.length; label++) {
    const rects = encodeRects(maskLabels, maskImg.width, maskImg.height, label);
    if (!rects.length) continue;                // palette entry nothing landed on

    let area = 0;
    for (let i = 0; i < rects.length; i += 4) {
      area += (rects[i + 2] - rects[i]) * (rects[i + 3] - rects[i + 1]);
    }

    const rings = traceLabel(shapeLabels, shapeImg.width, shapeImg.height, label)
      // Cosmetic only -- see MIN_RING_AREA. `rects` above is already complete.
      .filter((r) => Math.abs(ringArea(r)) >= MIN_RING_AREA)
      .map((r) => {
        const o = new Float64Array(r.length);
        for (let i = 0; i < r.length; i += 2) { o[i] = r[i] * rx; o[i + 1] = r[i + 1] * ry; }
        return o;
      })
      // Outer rings first: `scribbleRegion` uses the even-odd rule, which does
      // not care about order, but drawing outside-in reads better.
      .sort((a, b) => ringArea(b) - ringArea(a));

    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    for (let i = 0; i < rects.length; i += 4) {
      if (rects[i] < x0) x0 = rects[i];
      if (rects[i + 1] < y0) y0 = rects[i + 1];
      if (rects[i + 2] > x1) x1 = rects[i + 2];
      if (rects[i + 3] > y1) y1 = rects[i + 3];
    }

    const group = {
      label,
      color: hex(palette[label]),
      luma: luma(palette[label]),
      area,
      bbox: [x0 * sx, y0 * sy, x1 * sx, y1 * sy],
      rings,
      rects,
    };
    if (opts.pieces) {
      group.pieces = piecesOf(maskLabels, maskImg, shapeImg, label, { sx, sy, rx, ry });
    }
    groups.push(group);
  }

  return {
    width: img.width,
    height: img.height,
    groups,
    mask: { width: maskImg.width, height: maskImg.height, sx, sy },
  };
}

/**
 * One group's 4-connected shapes, each with exact coverage and its own rings.
 *
 * The two resolutions have to be reconciled here, and the direction matters.
 * Pieces are found on the **mask** grid, so `rects` are exact and a shape that
 * is one pixel wide is still a shape. Rings are then traced from a *point
 * sampling* of those piece ids down to the **shape** grid, which is the same
 * fine-coverage / coarse-path split the rest of the file makes.
 *
 * Sampling ids rather than re-finding pieces on the coarse grid is what keeps
 * the two views consistent: a piece's rings and its rects always name the same
 * piece. Two shapes that merge into one blob when sampled coarsely still hold
 * separate, exact `rects`; they just get drawn as one gesture. A shape too thin
 * to survive sampling gets no rings and is folded into a neighbour's closure by
 * the caller -- painted, but not separately drawn.
 */
function piecesOf(maskLabels, maskImg, shapeImg, label, scale) {
  const { ids, count } = connectedPieces(maskLabels, maskImg.width, maskImg.height, label);
  if (!count) return [];
  const shapeIds = sampleIds(
    ids, maskImg.width, maskImg.height, shapeImg.width, shapeImg.height);
  const byPiece = encodeRectsMulti(ids, maskImg.width, maskImg.height, count);

  const measured = [];
  for (let id = 0; id < count; id++) {
    const rects = byPiece[id];
    if (!rects.length) continue;
    let area = 0;
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    for (let i = 0; i < rects.length; i += 4) {
      area += (rects[i + 2] - rects[i]) * (rects[i + 3] - rects[i + 1]);
      if (rects[i] < x0) x0 = rects[i];
      if (rects[i + 1] < y0) y0 = rects[i + 1];
      if (rects[i + 2] > x1) x1 = rects[i + 2];
      if (rects[i + 3] > y1) y1 = rects[i + 3];
    }
    measured.push({ id, area, rects, box: [x0, y0, x1, y1] });
  }

  // Only the pieces big enough to be shapes get drawn separately. An
  // antialiased edge fragments into thousands of specks -- the bundled scribble
  // icon makes 27557 of them -- and a three-pixel speck is not something a hand
  // fills, it is something that gets covered while filling what is around it.
  // Their coverage is kept: they are merged into one ringless remainder piece,
  // which the paint pass folds into a neighbouring shape's closure.
  const drawable = measured
    .filter((p) => p.area >= MIN_PIECE_AREA)
    .sort((a, b) => (b.area - a.area) || (a.id - b.id))
    .slice(0, MAX_DRAWN_PIECES);
  const drawn = new Set(drawable.map((p) => p.id));

  const out = drawable
    .sort((a, b) => a.id - b.id)                // back to raster order
    .map((p) => ({
      id: p.id,
      area: p.area,
      bbox: [p.box[0] * scale.sx, p.box[1] * scale.sy,
             p.box[2] * scale.sx, p.box[3] * scale.sy],
      rings: ringsFor(shapeIds, shapeImg, maskImg, p, scale),
      rects: p.rects,
    }));

  const rest = measured.filter((p) => !drawn.has(p.id));
  if (rest.length) {
    let n = 0;
    for (const p of rest) n += p.rects.length;
    const merged = new Int32Array(n);
    let at = 0;
    let area = 0;
    for (const p of rest) { merged.set(p.rects, at); at += p.rects.length; area += p.area; }
    out.push({ id: -1, area, bbox: [0, 0, 0, 0], rings: [], rects: merged });
  }
  return out;
}

/**
 * A piece's boundary rings, traced inside its own bounds.
 *
 * `traceLabel` scans whatever grid it is handed, so tracing each piece against
 * the whole shape grid costs pieces x grid. Cropping to the piece's own box
 * makes the total proportional to the artwork's area instead, which is what it
 * should have been.
 */
function ringsFor(shapeIds, shapeImg, maskImg, piece, scale) {
  const kx = shapeImg.width / maskImg.width;
  const ky = shapeImg.height / maskImg.height;
  // One cell of slack, so a boundary never runs along the edge of the crop.
  const x0 = Math.max(0, Math.floor(piece.box[0] * kx) - 1);
  const y0 = Math.max(0, Math.floor(piece.box[1] * ky) - 1);
  const x1 = Math.min(shapeImg.width, Math.ceil(piece.box[2] * kx) + 1);
  const y1 = Math.min(shapeImg.height, Math.ceil(piece.box[3] * ky) + 1);
  const cw = x1 - x0;
  const ch = y1 - y0;
  if (cw <= 0 || ch <= 0) return [];

  const crop = new Int32Array(cw * ch);
  for (let y = 0; y < ch; y++) {
    crop.set(shapeIds.subarray((y0 + y) * shapeImg.width + x0,
                               (y0 + y) * shapeImg.width + x1), y * cw);
  }
  return traceLabel(crop, cw, ch, piece.id)
    .filter((r) => Math.abs(ringArea(r)) >= MIN_RING_AREA)
    .map((r) => {
      const o = new Float64Array(r.length);
      for (let i = 0; i < r.length; i += 2) {
        o[i] = (r[i] + x0) * scale.rx;
        o[i + 1] = (r[i + 1] + y0) * scale.ry;
      }
      return o;
    })
    .sort((a, b) => ringArea(b) - ringArea(a));
}

/**
 * Order groups the way they should be painted.
 *
 * `darkFirst` is the default because it matches how a person colours: the dark
 * linework and shadows go down first and give the picture its structure, then
 * the lighter fills. `largestFirst` lays the background in before the detail,
 * and `readingOrder` sweeps top-left to bottom-right regardless of colour.
 *
 * Every comparator falls back to the label index, so the order is total and two
 * groups that tie never swap between runs.
 */
export function orderGroups(groups, style = 'darkFirst') {
  const by = {
    darkFirst: (a, b) => (a.luma - b.luma) || (a.label - b.label),
    largestFirst: (a, b) => (b.area - a.area) || (a.label - b.label),
    readingOrder: (a, b) => (a.bbox[1] - b.bbox[1]) || (a.bbox[0] - b.bbox[0])
                          || (a.label - b.label),
  };
  return groups.slice().sort(by[style] || by.darkFirst);
}
