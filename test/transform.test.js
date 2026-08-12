/**
 * The clip placement matrix, and the one thing that keeps going wrong with it:
 * the hand is positioned by a *second* copy of the matrix, written out by hand
 * in screen space because the sprite must not inherit the camera zoom.
 *
 * That copy silently lost the rotation term and nobody noticed, because every
 * project in the repo was authored with `rotation: 0`. These tests render with
 * a rotation, a squeeze and a mirror all at once, so the two paths cannot drift
 * apart again without something going red.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';

import { createSession, renderPage } from '../src/engine/render/renderFrame.js';
import { register } from '../src/engine/anim/registry.js';
import { applyTransform, transformTangent } from '../src/engine/model/transform.js';
import { useTestSurfaces } from './helpers/surface.js';

useTestSurfaces();

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !== ${b}`);

/** A pen parked at a known object-local point, so the maths has a fixed target. */
const PEN = { x: 130, y: 70, tangent: 0.4, down: true, active: true, tool: 'pen' };

register({
  id: 'test.fixedPen',
  label: 'fixed pen',
  compile: async () => ({ bbox: [0, 0, 200, 160] }),
  advance: () => PEN,
});

const project = (transform) => ({
  meta: { width: 1920, height: 1080, fps: 30 },
  pages: [{ id: 'p1', name: 'Page 1', cameraKeyframes: [{ t: 0, x: 0, y: 0, zoom: 1 }] }],
  assets: { a1: { kind: 'vector' } },
  clips: [{
    id: 'c1', assetId: 'a1', animId: 'test.fixedPen', pageId: 'p1',
    start: 0, duration: 2, transform,
  }],
});

function handFor(transform, cam = { x: 0, y: 0, zoom: 1 }) {
  const session = createSession();
  session.plans.set('c1', { bbox: [0, 0, 200, 160] });
  const p = project(transform);
  p.pages[0].cameraKeyframes = [{ t: 0, ...cam }];
  const canvas = createCanvas(1920, 1080);
  return renderPage(session, p, 'p1', 0.5, canvas.getContext('2d'),
    { width: 1920, height: 1080 });
}

const TRANSFORMS = [
  { x: 0, y: 0, scale: 1 },
  { x: -300, y: 120, scale: 2.5 },
  { x: 40, y: -80, scale: 1, rotation: 30 },
  { x: 40, y: -80, scale: 1.5, scaleX: -1, scaleY: 0.5 },
  { x: 200, y: 200, scale: 0.8, scaleX: 1.3, scaleY: -2, rotation: -115 },
];

test('the hand tracks the ink through rotation, squeeze and mirror', () => {
  for (const tr of TRANSFORMS) {
    for (const cam of [{ x: 0, y: 0, zoom: 1 }, { x: 90, y: -40, zoom: 2 }]) {
      const hand = handFor(tr, cam);
      assert.ok(hand, 'a live pen must report a hand');
      // The tip is the pen's local point through the very same matrix the
      // artwork was drawn with, then through the camera.
      const w = applyTransform(tr, PEN.x, PEN.y);
      near(hand.tip.x, 960 + (w.x - cam.x) * cam.zoom, 1e-6);
      near(hand.tip.y, 540 + (w.y - cam.y) * cam.zoom, 1e-6);
      // The lean follows the stroke as drawn, not as authored.
      near(hand.tangent, transformTangent(tr, PEN.tangent), 1e-9);
    }
  }
});

test('a rotation actually moves the hand, so the test above has teeth', () => {
  const flat = handFor({ x: 0, y: 0, scale: 1 });
  const turned = handFor({ x: 0, y: 0, scale: 1, rotation: 90 });
  assert.ok(Math.hypot(flat.tip.x - turned.tip.x, flat.tip.y - turned.tip.y) > 100,
    'a quarter turn must take the pen somewhere else entirely');
});

test('rotation is degrees: a full turn is 360, not 6.28', () => {
  const none = handFor({ x: 0, y: 0, scale: 1, rotation: 0 });
  const full = handFor({ x: 0, y: 0, scale: 1, rotation: 360 });
  near(full.tip.x, none.tip.x, 1e-6);
  near(full.tip.y, none.tip.y, 1e-6);
});
