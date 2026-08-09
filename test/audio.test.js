/**
 * Audio editing: placement, trimming, splitting and gaps.
 *
 * One invariant runs through all of it -- **two items never overlap on one
 * lane** -- and most of these tests are that invariant approached from a
 * different direction. The other recurring subject is the two clocks: `start`
 * and `duration` are timeline seconds, `trimIn` is source seconds, and they
 * only coincide at speed 1.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EMPTY_PROJECT, MIN_AUDIO, addAudio, audioEnd, closeAudioGap, laneEnd,
  patchAudio, removeAudio, setAudioSpeed, splitAudio,
} from '../src/engine/model/edits.js';
import { normalizeProject } from '../src/engine/model/project.js';

const base = () => JSON.parse(JSON.stringify(EMPTY_PROJECT));
/** Two four-second items laid end to end on the default audio lane. */
const two = () => addAudio(addAudio(base(),
  { src: 'a.mp3', duration: 4 }), { src: 'b.mp3', duration: 4 });

// ── placement ─────────────────────────────────────────────────────────

test('a second item appends to the lane rather than stacking at zero', () => {
  const doc = two();
  assert.equal(doc.audio[0].start, 0);
  assert.equal(doc.audio[1].start, 4);
  assert.equal(doc.audio[1].trackId, doc.audio[0].trackId);
  assert.equal(doc.tracks.filter((t) => t.kind === 'audio').length, 1,
    'appending must not invent a second lane the way packTrack would');
});

test('an explicit start that would overlap slides to the nearest free spot', () => {
  const doc = addAudio(two(), { src: 'c.mp3', start: 2, duration: 4 });
  // 2s is inside the first item; 0 is taken; the nearest free start is the end
  // of the lane.
  assert.equal(doc.audio[2].start, 8);
});

test('an explicit start in a hole is honoured exactly', () => {
  const doc = addAudio(two(), { src: 'c.mp3', start: 20, duration: 3 });
  assert.equal(doc.audio[2].start, 20);
});

test('a second lane is a stack: layering music under narration still works', () => {
  const withLane = { ...two(), tracks: [...two().tracks, { id: 'a2', name: 'Audio 2', kind: 'audio' }] };
  const doc = addAudio(withLane, { src: 'music.mp3', start: 0, duration: 30, trackId: 'a2' });
  assert.equal(doc.audio[2].start, 0, 'a different lane is not occupied');
});

test('patchAudio cannot author an overlap', () => {
  const doc = two();
  const moved = patchAudio(doc, doc.audio[1].id, { start: 1 });
  // Dragged left into its neighbour, it stops flush against it instead.
  assert.equal(moved.audio[1].start, 4);
});

test('a move nudges to whichever side of the obstruction is nearer', () => {
  const doc = two();
  // Asking to sit at 3.5 overlaps the first item's tail. Flush-right (4) is
  // nearer than flush-left (-4, invalid), so it lands at 4.
  assert.equal(patchAudio(doc, doc.audio[1].id, { start: 3.5 }).audio[1].start, 4);
  // The other direction: the first item asked to sit at 3 would run into the
  // second at 4, and flush-left (0) is nearer than flush-right (8).
  assert.equal(patchAudio(doc, doc.audio[0].id, { start: 3 }).audio[0].start, 0);
});

test('a gain change does not re-place the item', () => {
  const doc = patchAudio(two(), 1, { gain: 0.5 });
  assert.equal(doc.audio[1].start, 4);
  assert.equal(doc.audio[1].gain, 0.5);
});

test('laneEnd is where the next item would go', () => {
  assert.equal(laneEnd(base(), 'a1'), 0);
  assert.equal(laneEnd(two(), 'a1'), 8);
});

test('audioEnd falls back to the file length when the duration is unknown', () => {
  assert.equal(audioEnd({ start: 1 }), 1, 'no duration and no file length is zero-length');
  assert.equal(audioEnd({ start: 1, trimIn: 2 }, 12), 11);
  assert.equal(audioEnd({ start: 1, trimIn: 2, speed: 2 }, 12), 6,
    'at 2x, ten seconds of file is five seconds of timeline');
});

// ── ids ───────────────────────────────────────────────────────────────

test('items are addressable by id or by index', () => {
  const doc = two();
  assert.equal(patchAudio(doc, doc.audio[1].id, { gain: 2 }).audio[1].gain, 2);
  assert.equal(patchAudio(doc, 1, { gain: 3 }).audio[1].gain, 3);
  assert.equal(removeAudio(doc, doc.audio[0].id).audio.length, 1);
  assert.throws(() => patchAudio(doc, 'nope', {}), { name: 'EditError' });
  assert.throws(() => removeAudio(doc, 7), { name: 'EditError' });
});

