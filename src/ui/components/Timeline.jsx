/**
 * Timeline: one lane per *track*, with as many clips per lane as fit.
 *
 * The lane-per-clip model this replaced could not survive a real project -- 60
 * elements meant 60 rows in a 230px panel. Because whiteboard clips are almost
 * always sequential, packing them into shared lanes (see `packTrack` in
 * state/editor.js) keeps the timeline two rows tall no matter how many elements
 * the project has, and a second row appears only when two things genuinely
 * overlap in time, which is the one case where it carries information.
 *
 * Drags edit the document live and coalesce into a single undo step, so the
 * stage repaints continuously while a clip is being moved. That works only
 * because retiming -- and re-laning -- is a pure renderFrame input: nothing is
 * recompiled.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { pageAt, pageWindows } from '../../engine/model/project.js';
import { MIN_AUDIO, audioEnd } from '../../engine/model/edits.js';
import { Icon, PATH } from './common.jsx';

const SNAP_PX = 6;
/** Must match `.tl-lane` height in app.css; vertical drags are measured in it. */
const LANE_H = 30;
/** Coarse-to-fine ruler steps; the first one wide enough on screen wins. */
const STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
/**
 * Silence narrower than this is not offered as a closable gap. Below a few
 * pixels the target is unhittable, and a hundredth of a second of air between
 * two takes is a rounding artefact rather than something anyone wants removed.
 */
const MIN_GAP = 0.05;

const round1 = (t) => Math.round(t * 10) / 10;
const round3 = (t) => Math.round(t * 1000) / 1000;

/**
 * How far an audio item may be trimmed before it runs into its lane neighbours.
 *
 * `Infinity` on the right when nothing follows: a lane's last item can grow for
 * as long as its recording lasts.
 */
function audioNeighbours(doc, id) {
  const me = doc.audio.find((a) => a.id === id);
  let prevEnd = 0;
  let nextStart = Infinity;
  for (const a of doc.audio) {
    if (a.id === id || a.trackId !== me.trackId) continue;
    const s = a.start || 0;
    if (s >= (me.start || 0)) nextStart = Math.min(nextStart, s);
    else prevEnd = Math.max(prevEnd, audioEnd(a));
  }
  return { prevEnd, nextStart };
}

/**
 * The runs of silence on one lane, as `{start, end}` in seconds.
 *
 * Includes the lead-in before the first item -- pulling a lane back to zero is
 * the same gesture as closing any other gap. Excludes the tail, which has
 * nothing after it to pull back and so is not a gap but simply the end.
 */
function laneGaps(items) {
  const sorted = [...items].sort((p, q) => (p.a.start || 0) - (q.a.start || 0));
  const out = [];
  let cursor = 0;
  for (const { a } of sorted) {
    const s = a.start || 0;
    if (s - cursor > MIN_GAP) out.push({ start: cursor, end: s });
    cursor = Math.max(cursor, audioEnd(a));
  }
  return out;
}

function useWaveform(peaks, width, height) {
  const ref = useRef(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !peaks?.length) return;
    c.width = Math.max(1, Math.round(width));
    c.height = height;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.fillStyle = '#dff3ea';
    const mid = c.height / 2;
    for (let x = 0; x < c.width; x++) {
      const p = peaks[Math.floor((x / c.width) * peaks.length)] || 0;
      const h = Math.max(0.5, p * mid);
      ctx.fillRect(x, mid - h, 1, h * 2);
    }
  }, [peaks, width, height]);
  return ref;
}

function AudioClip({ track, peaks, pxPerSec, duration, selected, onSelect, onDrag }) {
  const width = Math.max(6, duration * pxPerSec);
  const ref = useWaveform(peaks, width, 22);
  const name = track.src.split('/').pop();
  const speed = track.speed ?? 1;
  const down = (e, edge) => { onSelect(); onDrag(e, { kind: 'audio', id: track.id, edge }); };
  return (
    <div
      className={`tl-clip audio${selected ? ' sel' : ''}`}
      style={{ left: (track.start || 0) * pxPerSec, width }}
      title={speed === 1 ? name : `${name} — ${speed}×`}
      onPointerDown={(e) => down(e, 'move')}
    >
      <canvas ref={ref} />
      {/* Same grips clips have: trimming audio by dragging its edge is the same
          gesture as resizing a draw, and should not be a different one. */}
      <span className="grip l" onPointerDown={(e) => { e.stopPropagation(); down(e, 'start'); }} />
      <span className="label">{speed === 1 ? name : `${name} ${speed}×`}</span>
      <span className="grip r" onPointerDown={(e) => { e.stopPropagation(); down(e, 'end'); }} />
    </div>
  );
}

