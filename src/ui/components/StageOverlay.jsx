/**
 * Direct manipulation on the stage: click to select, drag to move, corner
 * handles to resize.
 *
 * Sits as a transparent layer exactly over the canvas. It never draws artwork
 * -- `renderFrame` owns every pixel that ends up in the export, and a
 * selection box that could leak into a render would be a bug. This layer is
 * DOM, so it cannot.
 */

import React, { useCallback, useEffect, useRef } from 'react';
import {
  HANDLES, handleAnchors, hitTest, resizeTransform, rotateTransform,
  screenToWorld, worldPerPixel,
} from '../stageGeom.js';

/** Zoom the wheel may reach directly. Beyond this, type it in the inspector. */
const CAM_ZOOM = [0.1, 20];

/** deltaY -> zoom factor. Tuned so one notch on a mouse wheel is ~15%. */
const WHEEL_K = 0.0015;

const clampZoom = (z) => Math.min(CAM_ZOOM[1], Math.max(CAM_ZOOM[0], z));

/**
 * Round a transform field before it lands in the document.
 *
 * Three places is finer than a pixel at any zoom the stage offers, and it keeps
 * a saved project readable instead of full of 0.7999999999999999.
 */
const round3 = (v) => Math.round(v * 1000) / 1000;

export default function StageOverlay({
  ed, meta, cam, fit, boxes, camera, pageId, time, selection, setSelection, onDropAsset,
}) {
  const ref = useRef(null);
  const dragRef = useRef(null);

  const at = useCallback((e) => {
    const r = ref.current.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }, []);

  const begin = useCallback((e, mode, id, handle) => {
    e.preventDefault();
    e.stopPropagation();
    const clip = ed.doc.clips.find((c) => c.id === id);
    if (!clip) return;
    const p = at(e);
    dragRef.current = {
      mode, id, handle,
      // Bind the gesture to the pointer that started it. Resizing changes the
      // layout under the cursor, and Chromium answers a layout change with a
      // synthetic pointermove at the *real* cursor position -- which feeds
      // straight back into the resize and runs away. Only the originating
      // pointer may drive the drag.
      pointerId: e.pointerId,
      start: p,
      base: { ...clip.transform },
      bbox: boxes.find((b) => b.id === id)?.bbox,
      // One tag for the whole gesture, so a drag is a single undo step.
      tag: `stage:${id}:${mode}${handle || ''}`,
    };
  }, [ed.doc.clips, boxes, at]);

  /**
   * Start a camera pan. Unlike a clip drag there is nothing to hit-test: the
   * gesture belongs to the page, so anywhere on the paper will do.
   */
  const beginPan = useCallback((e) => {
    e.preventDefault();
    dragRef.current = {
      mode: 'pan',
      pointerId: e.pointerId,
      start: at(e),
      base: { ...cam },
      tag: `cam:${pageId}:pan`,
    };
  }, [at, cam, pageId]);

  const onMove = useCallback((e) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const p = at(e);

    if (d.mode === 'pan') {
      // The camera travels *against* the drag: dragging the paper right must
      // bring what is off the left edge into view, which means decreasing x.
      // Zoom is read from the gesture's own base so a coalesced repaint
      // part-way through cannot change the pixels-to-world ratio mid-drag.
      const k = 1 / (d.base.zoom * fit);
      ed.setCameraAt(pageId, time, {
        x: d.base.x - (p.x - d.start.x) * k,
        y: d.base.y - (p.y - d.start.y) * k,
        zoom: d.base.zoom,
      }, { coalesce: d.tag });
    } else if (d.mode === 'move') {
      // A screen delta is not a world delta: divide out both the camera zoom
      // and the stage's fit scale, or the artwork races the pointer.
      const k = worldPerPixel(cam, fit);
      ed.patchClip(d.id, {
        transform: {
          ...d.base,
          x: Math.round(d.base.x + (p.x - d.start.x) * k),
          y: Math.round(d.base.y + (p.y - d.start.y) * k),
        },
      }, { coalesce: d.tag });
    } else if ((d.mode === 'resize' || d.mode === 'rotate') && d.bbox) {
      const w = screenToWorld(meta, cam, fit, p.x, p.y);
      // Modifiers are read live rather than from the pointerdown: a person
      // reaches for shift *after* starting the drag, once they can see what the
      // unconstrained version is doing.
      const next = d.mode === 'rotate'
        ? rotateTransform(d.base, d.bbox, w.x, w.y, { snap: e.shiftKey })
        : resizeTransform(d.base, d.bbox, d.handle, w.x, w.y, { free: e.shiftKey });
      ed.patchClip(d.id, {
        transform: {
          ...d.base,
          x: Math.round(next.x),
          y: Math.round(next.y),
          scale: round3(next.scale),
          scaleX: round3(next.scaleX),
          scaleY: round3(next.scaleY),
          rotation: round3(next.rotation),
        },
      }, { coalesce: d.tag });
    }
  }, [ed, meta, cam, fit, at, pageId, time]);

  const onUp = useCallback((e) => {
    const d = dragRef.current;
    if (!d || (e && e.pointerId !== d.pointerId)) return;
    dragRef.current = null;
    ed.endGesture();
  }, [ed]);

  // Move and release are tracked on window, not the overlay: a drag that
  // leaves the stage must keep working, and releasing outside must still end
  // the gesture rather than leaving it stuck down.
  useEffect(() => {
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [onMove, onUp]);

  const onDown = useCallback((e) => {
    if (camera) { beginPan(e); return; }
    const p = at(e);
    const id = hitTest(boxes, p.x, p.y);
    setSelection(id ? { type: 'clip', id } : null);
    if (id) begin(e, 'move', id);
  }, [camera, beginPan, boxes, at, begin, setSelection]);

  // Wheel zoom, about the cursor.
  //
  // A native non-passive listener rather than React's onWheel: React attaches
  // wheel at the root as passive, so preventDefault() there is ignored and the
  // whole workspace scrolls under the zoom.
  //
  // The live inputs go through a ref so the listener is attached once. Re-
  // binding it on every camera change would tear it down mid-gesture during
  // playback, when `cam` moves on every frame.
  const wheelRef = useRef(null);
  wheelRef.current = { ed, meta, cam, fit, pageId, time, camera };

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    let idle = null;
    const onWheel = (e) => {
      const s = wheelRef.current;
      if (!s.camera) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      const zoom = clampZoom(s.cam.zoom * Math.exp(-e.deltaY * WHEEL_K));
      // Hold the world point under the cursor still, which is what makes a
      // wheel zoom feel like it is aimed rather than merely scaled. Solved by
      // inverting screenToWorld for the new zoom; see stageGeom.js.
      const w = screenToWorld(s.meta, s.cam, s.fit, px, py);
      s.ed.setCameraAt(s.pageId, s.time, {
        x: w.x - (px / s.fit - s.meta.width / 2) / zoom,
        y: w.y - (py / s.fit - s.meta.height / 2) / zoom,
        zoom,
      }, { coalesce: `cam:${s.pageId}:wheel` });
      // A wheel gesture has no release event, so close the undo step once the
      // notches stop. Without it the next unrelated edit merges into the zoom.
      clearTimeout(idle);
      idle = setTimeout(() => s.ed.endGesture(), 400);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      clearTimeout(idle);
      el.removeEventListener('wheel', onWheel);
    };
  }, []);

  // Handles and outlines are hidden while the camera tool is live: they belong
  // to a gesture that is not available, and leaving them up invites the user to
  // grab a corner that will pan the page instead of resizing the artwork.
  const selected = !camera && selection?.type === 'clip'
    ? boxes.find((b) => b.id === selection.id)
    : null;
  const anchors = selected ? handleAnchors(selected.corners) : null;

  return (
    <div
      className={`stage-overlay${camera ? ' camera' : ''}`}
      ref={ref}
      onPointerDown={onDown}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
      onDrop={(e) => {
        const raw = e.dataTransfer.getData('application/x-studio-asset');
        if (!raw) return;                    // an OS file drop; App handles it
        e.preventDefault();
        e.stopPropagation();
        const p = at(e);
        onDropAsset(JSON.parse(raw), screenToWorld(meta, cam, fit, p.x, p.y));
      }}
    >
      {/* Faint outline on every clip so the user can see what is grabbable.
          An SVG polygon rather than a CSS box: once a clip can be rotated, a
          rectangle is no longer the shape of anything on screen. */}
      {!camera && boxes.length > 0 && (
        <svg className="stage-outlines" width="100%" height="100%">
          {boxes.map((b) => (
            <polygon
              key={b.id}
              className={`stage-box${selected?.id === b.id ? ' sel' : ''}`}
              points={b.corners.map((p) => `${p.x},${p.y}`).join(' ')}
            />
          ))}
        </svg>
      )}

      {anchors && (
        <>
          <div
            className="stage-handle rot"
            style={{ left: anchors.rot.x, top: anchors.rot.y }}
            title="Drag to rotate; hold Shift to snap to 15°"
            onPointerDown={(e) => begin(e, 'rotate', selected.id)}
          />
          {HANDLES.map((h) => (
            <div
              key={h}
              className={`stage-handle ${h}`}
              style={{ left: anchors[h].x, top: anchors[h].y }}
              title={h.length === 2
                ? 'Drag to resize; hold Shift to stretch both axes freely'
                : 'Drag to squeeze this axis; drag past the far edge to flip'}
              onPointerDown={(e) => begin(e, 'resize', selected.id, h)}
            />
          ))}
        </>
      )}
    </div>
  );
}
