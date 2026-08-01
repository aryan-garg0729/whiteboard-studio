/**
 * Media probing for imported assets.
 *
 * The timeline needs an audio clip's real duration to draw its lane, and the
 * library needs a thumbnail. Both are main-process concerns: the renderer has
 * neither filesystem nor ffprobe.
 */

import { execFile, execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { promisify } from 'node:util';

import { dataUrl } from './prepare.js';

const run = promisify(execFile);

export const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'svg'];
export const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'];

/** Seconds, or null when ffprobe is unavailable or the file is unreadable. */
export async function probeDuration(path) {
  try {
    const { stdout } = await run('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', path,
    ]);
    const secs = Number.parseFloat(stdout.trim());
    return Number.isFinite(secs) ? secs : null;
  } catch {
    return null;
  }
}

/** Peak envelope for the waveform lane: `buckets` values in 0..1. */
export async function probePeaks(path, buckets = 400) {
  try {
    // s16le mono at a low rate: we only need an envelope, and decoding at
    // 48kHz stereo would move ~50x the bytes for no visible difference.
    const { stdout } = await run('ffmpeg', [
      '-v', 'error', '-i', path, '-ac', '1', '-ar', '8000',
      '-f', 's16le', '-',
    ], { encoding: 'buffer', maxBuffer: 256 << 20 });

    const samples = new Int16Array(
      stdout.buffer, stdout.byteOffset, Math.floor(stdout.byteLength / 2));
    if (!samples.length) return null;

    const step = samples.length / buckets;
    const peaks = new Array(buckets);
    for (let i = 0; i < buckets; i++) {
      const a = Math.floor(i * step);
      const b = Math.min(samples.length, Math.floor((i + 1) * step));
      let peak = 0;
      for (let j = a; j < b; j++) peak = Math.max(peak, Math.abs(samples[j]));
      peaks[i] = peak / 32768;
    }
    return peaks;
  } catch {
    return null;
  }
}

/**
 * Describe a file for the asset library.
 * @returns {Promise<Object>} `{ path, name, kind, ... }`; kind is
 *          'image' | 'vector' | 'audio' | 'unsupported'
 */
export async function describeFile(path) {
  const ext = extname(path).slice(1).toLowerCase();
  const base = { path, name: basename(path), ext, bytes: statSync(path).size };

  if (ext === 'svg') {
    return { ...base, kind: 'vector', thumb: svgThumb(path) };
  }
  if (IMAGE_EXT.includes(ext)) {
    return { ...base, kind: 'image', thumb: dataUrl(path) };
  }
  if (AUDIO_EXT.includes(ext)) {
    const [duration, peaks] = await Promise.all([probeDuration(path), probePeaks(path)]);
    return { ...base, kind: 'audio', duration, peaks };
  }
  return { ...base, kind: 'unsupported' };
}

function svgThumb(path) {
  // An <img> renders SVG natively, so the file itself is the thumbnail.
  return `data:image/svg+xml;base64,${readFileSync(path).toString('base64')}`;
}

/** True when ffmpeg is on PATH; the export button says so when it is not. */
export function hasFfmpeg() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
