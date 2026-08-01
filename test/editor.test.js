/**
 * Editor document transforms and history.
 *
 * These run without a renderer because the editing model is deliberately a set
 * of pure document transforms -- the UI holds no second model of the scene.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EMPTY_PROJECT, addClipTo, packTrack, removeClipFrom, isStructural, reducer, uniqueId,
} from '../src/ui/state/editor.js';
import { normalizeProject, projectDuration } from '../src/engine/model/project.js';

const base = () => JSON.parse(JSON.stringify(EMPTY_PROJECT));
const edit = (state, fn, opts = {}) => reducer(state, { type: 'edit', fn, ...opts });
const start = (doc) => ({
  doc, path: null, past: [], future: [], tag: null, rev: 0, structuralRev: 0, dirty: false,
});

test('uniqueId skips ids already in use', () => {
  assert.equal(uniqueId('clip', new Set()), 'clip1');
  assert.equal(uniqueId('clip', new Set(['clip1', 'clip2'])), 'clip3');
});

test('an added clip lands after everything already on the timeline', () => {
  let doc = addClipTo(base(), { kind: 'image', src: '/a.png' }, { duration: 4 });
  assert.equal(doc.clips[0].start, 0);

  doc = addClipTo(doc, { kind: 'text', text: 'hi' }, { duration: 2 });
  assert.equal(doc.clips[1].start, 4, 'second clip starts where the first ends');
  assert.equal(doc.clips[1].animId, 'draw.handwrite', 'text defaults to handwriting');
  assert.equal(doc.clips[0].animId, 'draw.outlineFill');
});

test('a clip is appended after an erase sweep, not after the draw', () => {
  let doc = addClipTo(base(), { kind: 'image', src: '/a.png' }, { duration: 3 });
  doc = { ...doc, clips: [{ ...doc.clips[0], erase: { start: 4, duration: 2 } }] };
  doc = addClipTo(doc, { kind: 'image', src: '/b.png' }, { duration: 1 });
  assert.equal(doc.clips[1].start, 6);
});

test('documents the editor produces survive the validator', () => {
  let doc = addClipTo(base(), { kind: 'image', src: '/a.png' }, { duration: 4 });
  doc = addClipTo(doc, { kind: 'text', text: 'hello' }, { duration: 2 });
  const p = normalizeProject(doc);
  assert.equal(p.clips.length, 2);
  assert.ok(projectDuration(p) > 6);
});

test('removing a clip drops its asset, but only when unreferenced', () => {
  const doc = addClipTo(base(), { kind: 'image', src: '/a.png' });
  const id = doc.clips[0].id;
  assert.equal(Object.keys(removeClipFrom(doc, id).assets).length, 0);

  // A second clip on the same asset must keep it alive.
  const shared = {
    ...doc,
    clips: [...doc.clips, { ...doc.clips[0], id: 'clip2' }],
  };
  assert.equal(Object.keys(removeClipFrom(shared, id).assets).length, 1);
});

test('timing fields are not structural; anything else is', () => {
  assert.equal(isStructural({ start: 1, duration: 2 }), false);
  assert.equal(isStructural({ erase: { start: 5, duration: 1 } }), false);
  assert.equal(isStructural({ transform: { x: 5 } }), false);
  assert.equal(isStructural({ animId: 'draw.handwrite' }), true);
  assert.equal(isStructural({ assetId: 'art2' }), true);
});

test('only structural edits bump structuralRev', () => {
  let s = start(base());
  s = edit(s, (d) => ({ ...d, meta: { ...d.meta, fps: 60 } }));
  assert.equal(s.structuralRev, 0);
  s = edit(s, (d) => addClipTo(d, { kind: 'image', src: '/a.png' }), { structural: true });
  assert.equal(s.structuralRev, 1);
});

test('an edit that returns the same document is not recorded', () => {
  let s = start(base());
  s = edit(s, (d) => d);
  assert.equal(s.past.length, 0);
  assert.equal(s.dirty, false);
});

test('undo and redo walk the history', () => {
  let s = start(base());
  s = edit(s, (d) => addClipTo(d, { kind: 'image', src: '/a.png' }), { structural: true });
  assert.equal(s.doc.clips.length, 1);

  s = reducer(s, { type: 'undo' });
  assert.equal(s.doc.clips.length, 0);
  assert.equal(s.future.length, 1);

  s = reducer(s, { type: 'redo' });
  assert.equal(s.doc.clips.length, 1);
  assert.equal(s.future.length, 0);
});

test('undo re-prepares, because the undone edit may have been structural', () => {
  // The reducer cannot know which kind of edit it is reversing, and a stale
  // prepared payload renders the wrong artwork.
  let s = start(base());
  s = edit(s, (d) => addClipTo(d, { kind: 'image', src: '/a.png' }), { structural: true });
  const before = s.structuralRev;
  s = reducer(s, { type: 'undo' });
  assert.ok(s.structuralRev > before);
});

test('a drag collapses into one undo step, then the next gesture starts a new one', () => {
  let s = start(addClipTo(base(), { kind: 'image', src: '/a.png' }));
  const id = s.doc.clips[0].id;
  const move = (t) => (d) => ({
    ...d, clips: d.clips.map((c) => (c.id === id ? { ...c, start: t } : c)),
  });

  for (const t of [1, 2, 3]) s = edit(s, move(t), { coalesce: 'drag:clip1:move' });
  assert.equal(s.past.length, 1, 'three pointermoves, one history entry');
  assert.equal(s.doc.clips[0].start, 3);

  s = reducer(s, { type: 'endGesture' });
  s = edit(s, move(4), { coalesce: 'drag:clip1:move' });
  assert.equal(s.past.length, 2, 'a new gesture is separately undoable');

  s = reducer(s, { type: 'undo' });
  assert.equal(s.doc.clips[0].start, 3, 'undo rewinds one whole gesture');
});

test('a different gesture does not merge into the previous one', () => {
  let s = start(addClipTo(base(), { kind: 'image', src: '/a.png' }));
  s = edit(s, (d) => ({ ...d, clips: [{ ...d.clips[0], start: 1 }] }), { coalesce: 'a' });
  s = edit(s, (d) => ({ ...d, clips: [{ ...d.clips[0], duration: 9 }] }), { coalesce: 'b' });
  assert.equal(s.past.length, 2);
});

test('loading a project clears history and marks it clean', () => {
  let s = start(base());
  s = edit(s, (d) => ({ ...d, meta: { ...d.meta, fps: 60 } }));
  s = reducer(s, { type: 'load', doc: base(), path: '/p.json' });
  assert.equal(s.past.length, 0);
  assert.equal(s.dirty, false);
  assert.equal(s.path, '/p.json');
});

// ── track packing ───────────────────────────────────────────────────

test('sequential clips all pack onto one lane', () => {
  let doc = base();
  for (let i = 0; i < 60; i++) {
    doc = addClipTo(doc, { kind: 'image', src: `/a${i}.png` }, { duration: 2 });
  }
  assert.equal(doc.clips.length, 60);
  assert.equal(doc.tracks.filter((t) => t.kind === 'clip').length, 1,
    '60 non-overlapping clips must not become 60 lanes');
  assert.ok(doc.clips.every((c) => c.trackId === 'v1'));
  // The whole point: this still validates, so the timeline is not lying.
  normalizeProject(doc);
});

test('an overlapping clip gets its own lane', () => {
  let doc = addClipTo(base(), { kind: 'image', src: '/a.png' }, { duration: 4 });
  // Drag it back over the origin so the next append collides with it.
  doc = { ...doc, clips: [{ ...doc.clips[0], start: 0, duration: 4 }] };
  doc = { ...doc, clips: [...doc.clips, { ...doc.clips[0], id: 'held' }] };
  const packed = packTrack(doc, 'clip', 1, 3);
  assert.notEqual(packed.trackId, 'v1');
  assert.equal(packed.tracks.length, doc.tracks.length + 1);
  assert.equal(packed.tracks.at(-1).name, 'Video 2');
});

test('clips that merely touch at an edge share a lane', () => {
  const doc = addClipTo(base(), { kind: 'image', src: '/a.png' }, { duration: 4 });
  assert.equal(packTrack(doc, 'clip', 4, 6).trackId, 'v1');
  assert.notEqual(packTrack(doc, 'clip', 3.9, 6).trackId, 'v1');
});

test('packing an erased clip accounts for the wipe, not just the draw', () => {
  let doc = addClipTo(base(), { kind: 'image', src: '/a.png' }, { duration: 3 });
  doc = { ...doc, clips: [{ ...doc.clips[0], erase: { start: 4, duration: 2 } }] };
  assert.notEqual(packTrack(doc, 'clip', 5, 7).trackId, 'v1', 'the sweep still occupies the lane');
  assert.equal(packTrack(doc, 'clip', 6, 8).trackId, 'v1');
});

test('moving a clip between lanes is not a structural edit', () => {
  assert.equal(isStructural({ trackId: 'v2' }), false,
    'a re-trace on every vertical drag would make the timeline unusable');
  assert.equal(isStructural({ trackId: 'v2', start: 1 }), false);
  assert.equal(isStructural({ trackId: 'v2', animId: 'draw.handwrite' }), true);
});

test('removing a track rehomes its contents rather than dropping them', () => {
  let doc = base();
  doc = { ...doc, tracks: [...doc.tracks, { id: 'v2', name: 'Video 2', kind: 'clip' }] };
  doc = addClipTo(doc, { kind: 'image', src: '/a.png' }, { duration: 2 });
  doc = { ...doc, clips: [{ ...doc.clips[0], trackId: 'v2' }] };

  let state = start(doc);
  state = edit(state, (d) => {
    const fallback = d.tracks.find((t) => t.kind === 'clip' && t.id !== 'v2');
    return {
      ...d,
      tracks: d.tracks.filter((t) => t.id !== 'v2'),
      clips: d.clips.map((c) => (c.trackId === 'v2' ? { ...c, trackId: fallback.id } : c)),
    };
  });
  assert.equal(state.doc.clips.length, 1, 'the clip survives its lane');
  assert.equal(state.doc.clips[0].trackId, 'v1');
  normalizeProject(state.doc);
});
