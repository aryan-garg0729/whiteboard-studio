/**
 * Document transforms: every editing action, as a pure `doc -> doc` function.
 *
 * These used to live inside `useEditor`, half as module-scope exports and half
 * as closures over the hook's dispatcher. The split was arbitrary -- none of
 * the closures captured anything but `edit` -- and it meant a headless caller
 * (the MCP server, a script, a test) could only reach the exported half.
 *
 * So all of them are here now, and `src/ui/state/editor.js` re-exports them and
 * keeps only what is genuinely React: the reducer, undo/redo, and the
 * structural-vs-timing bookkeeping that decides when to re-prepare.
 *
 * Deliberately DOM-free and dependency-free beyond the model, so it imports
 * cleanly from Node.
 *
 * Two conventions run through the file:
 *
 * - **Never produce a document the validator would reject.** Times the editor
 *   picks on the user's behalf clear transitions, page breaks land after
 *   everything already authored, and a `cut` is forced to zero duration. A
 *   button must not be able to author an unrenderable project.
 * - **Refusals throw.** A transform that cannot do what was asked raises
 *   `EditError` rather than returning the document unchanged. The UI catches
 *   and no-ops (the button was disabled anyway); a headless caller needs to be
 *   told, because "nothing happened" is indistinguishable from success.
 */

import { DEFAULTS, pageAt } from './project.js';
import { cameraAt } from '../render/renderFrame.js';

/**
 * A transform refusing an impossible edit -- the last page, a lane still in
 * use. Shaped like ProjectError (a `name` worth switching on) so callers can
 * treat validation failures and refusals the same way.
 */
export class EditError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EditError';
  }
}

/**
 * Fields that only move a clip in time, space, between lanes or between pages;
 * never re-prepared. `trackId` and `pageId` belong here because neither changes
 * a single byte of compiled geometry -- a track is timeline layout, and a page
 * decides only *when* the clip is on screen. Dragging a clip to another lane or
 * across a page boundary must not trigger a re-trace of its artwork.
 */
export const TIMING_FIELDS = new Set([
  'start', 'duration', 'erase', 'transform', 'trackId', 'pageId',
]);

/** True when a clip patch changes geometry and needs a main-process rebuild. */
export const isStructural = (patch) =>
  Object.keys(patch).some((k) => !TIMING_FIELDS.has(k));

export const EMPTY_PROJECT = {
  meta: {
    version: 1, name: '', fps: 30, width: 1920, height: 1080,
    background: '#fdfdfb', handStyleId: 'hand3', showHand: true,
  },
  assets: {},
  pages: [{ id: 'page1', name: 'Page 1', cameraKeyframes: [{ t: 0, x: 0, y: 0, zoom: 1 }] }],
  pageBreaks: [],
  tracks: [
    { id: 'v1', name: 'Video 1', kind: 'clip' },
    { id: 'a1', name: 'Audio 1', kind: 'audio' },
  ],
  clips: [],
  audio: [],
};

/** Short, stable, collision-checked id. Not random: seeded off what exists. */
export function uniqueId(prefix, taken) {
  for (let i = 1; ; i++) {
    const id = `${prefix}${i}`;
    if (!taken.has(id)) return id;
  }
}

// ── timing helpers ────────────────────────────────────────────────────

/** When a clip is finally off the page: after its wipe, or after its last stroke. */
export const clipEnd = (c) =>
  (c.erase ? Math.max(c.erase.start + c.erase.duration, c.start + c.duration)
           : c.start + c.duration);

/**
 * When an audio item stops on the timeline.
 *
 * `duration` is timeline seconds and may be absent -- ffprobe returns null often
 * enough that the document carries `undefined` rather than guessing. `srcLen`,
 * when a caller happens to know the file's real length, closes that hole: an
 * unprobed item is otherwise treated as zero-length and two of them will stack
 * on one lane. Divided by `speed`, because a file played at 2x occupies half as
 * much of the timeline as it has seconds in it.
 */
export const audioEnd = (a, srcLen) => (a.start || 0) + (a.duration
  ?? (srcLen != null ? Math.max(0, srcLen - (a.trimIn || 0)) / (a.speed || 1) : 0));

/** Half-open overlap; two clips that merely touch at an edge may share a lane. */
const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd;

/** Times are seconds in a JSON document; float noise there reads as a bug. */
const round3 = (t) => Math.round(t * 1000) / 1000;

/** Timeline times snap to a tenth: fine enough to author, coarse enough to read. */
const round1 = (t) => Math.round(t * 10) / 10;