/**
 * A run of silence on an audio lane, as a click-target that closes it.
 *
 * Dragging every later item back by hand is the tedious way to do what is
 * almost always the intent, so the gap itself offers to do it. Quiet until
 * hovered: a gap is the absence of content and should not read as content.
 */
function Gap({ left, width, onClose }) {
  return (
    <div
      className="tl-gap"
      style={{ left, width }}
      title="Close this gap — pulls everything after it back"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={onClose}
    >
      <span className="glyph">›‹</span>
    </div>
  );
}

function Block({ cls, left, width, label, title, selected, onSelect, onDown, resizable }) {
  return (
    <div
      className={`tl-clip ${cls}${selected ? ' sel' : ''}`}
      style={{ left, width: Math.max(8, width) }}
      title={title}
      onPointerDown={(e) => { onSelect(); onDown(e, 'move'); }}
    >
      {resizable && (
        <span className="grip l" onPointerDown={(e) => { e.stopPropagation(); onSelect(); onDown(e, 'start'); }} />
      )}
      <span className="label">{label}</span>
      {resizable && (
        <span className="grip r" onPointerDown={(e) => { e.stopPropagation(); onSelect(); onDown(e, 'end'); }} />
      )}
    </div>
  );
}

/** Arrow glyph for a transition, so direction is readable at a glance. */
const ARROW = {
  cut: '·',
  swipeLeft: '←',
  swipeRight: '→',
  swipeUp: '↑',
  swipeDown: '↓',
};

/**
 * The page lane: which sheet is on screen when, and the swipes between them.
 *
 * Pinned above the clip lanes rather than living in `doc.tracks`, because it is
 * not a track -- it holds no clips, cannot be added or removed, and there is
 * exactly one. Keeping it out of the track list leaves the add/remove-lane UI
 * and the track schema untouched.
 */
function PageLane({ doc, pxPerSec, selection, setSelection, onBreakDown }) {
  const windows = pageWindows(doc);
  const name = (id) => doc.pages.find((p) => p.id === id)?.name || id;
  return (
    <div className="tl-lane page" data-kind="page">
      {windows.map((w, i) => (
        <div
          key={`${w.pageId}-${i}`}
          className="tl-clip page"
          style={{
            left: w.start * pxPerSec,
            // The last window has no end -- a composition does not have one
            // either. Run it to the end of the ruler.
            width: Math.max(8, ((w.end === Infinity ? 1e5 : w.end) - w.start) * pxPerSec),
          }}
          title={`${name(w.pageId)} is on screen here`}
        >
          <span className="label">{name(w.pageId)}</span>
        </div>
      ))}

      {doc.pageBreaks.map((b, i) => (
        <div
          key={`b${i}`}
          className={`tl-break${selection?.type === 'pageBreak' && selection.index === i ? ' sel' : ''}`}
          style={{
            left: b.t * pxPerSec,
            // A cut has no duration, so give it a hairline the user can hit.
            width: Math.max(3, b.duration * pxPerSec),
          }}
          title={`${b.transition} to ${name(b.pageId)} — drag to move`}
          onPointerDown={(e) => {
            e.stopPropagation();
            setSelection({ type: 'pageBreak', index: i });
            onBreakDown(e, i);
          }}
        >
          <span className="arrow">{ARROW[b.transition]}</span>
        </div>
      ))}
    </div>
  );
}

/** Two framings are the same shot when nothing about them reads as different. */
const sameShot = (a, b) =>
  Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.zoom - b.zoom) < 1e-3;

