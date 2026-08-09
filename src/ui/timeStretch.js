/**
 * Time-stretching that leaves pitch alone.
 *
 * Playing an AudioBuffer at `playbackRate = 2` is a tape running fast: it takes
 * half the time and every frequency doubles. That is not what "2x speed" means
 * for narration -- the voice has to stay the same voice. ffmpeg's `atempo` does
 * the right thing on export, so preview has to do the same thing or the two
 * disagree about what the project sounds like.
 *
 * The method is WSOLA (waveform-similarity overlap-add), the same family
 * `atempo` belongs to. Cut the input into overlapping windows, lay them back
 * down at a different spacing, and -- the one idea that makes it work -- let
 * each window slide a few milliseconds to wherever it best continues the one
 * before it. Without that search the splice points land at arbitrary phases of
 * the pitch period and a voice turns into a buzz.
 *
 * Deliberately DOM-free, taking and returning raw channel arrays rather than
 * AudioBuffers, so the arithmetic can be tested under `node --test` with no
 * WebAudio to stand up. `audioClock.js` owns the AudioBuffer wrapping.
 */

/** Window length in seconds. Long enough to hold a pitch period, short enough
 *  that a transient is not smeared across it. */
const FRAME_S = 0.040;
/** How far a window may slide to find its best continuation, in seconds. */
const SEARCH_S = 0.010;
/**
 * Decimation for the similarity search only.
 *
 * The search is the expensive part -- offsets x window samples, per hop. At
 * full rate a 20-second file costs a couple of billion multiply-adds and takes
 * seconds; at 1/4 rate it costs tens of millions and takes tens of
 * milliseconds. Speech correlates fine at 1/4 rate: we are locating a pitch
 * period a few hundred samples long, not resolving fine detail.
 */
const DECIMATE = 4;

/** Periodic Hann. Two of these overlapped at 50% sum to exactly 1. */
function hann(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

/** Mono mixdown at 1/DECIMATE rate, for the similarity search. */
function searchSignal(channels, length) {
  const n = Math.floor(length / DECIMATE);
  const out = new Float32Array(n);
  for (const ch of channels) {
    for (let i = 0; i < n; i++) out[i] += ch[i * DECIMATE];
  }
  const scale = 1 / channels.length;
  for (let i = 0; i < n; i++) out[i] *= scale;
  return out;
}

/**
 * Resample in time without touching pitch.
 *
 * @param {Float32Array[]} channels  one array per channel, all the same length
 * @param {number} sampleRate
 * @param {number} speed  >1 shortens, <1 lengthens
 * @returns {Float32Array[]} new channels of length ceil(inputLength / speed)
 */
export function stretchChannels(channels, sampleRate, speed) {
  // Nothing to do, and nothing should pay for a feature it is not using.
  if (!(speed > 0) || Math.abs(speed - 1) < 1e-6) return channels;
  if (!channels.length) return channels;

  const inLen = channels[0].length;
  const outLen = Math.ceil(inLen / speed);
  const frame = Math.round(FRAME_S * sampleRate);
  const hopOut = frame >> 1;
  const hopIn = hopOut * speed;
  const search = Math.round(SEARCH_S * sampleRate);

  // Too short to window: fall back to a plain copy of what fits. A 30ms sound
  // effect has no periodicity worth preserving anyway.
  if (inLen < frame * 2) {
    return channels.map((ch) => ch.slice(0, Math.min(ch.length, outLen)));
  }

  const win = hann(frame);
  const probe = searchSignal(channels, inLen);
  const out = channels.map(() => new Float32Array(outLen + frame));

  // `template` is where the *previous* window would have continued to, had we
  // kept reading forward. The next window is chosen to look as much like that
  // as possible, so the join is phase-continuous.
  let templateAt = 0;
  let inPos = 0;
  let outPos = 0;

  while (outPos + frame < outLen + frame && inPos + frame < inLen) {
    let best = 0;
    if (templateAt > 0) {
      // Cross-correlate over the overlap region only: the second half of the
      // previous window is the part the next one has to agree with.
      const lenD = Math.floor(hopOut / DECIMATE);
      const tD = Math.floor(templateAt / DECIMATE);
      let bestScore = -Infinity;
      for (let off = -search; off <= search; off += DECIMATE) {
        const sD = Math.floor((inPos + off) / DECIMATE);
        if (sD < 0 || inPos + off < 0 || inPos + off + frame >= inLen) continue;
        let dot = 0;
        for (let i = 0; i < lenD; i++) {
          const t = probe[tD + i];
          if (t === undefined) break;
          const s = probe[sD + i];
          if (s === undefined) break;
          dot += t * s;
        }
        if (dot > bestScore) { bestScore = dot; best = off; }
      }
    }

    const from = Math.max(0, Math.min(inLen - frame, inPos + best));
    for (let c = 0; c < channels.length; c++) {
      const src = channels[c];
      const dst = out[c];
      for (let i = 0; i < frame; i++) dst[outPos + i] += src[from + i] * win[i];
    }

    templateAt = from + hopOut;
    outPos += hopOut;
    inPos = Math.round(inPos + hopIn);
  }

  // The window sum ramps in over the first half-window and out over the last,
  // so the very first and last hop are quieter than unity. Trim to length and
  // let the caller's own fades (or the silence around a clip) cover it.
  return out.map((ch) => ch.subarray(0, outLen));
}

/**
 * The same thing, wrapped for WebAudio.
 *
 * @param {BaseAudioContext} ctx  only used to allocate the output buffer
 * @param {AudioBuffer} buffer
 * @param {number} speed
 * @returns {AudioBuffer} `buffer` itself when the speed is 1
 */
export function stretchBuffer(ctx, buffer, speed) {
  if (Math.abs(speed - 1) < 1e-6) return buffer;
  const channels = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));

  const stretched = stretchChannels(channels, buffer.sampleRate, speed);
  const out = ctx.createBuffer(buffer.numberOfChannels,
    stretched[0].length, buffer.sampleRate);
  for (let c = 0; c < stretched.length; c++) out.copyToChannel(stretched[c], c);
  return out;
}

export default stretchChannels;
