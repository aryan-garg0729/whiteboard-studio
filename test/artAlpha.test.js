import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';

import {
  knockOutPaper, wantsPaperKnockout, PAPER_LEVEL, KEEP_LEVEL,
} from '../src/engine/render/artAlpha.js';

/** A 1px-per-sample strip, one sample per colour, so each pixel is readable. */
function strip(colours) {
  const canvas = createCanvas(colours.length, 1);
  const ctx = canvas.getContext('2d');
  colours.forEach(([r, g, b, a], i) => {
    const img = ctx.createImageData(1, 1);
    img.data[0] = r; img.data[1] = g; img.data[2] = b; img.data[3] = a;
    ctx.putImageData(img, i, 0);
  });
  const surface = { canvas, ctx };
  return {
    surface,
    alphas: () => [...ctx.getImageData(0, 0, colours.length, 1).data]
      .filter((_, i) => i % 4 === 3),
  };
}

test('paper dissolves and ink survives', () => {
  const mid = Math.round((PAPER_LEVEL + KEEP_LEVEL) / 2);
  const s = strip([
    [255, 255, 255, 255],           // paper
    [PAPER_LEVEL, 255, 255, 255],   // just at the paper threshold
    [mid, mid, mid, 255],           // halfway up the ramp
    [KEEP_LEVEL, 255, 255, 255],    // just at the keep threshold
    [0, 0, 0, 255],                 // ink
  ]);
  knockOutPaper(s.surface, 5, 1);
  const [white, atPaper, halfway, atKeep, ink] = s.alphas();

  assert.equal(white, 0, 'white paper must go fully transparent');
  assert.equal(atPaper, 0, 'the paper level itself counts as paper');
  assert.equal(atKeep, 255, 'the keep level survives whole');
  assert.equal(ink, 255, 'ink is untouched');
  // A ramp, not a threshold: this is what keeps antialiased edges smooth
  // instead of the artwork acquiring a jagged silhouette.
  assert.ok(Math.abs(halfway - 128) <= 8, `halfway alpha ${halfway}`);
});

test('a pale saturated colour is not mistaken for paper', () => {
  // The metric is the minimum channel, matching the vectorizer's own background
  // test. A perceptual luminance would read this highlight as near-white.
  const s = strip([[255, 250, 180, 255]]);
  knockOutPaper(s.surface, 1, 1);
  assert.equal(s.alphas()[0], 255);
});

test('existing transparency is multiplied, never replaced', () => {
  const s = strip([
    [0, 0, 0, 128],                 // half-transparent ink stays half-transparent
    [255, 255, 255, 128],           // half-transparent paper still goes away
    [0, 0, 0, 0],                   // already invisible
  ]);
  knockOutPaper(s.surface, 3, 1);
  const [ink, paper, gone] = s.alphas();
  assert.equal(ink, 128, 'a PNG that already has transparency must keep it');
  assert.equal(paper, 0);
  assert.equal(gone, 0);
});

test('a translated artwork surface is not slid sideways', () => {
  // The artwork surface carries a standing -origin translate. `putImageData` is
  // specified to ignore the transform and browsers do, but node canvases apply
  // it -- which moved the whole artwork by the origin, so the reveal mask lined
  // up with nothing and a fifth of the picture never appeared.
  const canvas = createCanvas(8, 4);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 3, 1);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 2, 2);                       // lands at device (3,1)-(5,3)

  knockOutPaper({ ctx }, 8, 4);

  const d = ctx.getImageData(0, 0, 8, 4).data;
  const at = (x, y) => d[(y * 8 + x) * 4 + 3];
  assert.equal(at(3, 1), 255, 'the ink must stay where it was drawn');
  assert.equal(at(4, 2), 255);
  assert.equal(at(6, 3), 0, 'and must not have been copied further along');
});

test('photographs keep their paper', () => {
  // A sky is not a background. The classifier is what decides, and this is the
  // only place that decision is consulted.
  assert.equal(wantsPaperKnockout('photo'), false);
  assert.equal(wantsPaperKnockout('lineArt'), true);
  assert.equal(wantsPaperKnockout(null), true, 'an untraced asset is treated as line art');
});
