import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';

import { setSurfaceFactory, ClipSurfaces } from '../src/engine/render/surfaces.js';
import { createSession, ensureSurfaces, renderFrame } from '../src/engine/render/renderFrame.js';
import { paintVectorArt } from '../src/engine/render/vectorArt.js';
import imageReveal from '../src/engine/anim/imageReveal.js';
import outlineFill from '../src/engine/anim/outlineFill.js';
import { hasInk, inkExtent } from '../src/engine/anim/erase.js';

setSurfaceFactory((w, h) => {
  const canvas = createCanvas(w, h);
  return { canvas, ctx: canvas.getContext('2d') };
});

const ring = (...xy) => Float64Array.from(xy);
const rect = (x0, y0, x1, y1) => ring(x0, y0, x1, y0, x1, y1, x0, y1);

/**
 * Three regions, one per way a mask used to miss something:
 *  - a slab big enough to fill normally, whose far edge (107.3) deliberately
 *    does not land on a step boundary;
 *  - a 3px bar, thinner than half a scan step, which produced no scribble
 *    geometry at all and left a slash through the finished picture;
 *  - an 8px speck, too small to hold a scribble pass, which the fill skipped.
 */
function testAsset() {
  const regions = [
    { rings: [rect(10, 10, 190, 107.3)], color: '#101010', bbox: [10, 10, 190, 107.3] },
    { rings: [rect(10, 120, 190, 123)], color: '#101010', bbox: [10, 120, 190, 123] },
    { rings: [rect(150, 140, 158, 148)], color: '#101010', bbox: [150, 140, 158, 148] },
  ];
  return {
    id: 'a1',
    bbox: [0, 0, 200, 160],
    regions,
    subpaths: regions.map((r) => ({ pts: r.rings[0], closed: true })),
  };
}

const PARAMS = { brushWidth: 2, fillBrushWidth: 14 };

function surfacesFor(plan) {
  const b = plan.bbox;
  return new ClipSurfaces(b[2] - b[0] + 64, b[3] - b[1] + 64, b[0] - 32, b[1] - 32);
}

/** Install artwork built from the asset's own regions, as a vector clip would. */
function paintArt(sf, asset) {
  paintVectorArt(sf.ensureArt().ctx, asset.regions, []);
}

const pixels = (canvas, w, h) => canvas.getContext('2d').getImageData(0, 0, w, h).data;

test('the finished frame is the artwork, not an approximation of it', async () => {
  const asset = testAsset();
  const plan = await imageReveal.compile(asset, PARAMS);
  const sf = surfacesFor(plan);
  paintArt(sf, asset);

  for (let i = 0; i <= 60; i++) imageReveal.advance(sf, plan, i / 60);
  const out = pixels(sf.composite(0), sf.w, sf.h);
  const art = pixels(sf.art.canvas, sf.w, sf.h);

  let worst = 0;
  for (let i = 0; i < art.length; i += 4) {
    if (art[i + 3] === 0) continue;
    worst = Math.max(worst, Math.abs(art[i + 3] - out[i + 3]));
  }
  assert.ok(worst <= 2, `artwork and finished frame differ by ${worst} in alpha`);
});

test('no gap survives, however thin or small the shape', async () => {
  // Each of the three regions used to be missed by a different mechanism, and
  // every miss was permanent: `art` is only ever shown intersected with the
  // mask, so a pixel no brush touched never appears at all.
  const asset = testAsset();
  const plan = await imageReveal.compile(asset, PARAMS);
  const sf = surfacesFor(plan);
  paintArt(sf, asset);

  for (let i = 0; i <= 60; i++) imageReveal.advance(sf, plan, i / 60);
  const out = pixels(sf.composite(0), sf.w, sf.h);
  const art = pixels(sf.art.canvas, sf.w, sf.h);

  let missing = 0;
  for (let i = 0; i < art.length; i += 4) {
    if (art[i + 3] > 8 && out[i + 3] < art[i + 3] - 2) missing++;
  }
  assert.equal(missing, 0, `${missing} artwork pixels never made it into the frame`);
});

test('outlineFill leaves the gaps this animation exists to close', async () => {
  // Not a complaint about outlineFill -- it draws a surrogate and its mask is
  // only ever a stand-in. It is here so the difference stays visible if anyone
  // "simplifies" the two back together.
  const asset = testAsset();
  const plan = await outlineFill.compile(asset, PARAMS);
  const sf = surfacesFor(plan);
  paintArt(sf, asset);

  for (let i = 0; i <= 60; i++) outlineFill.advance(sf, plan, i / 60);
  const out = pixels(sf.composite(1), sf.w, sf.h);
  const art = pixels(sf.art.canvas, sf.w, sf.h);

  let missing = 0;
  for (let i = 0; i < art.length; i += 4) {
    if (art[i + 3] > 8 && out[i + 3] < art[i + 3] - 2) missing++;
  }
  assert.ok(missing > 0, 'expected the legacy path to still drop the speck');
});

