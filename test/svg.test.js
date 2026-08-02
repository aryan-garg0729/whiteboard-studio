import test from 'node:test';
import assert from 'node:assert/strict';

import { createCanvas } from '@napi-rs/canvas';

import { parseSvg, parseTransform, matMul, shapeToPath } from '../src/engine/compile/svgDoc.js';
import { paintVectorArt } from '../src/engine/render/vectorArt.js';
import { readFileSync } from 'node:fs';
import { normalizeProject } from '../src/engine/model/project.js';

const svg = (body, attrs = 'viewBox="0 0 100 100" width="100" height="100"') =>
  `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;

test('basic shapes all become geometry', () => {
  for (const [name, el] of [
    ['rect', '<rect x="10" y="10" width="40" height="30"/>'],
    ['circle', '<circle cx="50" cy="50" r="20"/>'],
    ['ellipse', '<ellipse cx="50" cy="50" rx="30" ry="10"/>'],
    ['line', '<line x1="0" y1="0" x2="50" y2="50"/>'],
    ['polyline', '<polyline points="0,0 20,20 40,0"/>'],
    ['polygon', '<polygon points="0,0 40,0 20,30"/>'],
    ['path', '<path d="M0 0 C 10 10, 20 20, 30 0 Z"/>'],
  ]) {
    const r = parseSvg(svg(el));
    assert.ok(r.subpaths.length > 0, `${name} produced no subpaths`);
  }
});

test('degenerate shapes are skipped rather than emitting empty strokes', () => {
  assert.equal(parseSvg(svg('<rect x="0" y="0" width="0" height="10"/>')).subpaths.length, 0);
  assert.equal(parseSvg(svg('<circle cx="5" cy="5" r="0"/>')).subpaths.length, 0);
});

test('rect honours rx/ry rounding', () => {
  const sharp = shapeToPath({ tagName: 'rect', getAttribute: (k) =>
    ({ x: '0', y: '0', width: '10', height: '10' }[k] ?? null) });
  assert.ok(!sharp.includes('A'), 'a plain rect needs no arcs');
  const round = shapeToPath({ tagName: 'rect', getAttribute: (k) =>
    ({ x: '0', y: '0', width: '10', height: '10', rx: '2' }[k] ?? null) });
  assert.ok(round.includes('A'), 'a rounded rect should use arcs');
});

test('fill produces a fillable region; fill="none" does not', () => {
  const filled = parseSvg(svg('<rect x="0" y="0" width="50" height="50" fill="#ff0000"/>'));
  assert.equal(filled.regions.length, 1);
  assert.equal(filled.regions[0].color, '#ff0000');

  const outlined = parseSvg(svg('<rect x="0" y="0" width="50" height="50" fill="none"/>'));
  assert.equal(outlined.regions.length, 0, 'nothing to colour in');
  assert.ok(outlined.subpaths.length > 0, 'but the pen still traces it');
});

test('a missing fill attribute defaults to black, as SVG specifies', () => {
  const r = parseSvg(svg('<rect x="0" y="0" width="50" height="50"/>'));
  assert.equal(r.regions.length, 1);
  assert.equal(r.regions[0].color, '#000000');
});

test('inline style overrides the presentation attribute', () => {
  const r = parseSvg(svg('<rect x="0" y="0" width="9" height="9" fill="#ff0000" style="fill:#00ff00"/>'));
  assert.equal(r.regions[0].color, '#00ff00');
});

test('fill is inherited from an enclosing group', () => {
  const r = parseSvg(svg('<g fill="#123456"><rect x="0" y="0" width="9" height="9"/></g>'));
  assert.equal(r.regions[0].color, '#123456');
});

test('gradient fills degrade to a flat colour instead of dropping the shape', () => {
  // We cannot scribble-reveal a gradient, but silently losing the shape would
  // be worse than filling it grey.
  const r = parseSvg(svg('<rect x="0" y="0" width="9" height="9" fill="url(#grad)"/>'));
  assert.equal(r.regions.length, 1);
  assert.equal(r.regions[0].color, '#808080');
});

test('defs and other non-drawing containers are skipped', () => {
  const r = parseSvg(svg('<defs><rect x="0" y="0" width="9" height="9"/></defs>'));
  assert.equal(r.subpaths.length, 0);
});

test('group transforms are applied to descendants', () => {
  const plain = parseSvg(svg('<rect x="0" y="0" width="10" height="10"/>'));
  const moved = parseSvg(svg('<g transform="translate(40 20)"><rect x="0" y="0" width="10" height="10"/></g>'));
  assert.ok(Math.abs(moved.subpaths[0].pts[0] - plain.subpaths[0].pts[0] - 40) < 1e-6);
  assert.ok(Math.abs(moved.subpaths[0].pts[1] - plain.subpaths[0].pts[1] - 20) < 1e-6);
});

test('nested transforms compose', () => {
  const r = parseSvg(svg(
    '<g transform="translate(10 0)"><g transform="translate(5 0)">'
    + '<rect x="0" y="0" width="4" height="4"/></g></g>'));
  assert.ok(Math.abs(r.subpaths[0].pts[0] - 15) < 1e-6);
});

test('parseTransform handles rotate about a point', () => {
  // rotate(90, 10, 10) must map (10,10) to itself
  const m = parseTransform('rotate(90 10 10)');
  const x = m[0] * 10 + m[2] * 10 + m[4];
  const y = m[1] * 10 + m[3] * 10 + m[5];
  assert.ok(Math.abs(x - 10) < 1e-9 && Math.abs(y - 10) < 1e-9, `got ${x},${y}`);
});

test('matMul composes in SVG order', () => {
  const t = matMul([1, 0, 0, 1, 5, 0], [2, 0, 0, 2, 0, 0]); // translate then scale
  assert.deepEqual(t, [2, 0, 0, 2, 5, 0]);
});

test('viewBox wins over width/height for document size', () => {
  // width/height may carry physical units while coordinates are user units.
  const r = parseSvg(svg('<rect x="0" y="0" width="10" height="10"/>',
    'viewBox="0 0 200 150" width="20mm" height="15mm"'));
  assert.equal(r.width, 200);
  assert.equal(r.height, 150);
});

test('a shape with subpaths keeps them as rings so holes work', () => {
  // outer square with an inner square: even-odd makes the inner one a hole
  const r = parseSvg(svg(
    '<path d="M0 0 H60 V60 H0 Z M20 20 H40 V40 H20 Z" fill="#333"/>'));
  assert.equal(r.regions.length, 1);
  assert.equal(r.regions[0].rings.length, 2);
  // largest ring first, so consumers can treat rings[0] as the outer boundary
  assert.ok(r.regions[0].rings[0].length >= r.regions[0].rings[1].length);
});

test('a non-SVG document is rejected', () => {
  assert.throws(() => parseSvg('<html><body/></html>'), /not an SVG/);
});

test('an .svg src is routed to the vector pipeline even if declared as an image', () => {
  // Routing it to the raster tracer would reach cv2.imread and fail.
  const p = normalizeProject({
    assets: { a: { kind: 'image', src: 'logo.SVG' } },
    clips: [{ assetId: 'a', animId: 'draw.outlineFill', duration: 1 }],
  });
  assert.equal(p.assets.a.kind, 'vector');
});

test('the bundled SVG example parses into something drawable', () => {
  const r = parseSvg(
    readFileSync(new URL('../examples/shapes.svg', import.meta.url), 'utf8'));
  assert.ok(r.subpaths.length >= 5);
  assert.ok(r.regions.length >= 4);
  assert.equal(r.width, 400);
});

test('a shape drawn inside a bigger one is not painted over by it', () => {
  // paintVectorArt used to reverse the region list before painting. Both
  // producers emit largest-first, so reversing put the *largest* region last --
  // on top of everything inside it. A drawing with a background shape came out
  // as a flat rectangle of background, and only once the clip settled, because
  // until then the pen's own ink was covering it.
  const canvas = createCanvas(100, 100);
  const ctx = canvas.getContext('2d');
  const r = parseSvg(svg(
    '<rect x="0" y="0" width="100" height="100" fill="#ff0000"/>'
    + '<rect x="40" y="40" width="20" height="20" fill="#0000ff"/>',
  ));
  assert.equal(r.regions.length, 2);
  paintVectorArt(ctx, r.regions, r.subpaths);

  const [red, green, blue] = ctx.getImageData(50, 50, 1, 1).data;
  assert.deepEqual([red, green, blue], [0, 0, 255],
    'the small shape must sit on top of the big one');
});
