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
  CORNERS, clipRect, hitTest, resizeTransform, screenToWorld, worldPerPixel,
} from '../stageGeom.js';

export default function StageOverlay({
  ed, meta, cam, fit, boxes, selection, setSelection, onDropAsset,
}) {
  const ref = useRef(null);
  const dragRef = useRef(null);

  const at = useCallback((e) => {
    const r = ref.current.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }, []);

  const begin = useCallback((e, mode, id, corner) => {
    e.preventDefault();
    e.stopPropagation();
    const clip = ed.doc.clips.find((c) => c.id === id);
    if (!clip) return;
    const p = at(e);
    dragRef.current = {
      mode, id, corner,
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
      tag: `stage:${id}:${mode}${corner || ''}`,
    };
  }, [ed.doc.clips, boxes, at]);

  const onMove = useCallback((e) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const p = at(e);

    if (d.mode === 'move') {
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
    } else if (d.mode === 'resize' && d.bbox) {
      const w = screenToWorld(meta, cam, fit, p.x, p.y);
      const next = resizeTransform(d.base, d.bbox, d.corner, w.x, w.y);
      ed.patchClip(d.id, {
        transform: {
          ...d.base,
          x: Math.round(next.x),
          y: Math.round(next.y),
          scale: Math.round(next.scale * 1000) / 1000,
        },
      }, { coalesce: d.tag });
    }
  }, [ed, meta, cam, fit, at]);

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
    const p = at(e);
    const id = hitTest(boxes, p.x, p.y);
    setSelection(id ? { type: 'clip', id } : null);
    if (id) begin(e, 'move', id);
  }, [boxes, at, begin, setSelection]);

  const selected = selection?.type === 'clip'
    ? boxes.find((b) => b.id === selection.id)
    : null;

  return (
    <div
      className="stage-overlay"
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
      {/* Faint outline on every clip so the user can see what is grabbable. */}
      {boxes.map((b) => (
        <div
          key={b.id}
          className={`stage-box${selected?.id === b.id ? ' sel' : ''}`}
          style={b.rect}
        />
      ))}

      {selected && CORNERS.map((corner) => (
        <div
          key={corner}
          className={`stage-handle ${corner}`}
          style={{
            left: selected.rect.left + (corner === 'ne' || corner === 'se' ? selected.rect.width : 0),
            top: selected.rect.top + (corner === 'se' || corner === 'sw' ? selected.rect.height : 0),
          }}
          onPointerDown={(e) => begin(e, 'resize', selected.id, corner)}
        />
      ))}
    </div>
  );
}
