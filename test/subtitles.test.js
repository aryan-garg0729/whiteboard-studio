/**
 * The burned-in narration track: schema, cue grouping, and survival.
 *
 * The survival tests are the ones that matter most. `normalizeProject` returns
 * an explicit whitelist of top-level keys and every editing path runs the
 * document back through it, so a key that is not listed there is not merely
 * ignored -- it is deleted from disk by the next unrelated edit. A transcript
 * costs a minute of CPU to produce and cannot be retyped, so losing it silently
 * is the worst failure this feature has.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';

import {
  normalizeProject, projectDuration, ProjectError, SUBTITLE_STYLES,
} from '../src/engine/model/project.js';
import * as edits from '../src/engine/model/edits.js';
import { buildCues, cueAt } from '../src/engine/model/subtitles.js';
import { parseFont } from '../src/engine/compile/font.js';
import { toSrt } from '../src/engine/export/srt.js';
import { createSession, renderFrame } from '../src/engine/render/renderFrame.js';
import { prepareSubtitleFont } from '../electron/prepare.js';
import { loadSubtitleFont } from '../src/engine/host/nodeSession.js';
import { base64Bytes } from '../src/ui/engineHost.js';
import { useTestSurfaces } from './helpers/surface.js';

useTestSurfaces();

const font = parseFont(readFileSync('assets/fonts/Montserrat.ttf'));

const minimal = () => ({
  meta: { name: 'test' },
  assets: { t1: { kind: 'text', text: 'hi' } },
  clips: [{ id: 'c1', assetId: 't1', animId: 'draw.textReveal', start: 0, duration: 2 }],
});

const throwsAt = (raw, path) => assert.throws(
  () => normalizeProject(raw),
  (e) => e instanceof ProjectError && e.path === path,
  `expected a ProjectError at ${path}`,
);

const words = (...spec) => spec.map(([w, start, end]) => ({ w, start, end }));

// ── schema ────────────────────────────────────────────────────────────

test('a project without subtitles keeps the key absent', () => {
  const p = normalizeProject(minimal());
  assert.equal(p.subtitles, undefined);
  assert.ok(!('subtitles' in p) || p.subtitles === undefined);
});

test('subtitles fill in defaults around whatever was authored', () => {
  const p = normalizeProject({ ...minimal(), subtitles: { style: 'pop' } });
  assert.equal(p.subtitles.style, 'pop');
  assert.equal(p.subtitles.enabled, true);
  assert.equal(p.subtitles.fontSize, 56);
  assert.deepEqual(p.subtitles.words, []);
});

test('an unknown style is an error, not a silent fallback', () => {
  throwsAt({ ...minimal(), subtitles: { style: 'crawl' } }, 'subtitles.style');
});

test('word timings are validated one by one, with the path pointing at the bad one', () => {
  const bad = (ws) => ({ ...minimal(), subtitles: { words: ws } });
  throwsAt(bad([{ w: 'a', start: 0, end: 1 }, { w: 'b', start: 2, end: 1.5 }]),
    'subtitles.words[1].end');
  throwsAt(bad([{ w: 'a', start: 0 }]), 'subtitles.words[0].end');
  throwsAt(bad([{ w: '  ', start: 0, end: 1 }]), 'subtitles.words[0].w');
  throwsAt(bad([{ w: 'a', start: 'soon', end: 1 }]), 'subtitles.words[0].start');
});

test("the recogniser's own spelling of `word` is accepted verbatim", () => {
  // So a timestamps.json straight off faster-whisper can be pasted in.
  const p = normalizeProject({
    ...minimal(),
    subtitles: { words: [{ word: 'Picture', start: 0, end: 0.24 }] },
  });
  assert.equal(p.subtitles.words[0].w, 'Picture');
});

test('words are sorted, so a hand-edited file still behaves', () => {
  const p = normalizeProject({
    ...minimal(),
    subtitles: { words: words(['b', 1, 2], ['a', 0, 0.5]) },
  });
  assert.deepEqual(p.subtitles.words.map((w) => w.w), ['a', 'b']);
});

// ── survival ──────────────────────────────────────────────────────────

test('subtitles survive a normalize round trip', () => {
  const once = normalizeProject({ ...minimal(), subtitles: { words: words(['hi', 0, 1]) } });
  const twice = normalizeProject(once);
  assert.deepEqual(twice.subtitles, once.subtitles);
});

test('subtitles survive an unrelated edit', () => {
  // The failure this guards: normalizeProject whitelists top-level keys, and
  // every commit path re-normalises then saves. An omission here would mean the
  // transcript is erased by the next camera nudge.
  const doc = normalizeProject({ ...minimal(), subtitles: { words: words(['hi', 0, 1]) } });
  const after = normalizeProject(edits.patchMeta(doc, { name: 'renamed' }));
  assert.equal(after.subtitles.words.length, 1);
});

test('removeSubtitles takes the key away rather than emptying it', () => {
  const doc = normalizeProject({ ...minimal(), subtitles: { words: words(['hi', 0, 1]) } });
  const gone = normalizeProject(edits.removeSubtitles(doc));
  assert.equal(gone.subtitles, undefined);
});

test('setSubtitles on a project that has never had them authors a complete block', () => {
  const doc = normalizeProject(minimal());
  const next = normalizeProject(edits.setSubtitles(doc, { style: 'bar' }));
  assert.equal(next.subtitles.style, 'bar');
  assert.ok(next.subtitles.font, 'a renderable block needs a font');
});

test('setSubtitleWords refuses anything that is not an array', () => {
  const doc = normalizeProject(minimal());
  assert.throws(() => edits.setSubtitleWords(doc, null), edits.EditError);
});

// ── duration ──────────────────────────────────────────────────────────

test('the transcript extends the timeline when the narration has no duration', () => {
  // add_audio leaves `duration` optional, so this is the ordinary case: without
  // the words counting, a voiceover-plus-subtitles project renders zero frames.
  const doc = normalizeProject({
    meta: { name: 'vo' },
    assets: {}, clips: [],
    audio: [{ src: '/tmp/vo.mp3' }],
    subtitles: { words: words(['one', 0, 1], ['two', 8, 9]), holdTail: 0.25 },
  });
  assert.ok(projectDuration(doc) > 9, `expected past the last word, got ${projectDuration(doc)}`);
});

// ── cue grouping ──────────────────────────────────────────────────────

test('a silence longer than gapSplit ends the cue', () => {
  const cues = buildCues({
    words: words(['one', 0, 0.4], ['two', 0.4, 0.8], ['three', 3, 3.4]),
    gapSplit: 0.6, maxWords: 20, maxChars: 80,
  });
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, 'one two');
  assert.equal(cues[1].start, 3);
});

test('sentence-ending punctuation ends the cue, a comma does not', () => {
  const cues = buildCues({
    words: words(['Picture', 0, 0.2], ['this,', 0.2, 0.6], ['a', 0.6, 0.8],
      ['guy.', 0.8, 1.2], ['Next', 1.3, 1.6]),
    gapSplit: 5, maxWords: 20, maxChars: 80,
  });
  assert.deepEqual(cues.map((c) => c.text), ['Picture this, a guy.', 'Next']);
});

test('maxWords ends the cue', () => {
  const cues = buildCues({
    words: words(['a', 0, 1], ['b', 1, 2], ['c', 2, 3], ['d', 3, 4]),
    gapSplit: 5, maxWords: 2, maxChars: 80,
  });
  assert.deepEqual(cues.map((c) => c.text), ['a b', 'c d']);
});

test('a long cue wraps with a newline rather than running off the frame', () => {
  // outlineText splits on "\n" and does no wrapping of its own, so an unwrapped
  // cue is a cue that overruns the composition.
  const cues = buildCues({
    words: words(['aaaa', 0, 1], ['bbbb', 1, 2], ['cccc', 2, 3]),
    gapSplit: 5, maxWords: 20, maxChars: 10,
  });
  assert.equal(cues.length, 1);
  assert.equal(cues[0].lines.length, 2);
  assert.equal(cues[0].text, 'aaaa bbbb\ncccc');
});

test('word offsets index the cue text they were laid out into', () => {
  // This mapping is what lets the renderer recolour one word: it is how a word
  // finds the glyphs, and an off-by-one highlights the wrong one.
  const [cue] = buildCues({
    words: words(['aaaa', 0, 1], ['bbbb', 1, 2], ['cccc', 2, 3]),
    gapSplit: 5, maxWords: 20, maxChars: 10,
  });
  for (const w of cue.words) {
    assert.equal(cue.text.slice(w.from, w.to), w.w, `offsets for ${w.w}`);
  }
  assert.deepEqual(cue.words.map((w) => w.line), [0, 0, 1]);
});

test('a cue ends at the last word to finish, not the last word to start', () => {
  const [cue] = buildCues({
    words: words(['a', 0, 5], ['b', 1, 2]),
    gapSplit: 9, maxWords: 20, maxChars: 80,
  });
  assert.equal(cue.end, 5);
});

test('no words means no cues, and nothing downstream has to special-case it', () => {
  assert.deepEqual(buildCues({ words: [] }), []);
  assert.deepEqual(buildCues(undefined), []);
});

// ── cue lookup ────────────────────────────────────────────────────────

test('cueAt finds the cue on screen, and nothing before the first one', () => {
  const cues = buildCues({
    words: words(['one.', 0, 1], ['two.', 4, 5]),
    gapSplit: 0.6, maxWords: 20, maxChars: 80,
  });
  assert.equal(cueAt(cues, -0.1), null);
  assert.equal(cueAt(cues, 0.5).text, 'one.');
  assert.equal(cueAt(cues, 4.5).text, 'two.');
});

test('holdTail keeps a cue up past its last word but never past the next cue', () => {
  const cues = buildCues({
    words: words(['one.', 0, 1], ['two.', 4, 5]),
    gapSplit: 0.6, maxWords: 20, maxChars: 80,
  });
  assert.equal(cueAt(cues, 1.2, 0), null, 'no tail, no hold');
  assert.equal(cueAt(cues, 1.2, 0.5).text, 'one.');
  // A tail long enough to reach the next cue must not win over it.
  assert.equal(cueAt(cues, 4.5, 10).text, 'two.');
});

test('every style the schema accepts is one the renderer will be asked for', () => {
  assert.deepEqual([...SUBTITLE_STYLES], ['bar', 'karaoke', 'pop']);
});

// ── rendering ─────────────────────────────────────────────────────────

const W = 640;
const H = 360;

/** A project that is nothing but narration: no clips, no assets, no pages. */
const spoken = (subtitles) => normalizeProject({
  meta: { name: 'vo', width: W, height: H },
  assets: {}, clips: [],
  subtitles: {
    words: words(['one', 0, 0.5], ['two', 0.5, 1], ['three.', 1, 1.5]),
    background: '#00000000', maxWords: 9, gapSplit: 5, ...subtitles,
  },
});

