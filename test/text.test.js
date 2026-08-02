import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import opentype from 'opentype.js';
import { createCanvas } from '@napi-rs/canvas';

import {
  glyphKey, classifyStrokes, orientStroke, orderGlyphStrokes,
  layoutText, outlineText,
} from '../src/engine/compile/text.js';
import { setSurfaceFactory, ClipSurfaces } from '../src/engine/render/surfaces.js';
import { compileErase, hasInk } from '../src/engine/anim/erase.js';
import textReveal, {
  buildSegments, locateFrontier, OSCILLATION_REACH, LOOP_VARY,
} from '../src/engine/anim/textReveal.js';
import { easeEnds } from '../src/engine/anim/outlineFill.js';

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

// ── filled letterforms and the left-to-right reveal ───────────────────
//
// The reveal animation is the default for text, so these guard the geometry it
// stands on: the outlines must land where the tracing animation's centrelines
// do, and the pen must sweep the letters rather than wander off them.

const FONT_PATH = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
const font = (() => {
  try {
    const buf = readFileSync(FONT_PATH);
    return opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  } catch {
    return null;                              // no DejaVu installed; skip below
  }
})();

setSurfaceFactory((w, h) => {
  const canvas = createCanvas(w, h);
  return { canvas, ctx: canvas.getContext('2d') };
});

/** Surfaces sized the way renderFrame sizes them, so advance() can draw. */
const surfacesFor = (plan) => {
  const b = plan.bbox;
  return new ClipSurfaces(b[2] - b[0] + 64, b[3] - b[1] + 64, b[0] - 32, b[1] - 32);
};

test('outlined text keeps the real letterforms, counters and all', { skip: !font }, () => {
  const out = outlineText(font, 'oil', { fontSize: 100 });
  assert.equal(out.regions.length, 3, 'one region per inked glyph');
  // An 'o' is an outer contour plus its counter; without both, an evenodd fill
  // would paint a solid blob instead of a letter.
  assert.equal(out.regions[0].rings.length, 2, "'o' must keep its counter");
  assert.equal(out.regions[2].rings.length, 1, "'l' is a single contour");
});

test('outline and centreline layouts agree on where a glyph sits', { skip: !font }, async () => {
  // A clip switched between the two text animations must not move. Both derive
  // from placeGlyphs, but by different routes -- opentype's own transform for
  // one, a hand-written mapping for the other.
  const size = 100;
  const out = outlineText(font, 'H', { fontSize: size });
  const traced = await layoutText(font, 'H', {
    fontSize: size,
    // Stand in for the sidecar: a single centreline down the glyph's middle,
    // in font units, y-up. Its x must land inside the outline's x range.
    getSkeleton: () => ({ strokes: [{ pts: [[400, 0], [400, 700]], length: 700 }] }),
  });

  const [x0, , x1] = out.inkBbox;
  const cx = traced.strokes.find((s) => !s.lift).pts[0];
  assert.ok(cx > x0 && cx < x1, `centreline x ${cx} outside outline ${x0}..${x1}`);
  assert.deepEqual(out.bbox, traced.bbox, 'and both claim the same bounds');
});

test('a span is a word, not a letter', { skip: !font }, () => {
  const out = outlineText(font, 'Hello world again', { fontSize: 100 });
  assert.equal(out.lines[0].spans.length, 3, 'three words, three spans');
  // Spans must not overlap and must run left to right.
  const spans = out.lines[0].spans;
  for (let i = 1; i < spans.length; i++) {
    assert.ok(spans[i][0] > spans[i - 1][1], 'spans are disjoint and ordered');
  }
});

test('each line gets its own band and spans', { skip: !font }, () => {
  const out = outlineText(font, 'ab\ncd ef', { fontSize: 100 });
  assert.equal(out.lines.length, 2);
  assert.equal(out.lines[0].spans.length, 1);
  assert.equal(out.lines[1].spans.length, 2);
  assert.ok(out.lines[1].y0 > out.lines[0].y1, 'the second line sits below the first');
});

