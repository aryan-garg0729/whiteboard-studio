import test from 'node:test';
import assert from 'node:assert/strict';

import {
  atempoChain, buildAudioGraph, buildFfmpegArgs, parseProgress,
} from '../src/engine/export/ffmpeg.js';

test('no audio clips means no filter graph', () => {
  assert.equal(buildAudioGraph([]), null);
  assert.equal(buildAudioGraph(undefined), null);
  const args = buildFfmpegArgs({ width: 1920, height: 1080, fps: 30, out: 'o.mp4' });
  assert.ok(!args.includes('-filter_complex'));
  assert.ok(!args.includes('-c:a'));
});

test('a single audio clip is padded rather than mixed', () => {
  const { filter, label } = buildAudioGraph([{ file: 'v.mp3', start: 0, duration: 10 }]);
  assert.equal(label, '[aout]');
  assert.ok(filter.includes('atrim=start=0:duration=10'));
  assert.ok(filter.includes('asetpts=PTS-STARTPTS'));
  assert.ok(filter.includes('apad[aout]'));
  assert.ok(!filter.includes('amix'), 'one input needs no mixer');
});

test('amix always sets normalize=0', () => {
  // Verified against ffmpeg 4.4.2: the default halves amplitude with two
  // inputs (measured -26.1 dB vs -20.1 dB mean, exactly 6 dB down).
  const { filter } = buildAudioGraph([
    { file: 'a.mp3', start: 0 },
    { file: 'b.wav', start: 3, gain: 0.25 },
  ]);
  assert.ok(filter.includes('amix=inputs=2:duration=longest:normalize=0'));
});

test('clip offsets become integer-millisecond adelay on every channel', () => {
  const { filter } = buildAudioGraph([{ file: 'b.wav', start: 3.0007 }]);
  assert.ok(filter.includes('adelay=3001:all=1'), filter);
});

test('a clip starting at zero gets no adelay', () => {
  const { filter } = buildAudioGraph([{ file: 'a.wav', start: 0 }]);
  assert.ok(!filter.includes('adelay'));
});

test('gain of exactly 1 is omitted', () => {
  assert.ok(!buildAudioGraph([{ file: 'a.wav', start: 0, gain: 1 }]).filter.includes('volume='));
  assert.ok(buildAudioGraph([{ file: 'a.wav', start: 0, gain: 0.5 }]).filter.includes('volume=0.5'));
});

test('speed of exactly 1 changes nothing about the graph', () => {
  // The regression that matters: every project written before speed existed
  // normalises to speed 1, and none of them may encode differently for it.
  const clip = { file: 'a.wav', start: 2, trimIn: 1, duration: 10, gain: 0.5 };
  assert.equal(buildAudioGraph([{ ...clip, speed: 1 }]).filter,
    buildAudioGraph([clip]).filter);
  assert.ok(!buildAudioGraph([{ ...clip, speed: 1 }]).filter.includes('atempo'));
});

test('atrim length is source seconds, so speed scales it back up', () => {
  // A 10-second block at 2x is 20 seconds of file.
  const { filter } = buildAudioGraph([{ file: 'a.wav', start: 0, duration: 10, speed: 2 }]);
  assert.ok(filter.includes('atrim=start=0:duration=20'), filter);
  assert.ok(filter.includes('atempo=2'), filter);
  assert.ok(filter.indexOf('atrim') < filter.indexOf('atempo'),
    'trimming first keeps both atrim arguments on the source clock');
});

test('atempo chains for rates outside its own 0.5..2 range', () => {
  assert.deepEqual(atempoChain(1), []);
  assert.deepEqual(atempoChain(2), ['atempo=2']);
  assert.deepEqual(atempoChain(3), ['atempo=2', 'atempo=1.5']);
  assert.deepEqual(atempoChain(4), ['atempo=2', 'atempo=2']);
  assert.deepEqual(atempoChain(0.5), ['atempo=0.5']);
  assert.deepEqual(atempoChain(0.25), ['atempo=0.5', 'atempo=0.5']);
  // Every chain multiplies back out to the rate that was asked for.
  for (const s of [0.25, 0.4, 0.75, 1.5, 2.5, 3.2, 4]) {
    const product = atempoChain(s)
      .reduce((n, f) => n * Number(f.split('=')[1]), 1);
    assert.ok(Math.abs(product - s) < 1e-6, `${s} -> ${atempoChain(s).join(',')}`);
  }
});

