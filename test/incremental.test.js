/**
 * Rebuilding after an edit must cost one clip, not the whole project -- and must
 * be indistinguishable from having rebuilt everything.
 *
 * The editor re-prepares on a debounce measured in a few hundred milliseconds,
 * so on a project of any size a full rebuild per keystroke is what made typing
 * a caption unusable: every image re-read and base64'd in the main process,
 * shipped across IPC, decoded again in the renderer, and every clip re-traced.
 * `clipKey` decides what actually changed; this file is the check that it names
 * every input the compile stages read. Naming too few is the dangerous
 * direction -- the editor would quietly render stale artwork -- so the last test
 * renders both ways and compares pixels.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { prepareProject } from '../electron/prepare.js';
import { normalizeProject } from '../src/engine/model/project.js';
import { buildSession, clipKey, sessionKey, staleClips } from '../src/ui/engineHost.js';
import { renderFrame } from '../src/engine/render/renderFrame.js';
import { useTestSurfaces } from './helpers/surface.js';
import { newSurface } from '../src/engine/render/surfaces.js';

// engineHost.js points the engine at OffscreenCanvas as an import side effect,
// which does not exist here. This runs after that and puts node canvases back.
useTestSurfaces();

const ROOT = new URL('..', import.meta.url).pathname;
const PATH = `${ROOT}examples/svg.project.json`;

/**
 * Two vector clips, so a rebuild has something to keep as well as something to
 * redo. Vector artwork keeps this offline and, more importantly, off `Image`:
 * a raster clip would need the browser's decoder to rebuild.
 */
function twoClipProject() {
  const raw = JSON.parse(readFileSync(PATH, 'utf8'));
  return normalizeProject({
    ...raw,
    clips: [
      { ...raw.clips[0], id: 'a', start: 0, duration: 5 },
      { ...raw.clips[0], id: 'b', start: 0, duration: 5,
        transform: { x: 300, y: 200, scale: 1, rotation: 0 } },
    ],
  });
}

/** Mutate one clip of a normalised document. */
const patch = (project, id, fields) => normalizeProject({
  ...project,
  clips: project.clips.map((c) => (c.id === id ? { ...c, ...fields } : c)),
});

const load = async (project, only, previous = null) => buildSession({
  project,
  prepared: await prepareProject(project, PATH, only),
  hand: { style: { id: 'hand2', sources: [], tool: { type: 'pen' } },
          styles: [{ id: 'hand2', sources: [], tool: { type: 'pen' } }],
          images: {} },
  subtitleFont: null,
  frames: 150,
}, previous);

// ── what counts as a change ───────────────────────────────────────────

test('moving a clip in time or space does not restage its artwork', () => {
  const project = twoClipProject();
  const keys = staleClips(project, null).keys;

  for (const [what, fields] of [
    ['start', { start: 2 }],
    ['duration', { duration: 9 }],
    ['a page move', { pageId: 'page1' }],
    ['a lane move', { trackId: 'v1' }],
    ['a translation', { transform: { x: 40, y: -12, scale: 1, rotation: 0 } }],
    ['a rotation', { transform: { x: 300, y: 200, scale: 1, rotation: 30 } }],
    // A mirror is a negative axis multiplier. It changes no stroke's width,
    // which is the only thing the compile stage reads a scale for -- `penScale`
    // takes the absolute value precisely so this stays free.
    ['a mirror', { transform: { x: 300, y: 200, scale: 1, rotation: 0, scaleX: -1 } }],
  ]) {
    const { stale } = staleClips(patch(project, 'b', fields), keys);
    assert.deepEqual(stale, [], `${what} must not re-trace anything`);
  }
});

test('anything the compile stage reads does restage that clip, and only it', () => {
  const project = twoClipProject();
  const keys = staleClips(project, null).keys;

  for (const [what, fields] of [
    ['the animation', { animId: 'draw.inkPaint' }],
    ['its parameters', { params: { mode: 'colorGroups' } }],
    // Brush widths are authored in screen terms and divide the scale out, so a
    // rescale really does change the compiled strokes.
    ['a rescale', { transform: { x: 300, y: 200, scale: 2.5, rotation: 0 } }],
  ]) {
    const { stale } = staleClips(patch(project, 'b', fields), keys);
    assert.deepEqual(stale, ['b'], `${what} must re-trace exactly that clip`);
  }
});

test('rewording a caption restages that caption alone', () => {
  const project = normalizeProject({
    meta: { name: 't' },
    assets: { t1: { kind: 'text', text: 'one' }, t2: { kind: 'text', text: 'two' } },
    clips: [
      { id: 'a', assetId: 't1', animId: 'draw.textReveal', start: 0, duration: 3 },
      { id: 'b', assetId: 't2', animId: 'draw.textReveal', start: 3, duration: 3 },
    ],
  });
  const keys = staleClips(project, null).keys;

  const reworded = normalizeProject({
    ...project,
    assets: { ...project.assets, t2: { kind: 'text', text: 'two!' } },
  });
  assert.deepEqual(staleClips(reworded, keys).stale, ['b']);

  // The asset's own styling counts too: it is laid out in the main process, so
  // a size or weight change has to cross the boundary again.
  for (const field of [{ fontSize: 64 }, { bold: true }, { color: '#123456' },
                       { align: 'left' }]) {
    const restyled = normalizeProject({
      ...project,
      assets: { ...project.assets, t1: { kind: 'text', text: 'one', ...field } },
    });
    assert.deepEqual(staleClips(restyled, keys).stale, ['a'],
      `${Object.keys(field)[0]} must restage its own clip`);
  }
});

