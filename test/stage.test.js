/**
 * Stage coordinate maths and the two engine behaviours the editor leans on:
 * the settle-to-original crossfade and the hand's shaft-angle folding.
 *
 * The mapping tests matter because an error here is invisible in code review
 * and shows up as selection handles that drift away from the artwork.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MIN_SCALE, clipRect, cornerPoints, hitTest, localToWorld,
  resizeTransform, screenToWorld, worldPerPixel, worldToScreen,
} from '../src/ui/stageGeom.js';
import { readFileSync } from 'node:fs';

import { rotationFor, shaftAngle, solveHand } from '../src/engine/hand/rig.js';
import { SETTLE_SECONDS, settleAt } from '../src/engine/render/renderFrame.js';

const meta = { width: 1920, height: 1080 };
const cam0 = { x: 0, y: 0, zoom: 1 };
const DEG = 180 / Math.PI;
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !== ${b}`);

// ── coordinate mapping ────────────────────────────────────────────────

test('screenToWorld inverts worldToScreen at any zoom and fit', () => {
  for (const cam of [cam0, { x: 120, y: -75, zoom: 2.5 }, { x: -400, y: 900, zoom: 0.3 }]) {
    for (const fit of [1, 0.5389, 0.25]) {
      const s = worldToScreen(meta, cam, fit, 321, -654);
      const w = screenToWorld(meta, cam, fit, s.x, s.y);
      near(w.x, 321, 1e-9);
      near(w.y, -654, 1e-9);
    }
  }
});

test('world origin sits at the centre of the frame', () => {
  const s = worldToScreen(meta, cam0, 1, 0, 0);
  assert.deepEqual([s.x, s.y], [960, 540]);
});

test('worldPerPixel is the drag conversion factor', () => {
  const cam = { x: 0, y: 0, zoom: 2 };
  const fit = 0.5;
  const a = screenToWorld(meta, cam, fit, 100, 0);
  const b = screenToWorld(meta, cam, fit, 101, 0);
  near(b.x - a.x, worldPerPixel(cam, fit));
});

test('clipRect places a clip where renderFrame draws it', () => {
  // renderFrame composes: canvas = size/2 + (world - cam) * zoom, and
  // world = transform + local * scale. The rect must agree exactly.
  const tr = { x: -400, y: -300, scale: 0.5 };
  const bbox = [0, 0, 800, 600];
  const r = clipRect(meta, cam0, 1, tr, bbox);
  assert.deepEqual(
    [r.left, r.top, r.width, r.height],
    [960 - 400, 540 - 300, 400, 300],
  );
});

test('clipRect follows the camera, so handles do not drift when it moves', () => {
  const tr = { x: 0, y: 0, scale: 1 };
  const bbox = [0, 0, 100, 100];
  const still = clipRect(meta, cam0, 1, tr, bbox);
  const panned = clipRect(meta, { x: 50, y: 0, zoom: 1 }, 1, tr, bbox);
  near(still.left - panned.left, 50);
});

// ── selection ─────────────────────────────────────────────────────────

test('hitTest picks the topmost clip where they overlap', () => {
  const boxes = [
    { id: 'under', rect: { left: 0, top: 0, width: 100, height: 100 } },
    { id: 'over', rect: { left: 50, top: 50, width: 100, height: 100 } },
  ];
  assert.equal(hitTest(boxes, 75, 75), 'over', 'later clips draw on top');
  assert.equal(hitTest(boxes, 10, 10), 'under');
  assert.equal(hitTest(boxes, 400, 400), null);
});

// ── resize ────────────────────────────────────────────────────────────

test('each corner is anchored on its opposite', () => {
  const bbox = [10, 20, 110, 220];
  assert.deepEqual(cornerPoints(bbox, 'se'), { grabbed: [110, 220], anchor: [10, 20] });
  assert.deepEqual(cornerPoints(bbox, 'nw'), { grabbed: [10, 20], anchor: [110, 220] });
  assert.deepEqual(cornerPoints(bbox, 'ne'), { grabbed: [110, 20], anchor: [10, 220] });
  assert.deepEqual(cornerPoints(bbox, 'sw'), { grabbed: [10, 220], anchor: [110, 20] });
});

test('resizing holds the opposite corner still', () => {
  const tr = { x: 100, y: 200, scale: 1 };
  const bbox = [0, 0, 400, 300];
  for (const corner of ['nw', 'ne', 'se', 'sw']) {
    const { anchor } = cornerPoints(bbox, corner);
    const before = localToWorld(tr, anchor[0], anchor[1]);
    const next = resizeTransform(tr, bbox, corner, 700, 900);
    const after = localToWorld(next, anchor[0], anchor[1]);
    near(after.x, before.x, 1e-9);
    near(after.y, before.y, 1e-9);
  }
});

test('dragging a corner to where it already is leaves the scale alone', () => {
  const tr = { x: -50, y: -50, scale: 0.8 };
  const bbox = [0, 0, 800, 700];
  const { grabbed } = cornerPoints(bbox, 'se');
  const at = localToWorld(tr, grabbed[0], grabbed[1]);
  const next = resizeTransform(tr, bbox, 'se', at.x, at.y);
  near(next.scale, 0.8, 1e-9);
});

test('scale is clamped so a clip can never collapse to nothing', () => {
  const tr = { x: 0, y: 0, scale: 1 };
  const bbox = [0, 0, 400, 300];
  // Drag the SE corner exactly onto its NW anchor.
  const next = resizeTransform(tr, bbox, 'se', 0, 0);
  assert.equal(next.scale, MIN_SCALE);
});

test('a degenerate bbox cannot produce a division by zero', () => {
  const tr = { x: 5, y: 5, scale: 2 };
  const next = resizeTransform(tr, [7, 7, 7, 7], 'se', 900, 900);
  assert.deepEqual(next, { x: 5, y: 5, scale: 2 });
});

// ── hand rotation ─────────────────────────────────────────────────────

test('shaftAngle folds reversed travel onto the same pen pose', () => {
  // A pen does not flip end-for-end when the stroke reverses.
  for (const deg of [0, 30, -30, 45, 89]) {
    near(shaftAngle(deg / DEG), shaftAngle((deg + 180) / DEG), 1e-9);
  }
});

test('shaftAngle lands in (-90, 90]', () => {
  for (let d = -360; d <= 360; d += 7) {
    const a = shaftAngle(d / DEG) * DEG;
    assert.ok(a > -90.0001 && a <= 90.0001, `${d} -> ${a}`);
  }
});

test('serpentine fill no longer swings the hand every scan line', () => {
  // This was the dominant source of the hand looking frantic: a -45deg
  // scribble alternates travel direction on every pass, and following the raw
  // tangent alternated the sprite between -11deg and the +25deg clamp.
  const style = { alignFactor: 0.16, maxRotationDeg: 25 };
  const out = [-45, 135, -45, 135].map((d) => rotationFor(style, d / DEG));
  for (const r of out) near(r, out[0], 1e-9);
});

test('rotation stays well inside the clamp the scale solve assumes', () => {
  // minScale() guarantees the arm reaches a frame edge for rotations up to
  // maxRotationDeg. Exceeding it would detach the hand.
  const style = { alignFactor: 0.16, maxRotationDeg: 25 };
  let worst = 0;
  for (let d = -360; d <= 360; d += 3) {
    worst = Math.max(worst, Math.abs(rotationFor(style, d / DEG) * DEG));
  }
  assert.ok(worst <= 25, `${worst} exceeds the clamp`);
  assert.ok(worst < 15, `expected a calm hand, got +/-${worst.toFixed(1)}deg`);
});

// ── settle ────────────────────────────────────────────────────────────

test('settle starts only once the clip has finished drawing', () => {
  const clip = { start: 1, duration: 2 };          // draws 1s .. 3s
  assert.equal(settleAt(clip, 0), 0);
  assert.equal(settleAt(clip, 2.9), 0, 'still drawing');
  assert.equal(settleAt(clip, 3), 0, 'the instant it lands');
  near(settleAt(clip, 3 + SETTLE_SECONDS / 2), 0.5, 1e-9);
  assert.equal(settleAt(clip, 3 + SETTLE_SECONDS), 1);
  assert.equal(settleAt(clip, 99), 1, 'and stays settled');
});

test('settle is a pure function of time, so seeking is exact', () => {
  const clip = { start: 0.2, duration: 4.2 };
  const t = 4.5;
  assert.equal(settleAt(clip, t), settleAt(clip, t));
  assert.ok(settleAt(clip, t) > settleAt(clip, t - 0.1));
});

// ── hand reach ────────────────────────────────────────────────────────

test('stretchBand is normalised, not absolute source rows', () => {
  // One manifest serves every resolution variant. Absolute rows measured on
  // the 1080p art fall outside the 720p image, so drawImage clips the band
  // away, the stretch draws nothing, and the forearm ends mid-frame.
  for (const id of ['hand1', 'hand2', 'hand4']) {
    const style = JSON.parse(readFileSync(
      new URL(`../assets/hands/${id}.json`, import.meta.url), 'utf8'));
    if (!style.stretchBand) continue;
    const [a, b] = style.stretchBand;
    assert.ok(a >= 0 && a < b && b <= 1, `${id}: ${a}..${b} is not a fraction`);
  }
});

test('a landscape 1080p hand reaches the edge without any stretching', () => {
  // Ranking sources by "closest to 1" picks the smallest variant, whose
  // required scale then exceeds COMFORT_SCALE and forces the arm stretch --
  // lower resolution AND synthetic geometry when a bigger source needs neither.
  for (const id of ['hand1', 'hand2']) {
    const style = JSON.parse(readFileSync(
      new URL(`../assets/hands/${id}.json`, import.meta.url), 'utf8'));
    const sol = solveHand(style, { x: 960, y: 0 }, 0, { w: 1920, h: 1080 });
    assert.equal(sol.stretchPx, 0, `${id} should not need stretching at 1080p`);
  }
});

test('the arm leaves the frame from every nib position, in every orientation', () => {
  // The whole point of the rig: a limb that stops inside the frame reads as a
  // severed floating arm. Checked on the drawn geometry (opaque bbox + the
  // stretch actually applied), not on the model's own promise.
  for (const id of ['hand1', 'hand2']) {
    const style = JSON.parse(readFileSync(
      new URL(`../assets/hands/${id}.json`, import.meta.url), 'utf8'));
    for (const frame of [{ w: 1920, h: 1080 }, { w: 1080, h: 1920 }, { w: 1080, h: 1080 }]) {
      for (let ix = 0; ix <= 8; ix++) {
        for (let iy = 0; iy <= 8; iy++) {
          for (const tan of [0, Math.PI / 2, Math.PI / 4, -Math.PI / 4, Math.PI]) {
            const y = (iy / 8) * frame.h;
            const sol = solveHand(style, { x: (ix / 8) * frame.w, y }, tan, frame);
            const src = sol.source;
            const reach = ((src.opaqueBBox[3] - src.tipPx[1]) * sol.scale
                           + sol.stretchPx * sol.scale) * Math.cos(Math.abs(sol.rotation));
            assert.ok(y + reach >= frame.h,
              `${id} ${frame.w}x${frame.h}: arm ends ${(frame.h - y - reach).toFixed(0)}px `
              + 'inside the frame');
          }
        }
      }
    }
  }
});
