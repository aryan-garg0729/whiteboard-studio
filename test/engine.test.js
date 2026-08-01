import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  arcLengths, makeStroke, makePhase, locate, floorIndex, cubicSegments, tangentAt,
} from '../src/engine/compile/geometry.js';
import { spansAt, decomposeCells, scribbleRegion, mulberry32 } from '../src/engine/compile/scribble.js';
import { minScale, exitDistance, solveHand, elbowOutside, EDGE_MARGIN } from '../src/engine/hand/rig.js';

const ring = (...xy) => Float64Array.from(xy);
const rect = (x0, y0, x1, y1) => ring(x0, y0, x1, y0, x1, y1, x0, y1);

test('arcLengths accumulates segment lengths', () => {
  const cum = arcLengths([0, 0, 3, 4, 3, 10]);
  assert.deepEqual([...cum], [0, 5, 11]);
});

test('floorIndex finds the last entry <= v', () => {
  const a = Float64Array.from([0, 5, 11, 20]);
  assert.equal(floorIndex(a, -1), 0);
  assert.equal(floorIndex(a, 5), 1);
  assert.equal(floorIndex(a, 10.9), 1);
  assert.equal(floorIndex(a, 11), 2);
  assert.equal(floorIndex(a, 999), 3);
});

test('cubicSegments subdivides more for tighter tolerance', () => {
  const loose = cubicSegments(0, 0, 0, 100, 100, 100, 100, 0, 4);
  const tight = cubicSegments(0, 0, 0, 100, 100, 100, 100, 0, 0.05);
  assert.ok(tight > loose);
  assert.equal(cubicSegments(0, 0, 1, 0, 2, 0, 3, 0, 0.1), 1, 'a straight cubic needs one segment');
});

test('locate paces by arc length, not by stroke index', () => {
  // A very short stroke followed by a very long one. Index-based pacing would
  // put the halfway point at the join; arc-length pacing must not.
  const short = makeStroke([0, 0, 10, 0]);
  const long = makeStroke([10, 0, 210, 0]);
  const strokes = [short, long];
  const phase = makePhase(strokes, 0, 2, 'OUTLINE');
  assert.equal(phase.length, 210);

  const mid = locate(strokes, phase, 105);
  assert.equal(mid.strokeIndex, 1);
  assert.ok(Math.abs(mid.x - 105) < 1e-9, `expected x=105, got ${mid.x}`);

  // constant speed: equal arc-length steps produce equal spatial steps
  const a = locate(strokes, phase, 20);
  const b = locate(strokes, phase, 40);
  const c = locate(strokes, phase, 60);
  assert.ok(Math.abs((b.x - a.x) - (c.x - b.x)) < 1e-9);
});

test('locate clamps at both ends', () => {
  const s = [makeStroke([0, 0, 100, 0])];
  const ph = makePhase(s, 0, 1, 'OUTLINE');
  assert.equal(locate(s, ph, -50).x, 0);
  assert.equal(locate(s, ph, 1e6).x, 100);
});

test('travel strokes are discounted so pen lifts feel quick', () => {
  const draw = makeStroke([0, 0, 100, 0]);
  const trav = makeStroke([100, 0, 200, 0], { lift: true });
  const ph = makePhase([draw, trav], 0, 2, 'OUTLINE');
  assert.equal(ph.length, 100 + 100 * 0.25);
});

test('tangentAt is a pure function of arc length', () => {
  const s = [makeStroke([0, 0, 100, 0, 100, 100])];
  const ph = makePhase(s, 0, 1, 'OUTLINE');
  const first = tangentAt(s, ph, 50);
  const second = tangentAt(s, ph, 50);
  assert.equal(first, second, 'repeated sampling must not drift');
  assert.ok(Math.abs(first) < 1e-9, 'horizontal run should read as 0 rad');
});

test('spansAt pairs crossings under the even-odd rule', () => {
  const spans = spansAt([rect(0, 0, 100, 100)], 50);
  assert.deepEqual(spans, [[0, 100]]);
});