/** Renders `t` and hands back the pixels, plus a count of non-paper ones. */
function paint(project, t) {
  const session = createSession({ subtitleFont: font });
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  renderFrame(session, project, Math.round(t * project.meta.fps), ctx,
    { width: W, height: H, showHand: false });
  const { data } = ctx.getImageData(0, 0, W, H);
  return { data, ctx };
}

/** How many pixels in the lower fifth of the frame are close to `hex`. */
function bandPixels({ data }, hex) {
  const want = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  let n = 0;
  for (let y = Math.floor(H * 0.8); y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 4;
      if (Math.abs(data[p] - want[0]) < 24
        && Math.abs(data[p + 1] - want[1]) < 24
        && Math.abs(data[p + 2] - want[2]) < 24) n++;
    }
  }
  return n;
}

test('a project with no clips at all still paints its narration', () => {
  // The whole point of a project-level track: subtitles do not need artwork,
  // and the hosts must not skip building a session just because there are no
  // clips to compile.
  assert.ok(bandPixels(paint(spoken({ color: '#ff0000' }), 0.7), '#ff0000') > 40);
});

test('nothing is painted before the first word or after the last', () => {
  assert.equal(bandPixels(paint(spoken({ color: '#ff0000' }), 5), '#ff0000'), 0);
});