/**
 * Snap to a tenth, never earlier.
 *
 * Used where the time is a floor rather than a preference -- rounding down past
 * the thing being cleared is how a snapped time ends up back inside it.
 */
// The `+ 0` normalises -0, which ceil produces for t=0 once the epsilon is
// subtracted. A negative zero start is harmless to render and startling to read.
const ceil1 = (t) => Math.ceil(t * 10 - 1e-9) / 10 + 0;

/**
 * Snap up to a tenth, but never below where we started.
 *
 * Seconds in a document are floats and tenths are not exact in binary, so a
 * clip ending at "3.8" really ends at 3.8000000000000003 and snapping it lands
 * on 3.8 -- a hair *before* the ink it was supposed to follow. The validator
 * compares exactly and rejects the result, which is how two ordinary button
 * presses could produce an unrenderable document. Clamping to the input keeps
 * the tidy value whenever it is actually safe and falls back to the exact one
 * when it is not.
 */
const snapUp = (t) => Math.max(ceil1(t), t);

/** The last moment anything in the document is still happening. */
export const authoredEnd = (doc) => Math.max(
  (doc.clips || []).reduce((end, c) => Math.max(end, clipEnd(c)), 0),
  (doc.pageBreaks || []).reduce((end, b) => Math.max(end, b.t + b.duration), 0),
);

/**
 * Pick the lane a new item belongs in: the first existing track of the right
 * kind with nothing in the way, or a fresh one.
 *
 * This is what makes a 60-element project usable. Whiteboard clips are almost
 * always sequential, so they all land on one lane and the timeline stays two
 * rows tall regardless of how many elements the project has -- while anything
 * that genuinely overlaps in time still gets its own row, which is the only
 * case where a second row carries information.
 *
 * @returns {{trackId: string, tracks: Array}} `tracks` is the (possibly
 *   extended) track list, so callers can spread both into one document.
 */
export function packTrack(doc, kind, start, end) {
  const tracks = doc.tracks || [];
  const spans = kind === 'audio'
    ? doc.audio.map((a) => ({ trackId: a.trackId, start: a.start || 0, end: audioEnd(a) }))
    : doc.clips.map((c) => ({ trackId: c.trackId, start: c.start, end: clipEnd(c) }));

  for (const t of tracks) {
    if (t.kind !== kind) continue;
    const busy = spans.some((s) => s.trackId === t.id && overlaps(start, end, s.start, s.end));
    if (!busy) return { trackId: t.id, tracks };
  }

  const label = kind === 'audio' ? 'Audio' : 'Video';
  const n = tracks.filter((t) => t.kind === kind).length + 1;
  const track = { id: uniqueId(kind === 'audio' ? 'a' : 'v', new Set(tracks.map((t) => t.id))),
                  name: `${label} ${n}`, kind };
  return { trackId: track.id, tracks: [...tracks, track] };
}

/**
 * Nudge `t` forward out of any transition it lands inside.
 *
 * A clip may not draw while the paper is sliding, so times the editor picks on
 * the user's behalf have to clear the swipe rather than produce a document the
 * validator will reject.
 *
 * The lower bound is inclusive, and that is load-bearing rather than fussy:
 * "add a page, then add a clip" puts the break at the end of everything
 * authored and then appends the clip at exactly that instant, so a strict `>`
 * left the new clip drawing through its own transition -- a document the
 * validator rejects, reachable from two ordinary button presses.
 *
 * A cut is unaffected either way: its duration is zero, so no `t` is ever
 * inside it.
 */
export function afterTransition(doc, t) {
  for (const b of doc.pageBreaks || []) {
    if (t >= b.t && t < b.t + b.duration) return b.t + b.duration;
  }
  return t;
}

// ── clips and assets ──────────────────────────────────────────────────

/**
 * Append an asset plus a clip for it, starting after everything else ends.
 *
 * `clipId` may be supplied by the caller. That is not a convenience: a
 * drawable's size is only known once its clip has been compiled, so placing one
 * in the centre of frame takes two steps, and the caller needs a handle on the
 * clip to finish the job when the measurement comes back. Picking the id up
 * front is the only way to get one out of a dispatch-based action.
 */