/**
 * The camera lane: every keyframe, and the moves between them.
 *
 * Keyframes belong to a *page*, but they are laid out on one shared lane at
 * their absolute time, because that is what the user is actually reasoning
 * about -- "the camera pushes in here, just before this word is written". A
 * keyframe whose page is not on screen at its own time is dimmed rather than
 * hidden: it still affects the framing on the next visit to that page, and
 * silently dropping it from the lane would make it uneditable.
 *
 * Pinned above the clip lanes for the same reason PageLane is: it holds no
 * clips, cannot be added or removed, and there is exactly one.
 */
function CameraLane({ doc, pxPerSec, selection, setSelection, onKeyDown }) {
  const windows = pageWindows(doc);
  const onScreen = (pageId, t) =>
    windows.some((w) => w.pageId === pageId && t >= w.start && t <= w.end);

  return (
    <div className="tl-lane camera" data-kind="camera">
      {doc.pages.map((page) => {
        const kfs = [...(page.cameraKeyframes || [])]
          .map((k, index) => ({ ...k, index }))
          .sort((a, b) => a.t - b.t);
        return (
          <React.Fragment key={page.id}>
            {/* The move itself: the span over which the framing changes. This
                is the thing the auto-inserted hold keyframe exists to create,
                so drawing it is what makes that hold legible. */}
            {kfs.slice(1).map((k, i) => {
              const a = kfs[i];
              if (sameShot(a, k)) return null;
              return (
                <div
                  key={`m${page.id}-${a.index}`}
                  className="tl-cammove"
                  style={{ left: a.t * pxPerSec, width: Math.max(2, (k.t - a.t) * pxPerSec) }}
                  title={`${page.name}: zoom ${a.zoom}× → ${k.zoom}× over ${round1(k.t - a.t)}s`}
                >
                  <span className="label">{`${a.zoom}× → ${k.zoom}×`}</span>
                </div>
              );
            })}

            {kfs.map((k) => {
              const sel = selection?.type === 'camera'
                && selection.pageId === page.id && selection.index === k.index;
              const off = !onScreen(page.id, k.t);
              return (
                <div
                  key={`k${page.id}-${k.index}`}
                  className={`tl-camkey${sel ? ' sel' : ''}${off ? ' off' : ''}`}
                  style={{ left: k.t * pxPerSec }}
                  title={off
                    ? `${page.name} is not on screen at ${k.t}s — this framing applies `
                      + 'the next time it is'
                    : `${page.name} — ${k.x}, ${k.y} at ${k.zoom}× — drag to move`}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    setSelection({ type: 'camera', pageId: page.id, index: k.index });
                    onKeyDown(e, page.id, k.index);
                  }}
                />
              );
            })}
          </React.Fragment>
        );
      })}
    </div>
  );
}

/** Lane header: name (double-click to rename), preview mute, remove. */
function TrackHead({ track, count, canRemove, muted, onMute, onRename, onRemove }) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="tl-head" data-kind={track.kind}>
      <span className="swatch" style={{
        background: track.kind === 'audio' ? 'var(--lane-audio)' : 'var(--accent)',
      }} />
      {editing ? (
        <input
          className="rename"
          autoFocus
          defaultValue={track.name}
          onKeyDown={(e) => {
            e.stopPropagation();          // keep Space out of the transport
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') { setEditing(false); }
          }}
          onBlur={(e) => {
            const name = e.target.value.trim();
            if (name && name !== track.name) onRename(name);
            setEditing(false);
          }}
        />
      ) : (
        <span className="name" title={`${track.name} — double-click to rename`}
              onDoubleClick={() => setEditing(true)}>
          {track.name}
        </span>
      )}
      <span className="count">{count || ''}</span>
      {track.kind === 'audio' && (
        <button className="lane-btn" aria-pressed={muted} onClick={onMute}
                title={muted ? 'Unmute in preview' : 'Mute in preview (export is unaffected)'}>
          <Icon d={muted ? PATH.speakerOff : PATH.speaker} size={11} />
        </button>
      )}
      <button className="lane-btn" onClick={onRemove} disabled={!canRemove}
              title={canRemove
                ? 'Remove this lane; its contents move to the lane above'
                : 'The last lane of a kind cannot be removed'}>
        <Icon d={PATH.close} size={11} />
      </button>
    </div>
  );
}

