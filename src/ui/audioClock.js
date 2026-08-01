/**
 * Preview audio, and the playback clock that rides on it.
 *
 * Two jobs, deliberately in one module because they are the same fact:
 *
 *   1. Mix the document's audio tracks live through WebAudio.
 *   2. Drive the preview's frame counter from `AudioContext.currentTime`.
 *
 * (2) is the point. Deriving the frame from `performance.now()` lets the drawing
 * slide against the narration -- the two clocks are independent, and the audio
 * hardware's is the one the user actually hears. Anchoring the frame index to
 * the audio clock makes drift impossible by construction: if the sound card runs
 * slow, the drawing runs slow with it. A project with no audio has nothing to
 * drift against and falls back to `performance.now()` rather than spinning up a
 * context for nothing.
 *
 * Scheduling reads exactly the four fields `buildAudioGraph()` in
 * engine/export/ffmpeg.js reads -- start, trimIn, duration, gain -- so what you
 * hear in preview is what ffmpeg renders. The one intentional divergence: export
 * `apad`s the mix to the video length, preview simply stops.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Scheduling lead. `start(when)` with `when` already past fires immediately and
 * loses that much of the track, so give the graph construction a moment to land.
 * Small enough to read as instant.
 */
const LEAD = 0.05;

/**
 * When a track ends on the timeline, in seconds.
 *
 * `duration` is optional -- ffprobe returns null when it is unavailable, and the
 * document carries `undefined` rather than guessing. In that case the file plays
 * out from `trimIn` to its own end, which is what `atrim` with no duration does.
 */
function trackEnd(track, buffer) {
  const start = track.start || 0;
  const trimIn = track.trimIn || 0;
  if (track.duration != null) return start + track.duration;
  return start + Math.max(0, buffer.duration - trimIn);
}

/**
 * Live audio mixing plus the master clock for preview playback.
 *
 * @param {Object} o
 * @param {Array}  o.tracks   `doc.audio`
 * @param {number} o.fps
 * @param {number} o.frames   total frame count; playback stops at the last one
 * @param {boolean} o.playing
 * @param {number} o.frame    current frame; read when playback starts
 * @param {(n:number) => void} o.setFrame
 * @param {(p:boolean) => void} o.setPlaying
 * @param {boolean} [o.muted]
 * @param {number}  [o.volume] master gain, 0..1
 * @returns {{hasAudio:boolean}}
 */
