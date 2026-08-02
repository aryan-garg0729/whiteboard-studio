/**
 * Editor state: the project document plus undo/redo.
 *
 * The document is plain JSON and is the single source of truth for
 * renderFrame(), so every editing action is a pure document transform. That is
 * what makes undo a one-liner and keeps the UI from accumulating a second,
 * divergent model of the scene.
 *
 * Edits are tagged `structural` when they change geometry -- new assets, new
 * text, a different font. Those need a main-process round trip to re-trace or
 * re-skeletonise. Timing and placement edits are pure renderFrame inputs and
 * repaint immediately, which is why dragging a clip on the timeline is smooth.
 */

import { useCallback, useMemo, useReducer } from 'react';

import { pageAt } from '../../engine/model/project.js';
import { cameraAt } from '../../engine/render/renderFrame.js';

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

const HISTORY_LIMIT = 100;

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

const clone = (o) => JSON.parse(JSON.stringify(o));

// ── document transforms ───────────────────────────────────────────────
// Exported as plain functions rather than closures inside the hook so they can
// be exercised without a renderer.

/** When a clip is finally off the page: after its wipe, or after its last stroke. */
export const clipEnd = (c) =>
  (c.erase ? Math.max(c.erase.start + c.erase.duration, c.start + c.duration)
           : c.start + c.duration);

const audioEnd = (a) => (a.start || 0) + (a.duration || 0);

/** Half-open overlap; two clips that merely touch at an edge may share a lane. */
const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd;

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
 */
export function afterTransition(doc, t) {
  for (const b of doc.pageBreaks || []) {
    if (t > b.t && t < b.t + b.duration) return b.t + b.duration;
  }
  return t;
}

/**
 * Append an asset plus a clip for it, starting after everything else ends.
 *
 * `clipId` may be supplied by the caller. That is not a convenience: the
 * editor cannot know a drawable's size until the sidecar has traced it, so
 * placing a clip in the centre of frame takes two steps, and the caller needs
 * a handle on the clip to finish the job when the geometry arrives. Picking
 * the id up front is the only way to get one out of a dispatch-based action.
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
  const start = Math.round(afterTransition(doc, raw) * 10) / 10;
  const { trackId, tracks } = packTrack(doc, 'clip', start, start + duration);
  return {
    ...doc,
    tracks,
    assets: { ...doc.assets, [assetId]: { ...asset, id: assetId } },
    clips: [...doc.clips, {
      id: clipId,
      assetId,
      animId: animId || (asset.kind === 'text' ? 'draw.handwrite' : 'draw.imageReveal'),
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

// ── camera ────────────────────────────────────────────────────────────

/**
 * Two keyframes closer than this are the same moment. One frame at 30fps is
 * 0.033s, so this is under half a frame -- close enough that no move authored
 * through the UI can be swallowed, wide enough that float noise in a playhead
 * time cannot produce two keyframes at what the user sees as one instant.
 */
export const CAMERA_EPS = 0.02;

/** How long a camera move takes when the editor picks the timing. */
export const CAMERA_MOVE_SECONDS = 1.0;

/** Times are seconds in a JSON document; float noise there reads as a bug. */
const round3 = (t) => Math.round(t * 1000) / 1000;

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

/** True when a clip patch changes geometry and needs a main-process rebuild. */
export const isStructural = (patch) =>
  Object.keys(patch).some((k) => !TIMING_FIELDS.has(k));

