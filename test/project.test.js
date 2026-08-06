import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  normalizeProject, projectDuration, projectFrames, ProjectError,
} from '../src/engine/model/project.js';

const minimal = () => ({
  assets: { a: { kind: 'image', src: 'x.png' } },
  clips: [{ assetId: 'a', animId: 'draw.outlineFill', start: 0, duration: 2 }],
});

const throwsAt = (raw, path) => assert.throws(
  () => normalizeProject(raw),
  (e) => e instanceof ProjectError && e.path === path,
  `expected a ProjectError at ${path}`,
);

test('defaults fill in for an otherwise minimal project', () => {
  const p = normalizeProject(minimal());
  assert.equal(p.meta.fps, 30);
  assert.equal(p.meta.width, 1920);
  assert.equal(p.meta.height, 1080);
  assert.equal(p.pages.length, 1, 'a default page is synthesised');
  assert.deepEqual(p.pages[0].cameraKeyframes, [{ t: 0, x: 0, y: 0, zoom: 1 }]);
  assert.deepEqual(p.clips[0].transform, { x: 0, y: 0, scale: 1, rotation: 0 });
  assert.equal(p.clips[0].id, 'clip1', 'ids are generated when omitted');
});

test('normalize does not mutate its input', () => {
  const raw = minimal();
  const before = JSON.stringify(raw);
  normalizeProject(raw);
  assert.equal(JSON.stringify(raw), before);
});

test('a clip referencing a missing asset fails loudly', () => {
  const raw = minimal();
  raw.clips[0].assetId = 'nope';
  throwsAt(raw, 'clips[0].assetId');
});

test('an unknown animation id is rejected', () => {
  const raw = minimal();
  raw.clips[0].animId = 'draw.sparkle';
  throwsAt(raw, 'clips[0].animId');
});

test('duplicate clip ids are rejected', () => {
  const raw = minimal();
  raw.clips = [
    { id: 'x', assetId: 'a', animId: 'draw.outlineFill', duration: 1 },
    { id: 'x', assetId: 'a', animId: 'draw.outlineFill', duration: 1 },
  ];
  // Silently overwriting would make one clip vanish from the render with no
  // diagnostic, since session maps are keyed by clip id.
  throwsAt(raw, 'clips[1].id');
});

test('assets must declare a known kind and its required field', () => {
  throwsAt({ assets: { a: { kind: 'video', src: 'x' } }, clips: [] }, 'assets.a.kind');
  throwsAt({ assets: { a: { kind: 'image' } }, clips: [] }, 'assets.a.src');
  throwsAt({ assets: { a: { kind: 'text' } }, clips: [] }, 'assets.a.text');
});

test('an erase that starts before the draw finishes is rejected', () => {
  const raw = minimal();
  raw.clips[0] = { assetId: 'a', animId: 'draw.outlineFill', start: 1, duration: 3,
                   erase: { start: 2, duration: 1 } };
  // Erasing mid-draw would composite destination-out over ink that has not been
  // laid yet, which reads as a rendering glitch rather than an authoring error.
  throwsAt(raw, 'clips[0].erase.start');
});

test('an erase exactly at the end of the draw is allowed', () => {
  const raw = minimal();
  raw.clips[0] = { assetId: 'a', animId: 'draw.outlineFill', start: 1, duration: 3,
                   erase: { start: 4, duration: 1 } };
  assert.equal(normalizeProject(raw).clips[0].erase.start, 4);
});

test('out-of-range numbers are caught with their path', () => {
  throwsAt({ ...minimal(), meta: { fps: 0 } }, 'meta.fps');
  const bad = minimal();
  bad.clips[0].duration = -1;
  throwsAt(bad, 'clips[0].duration');
});

test('non-numeric values are rejected rather than coerced', () => {
  const raw = minimal();
  raw.clips[0].start = '2';
  throwsAt(raw, 'clips[0].start');
});

test('camera keyframes are sorted by time', () => {
  // cameraAt() walks keyframes assuming ascending time, so a hand-edited file
  // with them out of order would interpolate garbage.
  const raw = minimal();
  raw.pages = [{ id: 'p', cameraKeyframes: [
    { t: 5, x: 100, y: 0, zoom: 2 },
    { t: 0, x: 0, y: 0, zoom: 1 },
  ] }];
  const kfs = normalizeProject(raw).pages[0].cameraKeyframes;
  assert.deepEqual(kfs.map((k) => k.t), [0, 5]);
});

test('duration spans the last thing to finish, including erase', () => {
  const raw = minimal();
  raw.clips = [
    { assetId: 'a', animId: 'draw.outlineFill', start: 0, duration: 2 },
    { assetId: 'a', animId: 'draw.outlineFill', start: 1, duration: 2,
      erase: { start: 6, duration: 2 } },
  ];
  const p = normalizeProject(raw);
  assert.equal(projectDuration(p, 0), 8);
  assert.equal(projectFrames(p, 0), 240);
});