test('the picture does not change when the pen stops', async () => {
  // The direct pin for "it draws, then the original appears". It goes through
  // renderFrame because that is where the decision lives: asking `composite`
  // for a settle would NOT be a no-op even with no ink -- it draws the revealed
  // artwork over itself, and source-over of an image onto itself raises every
  // partial alpha, so antialiased edges would quietly thicken.
  assert.equal(imageReveal.settles, false, 'the animation must opt out of settling');

  const asset = testAsset();
  const project = {
    meta: { fps: 30, width: 320, height: 240, background: '#ffffff' },
    pages: [{ id: 'p1', cameraKeyframes: [{ t: 0, x: 0, y: 0, zoom: 1 }] }],
    clips: [{ id: 'c', assetId: 'a1', animId: 'draw.imageReveal', pageId: 'p1',
              start: 0, duration: 1, transform: { x: -100, y: -80, scale: 1, rotation: 0 } }],
  };
  const session = createSession();
  session.plans.set('c', await imageReveal.compile(asset, PARAMS));
  ensureSurfaces(session, project);
  paintArt(session.surfaces.get('c'), asset);

  const frame = (n) => {
    const canvas = createCanvas(320, 240);
    renderFrame(session, project, n, canvas.getContext('2d'),
      { width: 320, height: 240, showHand: false });
    return canvas.toBuffer('image/png');
  };

  let last;
  for (let n = 0; n <= 30; n++) last = frame(n);       // the clip ends at frame 30
  // Well past SETTLE_SECONDS, which is where the old crossfade landed.
  for (const n of [31, 35, 45]) {
    assert.ok(frame(n).equals(last), `frame ${n} differs from the end of the draw`);
  }
});

test('coverage closes progressively rather than popping at the end', async () => {
  const asset = testAsset();
  const plan = await imageReveal.compile(asset, PARAMS);
  const sf = surfacesFor(plan);
  paintArt(sf, asset);

  const covered = (u) => {
    for (let i = 0; i <= 60; i++) imageReveal.advance(sf, plan, (i / 60) * u);
    const d = pixels(sf.composite(0), sf.w, sf.h);
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 128) n++;
    return n;
  };

  const nearly = covered(0.985);
  const whole = covered(1);
  assert.ok(nearly > whole * 0.9,
    `${whole - nearly} pixels arrived in the last 1.5% of the clip -- that is a pop`);
});

test('scrubbing backwards into the outline phase replays exactly', async () => {
  // Both phases share sf.fill, which is the one genuinely new interaction with
  // commitRange's committed/active split.
  const asset = testAsset();
  const plan = await imageReveal.compile(asset, PARAMS);
  const sf = surfacesFor(plan);
  paintArt(sf, asset);

  imageReveal.advance(sf, plan, 0.2);
  const first = Buffer.from(pixels(sf.composite(0), sf.w, sf.h));

  for (let i = 0; i <= 40; i++) imageReveal.advance(sf, plan, i / 40);
  sf.resetAll();                                  // what renderPage does on a backward seek
  imageReveal.advance(sf, plan, 0.2);
  const again = Buffer.from(pixels(sf.composite(0), sf.w, sf.h));

  assert.ok(first.equals(again), 'a seek back must reproduce the frame exactly');
});

test('the reveal is a pure function of u', async () => {
  const asset = testAsset();
  const plan = await imageReveal.compile(asset, PARAMS);
  const sf = surfacesFor(plan);
  paintArt(sf, asset);

  const real = Math.random;
  Math.random = () => { throw new Error('imageReveal consumed randomness'); };
  try {
    for (let i = 0; i <= 40; i++) imageReveal.advance(sf, plan, i / 40);
  } finally {
    Math.random = real;
  }
});

test('erase can find the ink, including regions only a closure covered', async () => {
  const asset = testAsset();
  const plan = await imageReveal.compile(asset, PARAMS);
  assert.ok(hasInk(plan));

  const ext = inkExtent(plan);
  // The speck at 150..158 is revealed by its closure alone -- no stroke passes
  // through it -- so a stroke scan would size the sweep short of it.
  assert.ok(ext[2] >= 158, `sweep stops at x=${ext[2]}, short of the last region`);
  assert.ok(ext[3] >= 148, `sweep stops at y=${ext[3]}, short of the last region`);
  // ...but it must not simply be the drawable bbox, which carries paper margin.
  assert.ok(ext[0] > plan.bbox[0], 'the sweep must be the ink, not the whole drawable');
});
