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
  MIN_SCALE, aroundCentre, clipCorners, cornerPoints, handleAnchors,
  handlePoints, hitTest, localToWorld, placeInFrame, resizeTransform,
  rotateTransform, screenToWorld, worldPerPixel, worldToScreen,
} from '../src/ui/stageGeom.js';
import {
  applyTransform, invertTransform, penScale, transformTangent,
} from '../src/engine/model/transform.js';
import { readFileSync } from 'node:fs';

import { rotationFor, shaftAngle, solveHand } from '../src/engine/hand/rig.js';

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

test('clipCorners places a clip where renderFrame draws it', () => {
  // renderFrame composes: canvas = size/2 + (world - cam) * zoom, and
  // world = transform + local * scale. The box must agree exactly.
  const tr = { x: -400, y: -300, scale: 0.5 };
  const [nw, ne, se] = clipCorners(meta, cam0, 1, tr, [0, 0, 800, 600]);
  assert.deepEqual([nw.x, nw.y], [960 - 400, 540 - 300]);
  assert.deepEqual([se.x - nw.x, se.y - nw.y], [400, 300]);
  assert.deepEqual([ne.x, ne.y], [se.x, nw.y], 'corners run nw, ne, se, sw');
});

test('clipCorners follows the camera, so handles do not drift when it moves', () => {
  const tr = { x: 0, y: 0, scale: 1 };
  const bbox = [0, 0, 100, 100];
  const still = clipCorners(meta, cam0, 1, tr, bbox);
  const panned = clipCorners(meta, { x: 50, y: 0, zoom: 1 }, 1, tr, bbox);
  near(still[0].x - panned[0].x, 50);
});

// ── selection ─────────────────────────────────────────────────────────

/** The four screen corners of an axis-aligned box, in nw, ne, se, sw order. */
const quad = (left, top, w, h) => [
  { x: left, y: top }, { x: left + w, y: top },
  { x: left + w, y: top + h }, { x: left, y: top + h },
];

test('hitTest picks the topmost clip where they overlap', () => {
  const boxes = [
    { id: 'under', corners: quad(0, 0, 100, 100) },
    { id: 'over', corners: quad(50, 50, 100, 100) },
  ];
  assert.equal(hitTest(boxes, 75, 75), 'over', 'later clips draw on top');
  assert.equal(hitTest(boxes, 10, 10), 'under');
  assert.equal(hitTest(boxes, 400, 400), null);
});

test('hitTest follows a rotated clip instead of the box around it', () => {
  // A square turned 45 degrees: its own corners stick out where the axis-aligned
  // box has blank paper, and vice versa. Selecting on the box would grab the
  // clip from a corner the artwork does not reach.
  const tr = { x: 0, y: 0, scale: 1, rotation: 45 };
  const bbox = [-50, -50, 50, 50];
  const boxes = [{ id: 'tilted', corners: clipCorners(meta, cam0, 1, tr, bbox) }];
  assert.equal(hitTest(boxes, 960, 540), 'tilted', 'the centre is always inside');
  // World (-50, -50) is the untilted top-left; after the turn it is outside.
  assert.equal(hitTest(boxes, 960 - 49, 540 - 49), null);
  // ...while a point out on the rotated corner, past the untilted edge, is in.
  assert.equal(hitTest(boxes, 960, 540 - 65), 'tilted');
});

test('hitTest still works on a mirrored clip, whose corners wind the other way', () => {
  const tr = { x: 0, y: 0, scale: 1, scaleX: -1 };
  const boxes = [{ id: 'flipped', corners: clipCorners(meta, cam0, 1, tr, [0, 0, 100, 60]) }];
  assert.equal(hitTest(boxes, 960 - 50, 540 + 30), 'flipped');
  assert.equal(hitTest(boxes, 960 + 50, 540 + 30), null, 'it mirrored to the left');
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
  assert.deepEqual(next, { x: 5, y: 5, scale: 2, scaleX: 1, scaleY: 1, rotation: 0 });
});

// ── squeeze, flip and rotate ──────────────────────────────────────────

test('every handle is anchored on the point opposite it', () => {
  const bbox = [0, 0, 100, 200];
  assert.deepEqual(handlePoints(bbox, 'n'), { grabbed: [50, 0], anchor: [50, 200] });
  assert.deepEqual(handlePoints(bbox, 'w'), { grabbed: [0, 100], anchor: [100, 100] });
  assert.deepEqual(handlePoints(bbox, 'e'), { grabbed: [100, 100], anchor: [0, 100] });
});

test('an edge handle squeezes its own axis and leaves the other alone', () => {
  const tr = { x: 0, y: 0, scale: 1 };
  const bbox = [0, 0, 100, 200];
  // Drag the east edge to half its width. The anchor is the west edge.
  const next = resizeTransform(tr, bbox, 'e', 50, 100);
  near(next.scaleX, 0.5);
  near(next.scaleY, 1, 1e-9);
  near(next.scale, 1, 1e-9);
});

