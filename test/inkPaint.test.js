/**
 * `draw.inkPaint` — outline first, then colour, for whiteboard artwork.
 *
 * Two promises are under test, and they pull in opposite directions, which is
 * the whole reason this animation is interesting.
 *
 * **The finished frame is the source image, exactly**, the same guarantee
 * `stencilPaint` makes and for the same structural reason: coverage comes from
 * per-pixel ownership, never from where the brush happened to go.
 *
 * **The outline is revealed at its real thickness** while the hand only ever
 * walks a one-pixel centreline down the middle of it. Those are two different
 * things, and the tests below pin that they stay different — a nib sized to
 * cover the line would round every corner and fatten the drawing, and a reveal
 * sized to the centreline would show a hairline instead of the outline.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { createCanvas, loadImage } from '@napi-rs/canvas';

import inkPaint from '../src/engine/anim/inkPaint.js';
import {
  analyzeArtwork, connectedPieces, encodeRects, encodeRectsMulti,
  flatPalette, pickInkLabels,
} from '../src/engine/compile/pixels.js';
import {
  assignOwners, centerlines, chainSkeleton, maskFromRects, seedPolyline, thin,
} from '../src/engine/compile/centerline.js';
import { imagePixels } from '../src/engine/render/rasterize.js';
import { ClipSurfaces, setSurfaceFactory } from '../src/engine/render/surfaces.js';

setSurfaceFactory((w, h) => {
  const canvas = createCanvas(w, h);
  return { canvas, ctx: canvas.getContext('2d') };
});

/** Every bundled raster, which between them cover line art and cut-out alpha. */
const samples = () => [
  new URL('../assets/demo/lineart.png', import.meta.url),
  ...readdirSync(new URL('../assets/media/', import.meta.url))
    .filter((f) => f.endsWith('.png'))
    .map((f) => new URL(`../assets/media/${f}`, import.meta.url)),
];

const countDiff = (a, b) => {
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1]
      || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) n++;
  }
  return n;
};

/**
 * Synthetic whiteboard artwork: flat fills behind a thick black outline, with
 * a per-channel wobble so nothing is exactly one colour.
 *
 * The wobble is the point. Real artwork is never bit-exact — a JPEG round trip,
 * a gradient that reads as flat, an editor's own dithering — and a quantiser
 * that only works on synthetically perfect input would be no use.
 */
function clipart({ noise = 3, size = 200, outline = 9 } = {}) {
  const data = new Uint8ClampedArray(size * size * 4);
  const wob = (v, x, y) => v + ((x * 7 + y * 13) % (2 * noise + 1)) - noise;
  const boxes = [
    { x0: 20, y0: 20, x1: 100, y1: 100, c: [224, 58, 58] },
    { x0: 110, y0: 20, x1: 180, y1: 100, c: [58, 120, 224] },
    { x0: 20, y0: 110, x1: 180, y1: 180, c: [240, 200, 60] },
  ];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let c = [253, 253, 251];
      let ink = false;
      for (const b of boxes) {
        if (x >= b.x0 && x < b.x1 && y >= b.y0 && y < b.y1) c = b.c;
        const on = (v, e) => Math.abs(v - e) < outline / 2;
        if (x >= b.x0 - outline && x <= b.x1 + outline
          && y >= b.y0 - outline && y <= b.y1 + outline
          && (on(x, b.x0) || on(x, b.x1) || on(y, b.y0) || on(y, b.y1))
          && x >= b.x0 - outline / 2 && x <= b.x1 + outline / 2
          && y >= b.y0 - outline / 2 && y <= b.y1 + outline / 2) ink = true;
      }
      const i = (y * size + x) * 4;
      const rgb = ink ? [16, 16, 16] : c;
      data[i] = wob(rgb[0], x, y);
      data[i + 1] = wob(rgb[1], x, y);
      data[i + 2] = wob(rgb[2], x, y);
      data[i + 3] = 255;
    }
  }
  return { width: size, height: size, data };
}

async function drawToEnd(url, params = {}, steps = 90) {
  const decoded = await loadImage(url);
  const { width, height } = decoded;
  const sf = new ClipSurfaces(width, height, 0, 0);
  sf.ensureArt().ctx.drawImage(decoded, 0, 0);
  const target = sf.art.ctx.getImageData(0, 0, width, height).data;

  const plan = await inkPaint.compile(
    { id: 'a', image: imagePixels(decoded, width, height) }, params);
  for (let i = 0; i <= steps; i++) inkPaint.advance(sf, plan, i / steps);

  const out = sf.composite(0, false).getContext('2d').getImageData(0, 0, width, height).data;
  return { out, target, plan };
}