export function addClipTo(doc, asset, { animId, duration = 3, transform, clipId: wanted } = {}) {
  const assetId = uniqueId(asset.kind === 'text' ? 'text' : 'art',
    new Set(Object.keys(doc.assets)));
  const taken = new Set(doc.clips.map((c) => c.id));
  const clipId = wanted && !taken.has(wanted) ? wanted : uniqueId('clip', taken);
  const raw = doc.clips.reduce((end, c) => Math.max(end, clipEnd(c)), 0);
  // Never begin inside a transition: the validator forbids drawing while the
  // paper is sliding, so a clip appended right after a page break has to wait
  // for the swipe to land.
  //
  // Snap to a tenth *before* clearing the transition, and only ever upward.
  // Rounding afterwards can push the time back down into the swipe it just
  // escaped -- a break ending at 3.44s would round to 3.4s and be illegal again.
  const start = snapUp(afterTransition(doc, snapUp(raw)));
  const { trackId, tracks } = packTrack(doc, 'clip', start, start + duration);
  return {
    ...doc,
    tracks,
    assets: { ...doc.assets, [assetId]: { ...asset, id: assetId } },
    clips: [...doc.clips, {
      id: clipId,
      assetId,
      animId: animId || (asset.kind === 'text' ? 'draw.handwrite' : 'draw.inkPaint'),
      // Whichever page is showing then -- not page 1. A clip born on a hidden
      // page is rejected outright by the validator.
      pageId: pageAt(doc, start),
      trackId,
      start,
      duration,
      transform: { x: 0, y: 0, scale: 1, rotation: 0, ...transform },
      params: {},
    }],
  };
}

/**
 * Remove a clip, and its asset when nothing else references it -- otherwise the
 * document accumulates orphans the user has no way to see or delete.
 */
export function removeClipFrom(doc, id) {
  const clip = doc.clips.find((c) => c.id === id);
  const clips = doc.clips.filter((c) => c.id !== id);
  const assets = { ...doc.assets };
  if (clip && !clips.some((c) => c.assetId === clip.assetId)) delete assets[clip.assetId];
  return { ...doc, clips, assets };
}

/** Patch one clip's top-level fields. Structural unless every key is timing-only. */
export function patchClip(doc, id, patch) {
  return {
    ...doc,
    clips: doc.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)),
  };
}

/** Patch one clip's placement. Never structural: geometry does not depend on it. */
export function patchTransform(doc, id, patch) {
  return {
    ...doc,
    clips: doc.clips.map((c) => (c.id === id
      ? { ...c, transform: { ...c.transform, ...patch } }
      : c)),
  };
}

/**
 * Patch an asset: the text itself, its font, size, colour, trace options.
 *
 * Always structural -- every field here feeds the compile step, so the geometry
 * has to be rebuilt before the change is visible.
 */
export function patchAsset(doc, id, patch) {
  if (!doc.assets[id]) throw new EditError(`no such asset ${JSON.stringify(id)}`);
  return { ...doc, assets: { ...doc.assets, [id]: { ...doc.assets[id], ...patch } } };
}

export function patchMeta(doc, patch) {
  return { ...doc, meta: { ...doc.meta, ...patch } };
}

// ── audio ─────────────────────────────────────────────────────────────
//
// One rule underlies everything here: **two items never overlap on one lane.**
// Overlapping audio does not read as an edit, it reads as a bug -- both files
// play at once and the mix is a surprise. So every path that can move or resize
// an item goes through `audioSlot`, and the worst a drag can do is stop flush
// against its neighbour.
//
// The other thing to keep straight is which clock a number is on. `start` and
// `duration` are *timeline* seconds; `trimIn` is *source* seconds. At speed 1
// they coincide, which is why the distinction never mattered before.

/** Shortest audio item worth having. Below this a block is not clickable. */
export const MIN_AUDIO = 0.05;

/** Index or id. Audio grew ids late, so both spellings stay valid. */
export function audioIndex(doc, ref) {
  const i = typeof ref === 'number' ? ref : doc.audio.findIndex((a) => a.id === ref);
  if (i < 0 || i >= doc.audio.length) {
    throw new EditError(`no such audio item ${JSON.stringify(ref)}`);
  }
  return i;
}

/** Items on one lane, ascending, optionally minus the one being moved. */
const laneItems = (doc, trackId, skipId) => doc.audio
  .filter((a) => a.trackId === trackId && a.id !== skipId)
  .map((a) => ({ start: a.start || 0, end: audioEnd(a) }))
  .sort((p, q) => p.start - q.start);

/** Where a lane runs out: the end of its last item, or zero when it is empty. */
export function laneEnd(doc, trackId, skipId) {
  return laneItems(doc, trackId, skipId).reduce((end, s) => Math.max(end, s.end), 0);
}