test('a blank line contributes nothing to write', { skip: !font }, () => {
  const out = outlineText(font, 'a\n\nb', { fontSize: 100 });
  assert.equal(out.lines.length, 3);
  assert.equal(out.lines[1].spans.length, 0);
  const segs = buildSegments(out.lines);
  assert.ok(segs.every((s) => s.li !== 1), 'the empty line yields no segments');
});

test('the reveal sweeps left to right and stays on the letters', { skip: !font }, async () => {
  const out = outlineText(font, 'Hello world', { fontSize: 150 });
  const plan = await textReveal.compile({ id: 't1', layout: out });
  const sf = surfacesFor(plan);
  const band = out.lines[0];

  // The *frontier* is what reveals ink, and it may never go backwards -- that
  // would un-draw letters. The nib is a separate thing and does loop back.
  let prev = -Infinity;
  for (let i = 0; i <= 200; i++) {
    const at = locateFrontier(plan.segments, (i / 200) * plan.total);
    assert.ok(at.x >= prev - 1e-9, `the reveal went backwards at ${i}`);
    prev = at.x;
  }

  let lifts = 0;
  for (let i = 0; i <= 120; i++) {
    const pen = textReveal.advance(sf, plan, i / 120);
    assert.ok(pen.y >= band.y0 && pen.y <= band.y1,
      `pen left the letters: ${pen.y} outside ${band.y0}..${band.y1}`);
    assert.equal(pen.active, true, 'the hand never vanishes mid-write');
    if (!pen.down) lifts++;
  }
  assert.ok(lifts > 0, 'the pen must lift crossing the space between words');
  assert.ok(lifts < 20, 'but a hop is brief, not a stall');
});

test('the nib loops back on itself, as cursive does', { skip: !font }, async () => {
  // A pure vertical oscillation only ever moves the nib forward, so every
  // stroke is a straight diagonal and the motion reads as a machine. Writing
  // `eee` means swinging back over what was just written at the top of each
  // loop -- so the nib's x must genuinely decrease part of the time.
  const out = outlineText(font, 'Hello world', { fontSize: 150 });
  const plan = await textReveal.compile({ id: 't1', layout: out });
  const sf = surfacesFor(plan);

  const xs = [];
  for (let i = 0; i <= 600; i++) xs.push(textReveal.advance(sf, plan, i / 600).x);
  let back = 0;
  for (let i = 1; i < xs.length; i++) if (xs[i] < xs[i - 1] - 1e-9) back++;
  assert.ok(back > xs.length * 0.15,
    `only ${back}/${xs.length} samples move backwards -- the loops are not closing`);

  // ...but it must stay near the frontier: a nib wandering a whole word behind
  // the ink stops reading as the thing doing the writing.
  const width = out.inkBbox[2] - out.inkBbox[0];
  for (let i = 0; i <= 200; i++) {
    const u = i / 200;
    const at = locateFrontier(plan.segments, easeEnds(u) * plan.total);
    const pen = textReveal.advance(sf, plan, u);
    assert.ok(Math.abs(pen.x - at.x) < width * 0.1,
      `nib strayed ${Math.abs(pen.x - at.x).toFixed(0)}px from the frontier`);
  }
});

