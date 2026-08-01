/**
 * ffmpeg command construction for MP4 export.
 *
 * Pure string/array building so the filter graph can be unit-tested without
 * spawning anything. The frame pump lives in driver.js.
 */

/**
 * @typedef {Object} AudioClip
 * @property {string} file
 * @property {number} start    seconds on the timeline where it begins
 * @property {number} [trimIn] seconds into the source file to start from
 * @property {number} [duration]
 * @property {number} [gain]   linear, 1 = unity
 */

/** Milliseconds, integer -- `adelay` takes ms and rejects fractions. */
const ms = (s) => Math.max(0, Math.round(s * 1000));

/**
 * Build the `-filter_complex` graph mixing N audio clips onto one output.
 *
 * Video is always input 0 (the raw frame pipe), so audio clip i is input i+1.
 *
 * @param {AudioClip[]} clips
 * @returns {{filter:string, label:string}|null} null when there is no audio
 */
export function buildAudioGraph(clips) {
  if (!clips || !clips.length) return null;

  const parts = [];
  const labels = [];

  clips.forEach((c, i) => {
    const input = i + 1;
    const label = `a${i}`;
    const seg = [];

    // atrim selects the slice of the source; asetpts rebases it to zero so the
    // following adelay positions it from the start rather than compounding.
    const trimIn = c.trimIn ?? 0;
    let trim = `atrim=start=${trimIn}`;
    if (c.duration != null) trim += `:duration=${c.duration}`;
    seg.push(trim, 'asetpts=PTS-STARTPTS');

    if (c.gain != null && c.gain !== 1) seg.push(`volume=${c.gain}`);

    // adelay needs one value per channel; `all=1` applies it to every channel
    // without having to know the channel count up front.
    if (c.start > 0) seg.push(`adelay=${ms(c.start)}:all=1`);

    parts.push(`[${input}:a]${seg.join(',')}[${label}]`);
    labels.push(`[${label}]`);
  });

  if (clips.length === 1) {
    // Still pad, so a short track cannot truncate the video via -shortest.
    parts.push(`${labels[0]}apad[aout]`);
  } else {
    // normalize=0 is essential: amix otherwise divides by the input count,
    // silently halving the volume as soon as there are two clips.
    parts.push(`${labels.join('')}amix=inputs=${clips.length}:duration=longest:normalize=0,apad[aout]`);
  }

  return { filter: parts.join(';'), label: '[aout]' };
}

/**
 * Full argv for the export process.
 *
 * @param {Object} o
 * @param {number} o.width @param {number} o.height @param {number} o.fps
 * @param {string} o.out output path
 * @param {AudioClip[]} [o.audio]
 * @param {number} [o.duration] total seconds; caps output when there is no audio
 * @param {'quality'|'fast'} [o.preset]
 */
export function buildFfmpegArgs(o) {
  const args = ['-y',
    '-f', 'rawvideo',
    '-pixel_format', 'rgba',
    '-video_size', `${o.width}x${o.height}`,
    '-framerate', String(o.fps),
    '-i', 'pipe:0'];

  const audio = o.audio || [];
  for (const c of audio) args.push('-i', c.file);

  const graph = buildAudioGraph(audio);
  if (graph) args.push('-filter_complex', graph.filter);

  args.push('-map', '0:v');
  if (graph) args.push('-map', graph.label);

  if (o.preset === 'fast') {
    // NVENC is ~4x faster but is not bit-deterministic across driver versions
    // and is worse per-bit on flat graphics, so it is opt-in only.
    args.push('-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '20');
  } else {
    args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '18');
  }

  // yuv420p is mandatory for QuickTime and browser playback.
  args.push('-pix_fmt', 'yuv420p');

  if (graph) args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-shortest');
  else if (o.duration != null) args.push('-t', String(o.duration));

  args.push('-movflags', '+faststart',
    '-progress', 'pipe:2', '-nostats',
    o.out);
  return args;
}

/**
 * Parse ffmpeg's `-progress` key=value stream. Far more reliable than scraping
 * the human-readable stderr, which changes format between versions.
 */
export function parseProgress(chunk) {
  const out = {};
  for (const line of String(chunk).split('\n')) {
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim();
    if (k === 'frame') out.frame = Number(v);
    else if (k === 'out_time_us') out.outTimeUs = Number(v);
    else if (k === 'progress') out.done = v === 'end';
  }
  return out;
}