/**
 * The nearest free start for a `length`-second block on `trackId`.
 *
 * `wantStart` is a request, not an instruction. When it collides, the answer is
 * whichever side of the obstruction is nearer -- flush after it, or flush
 * before it -- which is what makes dragging feel like the block is butting up
 * against its neighbour rather than teleporting past it.
 *
 * A zero-length block (an item whose duration ffprobe could not determine) is
 * measured as MIN_AUDIO so it still collides with something.
 */
export function audioSlot(doc, trackId, wantStart, length, skipId) {
  const len = Math.max(length || 0, MIN_AUDIO);
  const others = laneItems(doc, trackId, skipId);
  const free = (s) => s >= 0 && !others.some((n) => s < n.end && n.start < s + len);

  const want = Math.max(0, wantStart);
  if (free(want)) return round3(want);

  const candidates = [];
  for (const n of others) candidates.push(n.end, n.start - len);
  const valid = candidates.filter(free);
  // Nothing fits anywhere before the end of the lane, so go after it.
  if (!valid.length) return round3(laneEnd(doc, trackId, skipId));
  return round3(valid.reduce((best, c) =>
    (Math.abs(c - want) < Math.abs(best - want) ? c : best)));
}

/**
 * Lay an item on a lane, after whatever is already there.
 *
 * Appending is the default because it is what "add another one" means: dropping
 * a second file onto a lane that already has one is asking for the two of them
 * in sequence, not for both at zero playing over each other. An explicit
 * `start` is still honoured, but it is a request like any other and slides to
 * the nearest free spot rather than overlapping.
 */
export function addAudio(doc, track) {
  const existing = track.trackId ?? doc.tracks.find((t) => t.kind === 'audio')?.id;
  // A document always has an audio lane after normalisation, but a hand-built
  // one passed straight to a transform might not.
  const { trackId, tracks } = existing
    ? { trackId: existing, tracks: doc.tracks }
    : packTrack(doc, 'audio', 0, track.duration || 0);
  const start = audioSlot(doc, trackId,
    track.start ?? laneEnd(doc, trackId), track.duration || 0);
  const id = uniqueId('aud', new Set(doc.audio.map((a) => a.id)));
  return { ...doc, tracks, audio: [...doc.audio, { ...track, id, trackId, start }] };
}

/**
 * Change an item's rate, resizing it to hold the same audio.
 *
 * The resize is the point. `duration` is timeline seconds, so the same
 * recording at 2x occupies half as much of the timeline -- leaving it alone
 * meant the block went on claiming its old length while holding half as much
 * sound, and `atrim` asked for more file than the trim had left. The remainder
 * came out as silence, in preview and in the MP4 alike.
 *
 * The rest of the lane slides by the same delta. This is the one place
 * something moves that the user did not select, and it is deliberate: the
 * alternative is a lane that grows a hole every time a take is sped up, which
 * is the bug this is fixing wearing a different hat. Uniform shift, so no
 * overlap can appear and the spacing between later items is preserved exactly.
 *
 * `trimIn` is untouched -- it is source seconds, and the in-point has not moved.
 */
export function setAudioSpeed(doc, ref, speed) {
  const index = audioIndex(doc, ref);
  const a = doc.audio[index];
  const old = a.speed || 1;
  if (speed === old) return doc;

  // An item ffprobe could not measure has no length to rescale; it plays to the
  // end of the file either way, just faster.
  const duration = a.duration == null ? undefined : round3(a.duration * old / speed);
  const shift = (duration ?? 0) - (a.duration ?? 0);
  const from = audioEnd(a);

  return {
    ...doc,
    audio: doc.audio.map((x, i) => {
      if (i === index) return { ...x, speed, duration };
      if (!shift || x.trackId !== a.trackId || (x.start || 0) < from) return x;
      return { ...x, start: round3((x.start || 0) + shift) };
    }),
  };
}

/** Fields whose new value could put an item on top of a neighbour. */
const PLACEMENT_FIELDS = ['start', 'duration', 'trackId'];

export function patchAudio(doc, ref, patch) {
  // Speed carries a length change with it, unless the caller states a length of
  // its own -- an explicit `{speed, duration}` is someone who knows what they
  // want, and second-guessing them would make the pair unusable.
  if ('speed' in patch && !('duration' in patch)) {
    const rest = { ...patch };
    delete rest.speed;
    const respeeded = setAudioSpeed(doc, ref, patch.speed);
    return Object.keys(rest).length ? patchAudio(respeeded, ref, rest) : respeeded;
  }

  const index = audioIndex(doc, ref);
  const next = { ...doc.audio[index], ...patch };
  if (PLACEMENT_FIELDS.some((k) => k in patch)) {
    next.start = audioSlot(doc, next.trackId, next.start || 0, next.duration || 0, next.id);
  }
  return { ...doc, audio: doc.audio.map((a, i) => (i === index ? next : a)) };
}