test('karaoke highlights the word being spoken and not the ones still to come', () => {
  const at = (t) => bandPixels(
    paint(spoken({ style: 'karaoke', color: '#ff0000', highlight: '#00ff00' }), t), '#00ff00');
  assert.equal(at(0.1) > 0, true, 'the first word highlights immediately');
  const early = at(0.1);
  const late = at(1.2);
  assert.ok(late > early, `highlight should spread over time, got ${early} then ${late}`);
});

test('pop shows nothing of a word until its own timestamp', () => {
  const at = (t) => bandPixels(
    paint(spoken({ style: 'pop', color: '#ff0000', highlight: '#ff0000' }), t), '#ff0000');
  const one = at(0.2);
  const three = at(1.4);
  assert.ok(one > 0, 'the first word is up');
  assert.ok(three > one, `words accumulate, got ${one} then ${three}`);
});

test('bar paints every word of the cue at once, in the base colour', () => {
  const bar = bandPixels(paint(spoken({ style: 'bar', color: '#ff0000' }), 0.1), '#ff0000');
  const karaoke = bandPixels(
    paint(spoken({ style: 'karaoke', color: '#ff0000', highlight: '#ff0000' }), 0.1), '#ff0000');
  // Same cue, same colour everywhere: bar and karaoke must lay out identically,
  // since they are one subtitle differing only in how it is coloured.
  assert.equal(bar, karaoke);
});

