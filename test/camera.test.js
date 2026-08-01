/**
 * The camera: interpolation, the authoring rule that inserts holds, and the
 * promise that neither of them breaks pure-renderFrame(t).
 *
 * The interesting bug this guards against is not "the camera is in the wrong
 * place" -- that is visible immediately -- but "framing a shot at 20s makes the
 * camera creep for the whole preceding video", which looks like a slow drift
 * nobody attributes to the keyframe they just added.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createCanvas } from '@napi-rs/canvas';

import { setSurfaceFactory } from '../src/engine/render/surfaces.js';
import { cameraAt, createSession, renderFrame } from '../src/engine/render/renderFrame.js';
import { normalizeProject, projectDuration } from '../src/engine/model/project.js';
import { withCameraAt, CAMERA_MOVE_SECONDS } from '../src/ui/state/editor.js';
import { flattenPath } from '../src/engine/compile/svgPath.js';
import outlineFill from '../src/engine/anim/outlineFill.js';

setSurfaceFactory((w, h) => {
  const canvas = createCanvas(w, h);
  return { canvas, ctx: canvas.getContext('2d') };
});

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !== ${b}`);

const page = (kfs) => ({ cameraKeyframes: kfs });

// ── interpolation ─────────────────────────────────────────────────────

test('cameraAt hits each keyframe exactly at its own time', () => {
  const p = page([
    { t: 0, x: 0, y: 0, zoom: 1 },
    { t: 2, x: 300, y: -200, zoom: 4 },
  ]);
  assert.deepEqual(cameraAt(p, 0), p.cameraKeyframes[0]);
  assert.deepEqual(cameraAt(p, 2), p.cameraKeyframes[1]);
});

test('cameraAt clamps outside the keyframe range rather than extrapolating', () => {
  const p = page([{ t: 1, x: 10, y: 20, zoom: 2 }, { t: 3, x: 90, y: 20, zoom: 3 }]);
  assert.equal(cameraAt(p, -5).x, 10);
  assert.equal(cameraAt(p, 99).x, 90);
});

test('a page with no keyframes reads as the identity camera', () => {
  assert.deepEqual(cameraAt(undefined, 4), { x: 0, y: 0, zoom: 1 });
  assert.deepEqual(cameraAt(page([]), 4), { x: 0, y: 0, zoom: 1 });
});

test('zoom interpolates geometrically, so its apparent rate is constant', () => {
  // 1 -> 4 with smoothstep easing. At the midpoint smoothstep gives u = 0.5,
  // and a geometric step lands on sqrt(4) = 2 -- one doubling either side.
  // A linear lerp would land on 2.5, spending the first half of the move on
  // 1x-2.5x and the second half on 2.5x-4x, which reads as a lurch then a crawl.
  const p = page([{ t: 0, x: 0, y: 0, zoom: 1 }, { t: 2, x: 0, y: 0, zoom: 4 }]);
  near(cameraAt(p, 1).zoom, 2);

  // Equal time steps in the linear (constant-u) part must give equal ratios.
  const q = page([{ t: 0, x: 0, y: 0, zoom: 1 }, { t: 4, x: 0, y: 0, zoom: 16 }]);
  const r = (a, b) => cameraAt(q, b).zoom / cameraAt(q, a).zoom;
  near(r(2, 2.5), r(1.5, 2), 1e-9);
});

test('zoom is monotonic across a push-in', () => {
  const p = page([{ t: 0, x: 0, y: 0, zoom: 1 }, { t: 2, x: 0, y: 0, zoom: 4 }]);
  let prev = 0;
  for (let t = 0; t <= 2; t += 0.05) {
    const z = cameraAt(p, t).zoom;
    assert.ok(z >= prev, `zoom went backwards at ${t}`);
    prev = z;
  }
});

test('x and y still interpolate linearly', () => {
  const p = page([{ t: 0, x: 0, y: 0, zoom: 1 }, { t: 2, x: 400, y: 200, zoom: 4 }]);
  // smoothstep(0.5) = 0.5, so the midpoint is the arithmetic mean.
  near(cameraAt(p, 1).x, 200);
  near(cameraAt(p, 1).y, 100);
});

// ── authoring ─────────────────────────────────────────────────────────

const doc = (kfs) => ({
  pages: [{ id: 'p1', name: 'Page 1', cameraKeyframes: kfs }],
});

const kfsOf = (d) => d.pages[0].cameraKeyframes;

test('framing a shot plants a hold so the move arrives at the playhead', () => {
  const before = doc([{ t: 0, x: 0, y: 0, zoom: 1 }]);
  const after = withCameraAt(before, 'p1', 5, { x: 300, y: 120, zoom: 2.5 });
  const kfs = kfsOf(after);

  assert.equal(kfs.length, 3, 'origin, hold, and the new framing');
  assert.deepEqual(kfs[1], { t: 5 - CAMERA_MOVE_SECONDS, x: 0, y: 0, zoom: 1 },
    'the hold must carry the framing that was in effect, unchanged');
  assert.deepEqual(kfs[2], { t: 5, x: 300, y: 120, zoom: 2.5 });

  // The point of the hold: nothing moves until the second before the playhead.
  assert.deepEqual(cameraAt(after.pages[0], 3.9), { x: 0, y: 0, zoom: 1 });
  assert.equal(cameraAt(after.pages[0], 5).zoom, 2.5);
});

test('re-framing at the same instant replaces rather than accumulating', () => {
  let d = doc([{ t: 0, x: 0, y: 0, zoom: 1 }]);
  d = withCameraAt(d, 'p1', 5, { x: 300, y: 120, zoom: 2.5 });
  const afterFirst = kfsOf(d).length;

  // This is what a pan drag does: one call per pointermove, all at one time.
  for (let i = 0; i < 20; i++) {
    d = withCameraAt(d, 'p1', 5, { x: 300 + i, y: 120, zoom: 2.5 });
  }
  assert.equal(kfsOf(d).length, afterFirst, 'a drag must not plant a hold per frame');
  assert.equal(kfsOf(d).at(-1).x, 319);
  assert.deepEqual(kfsOf(d)[1], { t: 4, x: 0, y: 0, zoom: 1 }, 'the hold is untouched');
});

test('a second shot holds the first rather than reaching back past it', () => {
  let d = doc([{ t: 0, x: 0, y: 0, zoom: 1 }]);
  d = withCameraAt(d, 'p1', 5, { x: 300, y: 0, zoom: 2 });
  d = withCameraAt(d, 'p1', 12, { x: -400, y: 0, zoom: 3 });

  // Between the two shots the camera must sit still on the first one.
  const cam = cameraAt(d.pages[0], 9);
  assert.equal(cam.x, 300);
  assert.equal(cam.zoom, 2);
});

test('the hold never lands before the keyframe it holds', () => {
  // Two shots half a second apart: a full-length move would put the hold at
  // 4.7s, behind the 5.2s keyframe it is meant to preserve.
  let d = doc([{ t: 0, x: 0, y: 0, zoom: 1 }]);
  d = withCameraAt(d, 'p1', 5.2, { x: 300, y: 0, zoom: 2 });
  d = withCameraAt(d, 'p1', 5.7, { x: 900, y: 0, zoom: 3 });

  const ts = kfsOf(d).map((k) => k.t);
  assert.deepEqual([...ts].sort((a, b) => a - b), ts, 'keyframes must stay in order');
  assert.ok(new Set(ts).size === ts.length, 'no two keyframes may share a time');
});

test('addCameraKeyframe-style pinning adds one keyframe and no hold', () => {
  let d = doc([{ t: 0, x: 0, y: 0, zoom: 1 }, { t: 4, x: 200, y: 0, zoom: 2 }]);
  const live = cameraAt(d.pages[0], 2);
  d = withCameraAt(d, 'p1', 2, live, { moveDuration: 0 });

  assert.equal(kfsOf(d).length, 3);
  const { t, ...framing } = kfsOf(d)[1];
  assert.equal(t, 2);
  assert.deepEqual(cameraAt(d.pages[0], 2), framing,
    'pinning the live framing must not change what is on screen at that instant');
});

test('an unsorted keyframe list is still reasoned about correctly', () => {
  // A timeline drag deliberately leaves the list out of order; withCameraAt
  // must not treat the last array element as the latest keyframe.
  const d = withCameraAt(
    doc([{ t: 6, x: 500, y: 0, zoom: 3 }, { t: 0, x: 0, y: 0, zoom: 1 }]),
    'p1', 10, { x: 0, y: 0, zoom: 1 },
  );
  const kfs = kfsOf(d);
  assert.deepEqual(kfs.map((k) => k.t), [0, 6, 9, 10]);
  assert.deepEqual(kfs[2], { t: 9, x: 500, y: 0, zoom: 3 }, 'held from t=6, not from t=0');
});

test('editing an unknown page leaves the document alone', () => {
  const before = doc([{ t: 0, x: 0, y: 0, zoom: 1 }]);
  assert.deepEqual(withCameraAt(before, 'nope', 3, { x: 1, y: 2, zoom: 3 }), before);
});

// ── document ──────────────────────────────────────────────────────────

test('a camera move past the last stroke still gets to finish', () => {
  const base = {
    meta: { fps: 30 },
    assets: { a: { kind: 'text', text: 'hi' } },
    clips: [{ id: 'c', assetId: 'a', animId: 'draw.handwrite', start: 0, duration: 2 }],
  };
  const short = normalizeProject(base);
  const long = normalizeProject({
    ...base,
    pages: [{ id: 'page1', cameraKeyframes: [{ t: 0, x: 0, y: 0, zoom: 1 }, { t: 9, x: 0, y: 0, zoom: 1 }] }],
  });
  assert.ok(projectDuration(long) > projectDuration(short));
  assert.ok(projectDuration(long) >= 9, 'the timeline must reach the last keyframe');
});

test('normalizeProject sorts keyframes a timeline drag left out of order', () => {
  const p = normalizeProject({
    pages: [{ id: 'p', cameraKeyframes: [{ t: 4, zoom: 2 }, { t: 1, zoom: 1 }] }],
  });
  assert.deepEqual(p.pages[0].cameraKeyframes.map((k) => k.t), [1, 4]);
});

// ── determinism, with a move in flight ────────────────────────────────

const W = 480;
const H = 270;

const asset = {
  id: 'shape',
  bbox: [0, 0, 200, 200],
  subpaths: flattenPath('M 20 20 L 180 20 L 180 180 L 20 180 Z', { eps: 0.2 }),
  regions: [{
    rings: [Float64Array.from([20, 20, 180, 20, 180, 180, 20, 180])],
    bbox: [20, 20, 180, 180],
    color: '#3366cc',
  }],
};

const moving = {
  meta: { fps: 30, width: W, height: H, background: '#ffffff' },
  pages: [{
    id: 'p',
    cameraKeyframes: [
      { t: 0, x: 0, y: 0, zoom: 1 },
      { t: 1, x: 140, y: 90, zoom: 3 },
    ],
  }],
  clips: [{
    id: 'c', assetId: 'shape', animId: 'draw.outlineFill', start: 0, duration: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0 },
  }],
};

async function freshSession() {
  const s = createSession();
  s.plans.set('c', await outlineFill.compile(asset, { brushWidth: 3, fillBrushWidth: 12 }));
  return s;
}

function hashFrame(session, n) {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  renderFrame(session, moving, n, ctx, { width: W, height: H, showHand: false });
  return createHash('sha256').update(canvas.toBuffer('image/png')).digest('hex');
}

test('a frame mid-zoom is identical forward and after a backward seek', async () => {
  const target = 14;

  const fwd = await freshSession();
  let expected;
  for (let i = 0; i <= target; i++) expected = hashFrame(fwd, i);

  const scrubbed = await freshSession();
  for (let i = 0; i <= 29; i++) hashFrame(scrubbed, i);

  assert.equal(hashFrame(scrubbed, target), expected);
});

test('the camera actually changes the pixels', async () => {
  const s = await freshSession();
  const a = hashFrame(s, 29);
  const still = { ...moving, pages: [{ id: 'p', cameraKeyframes: [{ t: 0, x: 0, y: 0, zoom: 1 }] }] };
  const s2 = await freshSession();
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  for (let i = 0; i <= 29; i++) {
    renderFrame(s2, still, i, ctx, { width: W, height: H, showHand: false });
  }
  const b = createHash('sha256').update(canvas.toBuffer('image/png')).digest('hex');
  assert.notEqual(a, b, 'a zoomed frame must not match the unzoomed one');
});