test('the hand oscillates rather than tracking the baseline', { skip: !font }, async () => {
  const out = outlineText(font, 'Hello world', { fontSize: 150 });
  const plan = await textReveal.compile({ id: 't1', layout: out });
  const sf = surfacesFor(plan);

  const ys = [];
  for (let i = 0; i <= 200; i++) ys.push(textReveal.advance(sf, plan, i / 200).y);
  const span = Math.max(...ys) - Math.min(...ys);
  const band = out.lines[0].y1 - out.lines[0].y0;

  // Two separate claims, because either one alone is worthless here.
  //
  // First: the sweep is what `OSCILLATION_REACH` advertises, either side of the
  // middle and scaled per loop by `1 ± LOOP_VARY`. This is what catches a bare
  // factor being slipped into `advance` -- exactly how the reach silently
  // became a quarter of what the constant claimed. Retuning the constant moves
  // this bound with it, which is the point.
  const reach = band * OSCILLATION_REACH * 2;
  assert.ok(span > reach * (1 - LOOP_VARY) * 0.9 && span < reach * (1 + LOOP_VARY) * 1.1,
    `hand swept ${span.toFixed(1)}, but the constants ask for about ${reach.toFixed(1)}`);

  // Second: absolute bounds, so retuning the constant cannot quietly tune the
  // *feature* away. Below a tenth of the band the jiggle stops reading as
  // writing at all; past half of it the hand is flailing above and below the
  // line rather than working along it. Deliberately wide -- this is a sanity
  // floor and ceiling, not a second opinion about the right amplitude.
  assert.ok(span > band * 0.08,
    `hand barely moved: ${span.toFixed(1)} over a ${band.toFixed(0)} band`);
  assert.ok(span < band * 0.6,
    `hand swept ${span.toFixed(1)}, most of a ${band.toFixed(0)} band`);

  // Several up-down cycles, not one slow drift: count sign changes.
  let turns = 0;
  for (let i = 2; i < ys.length; i++) {
    if (Math.sign(ys[i] - ys[i - 1]) !== Math.sign(ys[i - 1] - ys[i - 2])) turns++;
  }
  assert.ok(turns >= 8, `expected repeated strokes, saw ${turns} direction changes`);
});

test('the reveal is a pure function of u', { skip: !font }, async () => {
  const out = outlineText(font, 'Hello world', { fontSize: 150 });
  const plan = await textReveal.compile({ id: 't1', layout: out });
  const sf = surfacesFor(plan);

  // Walked forward, then asked again for a point already passed. Scrubbing
  // backward must reproduce the frame exactly, and nothing may consume
  // randomness on the way.
  const real = Math.random;
  Math.random = () => { throw new Error('textReveal consumed randomness'); };
  try {
    const first = textReveal.advance(sf, plan, 0.42);
    for (let i = 0; i <= 100; i++) textReveal.advance(sf, plan, i / 100);
    assert.deepEqual(textReveal.advance(sf, plan, 0.42), first);
  } finally {
    Math.random = real;
  }
});

test('nothing is revealed at u=0 and everything at u=1', { skip: !font }, async () => {
  const out = outlineText(font, 'Hi there', { fontSize: 120 });
  const plan = await textReveal.compile({ id: 't1', layout: out });
  const sf = surfacesFor(plan);

  const covered = () => {
    const { data } = sf.fill.active.ctx.getImageData(0, 0, sf.w, sf.h);
    let n = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 128) n++;
    return n;
  };

  textReveal.advance(sf, plan, 0);
  assert.equal(covered(), 0, 'the page starts blank');
  textReveal.advance(sf, plan, 0.5);
  const half = covered();
  assert.ok(half > 0, 'and fills in as it goes');
  textReveal.advance(sf, plan, 1);
  assert.ok(covered() > half * 1.5, 'ending fully revealed');
});

test('the last letter is whole when the writing stops', { skip: !font }, async () => {
  // The ragged frontier is a soft edge on the word being written. It used to be
  // applied to whichever segment the frontier sat in -- and the frontier never
  // rolls past the last one, so at u=1 the final word kept a wavy right edge
  // permanently, eating up to EDGE_WOBBLE of the band out of the rightmost stem
  // of the last letter. On a 'd' that is most of the stem.
  const out = outlineText(font, 'Hello world', { fontSize: 120 });
  const plan = await textReveal.compile({ id: 't1', layout: out });
  const sf = surfacesFor(plan);
  textReveal.advance(sf, plan, 1);

  const ox = plan.bbox[0] - 32;
  const oy = plan.bbox[1] - 32;
  const col = Math.floor(out.inkBbox[2] - 1 - ox);
  const y0 = Math.ceil(out.lines[0].y0 - oy);
  const y1 = Math.floor(out.lines[0].y1 - oy);
  const { data } = sf.fill.active.ctx.getImageData(col, y0, 1, y1 - y0);

  let clear = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 128) clear++;
  assert.equal(clear, 0,
    `${clear} of ${y1 - y0} rows of the last letter's rightmost column are unrevealed`);
});