test('subtitles scale with the frame, so a draft export is not a wall of text', () => {
  const project = spoken({ color: '#ff0000' });
  const session = createSession({ subtitleFont: font });
  const half = createCanvas(W / 2, H / 2);
  const ctx = half.getContext('2d');
  renderFrame(session, project, Math.round(0.7 * project.meta.fps), ctx,
    { width: W / 2, height: H / 2, showHand: false });
  const { data } = ctx.getImageData(0, 0, W / 2, H / 2);
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] > 200 && data[i + 1] < 80 && data[i + 2] < 80) n++;
  }
  const full = bandPixels(paint(project, 0.7), '#ff0000');
  // A quarter of the area, so roughly a quarter of the ink -- and emphatically
  // not the same count, which is what rendering at composition pixel size on a
  // half-size frame would give.
  assert.ok(n > 0 && n < full * 0.6, `expected the ink to shrink: ${full} -> ${n}`);
});

test('a subtitled frame is byte-identical across renders', () => {
  const project = spoken({ style: 'pop', color: '#ff0000' });
  const a = paint(project, 0.8).data;
  const b = paint(project, 0.8).data;
  assert.deepEqual(Buffer.from(a), Buffer.from(b));
});

test('the layout cache rebuilds when the subtitles change, and not otherwise', () => {
  // Reference identity is the only signal the renderer gets that a transcript
  // was edited, so this is what stands between a colour change and a stale frame.
  const project = spoken({ color: '#ff0000' });
  const session = createSession({ subtitleFont: font });
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const render = (p) => {
    renderFrame(session, p, 21, ctx, { width: W, height: H, showHand: false });
    return ctx.getImageData(0, 0, W, H).data;
  };

  render(project);
  const first = session.subtitleCache.plan;
  render(project);
  assert.equal(session.subtitleCache.plan, first, 'an unchanged track must not re-lay-out');

  const recoloured = normalizeProject(edits.setSubtitles(project, { color: '#0000ff' }));
  render(recoloured);
  assert.notEqual(session.subtitleCache.plan, first, 'an edited track must re-lay-out');
});