test('a project file written before ids gets stable ones by position', () => {
  const p = normalizeProject({
    meta: { width: 100, height: 100, fps: 30 },
    pages: [{ id: 'page1' }],
    audio: [{ src: 'a.mp3' }, { src: 'b.mp3' }],
  });
  assert.deepEqual(p.audio.map((a) => a.id), ['aud1', 'aud2']);
  assert.equal(p.audio[0].speed, 1, 'speed defaults to as-recorded');
});

test('a duplicate id in a hand-edited file is disambiguated, not accepted', () => {
  const p = normalizeProject({
    meta: { width: 100, height: 100, fps: 30 },
    pages: [{ id: 'page1' }],
    audio: [{ id: 'x', src: 'a.mp3' }, { id: 'x', src: 'b.mp3' }],
  });
  assert.notEqual(p.audio[0].id, p.audio[1].id);
});

// ── speed ─────────────────────────────────────────────────────────────

test('speeding up shortens the block to hold the same audio', () => {
  // The bug this replaces: `duration` stayed at 4 while the block held 2
  // seconds of sound, and the other two came out as silence.
  const doc = patchAudio(two(), 0, { speed: 2 });
  assert.equal(doc.audio[0].duration, 2);
  assert.equal(doc.audio[0].speed, 2);
  const trimmed = patchAudio(two(), 0, { trimIn: 1.5 });
  assert.equal(patchAudio(trimmed, 0, { speed: 2 }).audio[0].trimIn, 1.5,
    'the in-point is source seconds and has not moved');
});

test('and the rest of the lane follows, so no silence opens up', () => {
  const doc = patchAudio(two(), 0, { speed: 2 });
  assert.equal(doc.audio[1].start, 2, 'the neighbour closed up behind it');
  assert.equal(audioEnd(doc.audio[0]), doc.audio[1].start, 'still flush');
});

test('slowing down pushes the lane out to make room', () => {
  const doc = patchAudio(two(), 0, { speed: 0.5 });
  assert.equal(doc.audio[0].duration, 8);
  assert.equal(doc.audio[1].start, 8, 'shifted from 4 by the same +4 the block grew');
});

test('the ripple keeps the spacing of everything downstream', () => {
  let doc = addAudio(base(), { src: 'a.mp3', duration: 4 });
  doc = addAudio(doc, { src: 'b.mp3', start: 10, duration: 2 });
  doc = addAudio(doc, { src: 'c.mp3', start: 20, duration: 2 });
  const fast = patchAudio(doc, 0, { speed: 2 });
  assert.deepEqual(fast.audio.map((a) => a.start), [0, 8, 18],
    'both later items moved by -2, and the gaps between them are unchanged');
});

test('the ripple leaves other lanes alone', () => {
  const withLane = base();
  withLane.tracks.push({ id: 'a2', name: 'Audio 2', kind: 'audio' });
  let doc = addAudio(withLane, { src: 'vo.mp3', duration: 4 });
  doc = addAudio(doc, { src: 'music.mp3', start: 10, duration: 30, trackId: 'a2' });
  const fast = patchAudio(doc, 0, { speed: 2 });
  assert.equal(fast.audio[1].start, 10, 'the music is on its own lane and stays put');
});

test('an explicit length alongside a speed wins', () => {
  // A caller that names both knows what it wants; second-guessing it would make
  // the pair unusable from the MCP tool.
  const doc = patchAudio(two(), 0, { speed: 2, duration: 3 });
  assert.equal(doc.audio[0].duration, 3);
  assert.equal(doc.audio[0].speed, 2);
});

test('an unmeasured item has no length to rescale, and nothing ripples', () => {
  let doc = addAudio(base(), { src: 'a.mp3' });
  doc = addAudio(doc, { src: 'b.mp3', start: 10, duration: 2 });
  const fast = patchAudio(doc, 0, { speed: 2 });
  assert.equal(fast.audio[0].duration, undefined);
  assert.equal(fast.audio[0].speed, 2);
  assert.equal(fast.audio[1].start, 10);
});

test('successive speed changes land where one jump would', () => {
  const once = patchAudio(two(), 0, { speed: 4 });
  const twice = patchAudio(patchAudio(two(), 0, { speed: 2 }), 0, { speed: 4 });
  assert.equal(twice.audio[0].duration, once.audio[0].duration);
  assert.equal(twice.audio[1].start, once.audio[1].start);
});

test('setting the speed it already has changes nothing at all', () => {
  const doc = two();
  assert.equal(setAudioSpeed(doc, 0, 1), doc, 'the very same document object');
});

test('speed survives a round trip through the validator', () => {
  const doc = patchAudio(two(), 0, { speed: 2.5 });
  const p = normalizeProject({ ...doc, pages: [{ id: 'page1' }] });
  assert.equal(p.audio[0].speed, 2.5);
  assert.equal(p.audio[0].duration, doc.audio[0].duration);
});

