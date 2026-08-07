/**
 * Editor state: the project document plus undo/redo.
 *
 * The document is plain JSON and is the single source of truth for
 * renderFrame(), so every editing action is a pure document transform. That is
 * what makes undo a one-liner and keeps the UI from accumulating a second,
 * divergent model of the scene.
 *
 * The transforms themselves live in `engine/model/edits.js` -- they are not a
 * UI concern, and a headless host (the MCP server, a script) needs exactly the
 * same timing rules. What is left here is the genuinely React half: the
 * reducer, history, and the structural-vs-timing bookkeeping.
 *
 * Edits are tagged `structural` when they change geometry -- new assets, new
 * text, a different font. Those need a main-process round trip to recompile.
 * Timing and placement edits are pure renderFrame inputs and repaint
 * immediately, which is why dragging a clip on the timeline is smooth.
 */

import { useCallback, useMemo, useReducer } from 'react';

import * as edits from '../../engine/model/edits.js';
import { EMPTY_PROJECT, isStructural } from '../../engine/model/edits.js';

// Re-exported so the app and the existing tests keep importing document
// transforms from here; the move to the engine is not meant to be visible.
export {
  EMPTY_PROJECT, uniqueId, packTrack,
  addClipTo, removeClipFrom, isStructural,
  CAMERA_MOVE_SECONDS, withCameraAt,
} from '../../engine/model/edits.js';

const HISTORY_LIMIT = 100;

const clone = (o) => JSON.parse(JSON.stringify(o));

/**
 * Run a transform, swallowing its refusal.
 *
 * The lifted transforms throw `EditError` when they cannot do what was asked --
 * removing the last page, the only audio lane. A headless caller needs that,
 * because a document returned unchanged is indistinguishable from success. The
 * UI does not: the control was disabled anyway, and an exception out of a click
 * handler would take the renderer down. So it becomes a no-op edit, which the
 * reducer already discards on identity.
 */
const guard = (fn) => (doc) => {
  try {
    return fn(doc);
  } catch (e) {
    if (e.name === 'EditError') return doc;
    throw e;
  }
};

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
        // it would recompile every clip for nothing -- and the progress overlay
        // it puts up hides the stage while it does.
        preparedRev: action.prepared ? structuralRev : state.preparedRev,
        dirty: false,
      };
    }

    // Rebuild finished. Guarded by the revision it was started at: if the
    // document moved on while the rebuild was running, it stays dirty.
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
      // uses it -- the centring pass runs once the measurement arrives, and
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
        // prepared payload renders the wrong artwork. Re-preparing is always
        // correct, and cheap enough not to be worth guessing about.
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
      edit((doc) => edits.patchClip(doc, id, patch), { structural: isStructural(patch), ...opts });
    },

    patchTransform(id, patch, opts = {}) {
      edit((doc) => edits.patchTransform(doc, id, patch), opts);
    },

    patchAsset(id, patch) {
      edit(guard((doc) => edits.patchAsset(doc, id, patch)), { structural: true });
    },

    patchMeta(patch) {
      // A different hand style needs its sprites loaded, so it is structural;
      // background and fps are not, but meta edits are rare enough that
      // splitting them would buy nothing.
      edit((doc) => edits.patchMeta(doc, patch), { structural: 'handStyleId' in patch });
    },

    addClip(asset, opts) {
      edit((doc) => edits.addClipTo(doc, asset, opts), { structural: true });
    },

    removeClip(id) {
      edit((doc) => edits.removeClipFrom(doc, id), { structural: true });
    },

    addAudio(track) {
      edit((doc) => edits.addAudio(doc, track));
    },

    patchAudio(index, patch, opts = {}) {
      edit((doc) => edits.patchAudio(doc, index, patch), opts);
    },

    removeAudio(index) {
      edit((doc) => edits.removeAudio(doc, index));
    },

    // ── tracks ────────────────────────────────────────────────────────
    // All of these are layout, never structural: a clip's compiled geometry does
    // not depend on which lane it is drawn in.

    addTrack(kind) {
      edit((doc) => edits.addTrack(doc, kind));
    },

    renameTrack(id, name) {
      edit((doc) => edits.renameTrack(doc, id, name));
    },

    /**
     * Drop a track. Its contents move to the first other track of the same kind
     * rather than vanishing -- deleting a lane should never delete artwork, and
     * the validator rejects a clip whose trackId no longer resolves.
     */
    removeTrack(id) {
      edit(guard((doc) => edits.removeTrack(doc, id)));
    },

    // ── pages ─────────────────────────────────────────────────────────
    // Also layout-class: a page decides when a clip is on screen, never what
    // its geometry is, so none of these re-prepare.

    /** Go to another page, creating a fresh one when `pageId` is null. */
    addPageBreak(opts) {
      edit(guard((doc) => edits.addPageBreak(doc, opts)));
    },

    patchPageBreak(index, patch, opts = {}) {
      edit((doc) => edits.patchPageBreak(doc, index, patch), opts);
    },

    removePageBreak(index) {
      edit((doc) => edits.removePageBreak(doc, index));
    },

    // ── camera ────────────────────────────────────────────────────────
    // Also layout-class. A camera move changes what the frame shows, never
    // what any drawable's compiled geometry is, so none of these re-prepare --
    // which is what lets a pan drag repaint the stage continuously.

    /** Frame `pageId` as `cam` at `t`. See withCameraAt for the hold rule. */
    setCameraAt(pageId, t, cam, opts = {}) {
      const { moveDuration, ...editOpts } = opts;
      edit((doc) => edits.withCameraAt(doc, pageId, t, cam, { moveDuration }), editOpts);
    },

    /** Snapshot the framing already in effect at `t` as a keyframe of its own. */
    addCameraKeyframe(pageId, t) {
      edit(guard((doc) => edits.addCameraKeyframe(doc, pageId, t)));
    },

    patchCameraKeyframe(pageId, index, patch, opts = {}) {
      edit((doc) => edits.patchCameraKeyframe(doc, pageId, index, patch), opts);
    },

    removeCameraKeyframe(pageId, index) {
      edit((doc) => edits.removeCameraKeyframe(doc, pageId, index));
    },

    renamePage(id, name) {
      edit((doc) => edits.renamePage(doc, id, name));
    },

    /** Only when nothing references it -- a page with clips is not disposable. */
    removePage(id) {
      edit(guard((doc) => edits.removePage(doc, id)));
    },

    /**
     * Subtitle presentation.
     *
     * Non-structural, with one exception: the renderer lays subtitles out
     * itself from the face the main process sent it, so size, colour, style and
     * wrapping all repaint locally -- but a different *face* is bytes it does
     * not have, and only a re-prepare can deliver them.
     */
    setSubtitles(patch) {
      edit(guard((doc) => edits.setSubtitles(doc, patch)),
        { structural: 'font' in patch || 'enabled' in patch });
    },

    setSubtitleWords(words, meta) {
      // Structural because the very first transcript is what makes the main
      // process start sending a font at all.
      edit(guard((doc) => edits.setSubtitleWords(doc, words, meta)), { structural: true });
    },

    removeSubtitles() {
      edit(guard((doc) => edits.removeSubtitles(doc)), { structural: true });
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