test('a project with no clips has zero duration rather than just a tail', () => {
  assert.equal(projectDuration(normalizeProject({ assets: {}, clips: [] })), 0);
});

// ── tracks ──────────────────────────────────────────────────────────

test('a document with no tracks gets the defaults and everything assigned', () => {
  const p = normalizeProject({
    ...minimal(),
    audio: [{ src: 'v.mp3', start: 0 }],
  });
  assert.deepEqual(p.tracks.map((t) => t.id), ['v1', 'a1']);
  assert.deepEqual(p.tracks.map((t) => t.kind), ['clip', 'audio']);
  assert.equal(p.clips[0].trackId, 'v1');
  assert.equal(p.audio[0].trackId, 'a1');
});

test('a declared track list is kept, and a missing kind is filled in', () => {
  const p = normalizeProject({
    ...minimal(),
    tracks: [{ id: 'main', name: 'Main', kind: 'clip' }],
    audio: [{ src: 'v.mp3', start: 0 }],
  });
  assert.equal(p.tracks[0].id, 'main');
  assert.equal(p.clips[0].trackId, 'main', 'clips fall back to the first clip lane');
  assert.equal(p.tracks[1].kind, 'audio', 'an audio lane is synthesised for the track');
  assert.equal(p.audio[0].trackId, p.tracks[1].id);
});

test('tracks reject unknown kinds and duplicate ids', () => {
  throwsAt({ ...minimal(), tracks: [{ id: 'x', kind: 'camera' }] }, 'tracks[0].kind');
  throwsAt({ ...minimal(), tracks: [
    { id: 'x', kind: 'clip' }, { id: 'x', kind: 'clip' },
  ] }, 'tracks[1].id');
});

test('a clip cannot name a track that does not exist or holds the wrong kind', () => {
  const m = minimal();
  throwsAt({ ...m, clips: [{ ...m.clips[0], trackId: 'nope' }] }, 'clips[0].trackId');
  throwsAt({ ...m, clips: [{ ...m.clips[0], trackId: 'a1' }] }, 'clips[0].trackId');
  throwsAt({ ...m, audio: [{ src: 'v.mp3', trackId: 'v1' }] }, 'audio[0].trackId');
});

test('every shipped example still normalises now that tracks exist', () => {
  for (const f of ['demo.project.json', 'svg.project.json']) {
    const raw = JSON.parse(readFileSync(new URL(`../examples/${f}`, import.meta.url), 'utf8'));
    const p = normalizeProject(raw);
    assert.ok(p.tracks.length >= 2, `${f}: tracks synthesised`);
    for (const c of p.clips) {
      assert.ok(p.tracks.some((t) => t.id === c.trackId && t.kind === 'clip'),
        `${f}: ${c.id} lands on a clip track`);
    }
  }
});

// ── pages and page breaks ───────────────────────────────────────────

const paged = (over = {}) => ({
  assets: { a: { kind: 'image', src: 'x.png' } },
  pages: [{ id: 'p1' }, { id: 'p2' }],
  pageBreaks: [{ t: 5, pageId: 'p2', transition: 'swipeLeft', duration: 1 }],
  clips: [{ id: 'c', assetId: 'a', animId: 'draw.outlineFill', start: 0, duration: 2 }],
  ...over,
});

test('a project with no page breaks is unchanged', () => {
  const p = normalizeProject(minimal());
  assert.deepEqual(p.pageBreaks, []);
  assert.equal(p.pages[0].name, 'Page 1', 'pages get a default name');
  assert.equal(p.clips[0].pageId, p.pages[0].id);
});

test('a cut is forced to zero length whatever the document says', () => {
  const p = normalizeProject(paged({
    pageBreaks: [{ t: 5, pageId: 'p2', transition: 'cut', duration: 3 }],
  }));
  assert.equal(p.pageBreaks[0].duration, 0);
});

test('breaks are sorted, so a hand-edited file out of order still behaves', () => {
  const p = normalizeProject(paged({
    pages: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }],
    pageBreaks: [
      { t: 9, pageId: 'p3', transition: 'cut' },
      { t: 5, pageId: 'p2', transition: 'cut' },
    ],
  }));
  assert.deepEqual(p.pageBreaks.map((b) => b.t), [5, 9]);
});

test('page breaks reject unknown transitions and unknown pages', () => {
  throwsAt(paged({
    pageBreaks: [{ t: 1, pageId: 'p2', transition: 'dissolve' }],
  }), 'pageBreaks[0].transition');
  throwsAt(paged({
    pageBreaks: [{ t: 1, pageId: 'nope', transition: 'cut' }],
  }), 'pageBreaks[0].pageId');
});

test('a transition may not begin before the previous one has finished', () => {
  throwsAt(paged({
    pages: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }],
    pageBreaks: [
      { t: 5, pageId: 'p2', transition: 'swipeLeft', duration: 2 },
      { t: 6, pageId: 'p3', transition: 'swipeLeft', duration: 1 },
    ],
  }), 'pageBreaks[1].t');
});