export default function Timeline({
  ed, selection, setSelection, frame, fps, frames, onSeek, mediaBySrc, height, setHeight,
  mutedTracks, setMutedTracks,
}) {
  const doc = ed.doc;
  const [pxPerSec, setPxPerSec] = useState(64);
  const scrollRef = useRef(null);
  const headsRef = useRef(null);
  const dragRef = useRef(null);

  const total = Math.max(8, (frames || 0) / fps + 2);
  const width = total * pxPerSec;
  const time = frame / fps;
  // Which sheet a keyframe added right now would belong to. Mid-swipe this is
  // the incoming page, which is also where the validator would put a clip.
  const activePageId = pageAt(doc, time);

  // Whether the razor has anything to cut: an audio item selected, measured,
  // and with the playhead far enough inside it to leave two real halves.
  const splittable = useMemo(() => {
    if (selection?.type !== 'audio') return false;
    const a = doc.audio.find((x) => x.id === selection.id);
    return !!a && a.duration != null
      && time > (a.start || 0) + MIN_AUDIO
      && time < audioEnd(a) - MIN_AUDIO;
  }, [doc, selection, time]);

  // ── lanes ─────────────────────────────────────────────────────────
  // Clip lanes above audio lanes regardless of the order tracks were added in;
  // the document's own order is left alone, this is presentation.
  const lanes = useMemo(() => {
    const ordered = [
      ...doc.tracks.filter((t) => t.kind === 'clip'),
      ...doc.tracks.filter((t) => t.kind === 'audio'),
    ];
    return ordered.map((track) => ({
      track,
      clips: track.kind === 'clip'
        ? doc.clips.filter((c) => c.trackId === track.id)
        : [],
      // Audio keeps its index into doc.audio: that is patchAudio's handle on it.
      audio: track.kind === 'audio'
        ? doc.audio.map((a, i) => ({ a, i })).filter(({ a }) => a.trackId === track.id)
        : [],
    }));
  }, [doc]);

  // The window-level pointermove handler needs the current lane list without
  // being torn down and rebuilt on every document edit.
  const lanesRef = useRef(lanes);
  lanesRef.current = lanes;

  const kindCount = (kind) => doc.tracks.filter((t) => t.kind === kind).length;

  /** Edges other clips can snap to, excluding whatever is being dragged. */
  const snapPoints = useCallback((skip) => {
    const pts = [0, time];
    for (const c of doc.clips) {
      if (skip?.kind === 'clip' && skip.id === c.id) continue;
      pts.push(c.start, c.start + c.duration);
      if (c.erase) pts.push(c.erase.start, c.erase.start + c.erase.duration);
    }
    // Both edges, not just the start: with lanes kept gapless, the edge a
    // neighbour wants to butt up against is exactly where the overlap clamp
    // would put it anyway.
    for (const a of doc.audio) {
      if (skip?.kind === 'audio' && skip.id === a.id) continue;
      pts.push(a.start || 0, audioEnd(a));
    }
    // Both edges of every transition. Clips want to butt up against these more
    // than against anything else: a draw must begin after the swipe lands.
    doc.pageBreaks.forEach((b, i) => {
      if (skip?.kind === 'pageBreak' && skip.index === i) return;
      pts.push(b.t, b.t + b.duration);
    });
    // Camera keyframes too: the point of the whole feature is that a draw
    // begins exactly where a camera move lands, so those are edges clips very
    // much want to butt up against.
    for (const p of doc.pages) {
      (p.cameraKeyframes || []).forEach((k, i) => {
        if (skip?.kind === 'camera' && skip.pageId === p.id && skip.index === i) return;
        pts.push(k.t);
      });
    }
    return pts;
  }, [doc, time]);

  const snap = useCallback((t, skip) => {
    let best = t;
    let bestPx = SNAP_PX;
    for (const p of snapPoints(skip)) {
      const dpx = Math.abs(p - t) * pxPerSec;
      if (dpx < bestPx) { bestPx = dpx; best = p; }
    }
    return best === t ? round1(t) : best;
  }, [snapPoints, pxPerSec]);

  // ── dragging ──────────────────────────────────────────────────────
  const onDrag = useCallback((e, target) => {
    e.preventDefault();
    // Capture is an optimisation -- the move/up listeners are on window either
    // way. It throws NotFoundError for a pointer id the browser is not
    // tracking, which must not abort the drag setup below.
    try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* not fatal */ }
    const clip = target.kind === 'clip' ? doc.clips.find((c) => c.id === target.id) : null;
    const audio = target.kind === 'audio' ? doc.audio.find((a) => a.id === target.id) : null;
    const item = clip || audio;
    const base = clip
      ? { start: clip.start, duration: clip.duration, erase: clip.erase }
      : target.kind === 'pageBreak'
        ? { start: doc.pageBreaks[target.index].t }
        : target.kind === 'camera'
          ? {
            start: doc.pages.find((p) => p.id === target.pageId)
              ?.cameraKeyframes[target.index]?.t ?? 0,
          }
          // Trimming needs all four: the left grip moves the start and the
          // in-point together, and how far the in-point moves depends on speed.
          : {
            start: audio?.start || 0,
            duration: audio?.duration,
            trimIn: audio?.trimIn || 0,
            speed: audio?.speed || 1,
          };
    dragRef.current = {
      ...target,
      x0: e.clientX,
      y0: e.clientY,
      lane0: lanesRef.current.findIndex((l) => l.track.id === item?.trackId),
      base,
      tag: `drag:${target.kind}:${target.id ?? target.index}:${target.edge}`,
    };
  }, [doc]);

  /**
   * Which lane a vertical drag has landed on, or null to stay put.
   *
   * Only lanes of the matching kind are candidates: an audio track has no
   * meaning on a clip lane, and the validator rejects the document either way.
   */
  const laneUnder = (d, dy) => {
    if (d.edge !== 'move' || d.lane0 < 0) return null;
    const want = d.lane0 + Math.round(dy / LANE_H);
    const lane = lanesRef.current[want];
    const kind = d.kind === 'audio' ? 'audio' : 'clip';
    if (!lane || lane.track.kind !== kind) return null;
    return lane.track.id;
  };

  useEffect(() => {
    const move = (e) => {
      const d = dragRef.current;
      if (!d) return;
      const dt = (e.clientX - d.x0) / pxPerSec;
      const opts = { coalesce: d.tag };
      const skip = { kind: d.kind, id: d.id, index: d.index, pageId: d.pageId };
      // Folded into the same patch as the horizontal move so the whole gesture
      // stays one coalesced undo step.
      const trackId = laneUnder(d, e.clientY - d.y0);
      const lane = trackId ? { trackId } : null;

      if (d.kind === 'pageBreak') {
        ed.patchPageBreak(d.index, { t: Math.max(0, snap(d.base.start + dt, skip)) }, opts);
        return;
      }

      if (d.kind === 'camera') {
        // Retimes the keyframe only, never its framing -- dragging a diamond
        // sideways asks "make the push happen later", not "point it elsewhere".
        ed.patchCameraKeyframe(d.pageId, d.index,
          { t: Math.max(0, snap(d.base.start + dt, skip)) }, opts);
        return;
      }

      if (d.kind === 'audio') {
        const b = d.base;
        if (d.edge === 'move') {
          // No clamping here: patchAudio runs the result through audioSlot,
          // which slides the whole block clear of its neighbours. trimIn is
          // untouched by a move, so relocating it is always safe.
          ed.patchAudio(d.id, {
            start: Math.max(0, snap(b.start + dt, skip)),
            ...lane,
          }, opts);
          return;
        }

        // The trim edges are clamped here instead, against the neighbours
        // directly. audioSlot would happily relocate the block to make room --
        // correct for a move, wrong for a trim, where `start` and `trimIn` have
        // to move by the same amount or the waveform slides under the window.
        const { prevEnd, nextStart } = audioNeighbours(doc, d.id);
        if (d.edge === 'start') {
          // Left grip: the in-point follows the edge, in *source* seconds.
          const floor = Math.max(prevEnd, b.start - b.trimIn / b.speed);
          const ceiling = b.duration != null
            ? b.start + b.duration - MIN_AUDIO
            : Infinity;
          // `snap` already lands on a tenth or on a neighbour's exact edge; the
          // clamps below can only tighten it, so nothing is re-rounded here.
          // The right edge is held fixed rather than derived from a rounded
          // length, so trimming the head never nudges the tail.
          const start = Math.min(ceiling, Math.max(floor, snap(b.start + dt, skip)));
          ed.patchAudio(d.id, {
            start: round3(start),
            trimIn: round3(b.trimIn + (start - b.start) * b.speed),
            ...(b.duration == null
              ? {}
              : { duration: round3(b.start + b.duration - start) }),
          }, opts);
        } else if (d.edge === 'end') {
          // Right grip: length only. The recording itself is the other stop --
          // dragging past its last sample would only add silence.
          const srcLen = mediaBySrc?.[doc.audio.find((a) => a.id === d.id)?.src]?.duration;
          const maxLen = srcLen != null
            ? Math.max(MIN_AUDIO, (srcLen - b.trimIn) / b.speed)
            : Infinity;
          const end = Math.min(nextStart, snap(b.start + (b.duration ?? 0) + dt, skip));
          const duration = Math.min(maxLen, Math.max(MIN_AUDIO, end - b.start));
          ed.patchAudio(d.id, { duration: round3(duration) }, opts);
        }
        return;
      }

      const b = d.base;
      if (d.edge === 'move') {
        const start = Math.max(0, snap(b.start + dt, skip));
        const shift = start - b.start;
        // The clip's page travels with it, exactly as its erase sweep does. A
        // clip may not draw while its page is off screen, so dragging one past
        // a page break without re-homing it would make the document illegal
        // mid-gesture and blank the stage. Folded into this same patch, the
        // whole drag stays one coalesced undo step and every intermediate
        // frame is valid.
        ed.patchClip(d.id, {
          start,
          pageId: pageAt(doc, start),
          erase: b.erase && { ...b.erase, start: Math.max(0, b.erase.start + shift) },
          ...lane,
        }, opts);
      } else if (d.edge === 'start') {
        const start = Math.max(0, Math.min(b.start + b.duration - 0.1, snap(b.start + dt, skip)));
        ed.patchClip(d.id, { start, duration: round1(b.start + b.duration - start) }, opts);
      } else if (d.edge === 'end') {
        const end = Math.max(b.start + 0.1, snap(b.start + b.duration + dt, skip));
        const duration = round1(end - b.start);
        ed.patchClip(d.id, {
          duration,
          // Keep the wipe legal: it may never begin before the ink is down.
          erase: b.erase && {
            ...b.erase,
            start: Math.max(b.erase.start, round1(b.start + duration + 0.1)),
          },
        }, opts);
      } else if (d.edge === 'eraseMove') {
        const start = Math.max(b.start + b.duration, snap(b.erase.start + dt, skip));
        ed.patchClip(d.id, { erase: { ...b.erase, start } }, opts);
      } else if (d.edge === 'eraseEnd') {
        const duration = Math.max(0.1, round1(b.erase.duration + dt));
        ed.patchClip(d.id, { erase: { ...b.erase, duration } }, opts);
      }
    };
    const up = () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      ed.endGesture();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [ed, doc, pxPerSec, snap, mediaBySrc]);

  // ── scrubbing ─────────────────────────────────────────────────────
  const scrubbing = useRef(false);
  const scrubTo = useCallback((clientX) => {
    const el = scrollRef.current;
    if (!el) return;
    const x = clientX - el.getBoundingClientRect().left + el.scrollLeft;
    onSeek(Math.round((x / pxPerSec) * fps));
  }, [onSeek, pxPerSec, fps]);

  useEffect(() => {
    const move = (e) => { if (scrubbing.current) scrubTo(e.clientX); };
    const up = () => { scrubbing.current = false; };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [scrubTo]);

  // Lane headers scroll vertically with the lanes but must not scroll sideways.
  const onScroll = (e) => {
    if (headsRef.current) headsRef.current.scrollTop = e.currentTarget.scrollTop;
  };

  // ── ruler ─────────────────────────────────────────────────────────
  const ticks = useMemo(() => {
    const step = STEPS.find((s) => s * pxPerSec >= 56) ?? STEPS[STEPS.length - 1];
    const minor = step / (step * pxPerSec >= 140 ? 4 : 2);
    const out = [];
    for (let t = 0; t <= total; t = round1(t + minor)) {
      const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
      out.push({ t, major });
    }
    return out;
  }, [pxPerSec, total]);

  // ── panel resize ──────────────────────────────────────────────────
  const onResize = (e) => {
    e.preventDefault();
    const y0 = e.clientY;
    const h0 = height;
    const move = (ev) => setHeight(Math.max(150, Math.min(560, h0 - (ev.clientY - y0))));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const toggleMute = (id) => setMutedTracks((cur) => {
    const next = new Set(cur);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  /** What a block says when it is only a few pixels wide: the asset itself. */
  const clipTitle = (c, asset) => {
    const what = asset.kind === 'text'
      ? (asset.text || '').split('\n')[0] || 'Text'
      : (asset.src || '').split('/').pop();
    return `${what} — ${c.start}s for ${c.duration}s`;
  };

  return (
    <>
      <div className="tl-resize" onPointerDown={onResize} />
      <div className="timeline" style={{ '--tl-height': `${height}px` }}>
        <div className="tl-bar">
          <span className="panel-title">Timeline</span>
          <span className="pill">{doc.clips.length} clip{doc.clips.length === 1 ? '' : 's'}</span>
          {doc.audio.length > 0 && <span className="pill">{doc.audio.length} audio</span>}
          <span className="pill">{lanes.length} lane{lanes.length === 1 ? '' : 's'}</span>

          <div className="spacer" />

          <button className="btn quiet" title="Add a page and swipe to it, after everything authored so far"
                  onClick={() => ed.addPageBreak({ t: time })}>
            <Icon d={PATH.page} /> Page
          </button>
          <button className="btn quiet"
                  title="Pin the framing that is live right now, so a later move starts from here"
                  disabled={!activePageId}
                  onClick={() => ed.addCameraKeyframe(activePageId, time)}>
            <Icon d={PATH.plus} /> Camera
          </button>
          <button className="btn quiet" title="Add an empty video lane"
                  onClick={() => ed.addTrack('clip')}>
            <Icon d={PATH.plus} /> Lane
          </button>
          <button className="btn quiet" title="Add an empty audio lane"
                  onClick={() => ed.addTrack('audio')}>
            <Icon d={PATH.plus} /> Audio
          </button>
          {/* Razor. Only ever cuts audio -- a drawing has strokes in progress
              at any interior instant and splitting one would need a rule for
              what happens to the pen, which is a different feature. */}
          <button className="btn quiet icon" title="Split audio at the playhead (S)"
                  disabled={!splittable}
                  onClick={() => ed.splitAudio(selection.id, time)}>
            <Icon d={PATH.cut} />
          </button>
          <button className="btn quiet icon" title="Delete selected clip (Del)"
                  disabled={selection?.type !== 'clip' && selection?.type !== 'audio'}
                  onClick={() => {
                    if (selection.type === 'clip') ed.removeClip(selection.id);
                    else ed.removeAudio(selection.id);
                    setSelection(null);
                  }}>
            <Icon d={PATH.trash} />
          </button>
          <span style={{ color: 'var(--text-faint)' }}>Zoom</span>
          <input
            type="range" min={16} max={320} step={4} value={pxPerSec}
            // --fill draws the track's filled portion; CSS cannot read a
            // range's value on its own.
            style={{ width: 110, '--fill': `${((pxPerSec - 16) / (320 - 16)) * 100}%` }}
            onChange={(e) => setPxPerSec(Number(e.target.value))}
          />
        </div>

        <div className="tl-body">
          <div className="tl-heads" ref={headsRef}>
            <div className="tl-head-spacer" />
            <div className="tl-head" data-kind="page">
              <span className="swatch" style={{ background: 'var(--lane-page)' }} />
              <span className="name">Pages</span>
              <span className="count">{doc.pages.length}</span>
            </div>
            <div className="tl-head" data-kind="camera">
              <span className="swatch" style={{ background: 'var(--lane-camera)' }} />
              <span className="name">Camera</span>
              <span className="count">
                {doc.pages.reduce((n, p) => n + (p.cameraKeyframes?.length || 0), 0)}
              </span>
            </div>
            {lanes.map(({ track, clips, audio }) => (
              <TrackHead
                key={track.id}
                track={track}
                count={track.kind === 'audio' ? audio.length : clips.length}
                canRemove={kindCount(track.kind) > 1}
                muted={mutedTracks.has(track.id)}
                onMute={() => toggleMute(track.id)}
                onRename={(name) => ed.renameTrack(track.id, name)}
                onRemove={() => ed.removeTrack(track.id)}
              />
            ))}
          </div>

          <div className="tl-scroll" ref={scrollRef} onScroll={onScroll}>
            <div className="tl-canvas" style={{ width }}>
              <div
                className="tl-ruler"
                onPointerDown={(e) => { scrubbing.current = true; scrubTo(e.clientX); }}
              >
                {ticks.map(({ t, major }) => (
                  <div key={t} className={major ? 'tl-tick' : 'tl-tick minor'}
                       style={{ left: t * pxPerSec }}>
                    {major && <span>{t >= 60 ? `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}` : `${t}s`}</span>}
                  </div>
                ))}
              </div>

              <PageLane
                doc={doc}
                pxPerSec={pxPerSec}
                selection={selection}
                setSelection={setSelection}
                onBreakDown={(e, index) => onDrag(e, { kind: 'pageBreak', index, edge: 'move' })}
              />

              <CameraLane
                doc={doc}
                pxPerSec={pxPerSec}
                selection={selection}
                setSelection={setSelection}
                onKeyDown={(e, pageId, index) => onDrag(e, {
                  kind: 'camera', pageId, index, edge: 'move',
                })}
              />

              {doc.clips.length === 0 && doc.audio.length === 0 && (
                <div className="tl-empty">
                  Add a clip from the Library and it appears here.
                </div>
              )}

              {lanes.map(({ track, clips, audio }) => (
                <div className="tl-lane" key={track.id} data-kind={track.kind}>
                  {clips.map((c) => {
                    const asset = doc.assets[c.assetId] || {};
                    const sel = selection?.type === 'clip' && selection.id === c.id;
                    const select = () => setSelection({ type: 'clip', id: c.id });
                    return (
                      <React.Fragment key={c.id}>
                        <Block
                          cls={asset.kind || 'image'}
                          left={c.start * pxPerSec}
                          width={c.duration * pxPerSec}
                          label={asset.kind === 'text' ? 'Write' : 'Draw'}
                          title={clipTitle(c, asset)}
                          selected={sel}
                          resizable
                          onSelect={select}
                          onDown={(e, edge) => onDrag(e, { kind: 'clip', id: c.id, edge })}
                        />
                        {c.erase && (
                          <Block
                            cls="erase"
                            left={c.erase.start * pxPerSec}
                            width={c.erase.duration * pxPerSec}
                            label="Erase"
                            title={`Wipe — ${c.erase.start}s for ${c.erase.duration}s`}
                            selected={sel}
                            resizable
                            onSelect={select}
                            onDown={(e, edge) => onDrag(e, {
                              kind: 'clip',
                              id: c.id,
                              edge: edge === 'end' ? 'eraseEnd' : 'eraseMove',
                            })}
                          />
                        )}
                      </React.Fragment>
                    );
                  })}

                  {laneGaps(audio).map((g) => (
                    <Gap
                      key={`gap${g.start}`}
                      left={g.start * pxPerSec}
                      width={(g.end - g.start) * pxPerSec}
                      onClose={() => ed.closeAudioGap(track.id, (g.start + g.end) / 2)}
                    />
                  ))}

                  {audio.map(({ a }) => (
                    <AudioClip
                      key={a.id}
                      track={a}
                      peaks={mediaBySrc?.[a.src]?.peaks}
                      pxPerSec={pxPerSec}
                      duration={a.duration || 4}
                      selected={selection?.type === 'audio' && selection.id === a.id}
                      onSelect={() => setSelection({ type: 'audio', id: a.id })}
                      onDrag={onDrag}
                    />
                  ))}
                </div>
              ))}

              <div className="tl-playhead" style={{ left: time * pxPerSec }} />
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
