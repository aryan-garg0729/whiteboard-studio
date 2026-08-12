/**
 * The MCP layer's pure half: the sandbox, the validation the schema does not
 * do, the transactional edit rule, and the placement pass.
 *
 * Everything here runs without a server, a display, ffmpeg or Python. Driving
 * the actual protocol is `mcp/smoke.js`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  checkAnimForKind, checkParams, checkTransform, checkHandStyle, animations,
} from '../mcp/capabilities.js';
import { Studio } from '../mcp/studio.js';
import { storyboard, textDuration } from '../mcp/storyboard.js';
import {
  ROOT, WORKSPACE, ensureWorkspace, projectPath, readablePath, writablePath,
} from '../mcp/workspace.js';
import * as edits from '../src/engine/model/edits.js';
import { normalizeProject, projectFrames } from '../src/engine/model/project.js';

ensureWorkspace();

// Each test that writes gets its own project name, so a failure cannot leave
// state that makes the next run pass or fail for the wrong reason.
let seq = 0;
const scratch = () => `test_${process.pid}_${++seq}`;
const cleanup = (name) => rmSync(projectPath(name), { force: true });

const ctx = () => ({ root: ROOT, rel: readablePath });

// ── the sandbox ───────────────────────────────────────────────────────

test('a path escaping the workspace is refused, even normalised', () => {
  for (const bad of ['../../etc/passwd', '../../../etc/x', '/etc/passwd',
    'a/../../../../tmp/x', `${WORKSPACE}/../outside.json`]) {
    assert.throws(() => writablePath(bad), /outside the workspace/, bad);
  }
});

test('a plain name resolves inside the workspace', () => {
  assert.equal(writablePath('arrow.svg'), join(WORKSPACE, 'arrow.svg'));
  assert.equal(writablePath('sub/arrow.svg'), join(WORKSPACE, 'sub/arrow.svg'));
});

test('reads are allowed from the bundled assets but not from anywhere', () => {
  assert.ok(readablePath(join(ROOT, 'assets/fonts/Caveat.ttf')));
  assert.ok(readablePath(join(ROOT, 'examples/shapes.svg')));
  assert.throws(() => readablePath('/etc/passwd'), /outside the workspace/);
});

test('a project name that could escape is refused', () => {
  for (const bad of ['../evil', 'a/b', '', 'x'.repeat(65)]) {
    assert.throws(() => projectPath(bad), /invalid project name/);
  }
});

// ── validation the schema does not do ─────────────────────────────────

test('an animation must suit the asset kind it is asked to draw', () => {
  assert.throws(() => checkAnimForKind('draw.handwrite', 'image'),
    /does not suit a image asset/);
  assert.throws(() => checkAnimForKind('draw.stencilPaint', 'text'),
    /does not suit a text asset/);
  checkAnimForKind('draw.handwrite', 'text');
  checkAnimForKind('appear.fade', 'vector');
});

test('unknown params are rejected rather than silently dropped', () => {
  assert.throws(() => checkParams('draw.stencilPaint', { fillbrushwidth: 3 }),
    /has no parameter "fillbrushwidth"/);
  assert.throws(() => checkParams('draw.handwrite', { anything: 1 }),
    /takes no parameters/);
  // The pencil stencil is gone, and so are the parameters that described it.
  assert.throws(() => checkParams('draw.stencilPaint', { pencilWidth: 3 }),
    /has no parameter "pencilWidth"/);
});

test('out-of-range params are clamped, and the clamp is reported', () => {
  const r = checkParams('draw.stencilPaint', { fillBrushWidth: 999 });
  assert.equal(r.params.fillBrushWidth, 64);
  assert.match(r.notes[0], /fillBrushWidth clamped from 999 to 64/);
});

test('params of the wrong type are refused', () => {
  assert.throws(() => checkParams('draw.stencilPaint', { fillBrushWidth: 'thick' }),
    /must be a finite number/);
  assert.throws(() => checkParams('draw.stencilPaint', { mode: 'sideways' }),
    /must be one of/);
  assert.throws(() => checkParams('draw.stencilPaint', []), /must be an object/);
});

test('a transform must be finite numbers, because the schema does not check', () => {
  assert.throws(() => checkTransform({ scale: '2' }), /must be a finite number/);
  assert.throws(() => checkTransform({ x: NaN }), /must be a finite number/);
  assert.throws(() => checkTransform({ scale: 0 }), /must be positive/);
  assert.throws(() => checkTransform({ z: 1 }), /has no field "z"/);
  assert.deepEqual(checkTransform({ x: 10, scale: 2 }), { x: 10, scale: 2 });
});

test('an unknown hand style is refused', () => {
  assert.throws(() => checkHandStyle('hand9'), /unknown hand style/);
  checkHandStyle('hand1');
});

test('every registered animation is catalogued with the kinds it suits', () => {
  const all = animations();
  // stencilPaint replaced imageReveal and outlineFill; inkPaint was then added
  // beside it as the specialist for outlined, flat-filled artwork.
  assert.equal(all.length, 8);
  for (const a of all) {
    assert.ok(a.kinds.length, `${a.id} suits no asset kind`);
    assert.ok(a.paramSchema, `${a.id} has no paramSchema`);
  }
});

// ── the append rule ───────────────────────────────────────────────────

test('a clip appended straight after a page break waits for the swipe to land', () => {
  // Two ordinary actions -- add a page, add a clip -- used to produce a
  // document the validator rejects, because the break lands at the end of
  // everything authored and the clip then started at that same instant.
  let doc = edits.addClipTo(edits.EMPTY_PROJECT, { kind: 'text', text: 'one' }, { duration: 3 });
  doc = edits.addPageBreak(doc, { transition: 'swipeLeft', duration: 0.6 });
  doc = edits.addClipTo(doc, { kind: 'text', text: 'two' }, { duration: 2 });

  const brk = doc.pageBreaks[0];
  assert.ok(doc.clips[1].start >= brk.t + brk.duration,
    `clip starts at ${doc.clips[1].start}, transition ends at ${brk.t + brk.duration}`);
  assert.doesNotThrow(() => normalizeProject(doc));
});

test('a cut never pushes a clip forward, having no duration to be inside', () => {
  let doc = edits.addClipTo(edits.EMPTY_PROJECT, { kind: 'text', text: 'one' }, { duration: 3 });
  doc = edits.addPageBreak(doc, { transition: 'cut' });
  doc = edits.addClipTo(doc, { kind: 'text', text: 'two' }, { duration: 2 });
  assert.equal(doc.clips[1].start, doc.pageBreaks[0].t);
  assert.doesNotThrow(() => normalizeProject(doc));
});

// ── refusals ──────────────────────────────────────────────────────────

test('removing a page that is still in use reports why, instead of doing nothing', () => {
  let doc = edits.addClipTo(edits.EMPTY_PROJECT, { kind: 'text', text: 'hi' });
  doc = edits.addPageBreak(doc, {});
  const added = doc.pages[1].id;

  assert.throws(() => edits.removePage(doc, doc.pages[0].id), /still has 1 clip on it/);
  assert.throws(() => edits.removePage(doc, added), /target of a page break/);
  assert.throws(() => edits.removePage(edits.EMPTY_PROJECT, 'page1'),
    /needs at least one page/);
});

test('removing the only lane of a kind reports why', () => {
  assert.throws(() => edits.removeTrack(edits.EMPTY_PROJECT, 'v1'),
    /only clip lane/);
  assert.throws(() => edits.removeTrack(edits.EMPTY_PROJECT, 'nope'), /no such track/);
});

// ── placement ─────────────────────────────────────────────────────────

test('placeInFrame centres a drawable on the camera and never enlarges it', () => {
  const meta = { width: 1000, height: 1000 };
  const cam = { x: 0, y: 0, zoom: 1 };

  // A bbox whose origin is nowhere near its centre: the case the whole function
  // exists for, since a clip's transform positions its corner.
  const tr = edits.placeInFrame([100, 200, 300, 400], cam, meta);
  assert.equal(tr.scale, 1, 'already fits, so it is not blown up');
  assert.equal(tr.x + 200 * tr.scale, 0, 'bbox centre lands on the camera centre');
  assert.equal(tr.y + 300 * tr.scale, 0);

  const huge = edits.placeInFrame([0, 0, 5000, 5000], cam, meta);
  assert.ok(huge.scale < 1, 'oversized artwork is shrunk to fit');
  assert.ok(5000 * huge.scale <= meta.width, 'and actually fits afterwards');
});

test('only with grow does a small drawable get scaled up to fill the frame', () => {
  const meta = { width: 1000, height: 1000 };
  const cam = { x: 0, y: 0, zoom: 1 };
  const tiny = [0, 0, 50, 50];

  assert.equal(edits.placeInFrame(tiny, cam, meta).scale, 1, 'the default never enlarges');
  // An SVG viewBox is arbitrary units, so a small one must be allowed to fill
  // the frame or every generated diagram is a postage stamp.
  const grown = edits.placeInFrame(tiny, cam, meta, 0.8, true);
  assert.ok(grown.scale > 1);
  assert.equal(50 * grown.scale, 800, 'fills exactly the requested fraction');
});

test('worldRect composes a local bbox with a clip transform', () => {
  const r = edits.worldRect([0, 0, 100, 50], { x: 10, y: -20, scale: 2 });
  assert.deepEqual(r, { x: 10, y: -20, width: 200, height: 100 });
});

test('worldRect reports where a rotated or mirrored clip actually is', () => {
  // A quarter turn swaps the extents, and about the origin corner it also puts
  // the artwork somewhere else. Reporting the untilted box here would make the
  // MCP report's "offscreen" warning quietly wrong.
  const turned = edits.worldRect([0, 0, 100, 50], { x: 0, y: 0, scale: 1, rotation: 90 });
  for (const [k, want] of Object.entries({ x: -50, y: 0, width: 50, height: 100 })) {
    assert.ok(Math.abs(turned[k] - want) < 1e-9, `${k}: ${turned[k]} !== ${want}`);
  }

  const mirrored = edits.worldRect([0, 0, 100, 50], { x: 0, y: 0, scale: 1, scaleX: -1 });
  assert.deepEqual(mirrored, { x: -100, y: 0, width: 100, height: 50 });
});

// ── the studio ────────────────────────────────────────────────────────

test('a new project is valid, saved, and empty', () => {
  const name = scratch();
  try {
    const doc = new Studio().create(name, { width: 1280, height: 720 });
    assert.equal(doc.meta.width, 1280);
    assert.equal(doc.clips.length, 0);
    assert.doesNotThrow(() => normalizeProject(doc));
  } finally { cleanup(name); }
});

test('an edit the validator rejects leaves the document exactly as it was', () => {
  const name = scratch();
  try {
    const studio = new Studio();
    studio.create(name);
    const before = JSON.stringify(studio.doc(name));

    assert.throws(
      // An erase before the clip has finished drawing: a rule, not a typo.
      () => studio.commit(name, (d) => ({
        ...d,
        assets: { a1: { kind: 'text', text: 'hi' } },
        clips: [{ id: 'c1', assetId: 'a1', animId: 'draw.handwrite', start: 0, duration: 5,
                  erase: { start: 1, duration: 1 } }],
      })),
      /erase begins at 1s but the clip is still drawing/);

    assert.equal(JSON.stringify(studio.doc(name)), before, 'the document moved');
  } finally { cleanup(name); }
});

test('a structural edit drops the cached session and a timing edit keeps it', async () => {
  const name = scratch();
  try {
    const studio = new Studio();
    studio.create(name);
    await studio.addClip(name, { kind: 'text', text: 'hello' }, { duration: 3 });

    const built = await studio.built(name);
    const clipId = built.project.clips[0].id;

    // Asserted on the session rather than the wrapper: a retime refreshes the
    // wrapper so the render sees the new document, but must not touch the
    // compiled geometry inside it.
    studio.updateClip(name, clipId, { start: 1 });
    assert.equal((await studio.built(name)).session, built.session, 'a retime rebuilt the session');

    studio.updateClip(name, clipId, { animId: 'appear.fade' });
    assert.notEqual((await studio.built(name)).session, built.session,
      'an animation change reused a stale session');
  } finally { cleanup(name); }
});

test('a non-structural edit still reaches what gets rendered', async () => {
  const name = scratch();
  try {
    const studio = new Studio();
    studio.create(name);
    await studio.addClip(name, { kind: 'text', text: 'hello' }, { duration: 3 });
    const clipId = (await studio.built(name)).project.clips[0].id;

    // renderFrame takes the document as its own argument, so a session cached
    // beside an older document goes on rendering that older document. Every
    // non-structural edit hit this: saved to disk, invisible on screen, until
    // some later structural edit happened to force a rebuild.
    studio.updateClip(name, clipId, { start: 5 });
    const built = await studio.built(name);
    assert.equal(built.project.clips[0].start, 5, 'the render is using a stale document');
    assert.equal(built.frames, projectFrames(studio.doc(name)), 'stale frame count');

    // A camera move is the same class of edit, and it changes the length.
    studio.commit(name, (d) =>
      edits.withCameraAt(d, 'page1', 12, { x: 0, y: 0, zoom: 2 }, { moveDuration: 1 }));
    const after = await studio.built(name);
    assert.equal(after.project.pages[0].cameraKeyframes.length, 3, 'the camera move never landed');
    assert.ok(after.frames > built.frames, 'the timeline did not grow to fit the move');
  } finally { cleanup(name); }
});

test('refreshing for a non-structural edit keeps the compiled plans', async () => {
  const name = scratch();
  try {
    const studio = new Studio();
    studio.create(name);
    await studio.addClip(name, { kind: 'text', text: 'hello' }, { duration: 3 });
    const before = await studio.built(name);
    const plan = before.session.plans.get(before.project.clips[0].id);

    studio.updateClip(name, before.project.clips[0].id, { start: 2 });
    const after = await studio.built(name);

    // The point of the structural split: a retime must not re-compile geometry.
    assert.equal(after.session.plans.get(after.project.clips[0].id), plan, 'geometry was recompiled');
    assert.equal(after.session, before.session, 'the session was rebuilt');
  } finally { cleanup(name); }
});

test('a clip added without a transform is measured and fitted to the frame', async () => {
  const name = scratch();
  try {
    const studio = new Studio();
    studio.create(name, { width: 1920, height: 1080 });
    const { clipId } = await studio.addClip(name, { kind: 'text', text: 'centre me' });

    const view = await studio.describe(name);
    const clip = view.clips.find((c) => c.id === clipId);

    // Not the default transform, and its ink is centred on the frame rather
    // than having its corner there.
    assert.notEqual(clip.transform.x, 0);
    assert.ok(Math.abs(clip.rect.x + clip.rect.width / 2) <= 1, 'not horizontally centred');
    assert.ok(Math.abs(clip.rect.y + clip.rect.height / 2) <= 1, 'not vertically centred');
    assert.deepEqual(view.warnings, []);
  } finally { cleanup(name); }
});

test('an explicit transform is honoured rather than overridden', async () => {
  const name = scratch();
  try {
    const studio = new Studio();
    studio.create(name);
    const { clipId } = await studio.addClip(name, { kind: 'text', text: 'here' },
      { transform: { x: 120, y: -40 } });
    const clip = studio.doc(name).clips.find((c) => c.id === clipId);
    assert.equal(clip.transform.x, 120);
    assert.equal(clip.transform.y, -40);
  } finally { cleanup(name); }
});

test('undo restores the previous document', async () => {
  const name = scratch();
  try {
    const studio = new Studio();
    studio.create(name);
    await studio.addClip(name, { kind: 'text', text: 'one' });
    assert.equal(studio.doc(name).clips.length, 1);
    studio.undo(name);
    assert.equal(studio.doc(name).clips.length, 0);
    assert.equal(studio.undo(name), null, 'nothing left to undo');
  } finally { cleanup(name); }
});

test('rewording a caption goes through the asset and stays valid', async () => {
  const name = scratch();
  try {
    const studio = new Studio();
    studio.create(name);
    const { assetId } = await studio.addClip(name, { kind: 'text', text: 'before' });
    studio.updateAsset(name, assetId, { text: 'after' });
    assert.equal(studio.doc(name).assets[assetId].text, 'after');
    assert.throws(() => studio.updateAsset(name, assetId, { nope: 1 }), /has no field/);
  } finally { cleanup(name); }
});

// ── storyboard ────────────────────────────────────────────────────────

test('a caption is timed by its length, within sane bounds', () => {
  assert.equal(textDuration('hi'), 1.6, 'short captions get a floor');
  assert.equal(textDuration('x'.repeat(500)), 12, 'long ones get a ceiling');
  assert.ok(textDuration('a medium length caption here') > 1.6);
});

test('a storyboard produces a document the validator accepts', async () => {
  const doc = await storyboard({
    doc: normalizeProject(edits.EMPTY_PROJECT),
    beats: [
      { text: 'First idea' },
      { text: 'Second idea', page: true },
      { text: 'And a cut', page: true, transition: 'cut' },
    ],
    ctx: ctx(),
  });
  const p = normalizeProject(doc.doc);
  assert.equal(p.clips.length, 3);
  assert.equal(p.pages.length, 3);
  assert.equal(p.pageBreaks.length, 2);
  // Each beat on its own sheet, drawn while that sheet is up.
  assert.equal(new Set(p.clips.map((c) => c.pageId)).size, 3);
});

test('a caption and its artwork are banded so they do not collide', async () => {
  const svg = join(ROOT, 'examples/shapes.svg');
  const { doc } = await storyboard({
    doc: normalizeProject(edits.EMPTY_PROJECT),
    beats: [{ text: 'A label above', svg }],
    ctx: ctx(),
  });

  const studio = new Studio();
  const name = scratch();
  try {
    studio.create(name);
    studio.commit(name, () => doc, { structural: true });
    const view = await studio.describe(name);

    assert.equal(view.clips.length, 2);
    const text = view.clips.find((c) => c.kind === 'text');
    const art = view.clips.find((c) => c.kind === 'vector');
    assert.ok(text.rect.y + text.rect.height <= art.rect.y + 1,
      'the caption should sit entirely above the artwork');
    assert.deepEqual(view.warnings, [], 'banding should leave nothing overlapping');
  } finally { cleanup(name); }
});

test('a beat with nothing in it is refused', async () => {
  await assert.rejects(
    () => storyboard({ doc: normalizeProject(edits.EMPTY_PROJECT), beats: [{}], ctx: ctx() }),
    /needs at least one of text, image or svg/);
  await assert.rejects(
    () => storyboard({ doc: normalizeProject(edits.EMPTY_PROJECT), beats: [], ctx: ctx() }),
    /at least one beat/);
});