test('an unmeasured clip at speed still gets its atempo', () => {
  // No duration means atrim has no length argument, but the rate still applies.
  const { filter } = buildAudioGraph([{ file: 'a.wav', start: 0, speed: 1.5 }]);
  assert.ok(filter.includes('atrim=start=0,'), filter);
  assert.ok(filter.includes('atempo=1.5'), filter);
});

test('audio inputs are numbered after the video pipe', () => {
  const { filter } = buildAudioGraph([{ file: 'a.wav', start: 0 }, { file: 'b.wav', start: 0 }]);
  // input 0 is the raw frame pipe, so audio starts at 1
  assert.ok(filter.startsWith('[1:a]'));
  assert.ok(filter.includes('[2:a]'));
  assert.ok(!filter.includes('[0:a]'), 'input 0 is video, never audio');
});

test('video args describe a top-down RGBA pipe at the requested size', () => {
  const args = buildFfmpegArgs({ width: 1920, height: 1080, fps: 30, out: 'o.mp4' });
  const i = args.indexOf('-video_size');
  assert.equal(args[i + 1], '1920x1080');
  assert.equal(args[args.indexOf('-pixel_format') + 1], 'rgba');
  assert.equal(args[args.indexOf('-framerate') + 1], '30');
  assert.equal(args[args.indexOf('-i') + 1], 'pipe:0');
});

test('export threads can be capped explicitly', () => {
  const args = buildFfmpegArgs({ width: 16, height: 16, fps: 30, out: 'o.mp4', threads: 7 });
  assert.equal(args[args.indexOf('-threads') + 1], '7');
});

test('output is always yuv420p for player compatibility', () => {
  const args = buildFfmpegArgs({ width: 1920, height: 1080, fps: 30, out: 'o.mp4' });
  assert.equal(args[args.indexOf('-pix_fmt') + 1], 'yuv420p');
  assert.ok(args.includes('+faststart'));
});

test('the fast preset opts into nvenc, the default does not', () => {
  const quality = buildFfmpegArgs({ width: 16, height: 16, fps: 30, out: 'o.mp4' });
  assert.equal(quality[quality.indexOf('-c:v') + 1], 'libx264');
  const fast = buildFfmpegArgs({ width: 16, height: 16, fps: 30, out: 'o.mp4', preset: 'fast' });
  assert.equal(fast[fast.indexOf('-c:v') + 1], 'h264_nvenc');
});

test('duration caps the output only when there is no audio to be -shortest against', () => {
  const silent = buildFfmpegArgs({ width: 16, height: 16, fps: 30, out: 'o.mp4', duration: 4 });
  assert.equal(silent[silent.indexOf('-t') + 1], '4');
  assert.ok(!silent.includes('-shortest'));

  const withAudio = buildFfmpegArgs({ width: 16, height: 16, fps: 30, out: 'o.mp4',
    duration: 4, audio: [{ file: 'a.wav', start: 0 }] });
  assert.ok(withAudio.includes('-shortest'));
  assert.ok(!withAudio.includes('-t'), 'audio-bearing exports use -shortest, not -t');
});

test('parseProgress reads the machine-readable stream', () => {
  const p = parseProgress('frame=42\nfps=30\nout_time_us=1400000\nprogress=continue\n');
  assert.equal(p.frame, 42);
  assert.equal(p.outTimeUs, 1400000);
  assert.equal(p.done, false, 'mid-stream progress is explicitly not done');
  assert.equal(parseProgress('progress=end\n').done, true);
});
