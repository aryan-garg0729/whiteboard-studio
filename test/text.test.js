import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import opentype from 'opentype.js';
import { createCanvas } from '@napi-rs/canvas';

import { outlineText, placeGlyphs, traceText } from '../src/engine/compile/text.js';
import { guideForCharacter } from '../src/engine/compile/textGuides.js';
import handwrite from '../src/engine/anim/handwrite.js';
import { setSurfaceFactory, ClipSurfaces } from '../src/engine/render/surfaces.js';
import { compileErase, hasInk } from '../src/engine/anim/erase.js';
import textReveal, {
  buildSegments, locateFrontier, OSCILLATION_REACH, LOOP_VARY,
} from '../src/engine/anim/textReveal.js';
import { easeEnds } from '../src/engine/anim/penStrokes.js';
import { useTestSurfaces } from './helpers/surface.js';


// ── filled letterforms and the left-to-right reveal ───────────────────
//
// The reveal animation is the default for text, so these guard the geometry it
// stands on: the outlines must be the font's own, and the pen must sweep the
// letters rather than wander off them.

const FONT_PATH = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
const font = (() => {
  try {
    const buf = readFileSync(FONT_PATH);
    return opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  } catch {
    return null;                              // no DejaVu installed; skip below
  }
})();

useTestSurfaces();

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

test('every printable ASCII glyph has a deliberate writing guide', () => {
  for (let code = 33; code <= 126; code++) {
    const ch = String.fromCharCode(code);
    const guide = guideForCharacter(ch);
    assert.ok(guide?.length, `${JSON.stringify(ch)} has no guide`);
    for (const stroke of guide) assert.ok(stroke.length >= 2, `${JSON.stringify(ch)} has a degenerate stroke`);
  }
});

test('trace guides reveal real glyph outlines and never rotate the hand', { skip: !font }, async () => {
  const layout = traceText(font, 'A0?!', { fontSize: 120, penWidth: 5 });
  assert.equal(layout.regions.length, 4);
  assert.ok(layout.guides.some((g) => g.lift), 'multi-stroke letters lift the pen');
  const plan = await handwrite.compile({ layout });
  const sf = surfacesFor(plan);
  for (let i = 0; i <= 80; i++) {
    const pen = handwrite.advance(sf, plan, i / 80);
    assert.equal(pen.tangent, 0, 'guide turns must move at the wrist, not rotate the arm');
  }
  const { data } = sf.fill.active.ctx.getImageData(0, 0, sf.w, sf.h);
  assert.ok(data.some((v, i) => i % 4 === 3 && v > 0), 'the completed true-outline mask has ink');
});