test('every handle holds its anchor still, at any rotation', () => {
  const tr = { x: 100, y: 200, scale: 1.5, scaleX: 1.2, scaleY: 0.7, rotation: 37 };
  const bbox = [-20, -10, 380, 290];
  for (const h of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
    for (const free of [false, true]) {
      const { anchor } = handlePoints(bbox, h);
      const before = localToWorld(tr, anchor[0], anchor[1]);
      const next = resizeTransform(tr, bbox, h, 700, 900, { free });
      const after = localToWorld(next, anchor[0], anchor[1]);
      near(after.x, before.x, 1e-6);
      near(after.y, before.y, 1e-6);
    }
  }
});

test('a locked corner keeps the aspect a squeeze already gave the clip', () => {
  const tr = { x: 0, y: 0, scale: 1, scaleX: 2, scaleY: 0.5 };
  const bbox = [0, 0, 100, 100];
  const next = resizeTransform(tr, bbox, 'se', 400, 100);
  // The stretch is untouched; only the overall scale moved.
  near(next.scaleX, 2, 1e-9);
  near(next.scaleY, 0.5, 1e-9);
  assert.ok(next.scale > 1, 'dragging outwards grows the clip');
});

test('shift frees a corner to stretch each axis on its own', () => {
  const tr = { x: 0, y: 0, scale: 1 };
  const bbox = [0, 0, 100, 100];
  const next = resizeTransform(tr, bbox, 'se', 200, 50, { free: true });
  near(next.scaleX, 2);
  near(next.scaleY, 0.5);
});

test('dragging a handle past its anchor mirrors instead of collapsing', () => {
  const tr = { x: 0, y: 0, scale: 1 };
  const bbox = [0, 0, 100, 100];
  // The east edge dragged 60 units to the *left* of the west anchor.
  const next = resizeTransform(tr, bbox, 'e', -60, 0);
  near(next.scaleX, -0.6);
  // The anchor still holds, so the artwork mirrors about the far edge.
  const anchor = localToWorld(next, 0, 50);
  near(anchor.x, 0, 1e-9);
});

test('scale is clamped on magnitude, so a mirror cannot collapse either', () => {
  const tr = { x: 0, y: 0, scale: 1 };
  const bbox = [0, 0, 400, 300];
  near(resizeTransform(tr, bbox, 'e', 0, 0).scaleX, MIN_SCALE);
  // A tiny clip dragged to nothing still stops at the same absolute size, not
  // at a fraction of it.
  const small = resizeTransform({ x: 0, y: 0, scale: 0.1 }, bbox, 'se', 0, 0);
  assert.equal(small.scale, MIN_SCALE);
});

test('rotating turns about the centre rather than the origin corner', () => {
  const tr = { x: 100, y: 50, scale: 1 };
  const bbox = [0, 0, 200, 100];
  const before = localToWorld(tr, 100, 50);
  // Drag the handle out to the right of the centre: the handle points up at
  // zero, so a quarter turn clockwise puts it there.
  const next = rotateTransform(tr, bbox, before.x + 300, before.y);
  near(next.rotation, 90, 1e-9);
  const after = localToWorld(next, 100, 50);
  near(after.x, before.x, 1e-9);
  near(after.y, before.y, 1e-9);
});

test('shift snaps a rotation to fifteen degrees', () => {
  const tr = { x: 0, y: 0, scale: 1 };
  const bbox = [0, 0, 100, 100];
  const c = localToWorld(tr, 50, 50);
  // 6 degrees clockwise of straight up, which must land back on zero.
  const a = (-90 + 6) * (Math.PI / 180);
  const next = rotateTransform(tr, bbox, c.x + Math.cos(a) * 200, c.y + Math.sin(a) * 200,
    { snap: true });
  near(next.rotation, 0, 1e-9);
});

test('aroundCentre flips in place instead of swinging the clip away', () => {
  const tr = { x: 300, y: 40, scale: 2 };
  const bbox = [0, 0, 100, 60];
  const before = localToWorld(tr, 50, 30);
  const patch = aroundCentre(tr, bbox, { scaleX: -1 });
  const after = localToWorld({ ...tr, ...patch }, 50, 30);
  near(after.x, before.x, 1e-9);
  near(after.y, before.y, 1e-9);
});

