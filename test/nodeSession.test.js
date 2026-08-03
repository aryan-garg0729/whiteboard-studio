/**
 * The headless build path.
 *
 * `buildNodeSession` is shared by the CLI and the MCP server, so a regression
 * here changes what the app exports as well -- electron/main.js spawns
 * render-project.js for its own export.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createCanvas } from '@napi-rs/canvas';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildNodeSession, compileClip, installNodeSurfaces, traceKey,
} from '../src/engine/host/nodeSession.js';
import { renderFrame } from '../src/engine/render/renderFrame.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLES = join(ROOT, 'examples');

installNodeSurfaces();

const rel = (p) => (isAbsolute(p) ? p : resolve(EXAMPLES, p));
const load = (name) => JSON.parse(readFileSync(join(EXAMPLES, `${name}.project.json`), 'utf8'));

/** Vector and text compile in pure JS, so no sidecar is needed to exercise this. */
const build = (name) => buildNodeSession(load(name), { root: ROOT, sidecar: null, rel });

const hashFrame = (built, n) => {
  const { width, height } = built.project.meta;
  const canvas = createCanvas(width, height);
  renderFrame(built.session, built.project, n, canvas.getContext('2d'),
    { width, height, showHand: true, handStyleId: built.handStyleId });
  return createHash('sha256').update(canvas.toBuffer('image/png')).digest('hex');
};

test('a session builds from a document with no sidecar when nothing needs tracing', async () => {
  const built = await build('pages');
  assert.equal(built.project.clips.length, 3);
  assert.equal(built.session.plans.size, 3);
  assert.ok(built.frames > 0);
  assert.equal(built.handStyleId, built.project.meta.handStyleId);
});

test('every clip gets a surface and a bounding box', async () => {
  const { project, bboxes, session } = await build('pages');
  for (const clip of project.clips) {
    assert.ok(bboxes.get(clip.id), `${clip.id} has no bbox`);
    assert.equal(bboxes.get(clip.id).length, 4);
    assert.ok(session.surfaces.get(clip.id), `${clip.id} has no surface`);
  }
});

test('two independent builds of the same document render identical pixels', async () => {
  const a = await build('pages');
  const b = await build('pages');
  // The purity contract, at the level a host actually uses: building twice must
  // not be a source of drift between what an agent sees and what gets encoded.
  for (const n of [0, 40, 200]) assert.equal(hashFrame(a, n), hashFrame(b, n));
});

test('the minimal hand-written example still loads', async () => {
  const built = await build('svg');
  assert.equal(built.project.clips.length, 1);
  assert.equal(built.project.assets[built.project.clips[0].assetId].kind, 'vector');
});

test('compileClip measures a clip on its own, which is what placement needs', async () => {
  const project = load('svg');
  const clip = { ...project.clips[0], id: 'c', transform: { x: 0, y: 0, scale: 1, rotation: 0 } };
  const built = await compileClip(clip, project.assets[clip.assetId],
    { root: ROOT, sidecar: null, rel });
  const [x0, y0, x1, y1] = built.plan.bbox;
  assert.ok(x1 > x0 && y1 > y0, 'a compiled plan must have a real extent');
});

test('an image clip without a sidecar fails with a message that names the cause', async () => {
  await assert.rejects(
    () => compileClip(
      { id: 'c', assetId: 'a', animId: 'draw.imageReveal', transform: { scale: 1 }, params: {} },
      { kind: 'image', src: 'nope.png' },
      { root: ROOT, sidecar: null, rel }),
    /needs the Python sidecar/);
});

test('the trace key changes with the bytes and with the options', () => {
  const a = traceKey(Buffer.from('one'), { mode: 'auto' });
  assert.equal(a, traceKey(Buffer.from('one'), { mode: 'auto' }), 'stable for equal input');
  assert.notEqual(a, traceKey(Buffer.from('two'), { mode: 'auto' }), 'bytes matter');
  assert.notEqual(a, traceKey(Buffer.from('one'), { mode: 'lineArt' }), 'options matter');
});
