/**
 * Transcription, as a background job.
 *
 * The same reason exports are one: `small.en` over ten minutes of narration is
 * well over a minute of CPU, and an MCP client will not hold a tool call open
 * that long. `transcribe_audio` starts the work and returns a handle;
 * `transcribe_status` reports on it.
 *
 * The job commits its own result. A transcript that finished but was never
 * written to the document would be a minute of work thrown away because nobody
 * polled at the right moment, so the commit happens here rather than in
 * whichever status call happens to observe the job finishing.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import * as edits from '../src/engine/model/edits.js';
import { transcribe } from '../src/engine/transcribe/whisper.js';
import { EXPORT_DIR, ensureWorkspace } from './workspace.js';

export class Transcriptions {
  constructor(studio) {
    this.studio = studio;
    this.jobs = new Map();
    this.seq = 0;
  }

  get(id) { return this.jobs.get(id); }

  list() {
    return [...this.jobs.values()].map(({ id, name, state, progress, words, error }) =>
      ({ id, name, state, progress, words, error }));
  }

  /**
   * @param {Object} o
   * @param {string} o.name project to commit the transcript to
   * @param {string} o.file readable path to the narration
   * @param {string} [o.model] a faster-whisper model id
   */
  start({ name, file, model }) {
    ensureWorkspace();
    const id = `transcribe${++this.seq}`;
    const job = { id, name, file, state: 'running', progress: 0, words: 0, out: null,
                  error: null, startedAt: Date.now(), finishedAt: null };
    this.jobs.set(id, job);

    // Deliberately not awaited: the tool call returns the handle immediately.
    transcribe(file, {
      model,
      onProgress: (p) => { job.progress = p; },
    }).then((words) => {
      this.studio.commit(name, (d) => edits.setSubtitleWords(d, words, { source: file }));
      // Kept alongside the exports because it is a generated artefact of the
      // same kind, and that directory is already git-ignored.
      job.out = join(EXPORT_DIR, `${name}.words.json`);
      writeFileSync(job.out, `${JSON.stringify(words, null, 2)}\n`);
      job.words = words.length;
      job.progress = 1;
      job.state = 'done';
      job.finishedAt = Date.now();
    }).catch((e) => {
      job.state = 'failed';
      job.error = `${e.message}`.slice(0, 2000);
      job.finishedAt = Date.now();
    });

    return { id, file, model: model || 'small.en' };
  }
}
