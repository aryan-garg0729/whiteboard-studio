/**
 * `draw.stencilPaint`, and the one promise the whole rewrite exists to keep:
 * **the finished frame is the source image, exactly.**
 *
 * The animation this replaced could not promise that. It drew geometry a tracer
 * had produced -- downscaled, colour-quantised, area-thresholded and
 * Douglas-Peucker simplified -- and showed the artwork only where the pen had
 * been, so whatever the tracer dropped was missing from the last frame for good.
 * These tests are the guard on that not coming back.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { createCanvas, loadImage } from '@napi-rs/canvas';

import stencilPaint from '../src/engine/anim/stencilPaint.js';
import { analyzeArtwork, orderGroups } from '../src/engine/compile/pixels.js';
import { imagePixels } from '../src/engine/render/rasterize.js';
import { ClipSurfaces, setSurfaceFactory } from '../src/engine/render/surfaces.js';
import { twoToneImage } from './helpers/art.js';

setSurfaceFactory((w, h) => {
  const canvas = createCanvas(w, h);
  return { canvas, ctx: canvas.getContext('2d') };
});

const MODES = ['zigzag', 'colorGroups'];

/** Every bundled raster, which between them cover line art and cut-out alpha. */
const samples = () => [
  new URL('../assets/demo/lineart.png', import.meta.url),
  ...readdirSync(new URL('../assets/media/', import.meta.url))
    .filter((f) => f.endsWith('.png'))
    .map((f) => new URL(`../assets/media/${f}`, import.meta.url)),
];

/**
 * Draw a clip all the way through and hand back the finished pixels beside the
 * artwork as the engine holds it.
 *
 * The artwork surface is the honest comparison target, not the file on disk: a
 * canvas stores premultiplied alpha, so a partially transparent source cannot
 * survive a decode/read round trip byte for byte no matter what the animation
 * does. What is being pinned is that the animation adds and removes nothing.
 */
async function drawToEnd(url, mode, steps = 90) {
  const decoded = await loadImage(url);
  const { width, height } = decoded;
  const sf = new ClipSurfaces(width, height, 0, 0);
  sf.ensureArt().ctx.drawImage(decoded, 0, 0);
  const target = sf.art.ctx.getImageData(0, 0, width, height).data;

  const plan = await stencilPaint.compile(
    { id: 'a', image: imagePixels(decoded, width, height) }, { mode, colors: 8 });
  for (let i = 0; i <= steps; i++) stencilPaint.advance(sf, plan, i / steps);

  const out = sf.composite(0, false)
    .getContext('2d').getImageData(0, 0, width, height).data;
  return { out, target, plan, width, height };
}

const countDiff = (a, b) => {
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1]
      || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) n++;
  }
  return n;
};

// ── the guarantee ─────────────────────────────────────────────────────

for (const mode of MODES) {
  test(`the finished frame is the source image, exactly (${mode})`, async () => {
    for (const url of samples()) {
      const { out, target } = await drawToEnd(url, mode);
      assert.equal(countDiff(out, target), 0,
        `${url.pathname.split('/').pop()} in ${mode} mode did not finish on the source image`);
    }
  });
}

test('every pixel with any alpha is owned by exactly one colour group', async () => {
  // The decomposition is where exactness comes from: if a pixel belongs to no
  // group, no mask ever covers it and no amount of brushwork will save it.
  for (const url of samples()) {
    const decoded = await loadImage(url);
    const image = imagePixels(decoded, decoded.width, decoded.height);
    const a = analyzeArtwork(image, { colors: 8 });

    const owned = a.groups.reduce((s, g) => s + g.area, 0);
    const grid = new Set();
    for (const g of a.groups) {
      for (let i = 0; i < g.rects.length; i += 4) {
        for (let y = g.rects[i + 1]; y < g.rects[i + 3]; y++) {
          for (let x = g.rects[i]; x < g.rects[i + 2]; x++) grid.add(y * a.mask.width + x);
        }
      }
    }
    assert.equal(grid.size, owned,
      `${url.pathname.split('/').pop()}: groups overlap, so a pixel has two owners`);
  }
});

test('nothing is dropped for being small', async () => {
  // A single stray pixel in its own colour is exactly what the old minimum-area
  // threshold used to discard.
  const size = 64;
  const img = { width: size, height: size, data: new Uint8ClampedArray(size * size * 4) };
  for (let p = 0; p < size * size; p++) {
    const i = p * 4;
    img.data[i] = 255; img.data[i + 1] = 255; img.data[i + 2] = 255; img.data[i + 3] = 255;
  }
  const lone = (32 * size + 32) * 4;
  img.data[lone] = 255; img.data[lone + 1] = 0; img.data[lone + 2] = 0;

  const a = analyzeArtwork(img, { colors: 4 });
  const owned = a.groups.reduce((s, g) => s + g.area, 0);
  assert.equal(owned, size * size, 'every pixel must be owned, however lonely');

  // And it gets its own group rather than being folded into the white.
  assert.ok(a.groups.some((g) => g.area === 1 && g.color !== '#ffffff'),
    `the lone red pixel was merged away: ${a.groups.map((g) => `${g.color}:${g.area}`)}`);
});

// ── behaviour ─────────────────────────────────────────────────────────