export function removeAudio(doc, ref) {
  const index = audioIndex(doc, ref);
  return { ...doc, audio: doc.audio.filter((_, i) => i !== index) };
}

/**
 * Cut an item in two at timeline second `t`.
 *
 * The halves abut exactly, so neither needs re-placing and the lane's no-overlap
 * invariant survives for free. The one subtlety is `trimIn`: it is on the
 * source's clock, so the right half skips `(t - start) * speed` seconds of file,
 * not `(t - start)`.
 *
 * An item whose duration was never probed splits fine -- the right half inherits
 * the same `undefined` and plays to the end of the file, which is what it was
 * doing before the cut.
 */
export function splitAudio(doc, ref, t) {
  const index = audioIndex(doc, ref);
  const a = doc.audio[index];
  const start = a.start || 0;
  const speed = a.speed || 1;
  const end = audioEnd(a);
  // Only a cut with two real halves is an edit anyone meant; a slice a
  // twentieth of a second long is a misclick.
  if (t - start < MIN_AUDIO || (a.duration != null && end - t < MIN_AUDIO)) {
    throw new EditError(
      `cannot split at ${round3(t)}s: the playhead is not inside the audio item`);
  }
  const left = { ...a, duration: round3(t - start) };
  const right = {
    ...a,
    id: uniqueId('aud', new Set(doc.audio.map((x) => x.id))),
    start: round3(t),
    trimIn: round3((a.trimIn || 0) + (t - start) * speed),
    duration: a.duration == null ? undefined : round3(end - t),
  };
  const audio = [...doc.audio];
  audio.splice(index, 1, left, right);
  return { ...doc, audio };
}

/**
 * Close the silence at `t` on `trackId` by pulling everything after it left.
 *
 * Lane-local on purpose. Rippling every lane would drag the music along with
 * the narration it was placed against, and rippling the clips too would desync
 * the drawing -- neither is what "delete this gap" asks for.
 */
export function closeAudioGap(doc, trackId, t) {
  const items = laneItems(doc, trackId);
  if (!items.length) throw new EditError('that lane is empty');

  if (items.some((it) => t >= it.start && t < it.end)) {
    throw new EditError('that is an audio item, not a gap');
  }
  // The run of silence containing `t`: from the end of the last item before it
  // (or zero, for the lead-in) to the start of the first item after it.
  const before = items.filter((it) => it.end <= t).pop();
  const after = items.find((it) => it.start > t);
  // Trailing silence has nothing after it to pull back, so there is nothing to
  // close -- the lane simply ends there.
  if (!after) throw new EditError('there is nothing after that gap to pull back');
  const from = before ? before.end : 0;
  const to = after.start;
  const width = round3(to - from);
  if (width < MIN_AUDIO) throw new EditError('there is no gap there');

  return {
    ...doc,
    audio: doc.audio.map((a) => (a.trackId === trackId && (a.start || 0) >= to
      ? { ...a, start: round3((a.start || 0) - width) }
      : a)),
  };
}

// ── subtitles ─────────────────────────────────────────────────────────
// The burned-in narration track: one per project, no lane, no clips. None of
// these are structural -- nothing about a clip's compiled geometry depends on
// them, and forcing a re-prepare on every colour tweak would recompile every
// drawing in the project to repaint some text.

/**
 * Turn subtitles on, or change how they look.
 *
 * Patching onto DEFAULTS rather than onto `{}` means the first call authors a
 * complete, renderable block: `set_subtitles {style: 'pop'}` on a project that
 * has never had subtitles must not produce a track with no font and no size.
 */
export function setSubtitles(doc, patch) {
  return { ...doc, subtitles: { ...DEFAULTS.subtitles, ...doc.subtitles, ...patch } };
}

/**
 * Replace the transcript wholesale.
 *
 * There is no merge case: words come from one recogniser run over one file, and
 * splicing two runs together would interleave two different clocks. `source`
 * records which file they describe, so a later audio swap is detectable.
 */
export function setSubtitleWords(doc, words, { source } = {}) {
  if (!Array.isArray(words)) throw new EditError('subtitle words must be an array');
  return {
    ...doc,
    subtitles: {
      ...DEFAULTS.subtitles, ...doc.subtitles, words, ...(source ? { source } : {}),
    },
  };
}

