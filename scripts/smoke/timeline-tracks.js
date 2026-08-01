/**
 * WB_SMOKE_SCRIPT: tracks, pages and audio all reach the renderer.
 *
 * Runs in the renderer after WB_SMOKE has opened a project. Asserts against the
 * document and the DOM rather than a screenshot, because a headless compositor
 * can hand back a stale frame and make a broken build look like a passing test.
 *
 *   WB_SMOKE=/tmp/tl.png \
 *   WB_SMOKE_PROJECT=<a project with clips and an audio track> \
 *   WB_SMOKE_SCRIPT=scripts/smoke/timeline-tracks.js \
 *   xvfb-run -a npx electron .
 */

const fail = (msg) => { throw new Error(msg); };
const eq = (got, want, what) => {
  if (got !== want) fail(`${what}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const state = () => window.__studioState();

// ── the document carries lanes, and everything is assigned to one ──
const s0 = state();
if (!s0.tracks?.length) fail('document has no tracks');
for (const c of s0.clips) {
  if (!s0.tracks.some((t) => t.id === c.trackId && t.kind === 'clip')) {
    fail(`clip ${c.id} is not on a clip lane (trackId ${c.trackId})`);
  }
}
for (const a of s0.audio) {
  if (!s0.tracks.some((t) => t.id === a.trackId && t.kind === 'audio')) {
    fail(`audio ${a.src} is not on an audio lane (trackId ${a.trackId})`);
  }
}

// ── the timeline draws one lane per track, not one per clip ──
// The page lane is excluded throughout: it is pinned above the track lanes and
// is not one of them.
const trackLanes = () => document.querySelectorAll('.tl-lane:not(.page)');
const lanes = trackLanes();
const heads = document.querySelectorAll('.tl-head:not([data-kind="page"])');
eq(lanes.length, s0.tracks.length, 'lane count tracks the track count');
eq(heads.length, s0.tracks.length, 'header count tracks the track count');
if (s0.clips.length > lanes.length) {
  // The whole point of the change: N clips must not mean N rows.
  const blocks = document.querySelectorAll('.tl-lane:not(.page) .tl-clip');
  if (blocks.length < s0.clips.length) fail('clips are missing from their lanes');
}

// ── adding lanes, renaming, and packing ──
const before = s0.tracks.length;
const addLane = document.querySelector('.tl-bar .btn[title="Add an empty video lane"]');
if (!addLane) fail('no "add video lane" button');
addLane.click();
await sleep(60);
eq(state().tracks.length, before + 1, 'a lane was added');
eq(trackLanes().length, before + 1, 'the new lane rendered');

// ── the page lane ──
// Derived from pageBreaks, so it must show one segment per on-screen visit --
// a page visited twice appears twice.
const s1 = state();
const segments = document.querySelectorAll('.tl-lane.page .tl-clip.page');
eq(segments.length, s1.pageBreaks.length + 1, 'one page segment per visit');
eq(document.querySelectorAll('.tl-break').length, s1.pageBreaks.length,
  'one marker per page break');
if (!s1.activePage) fail('no active page reported');

// Adding a page must produce a document the validator accepts -- if it did not,
// the stage would fall back to the last good frame and show a banner.
const pagesBefore = s1.pages.length;
const addPage = document.querySelector('.tl-bar .btn[title^="Add a page"]');
if (!addPage) fail('no "add page" button');
addPage.click();
await sleep(120);
const s2 = state();
eq(s2.pages.length, pagesBefore + 1, 'a page was added');
eq(s2.pageBreaks.length, s1.pageBreaks.length + 1, 'and a break to reach it');
if (document.querySelector('.stage .overlay .title')?.textContent === 'Could not load project') {
  fail('adding a page produced a document the validator rejects');
}

// ── the transport exposes preview audio ──
const vol = document.querySelector('.vol input[type="range"]');
if (!vol) fail('no preview volume control in the transport bar');
eq(vol.disabled, s0.audio.length === 0, 'volume is enabled exactly when there is audio');

// ── audio bytes actually cross the IPC boundary ──
let decoded = null;
if (s0.audio.length) {
  const bytes = await window.studio.readAudio(s0.audio[0].src);
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    fail(`audio:read returned ${JSON.stringify(bytes)?.slice(0, 120)}`);
  }
  const ctx = new AudioContext();
  const buf = await ctx.decodeAudioData(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  decoded = Math.round(buf.duration * 100) / 100;
  await ctx.close();
  if (!(decoded > 0)) fail('decoded audio has no duration');
}

return {
  ok: true,
  tracks: state().tracks.map((t) => `${t.kind}:${t.name}`),
  clips: s0.clips.length,
  lanes: trackLanes().length,
  pages: state().pages.length,
  breaks: state().pageBreaks.length,
  audioSeconds: decoded,
};
