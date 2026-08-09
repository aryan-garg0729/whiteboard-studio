/**
 * Time-stretching preserves pitch.
 *
 * That is the whole contract, and it is exactly what the naive approach
 * (`playbackRate`) gets wrong: it changes length and pitch together. So the
 * central test here synthesises a tone, stretches it, and measures the tone
 * again -- a test that fails loudly against a resampler.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { stretchBuffer, stretchChannels } from '../src/ui/timeStretch.js';

const SR = 48000;

/** A pure tone, which has one unambiguous pitch to measure. */
function sine(freq, seconds, sampleRate = SR) {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate);
  return out;
}

/**
 * Frequency by counting zero crossings.
 *
 * Crude, and perfect for a sine: two crossings per cycle, so the rate of
 * upward crossings *is* the frequency. Measured over the interior only, since
 * the first and last window of an overlap-add ramp in and out.
 */
function pitch(ch, sampleRate = SR) {
  const from = Math.floor(ch.length * 0.2);
  const to = Math.floor(ch.length * 0.8);
  let crossings = 0;
  for (let i = from + 1; i < to; i++) {
    if (ch[i - 1] <= 0 && ch[i] > 0) crossings++;
  }
  return (crossings * sampleRate) / (to - from);
}

test('speed 1 is the identity, and costs nothing', () => {
  const input = [sine(440, 0.5)];
  assert.equal(stretchChannels(input, SR, 1), input, 'the same arrays come back');
});

test('a stretched tone keeps its pitch', () => {
  const input = sine(440, 2);
  assert.ok(Math.abs(pitch(input) - 440) < 5, 'the measurement itself is sound');

  for (const speed of [0.5, 0.75, 1.5, 2, 3]) {
    const [out] = stretchChannels([input], SR, speed);
    const got = pitch(out);
    // A resampler would land on 440 * speed -- 880 at 2x. Two percent is well
    // inside that and well outside anything WSOLA does to a steady tone.
    assert.ok(Math.abs(got - 440) < 440 * 0.02,
      `at ${speed}x expected ~440Hz, got ${Math.round(got)}Hz`);
  }
});

test('and takes proportionally less time', () => {
  const input = sine(440, 2);
  for (const speed of [0.25, 0.5, 1.5, 2, 4]) {
    const [out] = stretchChannels([input], SR, speed);
    assert.equal(out.length, Math.ceil(input.length / speed), `length at ${speed}x`);
  }
});

test('the output is finite and does not clip', () => {
  // Overlap-add sums two windows at every sample; a window that does not sum to
  // unity shows up here as gain, and a bad index shows up as NaN.
  const [out] = stretchChannels([sine(440, 1)], SR, 1.5);
  let peak = 0;
  for (let i = 0; i < out.length; i++) {
    assert.ok(Number.isFinite(out[i]), `sample ${i} is not finite`);
    peak = Math.max(peak, Math.abs(out[i]));
  }
  assert.ok(peak <= 1.05, `peak ${peak} exceeds the input's own amplitude`);
  assert.ok(peak > 0.5, `peak ${peak} is suspiciously quiet`);
});

test('channels stay aligned, because they slide together', () => {
  // Two identical channels must come back identical: a per-channel similarity
  // search would pick different offsets and smear the stereo image.
  const a = sine(440, 1);
  const b = sine(440, 1);
  const [outA, outB] = stretchChannels([a, b], SR, 1.7);
  assert.equal(outA.length, outB.length);
  for (let i = 0; i < outA.length; i += 97) {
    assert.equal(outA[i], outB[i], `channels diverge at ${i}`);
  }
});

test('channel count and rate survive', () => {
  // At 44.1k, not the 48k the rest of the file uses: the window sizes are
  // derived from the rate and must not be hard-coded to one of them.
  const out = stretchChannels([sine(300, 0.6, 44100), sine(300, 0.6, 44100)], 44100, 2);
  assert.equal(out.length, 2);
  assert.equal(out[0].length, Math.ceil(Math.round(0.6 * 44100) / 2));
  assert.ok(Math.abs(pitch(out[0], 44100) - 300) < 300 * 0.02);
});

test('a clip too short to window is passed through, not dropped', () => {
  const tiny = sine(1000, 0.01);
  const [out] = stretchChannels([tiny], SR, 2);
  assert.ok(out.length > 0, 'a 10ms blip must not vanish');
  assert.ok(out.length <= tiny.length);
});

/**
 * The bits of the WebAudio API `stretchBuffer` touches.
 *
 * Node has no AudioBuffer, and the wrapper is where an off-by-one in the
 * channel loop or a wrong `createBuffer` argument order would hide -- the very
 * things the pure function cannot catch.
 */
function fakeCtx() {
  return {
    created: null,
    createBuffer(numberOfChannels, length, sampleRate) {
      const data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
      this.created = {
        numberOfChannels,
        length,
        sampleRate,
        duration: length / sampleRate,
        getChannelData: (c) => data[c],
        copyToChannel: (src, c) => data[c].set(src),
      };
      return this.created;
    },
  };
}

test('the AudioBuffer wrapper preserves shape and hands back real samples', () => {
  const left = sine(440, 1);
  const right = sine(440, 1);
  const input = {
    numberOfChannels: 2,
    length: left.length,
    sampleRate: SR,
    duration: 1,
    getChannelData: (c) => (c === 0 ? left : right),
  };
  const ctx = fakeCtx();
  const out = stretchBuffer(ctx, input, 2);

  assert.equal(out.numberOfChannels, 2);
  assert.equal(out.sampleRate, SR);
  assert.equal(out.length, Math.ceil(left.length / 2));
  assert.ok(Math.abs(out.duration - 0.5) < 1e-6, 'half as long on the timeline');
  assert.ok(Math.abs(pitch(out.getChannelData(0)) - 440) < 440 * 0.02,
    'and still the same pitch once it is in a buffer');
});

test('the wrapper hands back the original buffer at speed 1', () => {
  const input = { numberOfChannels: 1, length: 10, sampleRate: SR, duration: 10 / SR };
  const ctx = fakeCtx();
  assert.equal(stretchBuffer(ctx, input, 1), input);
  assert.equal(ctx.created, null, 'and allocates nothing');
});

test('silence stretches to silence', () => {
  const [out] = stretchChannels([new Float32Array(SR)], SR, 2);
  assert.equal(out.length, SR / 2);
  assert.ok(out.every((v) => v === 0));
});
