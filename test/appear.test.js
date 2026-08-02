import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';

import { setSurfaceFactory, ClipSurfaces } from '../src/engine/render/surfaces.js';
import { createSession, ensureSurfaces, renderFrame } from '../src/engine/render/renderFrame.js';
import { paintVectorArt } from '../src/engine/render/vectorArt.js';
import { getAnimation } from '../src/engine/anim/registry.js';
import '../src/engine/anim/appear.js';
import { hasInk, inkExtent, compileErase } from '../src/engine/anim/erase.js';

setSurfaceFactory((w, h) => {
  const canvas = createCanvas(w, h);
  return { canvas, ctx: canvas.getContext('2d') };
});

const ring = (...xy) => Float64Array.from(xy);
const rect = (x0, y0, x1, y1) => ring(x0, y0, x1, y0, x1, y1, x0, y1);

const asset = {
  id: 'a1',
  bbox: [0, 0, 200, 160],
  regions: [{ rings: [rect(20, 20, 180, 140)], color: '#2266cc', bbox: [20, 20, 180, 140] }],
};

const IDS = ['appear.instant', 'appear.fade', 'appear.pop', 'appear.slide'];

function surfacesFor(plan) {
  const b = plan.bbox;
  const sf = new ClipSurfaces(b[2] - b[0] + 64, b[3] - b[1] + 64, b[0] - 32, b[1] - 32);
  paintVectorArt(sf.ensureArt().ctx, asset.regions, []);
  return sf;
}

const opaque = (canvas, w, h) => {
  const d = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 128) n++;
  return n;
};

test('an entrance shows the whole artwork from its first frame', async () => {
  for (const id of IDS) {
    const anim = getAnimation(id);
    const plan = await anim.compile(asset);
    const sf = surfacesFor(plan);

    anim.advance(sf, plan, 0);
    const first = opaque(sf.composite(0), sf.w, sf.h);
    anim.advance(sf, plan, 1);
    const last = opaque(sf.composite(0), sf.w, sf.h);

    // The mask is complete throughout; a fade is opacity at blit time, not a
    // mask that grows -- otherwise the artwork would wipe on rather than fade.
    assert.equal(first, last, `${id} does not reveal everything at once`);
    assert.ok(last > 0, `${id} revealed nothing`);
  }
});

test('no entrance ever asks for a hand', async () => {
  for (const id of IDS) {
    const anim = getAnimation(id);
    const plan = await anim.compile(asset);
    const sf = surfacesFor(plan);
    for (let i = 0; i <= 10; i++) {
      const pen = anim.advance(sf, plan, i / 10);
      assert.equal(pen.active, false, `${id} put a hand on screen`);
    }
  }
});

test('opacity ramps once, monotonically, and lands exactly on 1', async () => {
  for (const id of ['appear.fade', 'appear.pop', 'appear.slide']) {
    const anim = getAnimation(id);
    const plan = await anim.compile(asset);
    let prev = -1;
    for (let i = 0; i <= 20; i++) {
      const a = anim.present(plan, i / 20, {}).alpha;
      assert.ok(a >= prev - 1e-9, `${id} dipped in opacity`);
      prev = a;
    }
    assert.equal(anim.present(plan, 0, {}).alpha, 0, `${id} starts visible`);
    assert.equal(anim.present(plan, 1, {}).alpha, 1, `${id} never reaches full opacity`);
  }
  // Instant declares no entrance at all, which is what makes it instant.
  assert.equal(getAnimation('appear.instant').present, undefined);
});

test('pop and slide land on the clip\'s own position and size', async () => {
  const pop = getAnimation('appear.pop');
  const slide = getAnimation('appear.slide');
  const plan = await pop.compile(asset);

  assert.ok(pop.present(plan, 0, {}).scale < 1, 'a pop must start smaller');
  assert.equal(pop.present(plan, 1, {}).scale, 1, 'and must finish at true size');

  const start = slide.present(plan, 0, {});
  assert.ok(Math.abs(start.dy) > 1, 'a slide must start displaced');
  assert.equal(slide.present(plan, 1, {}).dy, 0, 'and must finish on its mark');

  // Direction is a parameter, not four registrations.
  const left = slide.present(plan, 0, { direction: 'left' });
  assert.ok(Math.abs(left.dx) > 1 && left.dy === 0, 'a left slide moves in x');
});

test('the picture does not change once the clip ends', async () => {
  const project = {
    meta: { fps: 30, width: 320, height: 240, background: '#ffffff' },
    pages: [{ id: 'p1', cameraKeyframes: [{ t: 0, x: 0, y: 0, zoom: 1 }] }],
    clips: [{ id: 'c', assetId: 'a1', animId: 'appear.fade', pageId: 'p1',
              start: 0, duration: 1, transform: { x: -100, y: -80, scale: 1, rotation: 0 } }],
  };
  const anim = getAnimation('appear.fade');
  const session = createSession();
  session.plans.set('c', await anim.compile(asset));
  ensureSurfaces(session, project);
  paintVectorArt(session.surfaces.get('c').ensureArt().ctx, asset.regions, []);

  const frame = (n) => {
    const canvas = createCanvas(320, 240);
    renderFrame(session, project, n, canvas.getContext('2d'),
      { width: 320, height: 240, showHand: false });
    return canvas.toBuffer('image/png');
  };

  const mid = frame(15);
  const end = frame(30);
  assert.ok(!mid.equals(end), 'the fade must actually be visible mid-clip');
  assert.equal(anim.settles, false);
  for (const n of [31, 40, 60]) {
    assert.ok(frame(n).equals(end), `frame ${n} changed after the clip ended`);
  }
});

test('an appeared clip can still be wiped away', async () => {
  // compileErase reads plan.inkBbox first precisely because an animation can
  // lay ink without laying strokes, and an entrance lays none at all.
  const plan = await getAnimation('appear.pop').compile(asset);
  assert.deepEqual(plan.strokes, []);
  assert.ok(hasInk(plan), 'the clip plainly has ink');
  assert.deepEqual(inkExtent(plan), [20, 20, 180, 140], 'the sweep covers the artwork');

  const sweep = compileErase(plan, { id: 'c1' });
  assert.ok(sweep.strokes.length > 0, 'so it must produce a sweep');
  assert.ok(sweep.width > 3, 'sized off the artwork, not the 3px stroke default');
});
