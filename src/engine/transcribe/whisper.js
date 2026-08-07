/**
 * Narration -> word timings, by spawning faster-whisper.
 *
 * The same shape as `export/driver.js` spawning ffmpeg: the engine stays pure
 * JS and hands the one job it cannot do itself to a process that can. Speech
 * recognition is Python's, so this is where the two meet.
 *
 * Node-only, on purpose. The Electron renderer cannot spawn anything, and both
 * the MCP server and the main process can, so this is imported by the hosts
 * rather than by the engine's render path.
 */

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'transcribe.py');

/**
 * A transcription that failed for a reason the user can act on: no such file,
 * no Python, no model. Shaped like the model's errors (a `name` worth switching
 * on) so the MCP tool wrapper reports it as a tool error rather than letting it
 * escape as a protocol failure.
 */
export class TranscribeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TranscribeError';
  }
}

/**
 * Which Python to use.
 *
 * The repo's own venv first, because that is where `requirements.txt` says to
 * install and it is the case that should need no configuration at all. Then an
 * explicit override, for a shared or system-managed install. `python3` last:
 * relying on PATH alone is what turns a missing dependency into a bare ENOENT
 * from deep inside a spawn.
 */
export function pythonPath() {
  const venv = join(ROOT, '.venv', 'bin', 'python');
  if (existsSync(venv)) return venv;
  if (process.env.WHITEBOARD_PYTHON) return process.env.WHITEBOARD_PYTHON;
  return 'python3';
}

let probed;

/**
 * True when transcription can actually run here.
 *
 * Memoised: `list_capabilities` reports it on every call, and this costs an
 * interpreter start plus an import of a machine-learning library.
 */
export function hasWhisper() {
  if (probed !== undefined) return probed;
  try {
    execFileSync(pythonPath(), ['-c', 'import faster_whisper'], { stdio: 'ignore' });
    probed = true;
  } catch {
    probed = false;
  }
  return probed;
}

/**
 * Transcribe `audioPath` to word timings.
 *
 * @param {string} audioPath
 * @param {Object} [o]
 * @param {string} [o.model] a faster-whisper model id
 * @param {(p:number) => void} [o.onProgress] 0..1, as the audio is drained
 * @returns {Promise<{w:string, start:number, end:number}[]>}
 */
export function transcribe(audioPath, { model = 'small.en', onProgress } = {}) {
  if (!existsSync(audioPath)) {
    return Promise.reject(new TranscribeError(`no such audio file: ${audioPath}`));
  }
  // Via a file rather than stdout so a model that decides to print something is
  // not able to corrupt the payload.
  const out = join(tmpdir(), `whiteboard-words-${process.pid}-${Date.now()}.json`);

  return new Promise((resolve, reject) => {
    const child = spawn(pythonPath(), [
      SCRIPT, '--audio', audioPath, '--out', out, '--model', model,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    // The last error the script reported, which is a far better message than
    // "exited with code 2".
    let reported = null;
    // Progress arrives as one JSON object per line, but a chunk boundary can
    // land mid-line, so the tail is held over until the rest of it turns up.
    let tail = '';

    child.stderr.on('data', (chunk) => {
      const lines = (tail + chunk).split('\n');
      tail = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.error) reported = msg.error;
        if (typeof msg.progress === 'number') onProgress?.(msg.progress);
      }
    });

    child.on('error', (err) => reject(new TranscribeError(
      `could not run ${pythonPath()} (${err.message}). `
      + 'Install faster-whisper: python3 -m venv .venv && '
      + '.venv/bin/pip install -r requirements.txt')));

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new TranscribeError(reported || `transcription failed (exit ${code})`));
        return;
      }
      try {
        resolve(JSON.parse(readFileSync(out, 'utf8')));
      } catch (err) {
        reject(new TranscribeError(`transcription wrote no usable output (${err.message})`));
      } finally {
        try { unlinkSync(out); } catch { /* already gone */ }
      }
    });
  });
}
