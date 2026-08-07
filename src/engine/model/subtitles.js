/**
 * Word timings -> cues: the one place the transcript becomes readable lines.
 *
 * A recogniser hands back words, not subtitles. Something has to decide where
 * one on-screen line ends and the next begins, and that decision has to be made
 * identically by the renderer, the SRT writer and the editor's preview -- three
 * callers that must never disagree about how many cues there are or when they
 * start. So it lives here, pure and dependency-free, rather than inside any one
 * of them.
 *
 * The rules, in the order they are applied:
 *
 *   1. A silence longer than `gapSplit` ends a cue. This is the strongest
 *      signal: the speaker stopped, so the subtitle should too.
 *   2. Sentence-ending punctuation ends a cue. Whisper keeps punctuation
 *      attached to the word ("this," / "guy."), so this is a suffix test.
 *   3. `maxWords` and `maxChars` end a cue, because an unbroken sentence can
 *      run past what fits on screen.
 *
 * Within a cue, `maxChars` also inserts line breaks -- `outlineText` splits on
 * "\n" and does no wrapping of its own, so a cue that is not pre-wrapped is a
 * cue that runs off the frame.
 */

/** Ends a thought. Excludes "," and ";" on purpose: those are pauses, not ends. */
const SENTENCE_END = /[.!?…]["')\]]*$/;

/**
 * Lines a single cue may wrap to.
 *
 * Two is the ceiling every subtitle convention lands on, and it is a viewing
 * constraint rather than a layout one: a third line is more than a viewer can
 * read before it changes, and it starts eating the frame the drawing is in.
 */
const MAX_LINES = 2;

/**
 * Group `words` into cues.
 *
 * @param {Object} subtitles a normalised `project.subtitles`
 * @returns {{text:string, start:number, end:number, lines:string[],
 *            words:{w:string, start:number, end:number, line:number,
 *                   from:number, to:number}[]}[]}
 *   `from`/`to` are character offsets into `text` (newlines included), which is
 *   what lets a caller map a word onto the glyphs that were laid out for it.
 */
export function buildCues(subtitles) {
  const words = subtitles?.words || [];
  if (!words.length) return [];

  const maxWords = subtitles.maxWords ?? 7;
  const maxChars = subtitles.maxChars ?? 42;
  const gapSplit = subtitles.gapSplit ?? 0.6;

  const cues = [];
  let group = [];

  const flush = () => {
    if (group.length) cues.push(layOut(group, maxChars));
    group = [];
  };

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const prev = words[i - 1];

    // A silence between this word and the last one breaks the cue *before* the
    // word, so the new cue starts when the speaker starts again.
    if (prev && word.start - prev.end > gapSplit) flush();

    // Adding this word would overrun the line budget. Measured against the
    // joined text, not the sum of word lengths, so the spaces are counted.
    if (group.length) {
      const wouldBe = group.reduce((n, w) => n + w.w.length + 1, 0) + word.w.length;
      if (group.length >= maxWords || wouldBe > maxChars * MAX_LINES) flush();
    }

    group.push(word);

    if (SENTENCE_END.test(word.w)) flush();
  }
  flush();

  return cues;
}

/**
 * Wrap one group of words into lines and record where each word landed.
 *
 * Greedy: a word goes on the current line if it fits, otherwise it starts the
 * next one. A word longer than `maxChars` on its own still gets its own line
 * rather than being split -- breaking mid-word is worse than overrunning.
 */
function layOut(group, maxChars) {
  const placed = [];
  const lines = [];
  let line = '';
  let lineIndex = 0;
  // Offset of the start of the current line within the finished `text`.
  let lineOrigin = 0;

  for (const word of group) {
    if (line && line.length + 1 + word.w.length > maxChars) {
      lines.push(line);
      lineOrigin += line.length + 1;          // +1 for the "\n" that joins them
      line = '';
      lineIndex++;
    }
    const from = lineOrigin + (line ? line.length + 1 : 0);
    line = line ? `${line} ${word.w}` : word.w;
    placed.push({
      w: word.w, start: word.start, end: word.end,
      line: lineIndex, from, to: from + word.w.length,
    });
  }
  lines.push(line);

  return {
    text: lines.join('\n'),
    lines,
    start: group[0].start,
    // Not `group[group.length - 1].end`: a recogniser can hand back a word whose
    // end precedes an earlier word's.
    end: group.reduce((t, w) => Math.max(t, w.end), 0),
    words: placed,
  };
}

/**
 * The cue on screen at `t`, or null.
 *
 * `holdTail` keeps the last cue up for a moment after the speaker finishes,
 * which is what stops a line vanishing on the final consonant. It applies to
 * every cue, but only reaches the screen when the next cue is further away than
 * the tail -- otherwise the next cue simply replaces this one.
 */
export function cueAt(cues, t, holdTail = 0) {
  let lo = 0;
  let hi = cues.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (found < 0) return null;
  const cue = cues[found];
  const next = cues[found + 1];
  const until = next ? Math.min(cue.end + holdTail, next.start) : cue.end + holdTail;
  return t <= until ? cue : null;
}
