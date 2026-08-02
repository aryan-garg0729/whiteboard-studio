/**
 * Frame pump: renders every frame deterministically and streams raw RGBA into
 * ffmpeg's stdin.
 *
 * Export runs entirely off the wall clock -- a slow machine produces a
 * byte-identical file to a fast one.
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { availableParallelism } from 'node:os';
import { buildFfmpegArgs, parseProgress } from './ffmpeg.js';

/**
 * @param {Object} o
 * @param {(frameIndex:number) => Uint8ClampedArray|Buffer} o.renderFrameRGBA
 *   must return top-down RGBA for the frame. Canvas getImageData is already
 *   top-down RGBA, which is what `-pix_fmt rgba` expects -- no vertical flip
 *   (that is the WebGL readPixels trap, not the 2D one).
 * @param {number} o.frames @param {number} o.width @param {number} o.height
 * @param {number} o.fps @param {string} o.out
 * @param {Array} [o.audio]
 * @param {'quality'|'fast'} [o.preset]
 * @param {string} [o.ffmpegPath='ffmpeg']
 * @param {(p:{frame:number, total:number}) => void} [o.onProgress]
 */
export async function exportVideo(o) {
  const args = buildFfmpegArgs({
    width: o.width, height: o.height, fps: o.fps, out: o.out,
    audio: o.audio, preset: o.preset, duration: o.frames / o.fps,
    threads: o.threads ?? Math.max(1, availableParallelism() - 1),
  });

  const ff = spawn(o.ffmpegPath || 'ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });

  let stderr = '';
  ff.stderr.on('data', (d) => {
    const p = parseProgress(d);
    if (p.frame != null && o.onProgress) o.onProgress({ frame: p.frame, total: o.frames });
    stderr += d;
    if (stderr.length > 64_000) stderr = stderr.slice(-32_000);
  });

  const finished = once(ff, 'close');
  // A pipe error (ffmpeg exiting early) would otherwise surface as an
  // unhandled EPIPE and mask the real cause in stderr.
  let pipeBroken = false;
  ff.stdin.on('error', () => { pipeBroken = true; });

  try {
    for (let n = 0; n < o.frames && !pipeBroken; n++) {
      const rgba = o.renderFrameRGBA(n);
      const buf = Buffer.isBuffer(rgba)
        ? rgba
        : Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);

      // Wait for the write callback even when the stream has not crossed its
      // high-water mark. The callback is the point at which Node no longer
      // owns the frame buffer; keeping this bounded prevents a fast renderer
      // from accumulating native buffers behind ffmpeg.
      await new Promise((resolve, reject) => {
        const onError = (err) => { ff.stdin.off('error', onError); reject(err); };
        ff.stdin.once('error', onError);
        ff.stdin.write(buf, (err) => {
          ff.stdin.off('error', onError);
          if (err) reject(err); else resolve();
        });
      });
    }
  } finally {
    if (!pipeBroken) ff.stdin.end();
  }

  const [code] = await finished;
  if (code !== 0) {
    throw new Error(`ffmpeg exited ${code}\n${stderr.slice(-4000)}`);
  }
  return o.out;
}