test('duplicate page ids are rejected', () => {
  throwsAt({ ...minimal(), pages: [{ id: 'x' }, { id: 'x' }] }, 'pages[1].id');
});

test('a clip may not draw while its own page is off screen', () => {
  // The draw runs 4s-7s but p1 leaves the screen at 5s.
  throwsAt(paged({
    clips: [{ id: 'c', assetId: 'a', animId: 'draw.outlineFill',
              pageId: 'p1', start: 4, duration: 3 }],
  }), 'clips[0].start');

  // Drawing during the swipe itself is just as illegal -- the paper is moving.
  throwsAt(paged({
    clips: [{ id: 'c', assetId: 'a', animId: 'draw.outlineFill',
              pageId: 'p2', start: 5.5, duration: 1 }],
  }), 'clips[0].start');
});

test('a clip on a page no break ever reaches is rejected', () => {
  throwsAt(paged({
    pages: [{ id: 'p1' }, { id: 'p2' }, { id: 'orphan' }],
    clips: [{ id: 'c', assetId: 'a', animId: 'draw.outlineFill',
              pageId: 'orphan', start: 0, duration: 1 }],
  }), 'clips[0].start');
});

test('drawing on one visit and erasing on a later one is allowed', () => {
  // This is the whole point of revisiting a page, so it must not be collateral
  // damage of the on-screen check.
  const p = normalizeProject(paged({
    pages: [{ id: 'p1' }, { id: 'p2' }],
    pageBreaks: [
      { t: 5, pageId: 'p2', transition: 'cut' },
      { t: 9, pageId: 'p1', transition: 'cut' },
    ],
    clips: [{
      id: 'c', assetId: 'a', animId: 'draw.outlineFill', pageId: 'p1',
      start: 0, duration: 2,
      erase: { start: 10, duration: 1 },
    }],
  }));
  assert.equal(p.clips[0].erase.start, 10);
});

test('a trailing page break still gets to finish', () => {
  const p = normalizeProject(paged({
    clips: [{ id: 'c', assetId: 'a', animId: 'draw.outlineFill', start: 0, duration: 2 }],
  }));
  // Clips end at 2s but the swipe runs to 6s; without counting it the export
  // would stop with the paper halfway across the frame.
  assert.ok(projectDuration(p, 0) >= 6, `duration was ${projectDuration(p, 0)}`);
});

test('the pages example is a valid document', () => {
  const raw = JSON.parse(readFileSync(new URL('../examples/pages.project.json', import.meta.url), 'utf8'));
  const p = normalizeProject(raw);
  assert.equal(p.pages.length, 2);
  assert.equal(p.pageBreaks.length, 2);
  // It must actually exercise the thing it exists to demonstrate.
  const visits = p.pageBreaks.filter((b) => b.pageId === p.pages[0].id);
  assert.equal(visits.length, 1, 'the example returns to its first page');
});

// ── retired animation ids ─────────────────────────────────────────────

test('a retired animation id is migrated rather than rejected', () => {
  // Every saved project, both bundled examples and any MCP script in the wild
  // names one of these. `draw.stencilPaint` replaced both, and a document that
  // used to render must not stop rendering.
  for (const old of ['draw.imageReveal', 'draw.outlineFill']) {
    const doc = normalizeProject({
      assets: { a: { kind: 'image', src: 'x.png' } },
      clips: [{ id: 'c', assetId: 'a', animId: old, start: 0, duration: 2 }],
    });
    assert.equal(doc.clips[0].animId, 'draw.stencilPaint', old);
  }
});

test('parameters that survived are renamed, and the rest are dropped', () => {
  const doc = normalizeProject({
    assets: { a: { kind: 'image', src: 'x.png' } },
    clips: [{
      id: 'c', assetId: 'a', animId: 'draw.outlineFill', start: 0, duration: 2,
      params: { brushWidth: 4, scribbleAngle: -30, outlineShare: 0.5, orderStyle: 'topDown' },
    }],
  });
  const p = doc.clips[0].params;
  assert.equal(p.sweepAngle, -30, 'scribbleAngle is the same quantity as sweepAngle');
  assert.equal(p.scribbleAngle, undefined, 'the old name must not survive alongside the new');
  // Everything that described the pencil stencil goes with it. Carrying these
  // onto the nearest surviving parameter would silently change the document.
  for (const gone of ['brushWidth', 'pencilWidth', 'outlineShare', 'orderStyle']) {
    assert.equal(p[gone], undefined, `${gone} described the stencil, which is gone`);
  }
});

test('an animation that never existed is still an error', () => {
  assert.throws(() => normalizeProject({
    assets: { a: { kind: 'image', src: 'x.png' } },
    clips: [{ id: 'c', assetId: 'a', animId: 'draw.wiggle', start: 0, duration: 2 }],
  }), /unknown animation "draw\.wiggle"|draw\.wiggle/);
});
