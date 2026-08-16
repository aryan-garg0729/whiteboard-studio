/**
 * What a rebuild is allowed to keep.
 *
 * Both hosts face the same problem: an edit arrives, and recompiling every clip
 * to service it costs seconds on a real project -- 13.4s for a 56-clip document,
 * which is what made adding the N-th clip cost N compiles. The answer in both is
 * to fingerprint each clip on the inputs its compile stage actually reads, and
 * redo only the clips whose fingerprint moved.
 *
 * This lives in the model, shared, rather than in either host, because the two
 * agreeing is the whole point: `src/ui/engineHost.js` decides what the main
 * process re-prepares for the editor, and `src/engine/host/nodeSession.js`
 * decides what the MCP server recompiles. A key that named one more field on one
 * side than the other would mean the app and the server disagreed about whether
 * an edit was visible, and the disagreement would show up as the editor
 * previewing something the export does not contain.
 */

import { penScale } from './transform.js';

/**
 * Everything a clip's compiled geometry depends on, as one comparable string.
 *
 * This is the whole basis for reusing work, so it has to name every input the
 * compile stages read and nothing else. Too much and a rebuild recompiles the
 * project on every keystroke; too little and it renders stale artwork, which is
 * far worse -- so when in doubt, include it.
 *
 * What is deliberately absent is the rest of `transform`. Position, rotation and
 * the sign of a mirror do not change a stroke: surfaces are object-local and the
 * bbox is measured before placement. Only the *scale* is here, and only through
 * `penScale`, because brush widths are authored in screen terms and divide it
 * out. `start`, `duration`, `pageId` and `trackId` are absent for the same
 * reason they are in `TIMING_FIELDS`: they decide when a clip is on screen, not
 * what it looks like.
 */
export function clipKey(clip, asset) {
  return JSON.stringify([
    clip.assetId,               // stencilPaint seeds its scribble off the asset id
    clip.animId,
    clip.params ?? null,
    penScale(clip.transform),
    asset.kind,
    asset.src ?? null,
    asset.text ?? null,
    asset.font ?? null,
    asset.fontSize ?? null,
    asset.penWidth ?? null,
    asset.color ?? null,
    !!asset.bold,
    asset.align ?? null,
  ]);
}

/** The key of every clip in a document, by clip id. */
export function clipKeys(project) {
  const keys = new Map();
  for (const clip of project.clips) {
    keys.set(clip.id, clipKey(clip, project.assets[clip.assetId]));
  }
  return keys;
}

/**
 * What a session captures that the live document cannot correct after the fact
 * -- i.e. everything outside the per-clip plans.
 *
 * `renderFrame` is handed the live document on every paint, so a change to meta,
 * pages, camera or the subtitle wording needs no rebuild at all. These two are
 * the exceptions, because they are baked into the session when it is built: the
 * hand sprites are decoded images held behind `resolveImage`, and the subtitle
 * face is a parsed font. Reusing a session across a change to either would leave
 * the drawing hand or the caption typeface stale.
 */
export function sessionKey(project) {
  const subs = project.subtitles;
  return JSON.stringify([
    project.meta?.handStyleId ?? null,
    subs?.enabled && subs.words?.length ? subs.font : null,
  ]);
}

/**
 * What a rebuild has to do: which clips need recompiling, and which are gone.
 *
 * A clip is stale when its key moved, and new when the previous session never
 * had one; both need the same treatment, so they come back as one list.
 * Removals are reported separately because they need no compile work at all --
 * but they are not nothing, and a caller that only checked `stale` would skip
 * the rebuild that drops a deleted clip's surfaces and its entry in `bboxes`.
 */
export function staleClips(project, previousKeys) {
  const keys = clipKeys(project);
  if (!previousKeys) return { keys, stale: [...keys.keys()], removed: [] };
  return {
    keys,
    stale: [...keys].filter(([id, k]) => previousKeys.get(id) !== k).map(([id]) => id),
    removed: [...previousKeys.keys()].filter((id) => !keys.has(id)),
  };
}