test('spansAt handles holes without special-casing them', () => {
  const spans = spansAt([rect(0, 0, 100, 100), rect(40, 40, 60, 60)], 50);
  assert.deepEqual(spans, [[0, 40], [60, 100]]);
});

test('spansAt is robust when a vertex lands exactly on the scan line', () => {
  // A diamond whose left/right vertices sit exactly at y=50. The naive
  // y0 < y < y1 test counts these twice or zero times, yielding an odd
  // crossing count and a span that leaks across the frame.
  const diamond = ring(50, 0, 100, 50, 50, 100, 0, 50);
  const spans = spansAt([diamond], 50);
  assert.equal(spans.length, 1, `expected one span, got ${JSON.stringify(spans)}`);
  assert.deepEqual(spans[0], [0, 100]);
});

test('spansAt is half-open in y: top edge included, bottom edge excluded', () => {
  // Horizontal edges contribute no crossings, but the two vertical edges still
  // do, so y=0 is interior under the [top, bottom) convention and y=100 is not.
  // This asymmetry is exactly why the scan grid is offset by a half step.
  assert.deepEqual(spansAt([rect(0, 0, 100, 100)], 0), [[0, 100]]);
  assert.deepEqual(spansAt([rect(0, 0, 100, 100)], 100), []);
  assert.deepEqual(spansAt([rect(0, 0, 100, 100)], 100.5), []);
});

test('decomposeCells separates the arms of a U', () => {
  // three scan lines: two disjoint arms, joining only on the last line
  const lines = [
    [[0, 20], [80, 100]],
    [[0, 20], [80, 100]],
    [[0, 100]],
  ];
  const cells = decomposeCells(lines, 1);
  assert.equal(cells.length, 1, 'the joining line fuses both arms into one cell');

  const disjoint = decomposeCells([[[0, 20], [80, 100]], [[0, 20], [80, 100]]], 1);
  assert.equal(disjoint.length, 2, 'without a join they stay separate cells');
});

test('decomposeCells does not fuse arms on a single-point touch', () => {
  const cells = decomposeCells([[[0, 50], [50, 100]]], 1);
  assert.equal(cells.length, 2, 'a bare touch at x=50 must not merge the spans');
});

test('scribbleRegion covers a rectangle with the expected pass count', () => {
  const { pts, spacing, cells } = scribbleRegion([rect(0, 0, 200, 200)], {
    brushWidth: 10, angleDeg: 0, overlap: 0.35, seed: 7,
  });
  assert.equal(cells, 1);
  assert.ok(Math.abs(spacing - 6.5) < 1e-9, `spacing ${spacing}`);
  assert.ok(pts.length > 0);
  // ~200/6.5 = 30 passes, 7 samples each
  const verts = pts.length / 2;
  assert.ok(verts > 150 && verts < 300, `unexpected vertex count ${verts}`);
});

test('scribbleRegion is deterministic for a given seed', () => {
  const a = scribbleRegion([rect(0, 0, 120, 90)], { brushWidth: 8, seed: 42 });
  const b = scribbleRegion([rect(0, 0, 120, 90)], { brushWidth: 8, seed: 42 });
  assert.deepEqual(a.pts, b.pts);
  const c = scribbleRegion([rect(0, 0, 120, 90)], { brushWidth: 8, seed: 43 });
  assert.notDeepEqual(a.pts, c.pts, 'a different seed must give different jitter');
});

test('scribbleRegion returns nothing for a degenerate region', () => {
  const { pts } = scribbleRegion([rect(0, 0, 0.001, 0.001)], { brushWidth: 8 });
  assert.equal(pts.length, 0);
});

test('mulberry32 is stable across calls', () => {
  const a = mulberry32(1); const b = mulberry32(1);
  for (let i = 0; i < 5; i++) assert.equal(a(), b());
});

test('exitDistance measures the ray/AABB exit', () => {
  assert.equal(exitDistance(50, 10, 0, 1, 100, 100), 90);   // straight down
  assert.equal(exitDistance(50, 10, 0, -1, 100, 100), 10);  // straight up
  assert.equal(exitDistance(10, 50, 1, 0, 100, 100), 90);   // right
});

