import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Icon, PATH } from './common.jsx';
import StageOverlay from './StageOverlay.jsx';
import { clipRect } from '../stageGeom.js';

const ZOOMS = [['fit', 'Fit'], [0.25, '25%'], [0.5, '50%'], [1, '100%']];
const PAD = 28;

/**
 * Measure the stage and size the canvas box explicitly.
 *
 * `max-height: 100%` cannot do this job: the percentage resolves against a
 * parent whose own height is content-derived, so it is ignored and the canvas
 * overflows the panel and slides under the transport bar.
 */
function useFitScale(ref, w, h, zoom) {
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(([e]) => {
      const r = e.contentRect;
      setBox({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);

  if (zoom !== 'fit') return zoom;
  if (!box.w || !box.h) return 0.25;
  return Math.max(0.02, Math.min(1, (box.w - PAD) / w, (box.h - PAD) / h));
}

const clock = (secs) => {
  const s = Math.max(0, secs);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:`
       + `${String(Math.floor(s % 60)).padStart(2, '0')}.`
       + `${String(Math.floor((s % 1) * 100)).padStart(2, '0')}`;
};

export default function Stage({
  canvasRef, meta, frame, frames, playing, onPlay, onSeek,
  zoom, setZoom, guides, setGuides, showHand, setShowHand,
  status, error, exporting, dropping,
  hasAudio, muted, setMuted, volume, setVolume,
  ed, cam, pageId, pageName, pageCount, bboxes, selection, setSelection, onDropAsset,
}) {
  const fps = meta.fps || 30;
  const stageRef = useRef(null);
  const scale = useFitScale(stageRef, meta.width, meta.height, zoom);
  // The canvas is authored at project resolution; zoom only changes its CSS
  // box, so the rendered pixels stay exactly what export produces.
  const size = { width: Math.round(meta.width * scale), height: Math.round(meta.height * scale) };

  // Screen boxes for every clip that has started *on the page being shown*, in
  // draw order -- hit-testing walks this backwards so the topmost clip wins.
  // Without the page filter the stage offers handles for artwork that is not on
  // screen, and clicking empty paper selects a clip from another sheet.
  const boxes = useMemo(() => {
    if (!bboxes || !ed) return [];
    const t = frame / fps;
    return ed.doc.clips
      .filter((c) => c.pageId === pageId)
      .filter((c) => bboxes.has(c.id) && t >= c.start)
      .map((c) => ({
        id: c.id,
        bbox: bboxes.get(c.id),
        rect: clipRect(meta, cam, scale, c.transform, bboxes.get(c.id)),
      }));
  }, [ed, bboxes, meta, cam, scale, frame, fps, pageId]);

  return (
    <div className="panel stage-wrap">
      <div className="stage" ref={stageRef}>
        <div className="stage-inner" style={size}>
          <canvas ref={canvasRef} style={size} />
          {guides && <div className="guides" />}
          {ed && boxes.length > 0 && !status && (
            <StageOverlay
              ed={ed}
              meta={meta}
              cam={cam}
              fit={scale}
              boxes={boxes}
              selection={selection}
              setSelection={setSelection}
              onDropAsset={onDropAsset}
            />
          )}
        </div>

        {dropping && <div className="dropzone">Drop to import</div>}

        {error && (
          <div className="overlay">
            <div>
              <div className="title">Could not load project</div>
              <pre>{error}</pre>
            </div>
          </div>
        )}

        {!error && status && (
          <div className="overlay">
            <div>
              <div className="spinner" />
              <div className="title">{status.title}</div>
              <div className="sub">{status.detail}</div>
              {status.progress != null && (
                <div className="progress">
                  <div style={{ width: `${Math.round(status.progress * 100)}%` }} />
                </div>
              )}
            </div>
          </div>
        )}

        {!error && !status && frames === 0 && (
          <div className="overlay">
            <div>
              <div className="title">No clips yet</div>
              <div className="sub">
                Import an image from the Library, or add a line of text. Clips
                land on the timeline below and can be dragged to retime.
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="stage-bar">
        <button className="btn quiet icon" title="Go to start (Home)"
                onClick={() => onSeek(0)} disabled={!frames}>
          <Icon d={PATH.start} />
        </button>
        <button className="btn icon" title="Play / pause (Space)"
                onClick={onPlay} disabled={!frames || exporting}>
          <Icon d={playing ? PATH.pause : PATH.play} />
        </button>
        <button className="btn quiet icon" title="Go to end (End)"
                onClick={() => onSeek(frames - 1)} disabled={!frames}>
          <Icon d={PATH.end} />
        </button>

        {/* Monitoring only: this never reaches the document, so a muted preview
            still exports with full audio. */}
        <div className="vol" title={hasAudio
          ? 'Preview volume — does not affect export'
          : 'No audio tracks in this project'}>
          <button className="btn quiet icon" disabled={!hasAudio}
                  aria-pressed={muted}
                  onClick={() => setMuted(!muted)}>
            <Icon d={muted ? PATH.speakerOff : PATH.speaker} />
          </button>
          <input type="range" min={0} max={1} step={0.02}
                 value={muted ? 0 : volume} disabled={!hasAudio}
                 onChange={(e) => { setVolume(Number(e.target.value)); setMuted(false); }} />
        </div>

        <span className="time-read">
          <b>{clock(frame / fps)}</b> / {clock(Math.max(0, frames - 1) / fps)}
          <span className="dim">
            {' · '}frame {frame} · {meta.width}×{meta.height} @ {fps}fps
            {pageCount > 1 && ` · ${pageName}`}
          </span>
        </span>

        <div className="spacer" />

        <label className="check" title="Toggle the drawing hand (H)">
          <input type="checkbox" checked={showHand}
                 onChange={(e) => setShowHand(e.target.checked)} />
          Hand
        </label>
        <label className="check" title="Rule-of-thirds guides (G)">
          <input type="checkbox" checked={guides}
                 onChange={(e) => setGuides(e.target.checked)} />
          Guides
        </label>

        <div className="seg">
          {ZOOMS.map(([v, label]) => (
            <button key={label} aria-pressed={zoom === v} onClick={() => setZoom(v)}>
              {v === 'fit' && zoom === 'fit' ? `Fit ${Math.round(scale * 100)}%` : label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
