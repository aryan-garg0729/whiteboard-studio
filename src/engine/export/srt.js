/**
 * Cues -> SubRip, written beside the exported MP4.
 *
 * The subtitles are burned into the frames, so this is not what puts them on
 * screen. It exists because burned-in text is invisible to everything that
 * reads a video rather than watches it: a platform's own captioning, a search
 * index, a viewer who needs to turn them off. Shipping the sidecar costs one
 * small file and makes the transcript usable outside the video.
 *
 * Built from the same `buildCues` output the renderer draws, so the file cannot
 * drift from what is on screen.
 */

import { buildCues } from '../model/subtitles.js';

/** SubRip wants `HH:MM:SS,mmm` -- a comma, not a point. */
function stamp(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor(ms / 60000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms % 1000, 3)}`;
}

/**
 * @param {Object} subtitles a normalised `project.subtitles`
 * @returns {string} the file's contents, empty when there is nothing to write
 */
export function toSrt(subtitles) {
  const cues = buildCues(subtitles);
  if (!cues.length) return '';
  const hold = subtitles.holdTail ?? 0;

  return cues.map((cue, i) => {
    // The same hold the renderer applies, clamped the same way, so a line does
    // not linger in the file after it has gone from the picture.
    const next = cues[i + 1];
    const end = next ? Math.min(cue.end + hold, next.start) : cue.end + hold;
    return `${i + 1}\n${stamp(cue.start)} --> ${stamp(end)}\n${cue.text}\n`;
  }).join('\n');
}