export function reducer(state, action) {
  switch (action.type) {
    case 'load': {
      const structuralRev = state.structuralRev + 1;
      return {
        doc: action.doc,
        path: action.path ?? null,
        past: [],
        future: [],
        tag: null,
        rev: state.rev + 1,
        structuralRev,
        // Opening a project already returns prepared geometry, so re-preparing
        // it would repeat every trace and skeletonisation for nothing -- and
        // the progress overlay it puts up hides the stage while it does.
        preparedRev: action.prepared ? structuralRev : state.preparedRev,
        dirty: false,
      };
    }

    // Rebuild finished. Guarded by the revision it was started at: if the
    // document moved on while the sidecar was working, it stays dirty.
    case 'prepared':
      return { ...state, preparedRev: Math.max(state.preparedRev, action.rev) };

    case 'edit': {
      const doc = action.fn(state.doc);
      if (doc === state.doc) return state;
      // A timeline drag emits an edit per pointermove. Coalescing by tag keeps
      // the preview live while collapsing the whole gesture into one undo step.
      //
      // `replace` is the same idea for a follow-up the user never asked for:
      // it amends the document in place without a history entry. Placing a clip
      // uses it -- the centring pass runs once the traced geometry arrives, and
      // without this an undo would leave the clip on the page and merely move
      // it, which reads as a bug rather than as an undo.
      const merge = action.replace || (action.coalesce && action.coalesce === state.tag);
      return {
        ...state,
        doc,
        past: merge ? state.past : [...state.past, state.doc].slice(-HISTORY_LIMIT),
        future: [],
        // A replace is an amendment, not a gesture, and may land while one is
        // running -- clearing the tag would break the coalescing of whatever
        // drag is in flight.
        tag: action.replace ? state.tag : (action.coalesce || null),
        rev: state.rev + 1,
        structuralRev: state.structuralRev + (action.structural ? 1 : 0),
        dirty: true,
      };
    }

    case 'endGesture':
      return state.tag ? { ...state, tag: null } : state;

    case 'undo': {
      if (!state.past.length) return state;
      const doc = state.past[state.past.length - 1];
      return {
        ...state,
        doc,
        past: state.past.slice(0, -1),
        future: [state.doc, ...state.future],
        rev: state.rev + 1,
        // We cannot know whether the undone edit was structural, and a stale
        // prepared payload renders the wrong artwork. Re-preparing is cheap
        // (the sidecar caches by content hash) and always correct.
        structuralRev: state.structuralRev + 1,
        dirty: true,
      };
    }

    case 'redo': {
      if (!state.future.length) return state;
      return {
        ...state,
        doc: state.future[0],
        past: [...state.past, state.doc],
        future: state.future.slice(1),
        rev: state.rev + 1,
        structuralRev: state.structuralRev + 1,
        dirty: true,
      };
    }

    case 'saved':
      return { ...state, path: action.path, dirty: false };

    default:
      return state;
  }
}