// ── the guarantee ─────────────────────────────────────────────────────

test('the finished frame is the source image, exactly', async () => {
  for (const url of samples()) {
    const { out, target } = await drawToEnd(url);
    assert.equal(countDiff(out, target), 0,
      `${url.pathname.split('/').pop()} did not finish on the source image`);
  }
});

test('a rasterised vector finishes on the source image too', async () => {
  // The host rasterises SVG before compile, so both asset kinds arrive here as
  // pixels. This pins that the one pipeline really is one pipeline.
  const size = 160;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#e03a3a';
  ctx.fillRect(30, 30, 100, 100);
  ctx.strokeStyle = '#101010';
  ctx.lineWidth = 8;
  ctx.strokeRect(30, 30, 100, 100);

  const sf = new ClipSurfaces(size, size, 0, 0);
  sf.ensureArt().ctx.drawImage(canvas, 0, 0);
  const target = sf.art.ctx.getImageData(0, 0, size, size).data;

  const image = ctx.getImageData(0, 0, size, size);
  const plan = await inkPaint.compile(
    { id: 'v', image: { width: size, height: size, data: image.data } }, {});
  for (let i = 0; i <= 60; i++) inkPaint.advance(sf, plan, i / 60);

  const out = sf.composite(0, false).getContext('2d').getImageData(0, 0, size, size).data;
  assert.equal(countDiff(out, target), 0);
});

test('every ink pixel belongs to exactly one stroke', async () => {
  // The ink pass partitions the outline among its strokes. A pixel owned twice
  // is a stroke revealing something it did not draw; a pixel owned by none is a
  // permanent hole. Both would still *look* fine at u = 1 because of the
  // backstop, which is exactly why this is checked at the decomposition.
  const a = analyzeArtwork(clipart(), { palette: 'flat', pieces: true });
  const labels = pickInkLabels(a.groups);
  assert.ok(labels.length, 'the synthetic clipart has a black outline');

  const { width: W, height: H } = a.mask;
  const byLabel = new Map(a.groups.map((g) => [g.label, g]));
  const mask = maskFromRects(labels.map((l) => byLabel.get(l).rects), W, H);
  const { paths, scale } = centerlines(mask, W, H);

  const seeds = new Int32Array(W * H).fill(-1);
  paths.forEach((p, i) => seedPolyline(seeds, W, H, p.pts, i, scale));
  const owner = assignOwners(mask, seeds, W, H, paths.length);

  let inkPixels = 0;
  let unowned = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    inkPixels++;
    if (owner[i] < 0) unowned++;
  }
  assert.ok(inkPixels > 0);
  assert.equal(unowned, 0, 'every ink pixel must have an owner');

  // And the per-owner rectangles reproduce the mask exactly.
  const byStroke = encodeRectsMulti(owner, W, H, paths.length + 1);
  const seen = new Set();
  for (const rects of byStroke) {
    for (let i = 0; i < rects.length; i += 4) {
      for (let y = rects[i + 1]; y < rects[i + 3]; y++) {
        for (let x = rects[i]; x < rects[i + 2]; x++) {
          const p = y * W + x;
          assert.ok(!seen.has(p), 'a pixel is claimed by two strokes');
          seen.add(p);
        }
      }
    }
  }
  assert.equal(seen.size, inkPixels, 'the closures must cover the outline exactly');
});

