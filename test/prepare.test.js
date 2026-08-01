/**
 * Covers the process boundary: the main process must hand the renderer enough
 * to rebuild plans without touching the filesystem or the sidecar again.
 *
 * The React/DOM layer is thin; this is the part that silently breaks, because
 * a field missing from the payload only shows up as an empty canvas at runtime.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';

import { setSurfaceFactory } from '../src/engine/render/surfaces.js';
import { createSession, renderFrame } from '../src/engine/render/renderFrame.js';
import { normalizeProject, projectFrames } from '../src/engine/model/project.js';
import { makeStroke } from '../src/engine/compile/geometry.js';
import { prepareProject, prepareHand } from '../electron/prepare.js';
import { HAND_STYLE_IDS, styleIdsFor } from '../src/engine/hand/styles.js';
import outlineFill from '../src/engine/anim/outlineFill.js';
import { compileErase } from '../src/engine/anim/erase.js';

setSurfaceFactory((w, h) => {
  const canvas = createCanvas(w, h);
  return { canvas, ctx: canvas.getContext('2d') };
});

const ROOT = new URL('..', import.meta.url).pathname;
const svgProjectPath = `${ROOT}examples/svg.project.json`;

/** A vector project needs no sidecar, so this runs offline. */
async function prepared() {
  const project = normalizeProject(JSON.parse(readFileSync(svgProjectPath, 'utf8')));
  return { project, prepared: await prepareProject(project, svgProjectPath, null) };
}

test('the prepared payload survives a JSON round trip', async () => {
  // Typed arrays are flattened deliberately: the payload must be loggable and
  // writable to disk, not merely structured-cloneable.
  const { prepared: p } = await prepared();
  const round = JSON.parse(JSON.stringify(p));
  assert.deepEqual(round, p, 'payload must contain no non-JSON values');
});

test('a vector clip is prepared without the sidecar', async () => {
  const { prepared: p } = await prepared();
  const entry = p.s;
  assert.equal(entry.kind, 'drawable');
  assert.ok(entry.subpaths.length > 0);
  assert.ok(entry.regions.length > 0);
  assert.equal(entry.art, null, 'vectors carry no raster; the renderer paints their fills');
  assert.ok(Array.isArray(entry.subpaths[0].pts), 'geometry must be plain arrays');
  assert.ok(Array.isArray(entry.regions[0].rings[0]));
});

test('the payload is sufficient to rebuild a plan and render a frame', async () => {
  const { project, prepared: p } = await prepared();
  const hand = prepareHand(ROOT, project.meta.handStyleId);

  const session = createSession({
    hands: new Map([[hand.style.id, hand.style]]),
    resolveImage: () => null,          // hand sprite not needed for this check
  });

  // Exactly what src/ui/engineHost.js does, minus the DOM.
  const f64 = (a) => Float64Array.from(a);
  for (const clip of project.clips) {
    const e = p[clip.id];
    const plan = await outlineFill.compile({
      id: clip.assetId,
      bbox: e.bbox,
      subpaths: e.subpaths.map((s) => ({ pts: f64(s.pts), closed: s.closed })),
      regions: e.regions.map((r) => ({ rings: r.rings.map(f64), color: r.color, bbox: r.bbox })),
    }, { brushWidth: 3, fillBrushWidth: 14 });
    assert.ok(plan.strokes.length > 0, `${clip.id} compiled to nothing`);
    session.plans.set(clip.id, plan);
  }

  const { width, height } = project.meta;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const mid = Math.floor(projectFrames(project) * 0.6);
  renderFrame(session, project, mid, ctx, { width, height, showHand: false });

  // Something must actually be on the canvas by 60% through the animation.
  const data = ctx.getImageData(0, 0, width, height).data;
  let painted = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] < 240 || data[i + 1] < 240 || data[i + 2] < 240) painted++;
  }
  assert.ok(painted > 1000, `expected visible ink, got ${painted} non-background pixels`);
});