export function useAudioClock({
  tracks, fps, frames, playing, frame, setFrame, setPlaying,
  muted = false, volume = 1, mutedTracks,
}) {
  const ctxRef = useRef(null);
  const masterRef = useRef(null);
  const buffersRef = useRef(new Map());   // src -> AudioBuffer
  const pendingRef = useRef(new Map());   // src -> Promise, so N lanes decode once
  const sourcesRef = useRef([]);
  // Per-track gain nodes, kept so a lane can be muted without tearing down and
  // rescheduling the graph -- which would be an audible restart.
  const lanesRef = useRef([]);
  // Read at play time, never a dependency: retiming a track mid-playback should
  // not tear the graph down and restart it under the user.
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;
  const frameRef = useRef(frame);
  frameRef.current = frame;
  const mutedRef = useRef(mutedTracks);
  mutedRef.current = mutedTracks;

  const hasAudio = tracks.length > 0;
  // Purely so the prefetch effect can re-run when a track is added; the decoded
  // buffers themselves live in a ref because nothing renders from them.
  const [, bumpDecoded] = useState(0);

  const context = useCallback(() => {
    if (!ctxRef.current) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      ctxRef.current = new Ctx();
      masterRef.current = ctxRef.current.createGain();
      masterRef.current.connect(ctxRef.current.destination);
    }
    return ctxRef.current;
  }, []);

  // ── decode ahead of time ──────────────────────────────────────────
  // Pressing space must be instant, so tracks are decoded when they are added,
  // not when playback starts. decodeAudioData works on a suspended context, so
  // this does not need a user gesture.
  useEffect(() => {
    if (!hasAudio || !window.studio?.readAudio) return;
    const ctx = context();
    if (!ctx) return;

    for (const t of tracks) {
      const src = t.src;
      if (buffersRef.current.has(src) || pendingRef.current.has(src)) continue;
      const job = (async () => {
        const bytes = await window.studio.readAudio(src);
        if (!(bytes instanceof Uint8Array)) throw new Error(bytes?.error || 'unreadable');
        // decodeAudioData takes ownership of the ArrayBuffer, and `bytes` may be
        // a view into a larger one, so hand it its own copy.
        const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        const buf = await ctx.decodeAudioData(ab);
        buffersRef.current.set(src, buf);
        bumpDecoded((n) => n + 1);
      })().catch(() => {
        // A track that will not decode stays silent; it must not break playback
        // or export, both of which go through ffmpeg with the original file.
      }).finally(() => {
        pendingRef.current.delete(src);
      });
      pendingRef.current.set(src, job);
    }
  }, [tracks, hasAudio, context]);

  // Master gain follows the transport's mute/volume without restarting anything.
  useEffect(() => {
    const g = masterRef.current;
    if (!g) return;
    const ctx = ctxRef.current;
    // setTargetAtTime rather than a raw assignment: stepping gain mid-waveform
    // is an audible click.
    g.gain.setTargetAtTime(muted ? 0 : volume, ctx.currentTime, 0.01);
  }, [muted, volume, hasAudio]);

  // Per-lane mute, same treatment.
  useEffect(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    for (const lane of lanesRef.current) {
      const target = mutedTracks?.has(lane.trackId) ? 0 : lane.base;
      lane.node.gain.setTargetAtTime(target, ctx.currentTime, 0.01);
    }
  }, [mutedTracks]);

  // ── playback ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!playing || !frames) return undefined;

    const ctx = hasAudio ? context() : null;
    // Replaying from the end restarts from zero, matching the transport button.
    const fromFrame = frameRef.current >= frames - 1 ? 0 : frameRef.current;

    let raf = 0;
    let cancelled = false;

    const stopAll = () => {
      for (const s of sourcesRef.current) {
        try { s.stop(); } catch { /* already ended */ }
        s.disconnect();
      }
      for (const lane of lanesRef.current) lane.node.disconnect();
      sourcesRef.current = [];
      lanesRef.current = [];
    };

    const schedule = (startAtCtx) => {
      if (!ctx) return;
      const t0 = fromFrame / fps;
      for (const track of tracksRef.current) {
        const buffer = buffersRef.current.get(track.src);
        if (!buffer) continue;                       // still decoding, or failed

        const start = track.start || 0;
        const trimIn = track.trimIn || 0;
        const end = trackEnd(track, buffer);
        if (end <= t0) continue;                     // already played out

        // Seeking into the middle of a track starts it mid-file; seeking before
        // it starts schedules it for later. Both are the same two expressions.
        const offset = trimIn + Math.max(0, t0 - start);
        if (offset >= buffer.duration) continue;
        const when = startAtCtx + Math.max(0, start - t0);
        const length = Math.min(end - Math.max(t0, start), buffer.duration - offset);
        if (length <= 0) continue;

        const node = ctx.createBufferSource();
        node.buffer = buffer;
        const base = track.gain ?? 1;
        const gain = ctx.createGain();
        gain.gain.value = mutedRef.current?.has(track.trackId) ? 0 : base;
        node.connect(gain).connect(masterRef.current);
        node.start(when, offset, length);
        sourcesRef.current.push(node);
        lanesRef.current.push({ trackId: track.trackId, node: gain, base });
      }
    };

    const run = () => {
      // The anchor, and the whole reason this module exists: one (clock time,
      // frame) pair that every subsequent frame index is derived from, so error
      // cannot accumulate the way `t += 1/fps` does.
      const now = ctx ? () => ctx.currentTime : () => performance.now() / 1000;
      const anchor = now() + (ctx ? LEAD : 0);
      schedule(anchor);

      const tick = () => {
        // Clamped below at fromFrame: during the LEAD the anchor is still in the
        // future and the raw expression would run backwards.
        const n = Math.max(fromFrame, fromFrame + Math.round((now() - anchor) * fps));
        if (n >= frames - 1) { setFrame(frames - 1); setPlaying(false); return; }
        setFrame(n);
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    };

    if (ctx && ctx.state !== 'running') {
      // Chromium suspends a context created outside a user gesture, and
      // currentTime does not advance while suspended -- so resume first or the
      // clock reads zero forever.
      ctx.resume().catch(() => {}).then(() => { if (!cancelled) run(); });
    } else {
      run();
    }

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      stopAll();
    };
    // `frame` is read through a ref on purpose: it changes every tick and would
    // restart the loop, pinning playback to the first frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, frames, fps, hasAudio, context, setFrame, setPlaying]);

  // Tear the context down with the editor, not with each play.
  useEffect(() => () => { ctxRef.current?.close().catch(() => {}); }, []);

  return { hasAudio };
}

export default useAudioClock;