test('trace reveals an active glyph as one advancing soft wipe, not stroke fragments', { skip: !font }, async () => {
  const layout = traceText(font, 'O', { fontSize: 160, penWidth: 5 });
  const plan = await handwrite.compile({ layout });
  const sf = surfacesFor(plan);
  const [x0, y0, x1, y1] = plan.glyphBounds[0];
  const y = Math.round((y0 + y1) / 2 - sf.originY);
  let previous = -Infinity;
  for (const u of [0.15, 0.3, 0.45, 0.6, 0.75]) {
    handwrite.advance(sf, plan, u);
    const { data } = sf.fill.active.ctx.getImageData(0, y, sf.w, 1);
    let edge = -Infinity;
    for (let x = Math.floor(x0 - sf.originX); x <= Math.ceil(x1 - sf.originX); x++) {
      if (data[x * 4 + 3] > 16) edge = x;
    }
    assert.ok(edge >= previous, `glyph reveal retreated at u=${u}`);
    previous = edge;
  }
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

// ── alignment ─────────────────────────────────────────────────────────

/** Left edge of the ink on each line, which is what alignment actually moves. */
const lineLefts = (out) => out.lines.map((l) => (l.spans.length ? l.spans[0][0] : null));

/** Right edge of the ink on each line. */
const lineRights = (out) =>
  out.lines.map((l) => (l.spans.length ? l.spans[l.spans.length - 1][1] : null));

/**
 * Where each line starts and ends in *advance* units, which is what alignment
 * is defined against.
 *
 * Deliberately not the ink extents: a glyph's sidebearing is part of its
 * advance, so two lines that are perfectly aligned still have ink edges a couple
 * of pixels apart depending on which letters they happen to end with. Aligning
 * on advances is what every text engine does, and optical alignment would be a
 * different feature.
 */
function lineAdvances(text, o) {
  const { placements, lineCount } = placeGlyphs(font, text, o);
  const rows = Array.from({ length: lineCount }, () => ({ x0: Infinity, x1: -Infinity }));
  for (const p of placements) {
    const row = rows[p.lineIndex];
    row.x0 = Math.min(row.x0, p.penX);
    row.x1 = Math.max(row.x1, p.penX + p.glyph.advanceWidth);
  }
  return rows;
}

test('a short line is centred against the long one by default', { skip: !font }, () => {
  // Deliberately lopsided, so the offset is far larger than any rounding.
  const text = 'a much longer line\nshort';
  const [long, short] = lineAdvances(text, { fontSize: 100 });

  assert.ok(short.x0 > long.x0, 'the short line must be pushed in from the left');
  assert.ok(short.x1 < long.x1, 'and must not reach as far right');
  // Centred means the two margins match, not merely that the line moved.
  assert.ok(Math.abs((short.x0 - long.x0) - (long.x1 - short.x1)) < 1e-6,
    `margins must match, got ${short.x0 - long.x0} and ${long.x1 - short.x1}`);

  // The ink follows, allowing for the sidebearings above.
  const out = outlineText(font, text, { fontSize: 100 });
  assert.ok(lineLefts(out)[1] > lineLefts(out)[0]);
  assert.ok(lineRights(out)[1] < lineRights(out)[0]);
});

test('align picks which edge the lines agree on', { skip: !font }, () => {
  const text = 'a much longer line\nshort';
  const left = lineAdvances(text, { fontSize: 100, align: 'left' });
  const right = lineAdvances(text, { fontSize: 100, align: 'right' });

  assert.equal(left[0].x0, left[1].x0, 'left-aligned lines must start together');
  assert.equal(right[0].x1, right[1].x1, 'right-aligned lines must end together');
  // And the two are genuinely different layouts, or neither assertion proves much.
  assert.ok(right[1].x0 > left[1].x0);
});

test('alignment moves the ink but never the drawable', { skip: !font }, () => {
  // The bbox is what places the clip in frame, so if it moved with alignment,
  // changing alignment would shove the caption across the page.
  const text = 'a much longer line\nshort';
  const each = ['left', 'center', 'right'].map((align) =>
    outlineText(font, text, { fontSize: 100, align }));

  for (const out of each.slice(1)) {
    assert.deepEqual(out.bbox, each[0].bbox, 'bbox must not depend on alignment');
    assert.equal(out.width, each[0].width);
    assert.equal(out.height, each[0].height);
  }
});

test('a single line lays out identically whatever the alignment', { skip: !font }, () => {
  // There is no slack to distribute, so all three must agree exactly -- this is
  // what makes centring safe as a default for existing one-line captions.
  const each = ['left', 'center', 'right'].map((align) =>
    outlineText(font, 'Hello world', { fontSize: 100, align }));
  assert.deepEqual(each[1].inkBbox, each[0].inkBbox);
  assert.deepEqual(each[2].inkBbox, each[0].inkBbox);
});

test('an unknown alignment falls back to the default rather than collapsing',
  { skip: !font }, () => {
    const text = 'a much longer line\nshort';
    const bogus = outlineText(font, text, { fontSize: 100, align: 'justify' });
    const centred = outlineText(font, text, { fontSize: 100, align: 'center' });
    assert.deepEqual(lineLefts(bogus), lineLefts(centred));
  });

test('handwriting guides follow the aligned letters', { skip: !font }, () => {
  // traceText fits its routes to each glyph's own bounds, so if alignment were
  // applied anywhere later than placeGlyphs the guides would be left behind on
  // the unaligned positions.
  const text = 'a much longer line\nshort';
  const layout = traceText(font, text, { fontSize: 100, penWidth: 5, align: 'right' });
  const outline = outlineText(font, text, { fontSize: 100, align: 'right' });

  const inked = layout.glyphs.filter((g) => g.ink);
  const last = inked[inked.length - 1];
  const guide = layout.guides.find((g) => g.glyph === last.regionIndex && !g.lift);
  assert.ok(guide, 'expected a guide on the last glyph');

  const xs = guide.pts.filter((_, i) => i % 2 === 0);
  const [x0, , x1] = last.bbox;
  assert.ok(Math.min(...xs) >= x0 - 1 && Math.max(...xs) <= x1 + 1,
    'the guide must sit inside its glyph, wherever alignment put it');
  assert.deepEqual(lineRights(layout), lineRights(outline));
});