/** Drop the track entirely -- the key goes away, rather than emptying in place. */
export function removeSubtitles(doc) {
  const { subtitles, ...rest } = doc;
  return rest;
}

// ── tracks ────────────────────────────────────────────────────────────
// All of these are layout, never structural: a clip's compiled geometry does
// not depend on which lane it is drawn in.

export function addTrack(doc, kind) {
  const n = doc.tracks.filter((t) => t.kind === kind).length + 1;
  return {
    ...doc,
    tracks: [...doc.tracks, {
      id: uniqueId(kind === 'audio' ? 'a' : 'v', new Set(doc.tracks.map((t) => t.id))),
      name: `${kind === 'audio' ? 'Audio' : 'Video'} ${n}`,
      kind,
    }],
  };
}

export function renameTrack(doc, id, name) {
  return { ...doc, tracks: doc.tracks.map((t) => (t.id === id ? { ...t, name } : t)) };
}

/**
 * Drop a track. Its contents move to the first other track of the same kind
 * rather than vanishing -- deleting a lane should never delete artwork, and
 * the validator rejects a clip whose trackId no longer resolves.
 */
export function removeTrack(doc, id) {
  const track = doc.tracks.find((t) => t.id === id);
  if (!track) throw new EditError(`no such track ${JSON.stringify(id)}`);
  const fallback = doc.tracks.find((t) => t.kind === track.kind && t.id !== id);
  // Never leave a kind with no lane at all: every trackId has to stay resolvable.
  if (!fallback) {
    throw new EditError(
      `track ${JSON.stringify(id)} is the only ${track.kind} lane; a document needs one of each`);
  }
  const move = (x) => (x.trackId === id ? { ...x, trackId: fallback.id } : x);
  return {
    ...doc,
    tracks: doc.tracks.filter((t) => t.id !== id),
    clips: doc.clips.map(move),
    audio: doc.audio.map(move),
  };
}

// ── pages ─────────────────────────────────────────────────────────────
// Also layout-class: a page decides when a clip is on screen, never what its
// geometry is, so none of these re-prepare.

/**
 * Go to another page, creating a fresh one when `pageId` is null.
 *
 * This one action covers both halves of the feature: "add a page and
 * transition to it" is `pageId: null`, and "go back to the page I filled in
 * earlier" is the id of a page that already exists.
 *
 * `t` is a floor, not a position. A break dropped into the middle of a
 * composition orphans every later clip still claiming the outgoing page --
 * they would be drawing on a sheet that has left the screen, which the
 * validator rejects outright. So the break lands at `t` or after everything
 * already authored, whichever is later. A button must not be able to produce a
 * document the app then refuses to render; moving the marker somewhere awkward
 * is a deliberate act, and the timeline still allows it.
 */
export function addPageBreak(doc, { t = 0, pageId = null, transition = 'swipeLeft', duration = 0.6 } = {}) {
  let pages = doc.pages;
  let target = pageId;
  if (target) {
    if (!doc.pages.some((p) => p.id === target)) {
      throw new EditError(`no such page ${JSON.stringify(target)}`);
    }
  } else {
    target = uniqueId('page', new Set(doc.pages.map((p) => p.id)));
    pages = [...doc.pages, {
      id: target,
      name: `Page ${doc.pages.length + 1}`,
      cameraKeyframes: [{ t: 0, x: 0, y: 0, zoom: 1 }],
    }];
  }
  // Snapped for tidiness, but never earlier than the last stroke: a break that
  // lands a float's width before the ink it follows leaves that clip drawing
  // into its own transition, which the validator rejects.
  const end = authoredEnd(doc);
  const at = Math.max(round1(Math.max(0, t, end)), end);
  return {
    ...doc,
    pages,
    // Kept sorted so the timeline can render segments by walking the list
    // and the validator's overlap check reads in document order.
    pageBreaks: [...doc.pageBreaks, {
      t: at,
      pageId: target,
      transition,
      duration: transition === 'cut' ? 0 : duration,
    }].sort((a, b) => a.t - b.t),
  };
}

export function patchPageBreak(doc, index, patch) {
  return {
    ...doc,
    pageBreaks: doc.pageBreaks.map((b, i) => {
      if (i !== index) return b;
      const next = { ...b, ...patch };
      // A cut is instantaneous by definition; the validator forces this too,
      // but doing it here keeps the inspector honest as you type.
      if (next.transition === 'cut') next.duration = 0;
      else if (!next.duration) next.duration = 0.6;
      return next;
    }),
  };
}