export function useEditor() {
  const [state, dispatch] = useReducer(reducer, {
    doc: EMPTY_PROJECT,
    path: null,
    past: [],
    future: [],
    tag: null,
    rev: 0,
    structuralRev: 0,
    preparedRev: 0,
    dirty: false,
  });

  const edit = useCallback((fn, { structural = false, coalesce = null, replace = false } = {}) => {
    dispatch({ type: 'edit', fn, structural, coalesce, replace });
  }, []);

  const actions = useMemo(() => ({
    edit,
    endGesture: () => dispatch({ type: 'endGesture' }),
    load: (doc, path, prepared = false) => dispatch({ type: 'load', doc, path, prepared }),
    markPrepared: (rev) => dispatch({ type: 'prepared', rev }),
    undo: () => dispatch({ type: 'undo' }),
    redo: () => dispatch({ type: 'redo' }),
    markSaved: (path) => dispatch({ type: 'saved', path }),

    /** Patch one clip. Structural unless every touched field is timing-only. */
    patchClip(id, patch, opts = {}) {
      edit((doc) => ({
        ...doc,
        clips: doc.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)),
      }), { structural: isStructural(patch), ...opts });
    },

    patchTransform(id, patch, opts = {}) {
      edit((doc) => ({
        ...doc,
        clips: doc.clips.map((c) => (c.id === id
          ? { ...c, transform: { ...c.transform, ...patch } }
          : c)),
      }), opts);
    },

    patchAsset(id, patch) {
      edit((doc) => ({
        ...doc,
        assets: { ...doc.assets, [id]: { ...doc.assets[id], ...patch } },
      }), { structural: true });
    },

    patchMeta(patch) {
      // A different hand style needs its sprites loaded, so it is structural;
      // background and fps are not, but meta edits are rare enough that
      // splitting them would buy nothing.
      edit((doc) => ({ ...doc, meta: { ...doc.meta, ...patch } }),
        { structural: 'handStyleId' in patch });
    },

    addClip(asset, opts) {
      edit((doc) => addClipTo(doc, asset, opts), { structural: true });
    },

    removeClip(id) {
      edit((doc) => removeClipFrom(doc, id), { structural: true });
    },

    addAudio(track) {
      edit((doc) => {
        const start = track.start || 0;
        const { trackId, tracks } = packTrack(doc, 'audio', start, start + (track.duration || 0));
        return { ...doc, tracks, audio: [...doc.audio, { ...track, trackId }] };
      });
    },

    patchAudio(index, patch, opts = {}) {
      edit((doc) => ({
        ...doc,
        audio: doc.audio.map((a, i) => (i === index ? { ...a, ...patch } : a)),
      }), opts);
    },

    removeAudio(index) {
      edit((doc) => ({ ...doc, audio: doc.audio.filter((_, i) => i !== index) }));
    },

    // ── tracks ────────────────────────────────────────────────────────
    // All of these are layout, never structural: a clip's compiled geometry does
    // not depend on which lane it is drawn in.

    addTrack(kind) {
      edit((doc) => {
        const n = doc.tracks.filter((t) => t.kind === kind).length + 1;
        return {
          ...doc,
          tracks: [...doc.tracks, {
            id: uniqueId(kind === 'audio' ? 'a' : 'v', new Set(doc.tracks.map((t) => t.id))),
            name: `${kind === 'audio' ? 'Audio' : 'Video'} ${n}`,
            kind,
          }],
        };
      });
    },

    renameTrack(id, name) {
      edit((doc) => ({
        ...doc,
        tracks: doc.tracks.map((t) => (t.id === id ? { ...t, name } : t)),
      }));
    },

    /**
     * Drop a track. Its contents move to the first other track of the same kind
     * rather than vanishing -- deleting a lane should never delete artwork, and
     * the validator rejects a clip whose trackId no longer resolves.
     */
    // ── pages ─────────────────────────────────────────────────────────
    // Also layout-class: a page decides when a clip is on screen, never what
    // its geometry is, so none of these re-prepare.

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
     * already authored, whichever is later. A button must not be able to
     * produce a document the app then refuses to render; moving the marker
     * somewhere awkward is a deliberate act, and the timeline still allows it.
     */
    addPageBreak({ t = 0, pageId = null, transition = 'swipeLeft', duration = 0.6 }) {
      edit((doc) => {
        let pages = doc.pages;
        let target = pageId;
        if (!target) {
          target = uniqueId('page', new Set(doc.pages.map((p) => p.id)));
          pages = [...doc.pages, {
            id: target,
            name: `Page ${doc.pages.length + 1}`,
            cameraKeyframes: [{ t: 0, x: 0, y: 0, zoom: 1 }],
          }];
        }
        const authored = Math.max(
          doc.clips.reduce((end, c) => Math.max(end, clipEnd(c)), 0),
          doc.pageBreaks.reduce((end, b) => Math.max(end, b.t + b.duration), 0),
        );
        const at = Math.round(Math.max(0, t, authored) * 10) / 10;
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
      });
    },

    patchPageBreak(index, patch, opts = {}) {
      edit((doc) => ({
        ...doc,
        pageBreaks: doc.pageBreaks.map((b, i) => {
          if (i !== index) return b;
          const next = { ...b, ...patch };
          // A cut is instantaneous by definition; the validator forces this
          // too, but doing it here keeps the inspector honest as you type.
          if (next.transition === 'cut') next.duration = 0;
          else if (!next.duration) next.duration = 0.6;
          return next;
        }),
      }), opts);
    },

    removePageBreak(index) {
      edit((doc) => ({
        ...doc,
        pageBreaks: doc.pageBreaks.filter((_, i) => i !== index),
      }));
    },

    // ── camera ────────────────────────────────────────────────────────
    // Also layout-class. A camera move changes what the frame shows, never
    // what any drawable's compiled geometry is, so none of these re-prepare --
    // which is what lets a pan drag repaint the stage continuously.

    /** Frame `pageId` as `cam` at `t`. See withCameraAt for the hold rule. */
    setCameraAt(pageId, t, cam, opts = {}) {
      const { moveDuration, ...editOpts } = opts;
      edit((doc) => withCameraAt(doc, pageId, t, cam, { moveDuration }), editOpts);
    },

    /** Snapshot the framing already in effect at `t` as a keyframe of its own. */
    addCameraKeyframe(pageId, t) {
      edit((doc) => {
        const page = doc.pages.find((p) => p.id === pageId);
        if (!page) return doc;
        return withCameraAt(doc, pageId, t, cameraAt(page, t), { moveDuration: 0 });
      });
    },

    /**
     * Patch one keyframe by index.
     *
     * Deliberately does *not* re-sort, exactly as patchPageBreak does not: a
     * timeline drag holds an index, and re-sorting under it mid-gesture would
     * hand the drag a different keyframe the moment one passed another.
     * normalizeProject sorts on the way to the renderer, so the document still
     * renders correctly while it is momentarily out of order.
     */
    patchCameraKeyframe(pageId, index, patch, opts = {}) {
      edit((doc) => ({
        ...doc,
        pages: doc.pages.map((p) => (p.id === pageId
          ? {
            ...p,
            cameraKeyframes: p.cameraKeyframes.map((k, i) => (i === index ? { ...k, ...patch } : k)),
          }
          : p)),
      }), opts);
    },

    /**
     * Drop a keyframe. Unguarded even for the last one: normalizeProject fills
     * an empty list back in with the identity camera, so "remove every
     * keyframe" means "no camera moves", which is a reasonable thing to ask
     * for and not a broken document.
     */
    removeCameraKeyframe(pageId, index) {
      edit((doc) => ({
        ...doc,
        pages: doc.pages.map((p) => (p.id === pageId
          ? { ...p, cameraKeyframes: p.cameraKeyframes.filter((_, i) => i !== index) }
          : p)),
      }));
    },

    renamePage(id, name) {
      edit((doc) => ({
        ...doc,
        pages: doc.pages.map((p) => (p.id === id ? { ...p, name } : p)),
      }));
    },

    /** Only when nothing references it -- a page with clips is not disposable. */
    removePage(id) {
      edit((doc) => {
        if (doc.pages.length < 2) return doc;
        if (doc.clips.some((c) => c.pageId === id)) return doc;
        if (doc.pageBreaks.some((b) => b.pageId === id)) return doc;
        return { ...doc, pages: doc.pages.filter((p) => p.id !== id) };
      });
    },

    removeTrack(id) {
      edit((doc) => {
        const kind = doc.tracks.find((t) => t.id === id)?.kind;
        const fallback = doc.tracks.find((t) => t.kind === kind && t.id !== id);
        if (!fallback) return doc;        // never leave a kind with no lane at all
        const move = (x) => (x.trackId === id ? { ...x, trackId: fallback.id } : x);
        return {
          ...doc,
          tracks: doc.tracks.filter((t) => t.id !== id),
          clips: doc.clips.map(move),
          audio: doc.audio.map(move),
        };
      });
    },
  }), [edit]);

  return {
    ...state,
    ...actions,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    needsPrepare: state.structuralRev !== state.preparedRev,
    snapshot: () => clone(state.doc),
  };
}