// ── the sidecar ───────────────────────────────────────────────────────

test('toSrt writes SubRip, comma decimals and all', () => {
  const srt = toSrt(normalizeProject({
    meta: { name: 's' }, assets: {}, clips: [],
    subtitles: {
      words: words(['Hello', 0, 0.5], ['world.', 0.5, 1.25], ['Again.', 4, 4.5]),
      gapSplit: 0.6, holdTail: 0,
    },
  }).subtitles);

  assert.equal(srt,
    '1\n00:00:00,000 --> 00:00:01,250\nHello world.\n'
    + '\n2\n00:00:04,000 --> 00:00:04,500\nAgain.\n');
});

test('an srt cue never outlasts the next one, exactly as on screen', () => {
  const subs = normalizeProject({
    meta: { name: 's' }, assets: {}, clips: [],
    subtitles: {
      words: words(['one.', 0, 1], ['two.', 1.1, 2]),
      gapSplit: 5, holdTail: 3,
    },
  }).subtitles;
  const [, end] = /--> (\S+)/.exec(toSrt(subs));
  assert.equal(end, '00:00:01,100', 'the hold must be clamped to the next cue');
});

test('no transcript means no sidecar, rather than an empty file', () => {
  assert.equal(toSrt({ words: [] }), '');
});

// ── the Electron seam ─────────────────────────────────────────────────

test('the main process ships subtitle font bytes, and only when they are needed', () => {
  // The renderer has no filesystem, so this is the only way a subtitle gets a
  // letterform in the app. Silence here is a blank subtitle band in the editor.
  const base = { meta: { name: 'f' }, assets: {}, clips: [] };
  assert.equal(prepareSubtitleFont(normalizeProject(base), '.').font, null);
  assert.equal(
    prepareSubtitleFont(normalizeProject({ ...base, subtitles: { words: [] } }), '.').font, null,
    'no words, nothing to set');

  const withWords = normalizeProject({ ...base, subtitles: { words: words(['hi', 0, 1]) } });
  const { font: b64, id } = prepareSubtitleFont(withWords, '.');
  assert.ok(b64 && b64.length > 1000, 'expected a font');
  // And it must be the same face the Node host would have used, or the editor's
  // preview and the exported file would set the same words differently.
  assert.ok(parseFont(Buffer.from(b64, 'base64')).unitsPerEm > 0);

  // Re-prepared on every keystroke, so a renderer that already parsed this face
  // is told to keep it rather than sent a megabyte of font again.
  const again = prepareSubtitleFont(withWords, '.', id);
  assert.equal(again.font, null, 'bytes must not be re-sent for a face already held');
  assert.equal(again.id, id, 'but the identity still comes back, or it reads as absent');
});

test('the renderer decodes those bytes into the font the Node host loaded', () => {
  // The one link the engine tests cannot reach: in the app the font crosses a
  // process boundary as base64 and is parsed on the far side. If this drifts,
  // the editor previews subtitles that are not the ones it exports.
  const project = normalizeProject({
    meta: { name: 'f' }, assets: {}, clips: [],
    subtitles: { words: words(['hi', 0, 1]) },
  });
  const viaIpc = parseFont(base64Bytes(prepareSubtitleFont(project, '.').font));
  const viaDisk = loadSubtitleFont(project, { root: '.' });
  assert.equal(viaIpc.unitsPerEm, viaDisk.unitsPerEm);
  assert.equal(viaIpc.charToGlyph('g').index, viaDisk.charToGlyph('g').index);
});