// ── splitting ─────────────────────────────────────────────────────────

test('a split advances the right half by source seconds, not timeline seconds', () => {
  const doc = addAudio(base(), { src: 'a.mp3', start: 1, trimIn: 0.5, duration: 5, speed: 2 });
  const cut = splitAudio(doc, doc.audio[0].id, 3);
  assert.equal(cut.audio.length, 2);
  const [left, right] = cut.audio;

  assert.equal(left.duration, 2);
  assert.equal(right.start, 3);
  assert.equal(right.duration, 3);
  // Two seconds of timeline at 2x consumed four seconds of the file.
  assert.equal(right.trimIn, 4.5);
  assert.equal(right.trackId, left.trackId);
  assert.notEqual(right.id, left.id);
  assert.equal(audioEnd(left), right.start, 'the halves must abut exactly');
});

test('at speed 1 the two clocks coincide, which is the ordinary case', () => {
  const doc = addAudio(base(), { src: 'a.mp3', duration: 10 });
  const [, right] = splitAudio(doc, 0, 4).audio;
  assert.equal(right.trimIn, 4);
  assert.equal(right.duration, 6);
});

test('the right half is spliced in place, not appended', () => {
  const doc = addAudio(two(), { src: 'c.mp3', duration: 4 });
  const cut = splitAudio(doc, doc.audio[0].id, 2);
  assert.deepEqual(cut.audio.map((a) => a.src), ['a.mp3', 'a.mp3', 'b.mp3', 'c.mp3']);
});

test('an unmeasured item splits and its tail still plays to the end of the file', () => {
  const doc = addAudio(base(), { src: 'a.mp3', start: 0 });
  const [left, right] = splitAudio(doc, 0, 2).audio;
  assert.equal(left.duration, 2);
  assert.equal(right.duration, undefined);
  assert.equal(right.trimIn, 2);
});

test('a split outside the item, or too near an edge, is refused', () => {
  const doc = addAudio(base(), { src: 'a.mp3', start: 1, duration: 4 });
  for (const t of [0, 1, 5, 9, 1 + MIN_AUDIO / 2, 5 - MIN_AUDIO / 2]) {
    assert.throws(() => splitAudio(doc, 0, t), { name: 'EditError' }, `t=${t}`);
  }
});

test('the halves of a split survive validation and still sum to the original', () => {
  const doc = addAudio(base(), { src: 'a.mp3', start: 1, duration: 6, speed: 1.5 });
  const p = normalizeProject({ ...splitAudio(doc, 0, 4), pages: [{ id: 'page1' }] });
  assert.equal(p.audio[0].duration + p.audio[1].duration, 6);
  assert.equal(p.audio[1].speed, 1.5, 'speed carries to both halves');
});

// ── gaps ──────────────────────────────────────────────────────────────

test('closing a gap pulls the later items back over it', () => {
  const doc = patchAudio(two(), 1, { start: 10 });
  const closed = closeAudioGap(doc, 'a1', 7);
  assert.equal(closed.audio[1].start, 4);
});

test('the lead-in before the first item is a gap like any other', () => {
  const doc = addAudio(base(), { src: 'a.mp3', start: 3, duration: 4 });
  assert.equal(closeAudioGap(doc, 'a1', 1).audio[0].start, 0);
});

test('closing a gap moves every later item, keeping their spacing', () => {
  let doc = addAudio(base(), { src: 'a.mp3', duration: 4 });
  doc = addAudio(doc, { src: 'b.mp3', start: 10, duration: 2 });
  doc = addAudio(doc, { src: 'c.mp3', start: 20, duration: 2 });
  const closed = closeAudioGap(doc, 'a1', 6);
  assert.deepEqual(closed.audio.map((a) => a.start), [0, 4, 14]);
});

test('closing a gap leaves other lanes where they are', () => {
  const withLane = base();
  withLane.tracks.push({ id: 'a2', name: 'Audio 2', kind: 'audio' });
  let doc = addAudio(withLane, { src: 'vo.mp3', start: 5, duration: 4 });
  doc = addAudio(doc, { src: 'music.mp3', start: 5, duration: 30, trackId: 'a2' });
  const closed = closeAudioGap(doc, 'a1', 2);
  assert.equal(closed.audio[0].start, 0);
  assert.equal(closed.audio[1].start, 5, 'the music was placed against the picture, not the lane');
});

test('there is no gap inside an item, and none after the last one', () => {
  const doc = two();
  assert.throws(() => closeAudioGap(doc, 'a1', 2), { name: 'EditError' });
  assert.throws(() => closeAudioGap(doc, 'a1', 20), { name: 'EditError' });
  assert.throws(() => closeAudioGap(base(), 'a1', 1), { name: 'EditError' });
});
