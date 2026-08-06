import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';

import { setSurfaceFactory, Layer, ClipSurfaces } from '../src/engine/render/surfaces.js';
import { useTestSurfaces } from './helpers/surface.js';

useTestSurfaces();

/** Count non-transparent pixels on a surface. */
function inked(surface, w, h) {
  const d = surface.ctx.getImageData(0, 0, w, h).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
  return n;
}

function paint(ctx) {
  ctx.fillStyle = '#000';
  ctx.fillRect(5, 5, 20, 20);
}

test('reset clears the active layer, not just the committed one', () => {
  // Regression: an animation only calls clearActive() on the layer it is
  // currently drawing into, so a stale `active` on an idle layer keeps
  // compositing forever -- a region appeared pre-coloured before its outline
  // had been drawn.
  const l = new Layer(64, 64);
  paint(l.committed.ctx);
  paint(l.active.ctx);
  assert.ok(inked(l.committed, 64, 64) > 0);
  assert.ok(inked(l.active, 64, 64) > 0);

  l.reset();
  assert.equal(inked(l.committed, 64, 64), 0, 'committed must be cleared');
  assert.equal(inked(l.active, 64, 64), 0, 'active must be cleared too');
  assert.equal(l.used, false);
});

test('resetAll leaves no layer holding stale ink', () => {
  const sf = new ClipSurfaces(64, 64, 0, 0);
  for (const l of [sf.fill, sf.erase]) {
    paint(l.committed.ctx);
    paint(l.active.ctx);
  }
  sf.resetAll();
  for (const [name, l] of [['fill', sf.fill], ['erase', sf.erase]]) {
    assert.equal(inked(l.committed, 64, 64), 0, `${name}.committed`);
    assert.equal(inked(l.active, 64, 64), 0, `${name}.active`);
  }
  assert.equal(sf.lastProgress, -1);
});

test('a reset clip composites to nothing even with artwork installed', () => {
  // The fill mask is empty after a reset, so `destination-in` against the
  // artwork must yield fully transparent output rather than the artwork.
  const sf = new ClipSurfaces(64, 64, 0, 0);
  const art = sf.ensureArt().ctx;
  art.fillStyle = '#ff0000';
  art.fillRect(0, 0, 64, 64);

  paint(sf.fill.active.ctx);   // stale mask from a warm-up render
  sf.resetAll();

  sf.composite();
  assert.equal(inked(sf.out, 64, 64), 0,
    'nothing may show through before any stroke has been drawn');
});

test('the origin translation does not defeat clearing', () => {
  // Drawing contexts carry a standing -origin translate, so a naive
  // clearRect(0,0,w,h) would clear the wrong rectangle.
  const l = new Layer(64, 64);
  l.setOrigin(20, 12);
  l.active.ctx.fillStyle = '#000';
  l.active.ctx.fillRect(20, 12, 30, 30); // object space -> surface (0,0)
  assert.ok(inked(l.active, 64, 64) > 0);
  l.clearActive();
  assert.equal(inked(l.active, 64, 64), 0);
});