test('the outline is revealed at full thickness, not as a hairline', async () => {
  // The heart of the design: the hand walks a one-pixel centreline, but what
  // appears is the whole slab of line. If coverage were derived from the path,
  // a 9px outline would come back a fraction as wide.
  const image = clipart({ outline: 9, noise: 0 });
  const a = analyzeArtwork(image, { palette: 'flat', pieces: true });
  const labels = pickInkLabels(a.groups);
  const byLabel = new Map(a.groups.map((g) => [g.label, g]));
  const { width: W, height: H } = a.mask;
  const mask = maskFromRects(labels.map((l) => byLabel.get(l).rects), W, H);

  const inkArea = mask.reduce((s, v) => s + v, 0);
  const { paths, scale } = centerlines(mask, W, H);
  let pathLength = 0;
  for (const p of paths) {
    for (let i = 2; i < p.pts.length; i += 2) {
      pathLength += Math.hypot(p.pts[i] - p.pts[i - 2], p.pts[i + 1] - p.pts[i - 1]) * scale;
    }
  }
  // Area over length is the mean thickness the reveal actually delivers.
  const thickness = inkArea / pathLength;
  assert.ok(thickness > 6 && thickness < 13,
    `the outline should reveal about 9px thick, got ${thickness.toFixed(1)}`);

  // Meanwhile the centreline itself is one pixel wide by construction.
  const skeleton = thin(mask, W, H);
  const skelPixels = skeleton.reduce((s, v) => s + v, 0);
  assert.ok(skelPixels * 4 < inkArea,
    'the centreline must be far thinner than the line it runs down');
});

// ── quantisation ──────────────────────────────────────────────────────

test('slight colour variation is treated as one colour', async () => {
  // Four flat fills plus a black outline, every pixel wobbled by up to 3 per
  // channel. A fixed-count median cut splits some of these and merges others;
  // anchoring on the flat fills must find exactly five.
  const a = analyzeArtwork(clipart({ noise: 3 }), { palette: 'flat' });
  assert.equal(a.groups.length, 5,
    `expected 5 groups, got ${a.groups.map((g) => `${g.color}:${g.area}`).join(' ')}`);

  const inks = pickInkLabels(a.groups);
  assert.equal(inks.length, 1, 'exactly one group is the linework');
  const ink = a.groups.find((g) => g.label === inks[0]);
  assert.ok(ink.luma < 0.12, `the ink group should be near black, got ${ink.color}`);
});

test('a wider tolerance merges more, a narrower one merges less', () => {
  const image = clipart({ noise: 3 });
  const counts = [2, 14, 50].map(
    (tolerance) => analyzeArtwork(image, { palette: 'flat', tolerance }).groups.length);
  assert.ok(counts[0] >= counts[1], `tolerance 2 should not merge more than 14: ${counts}`);
  assert.ok(counts[1] >= counts[2], `tolerance 14 should not merge more than 50: ${counts}`);
  assert.ok(counts[2] < counts[0], `tolerance must actually do something: ${counts}`);
});

test('the flat palette still owns every pixel', () => {
  for (const noise of [0, 3, 12]) {
    const image = clipart({ noise });
    const a = analyzeArtwork(image, { palette: 'flat' });
    const owned = a.groups.reduce((s, g) => s + g.area, 0);
    assert.equal(owned, a.mask.width * a.mask.height,
      `noise ${noise}: every pixel must belong to a group`);
  }
});

test('artwork with no dark neutral group has no linework', () => {
  const size = 64;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let p = 0; p < size * size; p++) {
    const i = p * 4;
    data[i] = p % 2 ? 240 : 90; data[i + 1] = 200; data[i + 2] = 90; data[i + 3] = 255;
  }
  const a = analyzeArtwork({ width: size, height: size, data }, { palette: 'flat' });
  assert.deepEqual(pickInkLabels(a.groups), [], 'nothing here is black linework');
});

// ── pieces ────────────────────────────────────────────────────────────

test('one colour in three places is three shapes', () => {
  // A colour is not a place: the fill pass should visit the shirt and each shoe
  // in turn rather than scribbling across all of them as one region.
  const size = 90;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let p = 0; p < size * size; p++) {
    const i = p * 4;
    data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; data[i + 3] = 255;
  }
  const blob = (x0, y0) => {
    for (let y = y0; y < y0 + 20; y++) {
      for (let x = x0; x < x0 + 20; x++) {
        const i = (y * size + x) * 4;
        data[i] = 224; data[i + 1] = 58; data[i + 2] = 58;
      }
    }
  };
  blob(5, 5); blob(60, 5); blob(5, 60);

  const a = analyzeArtwork({ width: size, height: size, data }, { palette: 'flat', pieces: true });
  const red = a.groups.find((g) => g.color.startsWith('#e'));
  assert.ok(red, 'the red group exists');
  assert.equal(red.pieces.filter((p) => p.rings.length).length, 3,
    'three disjoint blobs are three drawable shapes');

  // Whatever the split, the pieces still add up to the group.
  assert.equal(red.pieces.reduce((s, p) => s + p.area, 0), red.area);
});