test('prepareHand supplies the manifest plus every source image inline', () => {
  const hand = prepareHand(ROOT, 'hand1');
  assert.equal(hand.style.id, 'hand1', 'style is the chosen drawing hand');

  const sources = hand.styles.flatMap((s) => s.sources);
  assert.equal(Object.keys(hand.images).length, new Set(sources.map((s) => s.file)).size);
  for (const src of sources) {
    assert.ok(hand.images[src.file].startsWith('data:image/png;base64,'),
      `${src.file} must be inlined; the renderer cannot read the filesystem`);
  }
});

test('prepareHand carries the tool styles alongside the chosen hand', () => {
  // renderFrame resolves a non-pen tool by scanning the styles it was given, so
  // shipping only the drawing hand is what leaves erase sweeps handless.
  const hand = prepareHand(ROOT, 'hand1');
  assert.deepEqual(hand.styles.map((s) => s.id), ['hand1', 'eraser']);
  const eraser = hand.styles.find((s) => s.tool?.type === 'eraser');
  assert.ok(eraser, 'an eraser-tool style must be loaded');
  assert.ok(eraser.sources.length > 0);
  assert.equal(eraser.anchorEdge, 'bottom', 'the eraser arm exits the frame like a hand');
  // The tip must be the eraser block, not the index fingertip that touches the
  // top edge above it -- rigging by the finger drags the block off the stroke.
  const [, tipY] = eraser.sources[0].tipPx;
  assert.ok(tipY > 20, `eraser tip should sit on the block, got y=${tipY}`);
});

test('the eraser is not offered as a drawing hand', () => {
  assert.ok(!HAND_STYLE_IDS.includes('eraser'));
  assert.deepEqual(styleIdsFor('hand2'), ['hand2', 'eraser']);
  // A style must never be loaded twice into the same session map.
  assert.deepEqual(styleIdsFor('eraser'), ['eraser']);
});

test('an erase sweep draws the eraser hand, not nothing', async () => {
  // The regression this guards: renderFrame resolves a non-pen tool by scanning
  // session.hands, and every host used to build that map from the chosen
  // drawing hand alone. The eraser manifest then existed but was never loaded,
  // so erase sweeps silently ran with no hand at all.
  const { project: base, prepared: p } = await prepared();
  const clip = { ...base.clips[0] };
  const project = normalizeProject({
    ...base,
    clips: [{ ...clip, erase: { start: clip.start + clip.duration, duration: 2 } }],
  });

  const hand = prepareHand(ROOT, project.meta.handStyleId);
  // Stand in for the real sprites: a solid block per source, so "was the hand
  // drawn" is a pixel question rather than a mock-call question.
  const sprite = createCanvas(64, 64);
  const sctx = sprite.getContext('2d');
  sctx.fillStyle = '#ff00ff';
  sctx.fillRect(0, 0, 64, 64);

  const drawn = [];
  const session = createSession({
    hands: new Map(hand.styles.map((s) => [s.id, s])),
    resolveImage: (src) => { drawn.push(src.file); return sprite; },
  });

  const f64 = (a) => Float64Array.from(a);
  const e = p[clip.id];
  const plan = await outlineFill.compile({
    id: clip.assetId,
    bbox: e.bbox,
    subpaths: e.subpaths.map((s) => ({ pts: f64(s.pts), closed: s.closed })),
    regions: e.regions.map((r) => ({ rings: r.rings.map(f64), color: r.color, bbox: r.bbox })),
  }, { brushWidth: 3, fillBrushWidth: 14 });
  session.plans.set(clip.id, plan);
  session.erasePlans.set(clip.id, compileErase(plan, { id: clip.id }));

  const { width, height, fps } = project.meta;
  const ctx = createCanvas(width, height).getContext('2d');
  // Halfway through the sweep: past the draw, well before it ends.
  const n = Math.round((project.clips[0].erase.start + 1) * fps);
  renderFrame(session, project, n, ctx, {
    width, height, showHand: true, handStyleId: hand.style.id,
  });

  assert.ok(drawn.length > 0, 'no hand sprite was requested during the erase');
  const eraserSources = hand.styles.find((s) => s.tool?.type === 'eraser')
    .sources.map((s) => s.file);
  assert.ok(drawn.some((f) => eraserSources.includes(f)),
    `expected an eraser sprite, got ${JSON.stringify(drawn)}`);
});