test('there is no stencil pass: the clip is paint from the first frame', async () => {
  // The pencil sketch is gone. It spent a third of the clip drawing something
  // that was guaranteed to be erased, and artwork that wants its outline drawn
  // first has `draw.inkPaint` instead.
  const plan = await stencilPaint.compile({ id: 'a', image: twoToneImage() }, { mode: 'zigzag' });
  assert.equal(plan.phases.outline.length, 0, 'nothing is sketched first');
  assert.equal(plan.outlineShare, 0, 'so no share of the clip is spent on it');
  assert.ok(plan.phases.fill.length > 0, 'the whole clip is the paint pass');

  const sf = new ClipSurfaces(200, 200, 0, 0);
  sf.ensureArt();
  stencilPaint.advance(sf, plan, 0.2);
  assert.ok(sf.fill.used, 'paint lands from the start');
  assert.ok(!sf.ink.used, 'and nothing is ever laid in the ink layer');
});

test('nothing is drawn in a stand-in colour, so there is no pencil to erase', async () => {
  const plan = await stencilPaint.compile({ id: 'a', image: twoToneImage() }, { mode: 'zigzag' });
  assert.equal(plan.clearInkUnderFill, undefined,
    'no pen ink is laid, so composite has nothing to knock out');
  assert.equal(stencilPaint.settles, false, 'the artwork is already on screen');
});

test('a sweep direction actually changes where the pen starts', async () => {
  const image = twoToneImage();
  const first = async (sweepFrom) => {
    const plan = await stencilPaint.compile({ id: 'a', image }, { mode: 'zigzag', sweepFrom });
    const st = plan.strokes[plan.phases.fill.i0];
    return [st.pts[0], st.pts[1]];
  };
  const tl = await first('topLeft');
  const tr = await first('topRight');
  const bl = await first('bottomLeft');
  assert.notDeepEqual(tl, tr, 'topLeft and topRight must not start in the same place');
  assert.notDeepEqual(tl, bl, 'topLeft and bottomLeft must not start in the same place');
});

test('colour order is a total order, so two runs never disagree', () => {
  const groups = [
    { label: 0, luma: 0.5, area: 10, bbox: [0, 0, 1, 1] },
    { label: 1, luma: 0.5, area: 10, bbox: [0, 0, 1, 1] },
    { label: 2, luma: 0.1, area: 99, bbox: [5, 5, 6, 6] },
  ];
  for (const style of ['darkFirst', 'largestFirst', 'readingOrder']) {
    const a = orderGroups(groups, style).map((g) => g.label);
    const b = orderGroups(groups.slice().reverse(), style).map((g) => g.label);
    assert.deepEqual(a, b, `${style} must not depend on input order`);
  }
  assert.deepEqual(orderGroups(groups, 'darkFirst').map((g) => g.label), [2, 0, 1]);
  assert.deepEqual(orderGroups(groups, 'largestFirst').map((g) => g.label), [2, 0, 1]);
});

test('compiling twice gives byte-identical geometry', async () => {
  const image = twoToneImage();
  const shape = (p) => JSON.stringify(p.strokes.map((s) => Array.from(s.pts)));
  for (const mode of MODES) {
    const a = await stencilPaint.compile({ id: 'a', image }, { mode });
    const b = await stencilPaint.compile({ id: 'a', image }, { mode });
    assert.equal(shape(a), shape(b), `${mode} is not deterministic`);
  }
});

test('the plan consumes no randomness', async () => {
  const real = Math.random;
  Math.random = () => { throw new Error('stencilPaint consumed randomness'); };
  try {
    for (const mode of MODES) {
      const plan = await stencilPaint.compile({ id: 'a', image: twoToneImage() }, { mode });
      const sf = new ClipSurfaces(200, 200, 0, 0);
      sf.ensureArt();
      for (let i = 0; i <= 30; i++) stencilPaint.advance(sf, plan, i / 30);
    }
  } finally {
    Math.random = real;
  }
});

test('a backward seek lands on the same pixels as playing forward', async () => {
  const image = twoToneImage();
  const plan = await stencilPaint.compile({ id: 'a', image }, { mode: 'colorGroups' });

  const at = (visit) => {
    const sf = new ClipSurfaces(200, 200, 0, 0);
    const art = sf.ensureArt();
    art.ctx.fillStyle = '#3366cc';
    art.ctx.fillRect(0, 0, 200, 200);
    for (const u of visit) stencilPaint.advance(sf, plan, u);
    return sf.composite(0, false).getContext('2d').getImageData(0, 0, 200, 200).data;
  };

  const forward = at([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]);
  const scrubbed = at([0.1, 0.9, 0.6]);
  assert.equal(countDiff(forward, scrubbed), 0, 'a seek back must replay exactly');
});

test('a fully transparent image has no ink, so the eraser declines it', async () => {
  const blank = { width: 32, height: 32, data: new Uint8ClampedArray(32 * 32 * 4) };
  const plan = await stencilPaint.compile({ id: 'a', image: blank }, { mode: 'zigzag' });
  const [x0, y0, x1, y1] = plan.inkBbox;
  assert.ok(!(x1 > x0 && y1 > y0), 'an empty image must report a degenerate ink box');
});