// --- hand rig, against the real calibrated manifests -----------------------

const hand1 = JSON.parse(readFileSync(new URL('../assets/hands/hand1.json', import.meta.url)));
const hand4 = JSON.parse(readFileSync(new URL('../assets/hands/hand4.json', import.meta.url)));

test('calibrated hand1 manifest has the geometry the rig depends on', () => {
  assert.equal(hand1.anchorEdge, 'bottom');
  assert.equal(hand1.constraint, 'edge');
  const src = hand1.sources.find((s) => s.h === 1920);
  assert.equal(src.tipPx[1], 0, 'nib sits on the top edge of the asset');
  assert.ok(Math.abs(src.armLenPx - 1921.7) < 0.5, `armLenPx ${src.armLenPx}`);
});

test('minScale matches the closed-form derivation for hand1 at 1080p', () => {
  const src = hand1.sources.find((s) => s.h === 1920);
  const s = minScale(hand1, src, 1080);
  const tilt = Math.abs(Math.atan2(src.armExitPx[0] - src.tipPx[0], src.armExitPx[1] - src.tipPx[1]));
  const expected = (1080 + EDGE_MARGIN) / (src.armLenPx * Math.cos(25 * Math.PI / 180 + tilt));
  assert.ok(Math.abs(s - expected) < 1e-12);
  assert.ok(Math.abs(s - 0.647) < 0.002, `expected ~0.647, got ${s}`);
});

test('hand1 at 1080p occupies a sane fraction of the frame', () => {
  const src = hand1.sources.find((s) => s.h === 1920);
  const s = minScale(hand1, src, 1080);
  const bboxW = src.opaqueBBox[2] - src.opaqueBBox[0] + 1;
  const frac = (s * bboxW) / 1920;
  assert.ok(frac > 0.15 && frac < 0.30, `hand covers ${(frac * 100).toFixed(1)}% of frame width`);
});

test('the limb clears the frame for nib positions across the whole frame', () => {
  const frame = { w: 1920, h: 1080 };
  for (let gy = 0; gy <= 8; gy++) {
    for (let gx = 0; gx <= 8; gx++) {
      const tip = { x: (gx / 8) * frame.w, y: (gy / 8) * frame.h };
      for (const tangent of [0, Math.PI / 2, -Math.PI / 2, Math.PI]) {
        const sol = solveHand(hand1, tip, tangent, frame);
        assert.ok(elbowOutside(hand1, sol, frame),
          `detached at (${tip.x.toFixed(0)},${tip.y.toFixed(0)}) tangent ${tangent.toFixed(2)}`);
      }
    }
  }
});

test('portrait output stretches the forearm instead of inflating the sprite', () => {
  const portrait = { w: 1080, h: 1920 };
  const sol = solveHand(hand1, { x: 540, y: 100 }, 0, portrait);
  assert.ok(sol.scale <= 0.7 + 1e-9, `scale ${sol.scale} should be capped at comfort`);
  assert.ok(sol.stretchPx > 0, 'the deficit must be absorbed by the stretch band');
  assert.ok(elbowOutside(hand1, sol, portrait), 'still must not read as detached');
});

test('hand4 is a floating-pen style, exempt from the edge constraint', () => {
  assert.equal(hand4.constraint, 'none');
  assert.equal(hand4.anchorEdge, null);
  const sol = solveHand(hand4, { x: 200, y: 200 }, 0, { w: 1920, h: 1080 });
  assert.equal(sol.detached, true, 'declared floating, not silently broken');
});

test('rotation stays within the clamp for any tangent', () => {
  const frame = { w: 1920, h: 1080 };
  for (let a = -Math.PI; a <= Math.PI; a += 0.1) {
    const sol = solveHand(hand1, { x: 900, y: 500 }, a, frame);
    assert.ok(Math.abs(sol.rotation) <= (hand1.maxRotationDeg * Math.PI) / 180 + 1e-12);
  }
});