test('specks keep their pixels without becoming shapes of their own', () => {
  // An antialiased edge fragments into thousands of one-pixel islands. None is
  // worth a trip of the pen, and every one must still be painted.
  const size = 80;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let p = 0; p < size * size; p++) {
    const i = p * 4;
    data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; data[i + 3] = 255;
  }
  for (let y = 10; y < 50; y++) {
    for (let x = 10; x < 50; x++) {
      const i = (y * size + x) * 4;
      data[i] = 30; data[i + 1] = 30; data[i + 2] = 30;
    }
  }
  // Scattered lone dark pixels, each its own connected piece.
  for (let k = 0; k < 40; k++) {
    const i = ((60 + (k % 8)) * size + (5 + k * 2) % size) * 4;
    data[i] = 30; data[i + 1] = 30; data[i + 2] = 30;
  }

  const a = analyzeArtwork({ width: size, height: size, data }, { palette: 'flat', pieces: true });
  for (const g of a.groups) {
    assert.equal(g.pieces.reduce((s, p) => s + p.area, 0), g.area,
      `${g.color}: pieces must account for every pixel of the group`);
  }
  const dark = a.groups.find((g) => g.luma < 0.2);
  assert.ok(dark.pieces.some((p) => p.rings.length === 0),
    'the specks should be folded into a ringless remainder');
});

test('encodeRectsMulti agrees with encodeRects, one id at a time', () => {
  const w = 40;
  const h = 30;
  const ids = new Int32Array(w * h);
  for (let i = 0; i < ids.length; i++) ids[i] = (i * 7 + (i % 5)) % 4;
  const multi = encodeRectsMulti(ids, w, h, 4);
  for (let id = 0; id < 4; id++) {
    assert.deepEqual(Array.from(multi[id]), Array.from(encodeRects(ids, w, h, id)),
      `id ${id} disagrees`);
  }
});

// ── behaviour ─────────────────────────────────────────────────────────

test('the outline is inked before any colour lands', async () => {
  const plan = await inkPaint.compile({ id: 'a', image: clipart() }, {});
  assert.ok(plan.phases.outline.length > 0, 'there must be an outline to ink');
  assert.ok(plan.phases.fill.length > 0, 'and a colour pass after it');

  for (let i = plan.phases.outline.i0; i < plan.phases.outline.i1; i++) {
    assert.notEqual(plan.strokes[i].kind, 'FILL', 'a colour stroke landed in the ink pass');
  }
});

test('nothing is drawn in a stand-in colour, so there is no pencil to erase', async () => {
  const plan = await inkPaint.compile({ id: 'a', image: clipart() }, {});
  assert.equal(plan.clearInkUnderFill, undefined,
    'inkPaint lays no pen ink, so composite has nothing to knock out');
  assert.equal(inkPaint.settles, false, 'the artwork is already on screen');

  const sf = new ClipSurfaces(200, 200, 0, 0);
  sf.ensureArt();
  inkPaint.advance(sf, plan, plan.outlineShare * 0.5);
  assert.ok(sf.fill.used, 'the outline pass lays coverage into the fill layer');
  assert.ok(!sf.ink.used, 'and never into the ink layer');
});

test('compiling twice gives byte-identical geometry', async () => {
  const image = clipart();
  const shape = (p) => JSON.stringify(p.strokes.map((s) => Array.from(s.pts)));
  const a = await inkPaint.compile({ id: 'a', image }, {});
  const b = await inkPaint.compile({ id: 'a', image }, {});
  assert.equal(shape(a), shape(b), 'inkPaint is not deterministic');
});

test('the plan consumes no randomness', async () => {
  const real = Math.random;
  Math.random = () => { throw new Error('inkPaint consumed randomness'); };
  try {
    const plan = await inkPaint.compile({ id: 'a', image: clipart() }, {});
    const sf = new ClipSurfaces(200, 200, 0, 0);
    sf.ensureArt();
    for (let i = 0; i <= 30; i++) inkPaint.advance(sf, plan, i / 30);
  } finally {
    Math.random = real;
  }
});

