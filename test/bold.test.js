/**
 * Bold text.
 *
 * Two mechanisms, and which one a face gets is not a detail: four of the nine
 * bundled faces carry a `wght` variation axis and produce a real bold, the other
 * five have their own outline stroked wider. Both have to end up thicker, and
 * neither may move the letters off the line.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import opentype from 'opentype.js';

import {
  applyWeight, boldModeFor, hasSoundWeightAxis, outlineText, placeGlyphs, weightAxis,
} from '../src/engine/compile/text.js';
import { listFonts } from '../electron/fonts.js';

const face = (file) => {
  const buf = readFileSync(new URL(`../assets/fonts/${file}`, import.meta.url));
  return opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
};

/** A face with a wght axis, and one without. */
const VARIABLE = 'Caveat.ttf';
const STATIC = 'PatrickHand-Regular.ttf';

const inkWidth = (layout) => layout.inkBbox[2] - layout.inkBbox[0];
const inkHeight = (layout) => layout.inkBbox[3] - layout.inkBbox[1];

test('the bundled faces split into real and synthetic bold as expected', () => {
  const byFamily = Object.fromEntries(listFonts().map((f) => [f.family, f.boldMode]));
  assert.equal(byFamily.Caveat, 'variable');
  assert.equal(byFamily['Open Sans'], 'variable');
  assert.equal(byFamily['Playfair Display'], 'variable');
  // Has a wght axis, but see the Montserrat test below.
  assert.equal(byFamily.Montserrat, 'synthetic');
  assert.equal(byFamily['Patrick Hand'], 'synthetic');
  assert.equal(byFamily['Indie Flower'], 'synthetic');
  assert.equal(byFamily.Poppins, 'synthetic');
});

test('a face whose weight axis interpolates badly is refused', () => {
  // opentype.js 2.0.0 mis-interpolates Montserrat's `o`: at wght 700 its counter
  // comes back nearly as large as the letter, so the glyph renders as a thin
  // notched ring. Every other glyph in the face doubles its ink as expected,
  // which is exactly why the check is per-glyph and the verdict per-face.
  const font = face('Montserrat.ttf');
  assert.ok(weightAxis(font), 'Montserrat does carry a wght axis');
  assert.equal(hasSoundWeightAxis(font), false);
  assert.equal(boldModeFor(font), 'synthetic');

  // The bad glyph, pinned directly: bold must not lose ink.
  const regular = outlineText(face('Montserrat.ttf'), 'o', { fontSize: 100 });
  const bold = outlineText(face('Montserrat.ttf'), 'o', { fontSize: 100, bold: true });
  assert.ok(bold.regions[0].dilate > 0, 'so it falls back to a stroked outline');
  assert.deepEqual(bold.regions[0].rings[0], regular.regions[0].rings[0],
    'and the outline itself is left at the regular instance');
});

test('the sound faces are still given a real weight', () => {
  for (const file of ['Caveat.ttf', 'OpenSans.ttf', 'PlayfairDisplay.ttf']) {
    assert.equal(hasSoundWeightAxis(face(file)), true, file);
  }
});

test('probing a face leaves its variation coordinates where it found them', () => {
  const font = face('OpenSans.ttf');
  font.variation.set({ wght: 512 });
  hasSoundWeightAxis(font);
  assert.equal(font.variation.get().wght, 512);
});

test('a variable face gets a real weight, not a stroked outline', () => {
  const font = face(VARIABLE);
  assert.ok(weightAxis(font), 'this test needs a face with a wght axis');

  const regular = outlineText(face(VARIABLE), 'Handy', { fontSize: 100 });
  const bold = outlineText(face(VARIABLE), 'Handy', { fontSize: 100, bold: true });

  // Nothing to fake, so nothing is marked for faking.
  assert.equal(regular.regions[0].dilate, undefined);
  assert.equal(bold.regions[0].dilate, undefined);
  // The letterforms themselves changed.
  assert.notDeepEqual(bold.regions[0].rings[0], regular.regions[0].rings[0]);
});

test('a variable face lays bold out on its own bold metrics', () => {
  // The trap this pins: `glyph.advanceWidth` is only brought up to date with
  // HVAR as a side effect of the variation transform, which nothing else in
  // the layout triggers. Read it without that and the advances come back
  // identical to regular -- so the assertion is that they *differ*, not that
  // they are wider. Bold is not reliably wider: Montserrat's bold 'H' has
  // tighter sidebearings than its regular, while Open Sans' is wider.
  for (const file of ['PlayfairDisplay.ttf', 'OpenSans.ttf']) {
    const regular = placeGlyphs(face(file), 'HHHH', { fontSize: 100 });
    const bold = placeGlyphs(face(file), 'HHHH', { fontSize: 100, bold: true });
    assert.notEqual(bold.maxWidth, regular.maxWidth,
      `${file}: bold must not reuse the regular instance's advances`);
  }
  // Open Sans is the one that does widen, which fixes the direction in place.
  const r = placeGlyphs(face('OpenSans.ttf'), 'HHHH', { fontSize: 100 });
  const b = placeGlyphs(face('OpenSans.ttf'), 'HHHH', { fontSize: 100, bold: true });
  assert.ok(b.maxWidth > r.maxWidth, `${b.maxWidth} vs ${r.maxWidth}`);
});