export function removePageBreak(doc, index) {
  return { ...doc, pageBreaks: doc.pageBreaks.filter((_, i) => i !== index) };
}

export function renamePage(doc, id, name) {
  return { ...doc, pages: doc.pages.map((p) => (p.id === id ? { ...p, name } : p)) };
}

/** Only when nothing references it -- a page with clips is not disposable. */
export function removePage(doc, id) {
  if (!doc.pages.some((p) => p.id === id)) {
    throw new EditError(`no such page ${JSON.stringify(id)}`);
  }
  if (doc.pages.length < 2) {
    throw new EditError('a document needs at least one page');
  }
  const clips = doc.clips.filter((c) => c.pageId === id).length;
  if (clips) {
    throw new EditError(
      `page ${JSON.stringify(id)} still has ${clips} clip${clips > 1 ? 's' : ''} on it`);
  }
  if (doc.pageBreaks.some((b) => b.pageId === id)) {
    throw new EditError(`page ${JSON.stringify(id)} is still the target of a page break`);
  }
  return { ...doc, pages: doc.pages.filter((p) => p.id !== id) };
}

// ── camera ────────────────────────────────────────────────────────────
// Also layout-class. A camera move changes what the frame shows, never what any
// drawable's compiled geometry is, so none of these re-prepare -- which is what
// lets a pan drag repaint the stage continuously.

/**
 * Two keyframes closer than this are the same moment. One frame at 30fps is
 * 0.033s, so this is under half a frame -- close enough that no move authored
 * through the UI can be swallowed, wide enough that float noise in a playhead
 * time cannot produce two keyframes at what the user sees as one instant.
 */
export const CAMERA_EPS = 0.02;

/** How long a camera move takes when the editor picks the timing. */
export const CAMERA_MOVE_SECONDS = 1.0;

/**
 * Frame page `pageId` as `cam` at time `t`.
 *
 * The move *arrives* at `t` rather than departing from it, which is the whole
 * point: the user parks the playhead where a clip starts drawing, frames the
 * detail they want written, and the camera is already settled when the pen
 * lands. To get that, a *hold* keyframe is planted `moveDuration` earlier
 * carrying whatever the framing was at that instant -- without it, a new
 * keyframe would drag the camera all the way from the previous one, so
 * framing a shot at 20s would have the camera creeping for the whole video.
 *
 * Idempotent by construction, which is what makes it safe to call on every
 * pointermove of a drag: once a keyframe exists at `t` the first branch
 * replaces it in place and no second hold is ever planted.
 */
export function withCameraAt(doc, pageId, t, cam, { moveDuration = CAMERA_MOVE_SECONDS } = {}) {
  const at = round3(Math.max(0, t));
  const value = { x: Math.round(cam.x), y: Math.round(cam.y), zoom: round3(cam.zoom) };

  const pages = doc.pages.map((p) => {
    if (p.id !== pageId) return p;
    // A timeline drag leaves the list unsorted on purpose (see
    // patchCameraKeyframe), so sort before reasoning about neighbours.
    const kfs = [...(p.cameraKeyframes || [])].sort((a, b) => a.t - b.t);

    const hit = kfs.findIndex((k) => Math.abs(k.t - at) < CAMERA_EPS);
    if (hit >= 0) {
      kfs[hit] = { ...kfs[hit], ...value };
      return { ...p, cameraKeyframes: kfs };
    }

    const prev = [...kfs].reverse().find((k) => k.t < at - CAMERA_EPS);
    if (prev && moveDuration > 0) {
      const holdT = round3(Math.max(prev.t + CAMERA_EPS, at - moveDuration));
      // Skip when the gap is too small to hold anything: prev is then already
      // acting as the hold, and a second keyframe on top of it buys nothing.
      // The upper bound matters too -- a hold at `at` itself would be a
      // duplicate of the keyframe pushed below, at the same instant.
      if (holdT > prev.t + CAMERA_EPS && holdT < at - CAMERA_EPS) {
        // Spread field by field, not `...cameraAt(...)`: past the last
        // keyframe cameraAt hands back that keyframe itself, `t` and all, and
        // spreading it would silently move the hold to the wrong time.
        const held = cameraAt({ cameraKeyframes: kfs }, holdT);
        kfs.push({ t: holdT, x: held.x, y: held.y, zoom: held.zoom });
      }
    }
    kfs.push({ t: at, ...value });
    return { ...p, cameraKeyframes: kfs.sort((a, b) => a.t - b.t) };
  });

  return { ...doc, pages };
}

