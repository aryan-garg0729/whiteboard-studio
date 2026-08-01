/**
 * Guards the pure-renderFrame(t) contract.
 *
 * If this breaks, exports flicker and scrubbing disagrees with playback -- and
 * the cause is invisible until someone reports it, because a single run always
 * looks self-consistent. The usual culprits are a stray Math.random, a
 * Date.now, or an IIR filter that carries state between frames.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createCanvas } from '@napi-rs/canvas';

import { setSurfaceFactory } from '../src/engine/render/surfaces.js';
import { createSession, renderFrame } from '../src/engine/render/renderFrame.js';
import { flattenPath } from '../src/engine/compile/svgPath.js';
import outlineFill from '../src/engine/anim/outlineFill.js';

setSurfaceFactory((w, h) => {
  const canvas = createCanvas(w, h);
  return { canvas, ctx: canvas.getContext('2d') };
});

const W = 480;
const H = 270;
const FPS = 30;
const ring = (...xy) => Float64Array.from(xy);

const asset = {
  id: 'shape',
  bbox: [0, 0, 200, 200],
  subpaths: flattenPath('M 20 20 L 180 20 L 180 180 L 20 180 Z M 60 60 L 140 140', { eps: 0.2 }),
  regions: [{ rings: [ring(20, 20, 180, 20, 180, 180, 20, 180)], bbox: [20, 20, 180, 180], color: '#3366cc' }],
};

const project = {
  meta: { fps: FPS, width: W, height: H, background: '#ffffff' },
  pages: [{ id: 'p', cameraKeyframes: [{ t: 0, x: 100, y: 100, zoom: 1 }] }],
  clips: [{ id: 'c', assetId: 'shape', animId: 'draw.outlineFill', start: 0, duration: 1,
            transform: { x: 0, y: 0, scale: 1, rotation: 0 } }],
};

async function freshSession() {
  const s = createSession();
  s.plans.set('c', await outlineFill.compile(asset, { brushWidth: 3, fillBrushWidth: 12 }));
  return s;
}

function hashFrame(session, n) {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  renderFrame(session, project, n, ctx, { width: W, height: H, showHand: false });
  return createHash('sha256').update(canvas.toBuffer('image/png')).digest('hex');
}

test('the same frame renders identically in two independent sessions', async () => {
  const a = await freshSession();
  const b = await freshSession();
  for (const n of [0, 7, 15, 22, 29]) {
    // each session walks forward independently to the target frame
    const ha = (() => { let h; for (let i = 0; i <= n; i++) h = hashFrame(a, i); return h; })();
    const hb = (() => { let h; for (let i = 0; i <= n; i++) h = hashFrame(b, i); return h; })();
    assert.equal(ha, hb, `frame ${n} differs between sessions`);
  }
});

test('compiling twice yields byte-identical geometry', async () => {
  const p1 = await outlineFill.compile(asset, { brushWidth: 3, fillBrushWidth: 12 });
  const p2 = await outlineFill.compile(asset, { brushWidth: 3, fillBrushWidth: 12 });
  assert.equal(p1.strokes.length, p2.strokes.length);
  for (let i = 0; i < p1.strokes.length; i++) {
    assert.deepEqual([...p1.strokes[i].pts], [...p2.strokes[i].pts], `stroke ${i} differs`);
  }
});

test('seeking backward reproduces the forward-played frame exactly', async () => {
  const fwd = await freshSession();
  const target = 12;
  let expected;
  for (let i = 0; i <= target; i++) expected = hashFrame(fwd, i);

  // same session, now scrubbed past the target and back
  const s = await freshSession();
  for (let i = 0; i <= 25; i++) hashFrame(s, i);
  const afterSeek = hashFrame(s, target);

  assert.equal(afterSeek, expected,
    'a backward seek must land on the same pixels forward playback produced');
});

test('renderFrame does not consume randomness', async () => {
  const session = await freshSession();
  const real = Math.random;
  Math.random = () => { throw new Error('renderFrame called Math.random'); };
  try {
    for (let i = 0; i < 20; i++) hashFrame(session, i);
  } finally {
    Math.random = real;
  }
});

test('frame time derives from the index rather than accumulating', async () => {
  // Frame 30 at 30fps must be exactly t=1.0. Accumulating 1/30 thirty times
  // lands on 0.9999999999999999 and the clip would not read as complete.
  const session = await freshSession();
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  for (let i = 0; i <= 30; i++) {
    renderFrame(session, project, i, ctx, { width: W, height: H, showHand: false });
  }
  const sf = session.surfaces.get('c');
  assert.equal(sf.lastProgress, 1, 'clip should be exactly complete at frame 30');
});
