import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';

import { setSurfaceFactory, ClipSurfaces } from '../src/engine/render/surfaces.js';
import { makeStroke } from '../src/engine/compile/geometry.js';
import { compileErase, advanceErase, inkExtent } from '../src/engine/anim/erase.js';

setSurfaceFactory((w, h) => {
  const canvas = createCanvas(w, h);
  return { canvas, ctx: canvas.getContext('2d') };
});

const plan = {
  strokes: [
    makeStroke([100, 100, 300, 100], { width: 4 }),
    makeStroke([300, 100, 300, 260], { width: 4 }),
    makeStroke([300, 260, 900, 900], { lift: true, width: 0 }), // travel: no ink
  ],
  bbox: [0, 0, 1000, 1000],
};

test('inkExtent covers only strokes that lay ink', () => {
  const [x0, y0, x1, y1] = inkExtent(plan);
  assert.ok(x0 >= 97 && x0 <= 99, `x0 ${x0}`);
  assert.ok(x1 >= 301 && x1 <= 303, `x1 ${x1}`);
  assert.ok(y1 >= 261 && y1 <= 263, `y1 ${y1}`);
  assert.ok(x1 < 900, 'the pen-up travel stroke must not widen the extent');
});

test('inkExtent falls back to the plan bbox when nothing draws', () => {
  const empty = { strokes: [makeStroke([0, 0, 10, 10], { lift: true })], bbox: [1, 2, 3, 4] };
  assert.deepEqual(inkExtent(empty), [1, 2, 3, 4]);
});

test('erase sweeps horizontally with a much wider head than the pen', () => {
  const ep = compileErase(plan, { id: 'x' });
  assert.ok(ep.width > 4 * 4, `eraser ${ep.width} should dwarf the 4px pen`);
  assert.equal(ep.strokes.length, 1, 'the sweep is one continuous stroke');
  assert.ok(ep.phase.length > 0);
});

test('the erase sweep is deterministic', () => {
  const a = compileErase(plan, { id: 'x' });
  const b = compileErase(plan, { id: 'x' });
  assert.deepEqual([...a.strokes[0].pts], [...b.strokes[0].pts]);
});

test('advanceErase marks the layer used from the very first frame', () => {
  // Regression: the sweep is a single stroke, so committedUpTo stays at its
  // phase start throughout. Gating compositing on that counter made erase
  // invisible until the final frame.
  const sf = new ClipSurfaces(400, 400, 0, 0);
  const ep = compileErase(plan, { id: 'x' });

  assert.equal(sf.erase.used, false);
  advanceErase(sf, ep, 0.05);
  assert.equal(sf.erase.used, true, 'erase must composite while still in progress');
  assert.equal(sf.erase.committedUpTo, 0, 'and it does so before any stroke completes');
});

test('advanceErase reports the eraser tool so the rig can swap sprites', () => {
  const sf = new ClipSurfaces(400, 400, 0, 0);
  const ep = compileErase(plan, { id: 'x' });
  const pen = advanceErase(sf, ep, 0.5);
  assert.equal(pen.tool, 'eraser');
  assert.equal(pen.active, true);
  assert.equal(pen.down, true);
});

test('the eraser sweeps top to bottom over the run of the animation', () => {
  const sf = new ClipSurfaces(600, 600, 0, 0);
  const ep = compileErase(plan, { id: 'x' });
  const early = advanceErase(sf, ep, 0.05);
  const late = advanceErase(sf, ep, 0.95);
  assert.ok(late.y > early.y, `expected downward sweep, got ${early.y} -> ${late.y}`);
});

test('an empty erase plan is inert rather than throwing', () => {
  const sf = new ClipSurfaces(50, 50, 0, 0);
  const ep = compileErase({ strokes: [], bbox: [0, 0, 0, 0] }, { id: 'e' });
  const pen = advanceErase(sf, ep, 0.5);
  assert.equal(pen.active, false);
});