test('regular pins a variable face to 400 rather than its default instance', () => {
  // Montserrat's wght axis defaults to 100 -- left alone, every caption in it
  // rendered Thin.
  const font = face('Montserrat.ttf');
  assert.equal(font.tables.fvar.axes.find((a) => a.tag === 'wght').defaultValue, 100);
  applyWeight(font, false, 100);
  assert.equal(font.variation.get().wght, 400);
});

test('a static face is emboldened by stroking its own outline', () => {
  const font = face(STATIC);
  assert.equal(weightAxis(font), null, 'this test needs a face with no wght axis');

  const regular = outlineText(face(STATIC), 'Handy', { fontSize: 100 });
  const bold = outlineText(face(STATIC), 'Handy', { fontSize: 100, bold: true });

  assert.equal(regular.regions[0].dilate, undefined, 'regular must carry no dilation');
  assert.ok(bold.regions[0].dilate > 0, 'bold must ask for a dilation');
  // The outline cannot change -- it is the same glyph -- so the weight is
  // entirely in the stroke, and only the bounds may move.
  assert.deepEqual(bold.regions[0].rings[0], regular.regions[0].rings[0]);
});

test('synthetic bold grows the ink bounds so nothing downstream clips it', () => {
  // The reveal band in textReveal, the glyph wipe in handwrite and the eraser
  // sweep are all sized off these bounds. If they do not grow, the thickened
  // stems are drawn and then never revealed.
  const regular = outlineText(face(STATIC), 'Handy', { fontSize: 100 });
  const bold = outlineText(face(STATIC), 'Handy', { fontSize: 100, bold: true });
  const grow = bold.regions[0].dilate / 2;

  assert.ok(inkWidth(bold) > inkWidth(regular));
  assert.ok(inkHeight(bold) >= inkHeight(regular) + grow);
  assert.ok(bold.inkBbox[0] < regular.inkBbox[0], 'the left edge must move out too');
});

test('bold does not shift the baseline or the line count', () => {
  for (const file of [VARIABLE, STATIC]) {
    const regular = outlineText(face(file), 'one\ntwo', { fontSize: 80 });
    const bold = outlineText(face(file), 'one\ntwo', { fontSize: 80, bold: true });
    assert.equal(bold.lines.length, regular.lines.length, file);
    assert.equal(bold.height, regular.height, file);
    // Same rows of text, within the dilation the emboldening adds.
    const slack = (bold.regions[0].dilate || 0) / 2 + 1e-6;
    assert.ok(Math.abs(bold.lines[1].y0 - regular.lines[1].y0) <= slack + 4, file);
  }
});

test('bold is off unless asked for', () => {
  const plain = outlineText(face(STATIC), 'Handy', { fontSize: 100 });
  const explicit = outlineText(face(STATIC), 'Handy', { fontSize: 100, bold: false });
  assert.deepEqual(plain.inkBbox, explicit.inkBbox);
  assert.equal(explicit.regions[0].dilate, undefined);
});

// ── the serialiser trap ───────────────────────────────────────────────

test('no glyph is silently dropped at any size, in either weight', () => {
  // opentype.js 2.0.0's `toPathData` rounds by string concatenation
  // (`decimalPart + 'e+' + places`), so a coordinate whose fractional part is
  // small enough to stringify in exponential notation serialises as the literal
  // "NaN" and the contour is lost. It is silent, and it depends on where the
  // glyph happens to land, which is why it read as a rendering glitch rather
  // than a bug: at 64px this ate Caveat's `Y` and Playfair Display's `L`.
  // `flattenCommands` reads the command objects instead, which are always fine.
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const faces = readdirSync(new URL('../assets/fonts/', import.meta.url))
    .filter((f) => f.endsWith('.ttf'));
  assert.ok(faces.length >= 9);

  for (const file of faces) {
    for (const fontSize of [24, 37, 64, 91, 120, 203]) {
      for (const bold of [false, true]) {
        const layout = outlineText(face(file), chars, { fontSize, bold });
        const missing = layout.glyphs.filter((g) => !g.ink).map((g) => g.ch);
        assert.deepEqual(missing, [], `${file} @${fontSize} bold=${bold}`);
      }
    }
  }
});