test('a backward seek lands on the same pixels as playing forward', async () => {
  const image = clipart();
  const plan = await inkPaint.compile({ id: 'a', image }, {});

  const at = (visit) => {
    const sf = new ClipSurfaces(200, 200, 0, 0);
    const art = sf.ensureArt();
    art.ctx.fillStyle = '#3366cc';
    art.ctx.fillRect(0, 0, 200, 200);
    for (const u of visit) inkPaint.advance(sf, plan, u);
    return sf.composite(0, false).getContext('2d').getImageData(0, 0, 200, 200).data;
  };

  assert.equal(countDiff(at([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]), at([0.1, 0.9, 0.6])), 0,
    'a seek back must replay exactly');
});

// ── degenerate input ──────────────────────────────────────────────────

test('a fully transparent image has no ink, so the eraser declines it', async () => {
  const blank = { width: 32, height: 32, data: new Uint8ClampedArray(32 * 32 * 4) };
  const plan = await inkPaint.compile({ id: 'a', image: blank }, {});
  const [x0, y0, x1, y1] = plan.inkBbox;
  assert.ok(!(x1 > x0 && y1 > y0), 'an empty image must report a degenerate ink box');
});

test('artwork with no outline still compiles and still finishes exactly', async () => {
  // No dark neutral group at all, so there is no ink pass. The colour pass has
  // to carry the whole picture rather than the compile failing.
  const size = 96;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const hot = x > size / 2;
      data[i] = hot ? 240 : 90; data[i + 1] = 200; data[i + 2] = hot ? 90 : 200;
      data[i + 3] = 255;
    }
  }
  const image = { width: size, height: size, data };
  const plan = await inkPaint.compile({ id: 'a', image }, {});
  assert.equal(plan.phases.outline.length, 0, 'no linework means no ink pass');
  assert.ok(plan.phases.fill.length > 0, 'but the colour pass must still exist');

  const sf = new ClipSurfaces(size, size, 0, 0);
  const art = sf.ensureArt();
  const blit = art.ctx.createImageData(size, size);
  blit.data.set(data);
  art.ctx.putImageData(blit, 0, 0);
  const target = art.ctx.getImageData(0, 0, size, size).data;

  for (let i = 0; i <= 60; i++) inkPaint.advance(sf, plan, i / 60);
  const out = sf.composite(0, false).getContext('2d').getImageData(0, 0, size, size).data;
  assert.equal(countDiff(out, target), 0);
});

test('an image that is nothing but linework still finishes exactly', async () => {
  const size = 64;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const on = Math.abs(x - y) < 4;
      data[i] = on ? 12 : 12; data[i + 1] = 12; data[i + 2] = 12;
      data[i + 3] = on ? 255 : 0;
    }
  }
  const plan = await inkPaint.compile({ id: 'a', image: { width: size, height: size, data } }, {});
  assert.ok(plan.phases.outline.length > 0, 'the diagonal bar is linework');
  // The ink pass has to carry the backstop when there is nothing to colour.
  const inkStrokes = plan.strokes.slice(0, plan.phases.outline.i1).filter((s) => !s.lift);
  assert.ok(inkStrokes.some((s) => s.closure && s.closure.length),
    'the ink pass must close its own coverage');
});

test('a one-pixel-wide line is still traced and still owned', () => {
  // Thinning a shape that is already one pixel thick must be a no-op rather
  // than erasing it, and the chaining must find the line rather than nothing.
  const w = 60;
  const h = 20;
  const mask = new Uint8Array(w * h);
  for (let x = 5; x < 55; x++) mask[10 * w + x] = 1;

  const skeleton = thin(mask, w, h);
  assert.equal(skeleton.reduce((s, v) => s + v, 0), 50, 'a 1px line survives thinning intact');

  const chains = chainSkeleton(skeleton, w, h);
  assert.equal(chains.length, 1, 'and chains into a single polyline');

  const { ids, count } = connectedPieces(mask, w, h, 1);
  assert.equal(count, 1);
  assert.equal(ids.filter((v) => v === 0).length, 50);
});

test('the flat palette never returns an empty palette', () => {
  const empty = { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4) };
  assert.equal(flatPalette(empty).length, 1, 'a transparent image still yields one entry');

  // A pure gradient has no flat colour anywhere, so no bin clears the anchor
  // floor. The most populous one still has to anchor.
  const size = 64;
  const ramp = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      ramp[i] = (x * 4) % 256; ramp[i + 1] = (y * 4) % 256; ramp[i + 2] = 128; ramp[i + 3] = 255;
    }
  }
  assert.ok(flatPalette({ width: size, height: size, data: ramp }).length >= 1);
});
