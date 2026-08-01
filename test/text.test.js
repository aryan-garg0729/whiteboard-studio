import test from 'node:test';
import assert from 'node:assert/strict';

import {
  glyphKey, classifyStrokes, orientStroke, orderGlyphStrokes,
} from '../src/engine/compile/text.js';

const stroke = (pts, length) => ({ pts, length: length ?? pts.length * 10 });

test('glyphKey is stable and outline-sensitive', () => {
  const a = [{ type: 'M', x: 0, y: 0 }, { type: 'L', x: 100, y: 0 }];
  const b = [{ type: 'M', x: 0, y: 0 }, { type: 'L', x: 101, y: 0 }];
  assert.equal(glyphKey(a, 1000), glyphKey(a, 1000));
  assert.notEqual(glyphKey(a, 1000), glyphKey(b, 1000));
  assert.notEqual(glyphKey(a, 1000), glyphKey(a, 2048), 'upem is part of the key');
});

test('an isolated small mark is a tittle', () => {
  // 'i': a tall stem plus a detached dot well above it
  const strokes = [
    stroke([[50, 0], [50, 500]], 500),
    stroke([[48, 620], [52, 640]], 20),
  ];
  const roles = classifyStrokes(strokes, 1000).map((s) => s.role);
  assert.deepEqual(roles, ['main', 'dot']);
});

test('a short horizontal mark crossing another stroke is a crossbar', () => {
  // 't': vertical stem with a bar through it
  const strokes = [
    stroke([[100, 0], [100, 700]], 700),
    stroke([[20, 500], [180, 505]], 160),
  ];
  const roles = classifyStrokes(strokes, 1000).map((s) => s.role);
  assert.deepEqual(roles, ['main', 'bar']);
});

test('a long horizontal stroke is not mistaken for a crossbar', () => {
  const strokes = [
    stroke([[0, 0], [400, 5]], 400),
    stroke([[0, 200], [400, 205]], 400),
  ];
  assert.deepEqual(classifyStrokes(strokes, 1000).map((s) => s.role), ['main', 'main']);
});

test('crossbars and tittles are written after the main strokes', () => {
  const strokes = classifyStrokes([
    stroke([[100, 0], [100, 700]], 700),   // stem
    stroke([[20, 500], [180, 505]], 160),  // crossbar
  ], 1000);
  const ordered = orderGlyphStrokes(strokes);
  assert.equal(ordered[0].role, 'main');
  assert.equal(ordered[1].role, 'bar', 'the bar must come last');
});

test('main strokes are ordered top-down then left-right', () => {
  const strokes = classifyStrokes([
    stroke([[300, 100], [320, 200]], 400),
    stroke([[100, 600], [120, 500]], 400),
    stroke([[50, 600], [60, 500]], 400),
  ], 1000).map((s) => ({ ...s, role: 'main' }));
  const first = orderGlyphStrokes(strokes)[0];
  // y-up font units: the highest start point is written first
  assert.equal(first.pts[0][1], 600);
});

test('open strokes are oriented downward', () => {
  // font units are y-up, so "downward" means ending at a lower y
  const up = orientStroke(stroke([[0, 0], [0, 500]]));
  assert.deepEqual(up.pts[0], [0, 500], 'should start at the top and run down');

  const down = orientStroke(stroke([[0, 500], [0, 0]]));
  assert.deepEqual(down.pts[0], [0, 500], 'already downward, left alone');
});

test('a near-horizontal open stroke is oriented left to right', () => {
  const s = orientStroke(stroke([[400, 10], [0, 0]]));
  assert.equal(s.pts[0][0], 0);
});

test('closed rings start at the top and run clockwise in font units', () => {
  // a square ring listed counter-clockwise in y-up space
  const ring = [[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]];
  const s = orientStroke(stroke(ring));
  assert.equal(s.closed, true);
  const startY = s.pts[0][1];
  assert.ok(startY === 100, `ring should start at the top, started at y=${startY}`);
  // second point must move clockwise in y-up (i.e. +x along the top edge)
  assert.ok(s.pts[1][0] >= s.pts[0][0] || s.pts[1][1] < s.pts[0][1]);
});
