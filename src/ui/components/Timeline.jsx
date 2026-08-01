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
import { Icon, PATH } from './common.jsx';

const SNAP_PX = 6;
/** Must match `.tl-lane` height in app.css; vertical drags are measured in it. */
const LANE_H = 30;
/** Coarse-to-fine ruler steps; the first one wide enough on screen wins. */
const STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];

const round1 = (t) => Math.round(t * 10) / 10;

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

function AudioClip({ track, index, peaks, pxPerSec, duration, selected, onSelect, onDrag }) {
  const width = Math.max(6, duration * pxPerSec);
  const ref = useWaveform(peaks, width, 22);
  const name = track.src.split('/').pop();
  return (
    <div
      className={`tl-clip audio${selected ? ' sel' : ''}`}
      style={{ left: (track.start || 0) * pxPerSec, width }}
      title={name}
      onPointerDown={(e) => { onSelect(); onDrag(e, { kind: 'audio', index, edge: 'move' }); }}
    >
      <canvas ref={ref} />
      <span className="label">{name}</span>
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
  ed, selection, setSelection, frame, fps, frames, onSeek, peaksBySrc, height, setHeight,
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
    doc.audio.forEach((a, i) => {
      if (skip?.kind === 'audio' && skip.index === i) return;
      pts.push(a.start || 0);
    });
    // Both edges of every transition. Clips want to butt up against these more
    // than against anything else: a draw must begin after the swipe lands.
    doc.pageBreaks.forEach((b, i) => {
      if (skip?.kind === 'pageBreak' && skip.index === i) return;
      pts.push(b.t, b.t + b.duration);
    });
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
    const item = clip || (target.kind === 'audio' ? doc.audio[target.index] : null);
    const base = clip
      ? { start: clip.start, duration: clip.duration, erase: clip.erase }
      : target.kind === 'pageBreak'
        ? { start: doc.pageBreaks[target.index].t }
        : { start: doc.audio[target.index]?.start || 0 };
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
      const skip = { kind: d.kind, id: d.id, index: d.index };
      // Folded into the same patch as the horizontal move so the whole gesture
      // stays one coalesced undo step.
      const trackId = laneUnder(d, e.clientY - d.y0);
      const lane = trackId ? { trackId } : null;

      if (d.kind === 'pageBreak') {
        ed.patchPageBreak(d.index, { t: Math.max(0, snap(d.base.start + dt, skip)) }, opts);
        return;
      }

      if (d.kind === 'audio') {
        ed.patchAudio(d.index, {
          start: Math.max(0, snap(d.base.start + dt, skip)),
          ...lane,
        }, opts);
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
  }, [ed, doc, pxPerSec, snap]);

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
          <button className="btn quiet" title="Add an empty video lane"
                  onClick={() => ed.addTrack('clip')}>
            <Icon d={PATH.plus} /> Lane
          </button>
          <button className="btn quiet" title="Add an empty audio lane"
                  onClick={() => ed.addTrack('audio')}>
            <Icon d={PATH.plus} /> Audio
          </button>
          <button className="btn quiet icon" title="Delete selected clip (Del)"
                  disabled={selection?.type !== 'clip'}
                  onClick={() => { ed.removeClip(selection.id); setSelection(null); }}>
            <Icon d={PATH.trash} />
          </button>
          <span style={{ color: 'var(--text-faint)' }}>Zoom</span>
          <input
            type="range" min={16} max={320} step={4} value={pxPerSec}
            style={{ width: 110 }}
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
                          label={c.animId === 'draw.handwrite' ? 'Write' : 'Draw'}
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

                  {audio.map(({ a, i }) => (
                    <AudioClip
                      key={`a${i}`}
                      track={a}
                      index={i}
                      peaks={peaksBySrc[a.src]}
                      pxPerSec={pxPerSec}
                      duration={a.duration || 4}
                      selected={selection?.type === 'audio' && selection.index === i}
                      onSelect={() => setSelection({ type: 'audio', index: i })}
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