/** Snapshot the framing already in effect at `t` as a keyframe of its own. */
export function addCameraKeyframe(doc, pageId, t) {
  const page = doc.pages.find((p) => p.id === pageId);
  if (!page) throw new EditError(`no such page ${JSON.stringify(pageId)}`);
  return withCameraAt(doc, pageId, t, cameraAt(page, t), { moveDuration: 0 });
}

/**
 * Patch one keyframe by index.
 *
 * Deliberately does *not* re-sort, exactly as patchPageBreak does not: a
 * timeline drag holds an index, and re-sorting under it mid-gesture would
 * hand the drag a different keyframe the moment one passed another.
 * normalizeProject sorts on the way to the renderer, so the document still
 * renders correctly while it is momentarily out of order.
 */
export function patchCameraKeyframe(doc, pageId, index, patch) {
  return {
    ...doc,
    pages: doc.pages.map((p) => (p.id === pageId
      ? {
        ...p,
        cameraKeyframes: p.cameraKeyframes.map((k, i) => (i === index ? { ...k, ...patch } : k)),
      }
      : p)),
  };
}

/**
 * Drop a keyframe. Unguarded even for the last one: normalizeProject fills an
 * empty list back in with the identity camera, so "remove every keyframe" means
 * "no camera moves", which is a reasonable thing to ask for and not a broken
 * document.
 */
export function removeCameraKeyframe(doc, pageId, index) {
  return {
    ...doc,
    pages: doc.pages.map((p) => (p.id === pageId
      ? { ...p, cameraKeyframes: p.cameraKeyframes.filter((_, i) => i !== index) }
      : p)),
  };
}

// ── placement ─────────────────────────────────────────────────────────

/**
 * Where to put a newly added drawable so it lands in the middle of what the
 * viewer can actually see.
 *
 * A clip's origin is its bounding-box corner, not its centre, and world (0,0)
 * is the middle of the frame only while the camera sits at the identity. Adding
 * an asset at (0,0) after zooming in therefore drops it somewhere off screen --
 * which is exactly what it looked like.
 *
 * By default the scale only ever shrinks. An asset larger than the viewport is
 * as hard to find as one outside it, but enlarging a small one would be an edit
 * nobody asked for -- a person who wants it bigger drags a handle.
 *
 * `grow` lifts that cap, and exists for one case: **vector artwork has no
 * natural size**. An SVG's viewBox units are arbitrary -- `0 0 240 140` and
 * `0 0 2400 1400` describe the same picture -- so treating them as pixels
 * leaves a perfectly good drawing the size of a postage stamp in the corner of
 * the frame. A raster has real pixels and text has an authored fontSize, so
 * neither should be blown up; a traced photograph enlarged past its resolution
 * is just blurry.
 *
 * Lives here rather than in the UI because it is not a UI concern: any host
 * that places a clip without a cursor needs it, and a headless one needs it
 * most -- there is no drag to fix a bad initial placement.
 *
 * @param {number[]} bbox local-space [x0, y0, x1, y1] from the compiled plan
 * @param {{x:number, y:number, zoom:number}} cam framing to centre within
 * @param {{width:number, height:number}} meta composition size
 * @param {number} fill fraction of the visible frame the artwork may fill
 * @param {boolean} [grow=false] allow scaling up as well as down
 * @returns {{x:number, y:number, scale:number}}
 */
export function placeInFrame(bbox, cam, meta, fill = 0.8, grow = false) {
  const w = Math.abs(bbox[2] - bbox[0]);
  const h = Math.abs(bbox[3] - bbox[1]);
  // Zoomed in, less of the page is on screen: the visible extent in world units
  // is the composition size divided by the zoom.
  const scale = Math.min(grow ? Infinity : 1,
    ((meta.width / cam.zoom) * fill) / Math.max(1, w),
    ((meta.height / cam.zoom) * fill) / Math.max(1, h));
  return {
    x: Math.round(cam.x - ((bbox[0] + bbox[2]) / 2) * scale),
    y: Math.round(cam.y - ((bbox[1] + bbox[3]) / 2) * scale),
    scale: Math.round(scale * 1000) / 1000,
  };
}

/** A clip's bbox in world space: its local bbox under its own transform. */
export function worldRect(bbox, transform) {
  const s = transform.scale ?? 1;
  const x = transform.x ?? 0;
  const y = transform.y ?? 0;
  return {
    x: x + bbox[0] * s,
    y: y + bbox[1] * s,
    width: Math.abs(bbox[2] - bbox[0]) * s,
    height: Math.abs(bbox[3] - bbox[1]) * s,
  };
}
