/**
 * Node-side client for the Python CV sidecar.
 *
 * The sidecar is a long-lived process: startup costs ~0.4s of interpreter and
 * numpy/cv2 import, which is fine once and intolerable per glyph.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

/** Prefer the project venv; fall back to whatever python3 is on PATH. */
export function defaultPython(root) {
  const venv = join(root, '.venv', 'bin', 'python');
  return existsSync(venv) ? venv : 'python3';
}

export class Sidecar {
  /**
   * @param {Object} o
   * @param {string} o.root project root
   * @param {string} [o.python] interpreter path
   * @param {string} [o.cacheDir] enables on-disk memoisation of results
   */
  constructor({ root, python, cacheDir } = {}) {
    this.root = root;
    this.python = python || defaultPython(root);
    this.cacheDir = cacheDir;
    this.proc = null;
    this.seq = 0;
    this.pending = new Map();
    this.stderr = '';
  }

  start() {
    if (this.proc) return this;
    const script = join(this.root, 'src', 'sidecar', 'server.py');
    this.proc = spawn(this.python, ['-u', script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(this.cacheDir ? { WB_CACHE_DIR: this.cacheDir } : {}) },
    });

    createInterface({ input: this.proc.stdout }).on('line', (line) => {
      if (!line.trim()) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return; // not protocol traffic; ignore rather than crash
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${msg.error.type}: ${msg.error.message}`));
      else p.resolve(msg.result);
    });

    this.proc.stderr.on('data', (d) => {
      this.stderr += d;
      if (this.stderr.length > 32_000) this.stderr = this.stderr.slice(-16_000);
    });

    this.proc.on('close', (code) => {
      // Reject anything still in flight, or callers hang forever on a crash.
      for (const [, p] of this.pending) {
        p.reject(new Error(`sidecar exited (${code})\n${this.stderr.slice(-2000)}`));
      }
      this.pending.clear();
      this.proc = null;
    });

    return this;
  }

  call(method, params = {}) {
    this.start();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  ping() { return this.call('ping'); }

  skeletonizeGlyph(commands, opts = {}) {
    return this.call('skeletonizeGlyph', { commands, ...opts });
  }

  skeletonizeBatch(glyphs, opts = {}) {
    return this.call('skeletonizeBatch', { glyphs, ...opts });
  }

  stop() {
    if (this.proc) {
      this.proc.stdin.end();
      this.proc.kill();
      this.proc = null;
    }
  }
}