test('a deleted clip is reported even though nothing needs re-tracing', () => {
  // It produces no stale key -- there is no key left to differ -- but a rebuild
  // still has to happen, or its surfaces and its bbox outlive it.
  const project = twoClipProject();
  const keys = staleClips(project, null).keys;
  const fewer = normalizeProject({ ...project, clips: [project.clips[0]] });

  const { stale, removed } = staleClips(fewer, keys);
  assert.deepEqual(stale, []);
  assert.deepEqual(removed, ['b']);
});

test('two clips of the same asset key alike, and a new clip is stale', () => {
  const project = twoClipProject();
  const [a, b] = project.clips;
  assert.equal(clipKey({ ...a, id: 'x' }, project.assets[a.assetId]),
    clipKey({ ...b, id: 'y', transform: a.transform }, project.assets[b.assetId]),
    'identical inputs must produce identical keys, whatever the clip is called');

  const keys = staleClips(project, null).keys;
  const added = normalizeProject({
    ...project, clips: [...project.clips, { ...a, id: 'c', start: 6 }],
  });
  assert.deepEqual(staleClips(added, keys).stale, ['c']);
});

test('the hand and the subtitle face are session state, not document state', () => {
  // Neither is re-read from the live document on paint: the sprites are decoded
  // images and the face is a parsed font, both baked in when the session is
  // built. A rebuild skipped on clip keys alone would go on drawing with the old
  // hand, or setting captions in the old typeface.
  const project = twoClipProject();
  const base = sessionKey(project);

  assert.notEqual(sessionKey(normalizeProject({
    ...project, meta: { ...project.meta, handStyleId: 'hand1' },
  })), base, 'a different drawing hand must force a rebuild');

  const withSubs = normalizeProject({
    ...project,
    subtitles: { font: 'assets/fonts/OpenSans.ttf', words: [{ w: 'hi', start: 0, end: 1 }] },
  });
  assert.notEqual(sessionKey(withSubs), base, 'turning subtitles on must force one');
  assert.notEqual(sessionKey(normalizeProject({
    ...withSubs, subtitles: { ...withSubs.subtitles, font: 'assets/fonts/Caveat.ttf' },
  })), sessionKey(withSubs), 'and so must changing the face');

  // But the wording is read from the live document on every paint, so it is
  // exactly the kind of edit that must stay free.
  assert.equal(sessionKey(normalizeProject({
    ...withSubs,
    subtitles: { ...withSubs.subtitles, words: [{ w: 'there', start: 0, end: 2 }] },
  })), sessionKey(withSubs), 'rewording subtitles must not rebuild anything');
});

// ── the payload ───────────────────────────────────────────────────────

test('prepare re-encodes only the clips it is asked for', async () => {
  const project = twoClipProject();
  assert.deepEqual(Object.keys(await prepareProject(project, PATH, null)).sort(), ['a', 'b'],
    'a null filter is a full prepare, which is what opening a project needs');
  assert.deepEqual(Object.keys(await prepareProject(project, PATH, new Set(['b']))), ['b']);
  assert.deepEqual(Object.keys(await prepareProject(project, PATH, new Set())), [],
    'a removal-only rebuild must read no artwork at all');
});

// ── the guarantee ─────────────────────────────────────────────────────

test('an incrementally rebuilt session renders exactly like a full one', async () => {
  const project = twoClipProject();
  const keys = staleClips(project, null).keys;

  // Edit one clip's animation, which is as structural as an edit gets. Not
  // `draw.stencilPaint`: `draw.outlineFill` in the example migrates to exactly
  // that on load, so it would be no edit at all.
  const edited = patch(project, 'b', { animId: 'draw.inkPaint' });
  const { stale } = staleClips(edited, keys);
  assert.deepEqual(stale, ['b'], 'precondition: exactly one clip is stale');

  // The path the editor takes: build, edit, rebuild carrying the old session.
  const first = await load(project, null);
  const incremental = await load(edited, new Set(stale), first);

  // The path it used to take, and the reference: everything from scratch.
  const full = await load(edited, null);

  assert.equal(incremental.session.plans.get('a'), first.session.plans.get('a'),
    'the untouched clip must keep the very plan it had, not an equal copy');
  assert.notEqual(incremental.session.plans.get('b'), first.session.plans.get('b'),
    'and the edited one must not');

  const pixels = (built, frame) => {
    const { width, height } = built.project.meta;
    const c = newSurface(width, height);
    renderFrame(built.session, built.project, frame, c.ctx, {
      width, height, showHand: false, handStyleId: built.hand.id,
    });
    return Buffer.from(c.ctx.getImageData(0, 0, width, height).data);
  };

  for (const frame of [0, 20, 60, 149]) {
    assert.deepEqual(pixels(incremental, frame), pixels(full, frame),
      `frame ${frame} must be identical however the session was assembled`);
  }
});