test('the rotate handle floats outside the top edge, whichever way it faces', () => {
  const bbox = [0, 0, 100, 100];
  for (const rotation of [0, 90, 200, -45]) {
    const corners = clipCorners(meta, cam0, 1, { x: -50, y: -50, scale: 1, rotation }, bbox);
    const a = handleAnchors(corners);
    const centre = { x: (a.nw.x + a.se.x) / 2, y: (a.nw.y + a.se.y) / 2 };
    const toEdge = Math.hypot(a.n.x - centre.x, a.n.y - centre.y);
    const toRot = Math.hypot(a.rot.x - centre.x, a.rot.y - centre.y);
    near(toRot - toEdge, 26, 1e-6);
  }
});

// ── the matrix itself ─────────────────────────────────────────────────

test('invertTransform undoes applyTransform, mirrors and all', () => {
  for (const tr of [
    { x: 0, y: 0, scale: 1 },
    { x: -120, y: 340, scale: 2.5, rotation: 33 },
    { x: 10, y: 10, scale: 1, scaleX: -1.4, scaleY: 0.3, rotation: -75 },
  ]) {
    const w = applyTransform(tr, 123, -45);
    const l = invertTransform(tr, w.x, w.y);
    near(l.x, 123, 1e-9);
    near(l.y, -45, 1e-9);
  }
});

test('a tangent is turned by the matrix, not merely by the rotation', () => {
  // Under a pure rotation the stroke direction just adds.
  near(transformTangent({ scale: 1, rotation: 30 }, 0), 30 / DEG, 1e-9);
  // A squeeze is not conformal: 45 degrees through a 2:1 vertical squash comes
  // out shallower, at atan(0.5). Adding the rotation would have kept it at 45.
  near(transformTangent({ scale: 1, scaleY: 0.5 }, 45 / DEG), Math.atan(0.5), 1e-9);
  // A mirror reverses the direction along its own axis.
  near(transformTangent({ scale: 1, scaleX: -1 }, 0), Math.PI, 1e-9);
});

test('penScale is the geometric mean, so a mirror does not change stroke widths', () => {
  near(penScale({ scale: 2 }), 2, 1e-9);
  near(penScale({ scale: 2, scaleX: -1 }), 2, 1e-9);
  near(penScale({ scale: 1, scaleX: 4, scaleY: 1 }), 2, 1e-9);
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

// ── placing a new drawable ────────────────────────────────────────────

const META = { width: 1920, height: 1080 };

/** Where the middle of a placed drawable ends up, in world units. */
const placedCenter = (bbox, cam, meta = META) => {
  const tr = placeInFrame(bbox, cam, meta);
  const a = localToWorld(tr, bbox[0], bbox[1]);
  const b = localToWorld(tr, bbox[2], bbox[3]);
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
};

test('a placed drawable is centred on the camera, not on the page origin', () => {
  // The bug: adding an asset after zooming in put it at world (0,0), which is
  // the middle of frame only while the camera is at the identity.
  const bbox = [0, 0, 400, 300];
  for (const cam of [{ x: 0, y: 0, zoom: 1 },
                     { x: 900, y: -400, zoom: 3 },
                     { x: -250, y: 610, zoom: 0.5 }]) {
    const c = placedCenter(bbox, cam);
    near(c.x, cam.x, 1);
    near(c.y, cam.y, 1);
  }
});

test('centring accounts for a bbox that does not start at the origin', () => {
  // Text lays out around a baseline, so its bbox routinely has a negative top.
  const c = placedCenter([-120, -260, 880, 40], { x: 500, y: 500, zoom: 1 });
  near(c.x, 500, 1);
  near(c.y, 500, 1);
});

test('an oversized drawable is shrunk to fit the visible frame', () => {
  const huge = [0, 0, 6000, 400];
  const { scale } = placeInFrame(huge, { x: 0, y: 0, zoom: 1 }, META);
  assert.ok(scale < 1, 'must shrink');
  assert.ok(6000 * scale <= META.width, 'and must actually fit');
});

test('zooming in shrinks a new drawable further, because less page is visible', () => {
  const art = [0, 0, 1600, 900];
  const wide = placeInFrame(art, { x: 0, y: 0, zoom: 1 }, META).scale;
  const tight = placeInFrame(art, { x: 0, y: 0, zoom: 4 }, META).scale;
  assert.ok(tight < wide, 'a zoomed-in frame holds less, so the artwork is smaller');
  assert.ok(1600 * tight <= META.width / 4, 'and still fits what is on screen');
});

test('a drawable that already fits is never enlarged', () => {
  // Scaling a small asset up is an edit the user did not ask for.
  assert.equal(placeInFrame([0, 0, 80, 60], { x: 0, y: 0, zoom: 1 }, META).scale, 1);
});

test('a degenerate bbox does not divide by zero', () => {
  const tr = placeInFrame([10, 10, 10, 10], { x: 0, y: 0, zoom: 1 }, META);
  assert.ok(Number.isFinite(tr.x) && Number.isFinite(tr.y) && Number.isFinite(tr.scale));
});