test('the revealed region never shrinks, scanline by scanline', { skip: !font }, async () => {
  // Stronger than the frontier check above: the frontier can be monotonic while
  // the *mask* is not, if the ragged edge slides along it as it advances. A
  // scanline whose edge retreats is ink visibly un-drawing itself.
  const out = outlineText(font, 'Hello world', { fontSize: 120 });
  const plan = await textReveal.compile({ id: 't1', layout: out });
  const sf = surfacesFor(plan);
  const oy = plan.bbox[1] - 32;
  const rows = [0.25, 0.5, 0.75].map((f) =>
    Math.round(out.lines[0].y0 + (out.lines[0].y1 - out.lines[0].y0) * f - oy));

  const edges = rows.map(() => -Infinity);
  for (let i = 0; i <= 120; i++) {
    textReveal.advance(sf, plan, i / 120);
    rows.forEach((y, r) => {
      const { data } = sf.fill.active.ctx.getImageData(0, y, sf.w, 1);
      let edge = -Infinity;
      for (let x = 0; x < sf.w; x++) if (data[x * 4 + 3] > 128) edge = x;
      assert.ok(edge >= edges[r] - 1e-9,
        `row ${y} un-revealed ${edges[r] - edge}px at u=${(i / 120).toFixed(3)}`);
      edges[r] = edge;
    });
  }
});

test('erase finds the ink on a reveal plan, which has no strokes', { skip: !font }, async () => {
  // hasInk/inkExtent scan plan.strokes, and a reveal has none -- the ink is the
  // masked artwork. Without the inkBbox fallback, Erase silently does nothing.
  const out = outlineText(font, 'Hello', { fontSize: 120 });
  const plan = await textReveal.compile({ id: 't1', layout: out });
  assert.equal(plan.strokes.length, 0);
  assert.ok(hasInk(plan), 'the clip plainly has ink');

  const sweep = compileErase(plan, { id: 't1' });
  assert.ok(sweep.strokes.length > 0, 'so it must produce a sweep');
  assert.ok(sweep.width > 3, 'sized off the text, not the 3px stroke default');
});

test('the hand holds its pose instead of rocking about the nib', { skip: !font }, async () => {
  // Deriving the tangent from the near-vertical sweep slams it between roughly
  // +78 and -78 degrees twice per letter; the rig turns that into a visible
  // wag about the pen tip. The pose must be steady while the wrist moves.
  const out = outlineText(font, 'Hello world', { fontSize: 150 });
  const plan = await textReveal.compile({ id: 't1', layout: out });
  const sf = surfacesFor(plan);

  const angles = new Set();
  for (let i = 0; i <= 200; i++) angles.add(textReveal.advance(sf, plan, i / 200).tangent);
  assert.deepEqual([...angles], [0], 'the pen angle must not vary with the sweep');
});

test('reveal travel path bulges during gaps and line breaks', { skip: !font }, async () => {
  const out = outlineText(font, 'Hi\nthere', { fontSize: 100 });
  const plan = await textReveal.compile({ id: 't1', layout: out });

  // Find the line break transition segment index
  const lineBreakSegIndex = plan.segments.findIndex((s) => !s.ink && s.y0 !== s.y1);
  assert.ok(lineBreakSegIndex !== -1, 'must have a line break travel segment');
  
  // Sample frames within that transition segment
  const seg = plan.segments[lineBreakSegIndex];
  let startS = 0;
  for (let i = 0; i < lineBreakSegIndex; i++) startS += plan.segments[i].len;
  
  const midAt = locateFrontier(plan.segments, startS + seg.len / 2);
  
  // The midpoint of the travel between lines must be bulged (smaller Y means higher up on screen)
  const expectedLinearY = (seg.y0 + seg.y1) / 2;
  assert.ok(midAt.y < expectedLinearY - 5, 'midpoint of line break should be bulged upward');
});
