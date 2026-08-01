/**
 * Stage coordinate maths for direct manipulation.
 *
 * Three spaces are in play and mixing them up is the whole difficulty:
 *
 *   local   the drawable's own units, which is what plan.bbox is in
 *   world   the page; a clip sits at transform.{x,y} scaled by transform.scale
 *   screen  CSS pixels in the stage, i.e. canvas pixels times the fit scale
 *
 * `renderFrame` composes these as:
 *   canvas = size/2 + (world - camera) * camera.zoom
 *   world  = transform.{x,y} + local * transform.scale
 *
 * Kept DOM-free so the mapping can be tested directly -- an off-by-one here
 * shows up as handles that drift away from the artwork, which is tedious to
 * chase by eye.
 */

/** @typedef {{x:number, y:number, scale:number, rotation?:number}} Transform */
/** @typedef {{width:number, height:number}} Meta */
/** @typedef {{x:number, y:number, zoom:number}} Camera */

/** local -> world */
export function localToWorld(tr, lx, ly) {
  return { x: tr.x + lx * tr.scale, y: tr.y + ly * tr.scale };
}

/** world -> screen (CSS px within the stage) */
export function worldToScreen(meta, cam, fit, wx, wy) {
  return {
    x: (meta.width / 2 + (wx - cam.x) * cam.zoom) * fit,
    y: (meta.height / 2 + (wy - cam.y) * cam.zoom) * fit,
  };
}

/** screen -> world; the inverse of worldToScreen, used for every drag delta */
export function screenToWorld(meta, cam, fit, sx, sy) {
  return {
    x: (sx / fit - meta.width / 2) / cam.zoom + cam.x,
    y: (sy / fit - meta.height / 2) / cam.zoom + cam.y,
  };
}

/** How many world units one screen pixel covers. */
export const worldPerPixel = (cam, fit) => 1 / (cam.zoom * fit);

/**
 * Screen-space rectangle for a clip, from its local bbox.
 *
 * Rotation is deliberately not applied: the box is used for hit-testing and
 * for handles, and an axis-aligned box around a rotated drawable is still a
 * correct, if loose, selection target. Rotation is edited numerically.
 *
 * @returns {{left:number, top:number, width:number, height:number}}
 */
export function clipRect(meta, cam, fit, tr, bbox) {
  const w0 = localToWorld(tr, bbox[0], bbox[1]);
  const w1 = localToWorld(tr, bbox[2], bbox[3]);
  const a = worldToScreen(meta, cam, fit, w0.x, w0.y);
  const b = worldToScreen(meta, cam, fit, w1.x, w1.y);
  return {
    left: Math.min(a.x, b.x),
    top: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

/** Corner order used by both the handle rendering and the resize maths. */
export const CORNERS = ['nw', 'ne', 'se', 'sw'];

/** The local-space point a given corner refers to, and its opposite. */
export function cornerPoints(bbox, corner) {
  const [x0, y0, x1, y1] = bbox;
  const pt = {
    nw: [x0, y0], ne: [x1, y0], se: [x1, y1], sw: [x0, y1],
  };
  const opposite = { nw: 'se', ne: 'sw', se: 'nw', sw: 'ne' };
  return { grabbed: pt[corner], anchor: pt[opposite[corner]] };
}

export const MIN_SCALE = 0.02;

/**
 * New transform for dragging `corner` to world point `(wx, wy)`.
 *
 * Scaling is uniform and anchored on the opposite corner, so that corner stays
 * put under the pointer's expectations. Non-uniform scaling is not offered:
 * `transform` carries a single `scale`, and the compiled stroke geometry --
 * including brush widths chosen from it -- assumes the drawable is not
 * distorted.
 *
 * @returns {{x:number, y:number, scale:number}}
 */
export function resizeTransform(tr, bbox, corner, wx, wy) {
  const { grabbed, anchor } = cornerPoints(bbox, corner);
  const anchorWorld = localToWorld(tr, anchor[0], anchor[1]);

  // Distance from the fixed anchor, in local units, is constant; the ratio of
  // world distances is therefore the new scale.
  const localSpan = Math.hypot(grabbed[0] - anchor[0], grabbed[1] - anchor[1]);
  if (localSpan < 1e-9) return { x: tr.x, y: tr.y, scale: tr.scale };

  const scale = Math.max(MIN_SCALE,
    Math.hypot(wx - anchorWorld.x, wy - anchorWorld.y) / localSpan);

  // Re-solve the origin so the anchor corner lands where it already was.
  return {
    x: anchorWorld.x - anchor[0] * scale,
    y: anchorWorld.y - anchor[1] * scale,
    scale,
  };
}

/**
 * Where to put a newly added drawable so it lands in the middle of what the
 * viewer can actually see.
 *
 * A clip's origin is its bounding-box corner, not its centre, and world (0,0)
 * is the middle of the frame only while the camera sits at the identity. Adding
 * an asset at (0,0) after zooming in therefore drops it somewhere off screen --
 * which is exactly what it looked like.
 *
 * The scale only ever shrinks. An asset larger than the viewport is as hard to
 * find as one outside it, but enlarging a small one would be an edit nobody
 * asked for.
 *
 * @param {number[]} bbox local-space [x0, y0, x1, y1] from the compiled plan
 * @param {{x:number, y:number, zoom:number}} cam framing to centre within
 * @param {Meta} meta composition size
 * @param {number} fill fraction of the visible frame the artwork may fill
 * @returns {{x:number, y:number, scale:number}}
 */
export function placeInFrame(bbox, cam, meta, fill = 0.8) {
  const w = Math.abs(bbox[2] - bbox[0]);
  const h = Math.abs(bbox[3] - bbox[1]);
  // Zoomed in, less of the page is on screen: the visible extent in world units
  // is the composition size divided by the zoom.
  const scale = Math.min(1,
    ((meta.width / cam.zoom) * fill) / Math.max(1, w),
    ((meta.height / cam.zoom) * fill) / Math.max(1, h));
  return {
    x: Math.round(cam.x - ((bbox[0] + bbox[2]) / 2) * scale),
    y: Math.round(cam.y - ((bbox[1] + bbox[3]) / 2) * scale),
    scale: Math.round(scale * 1000) / 1000,
  };
}

/**
 * Topmost clip whose box contains a screen point.
 *
 * Later clips are drawn on top, so the search runs backwards -- picking the
 * first match would select whatever happens to be underneath.
 */
export function hitTest(boxes, sx, sy) {
  for (let i = boxes.length - 1; i >= 0; i--) {
    const r = boxes[i].rect;
    if (sx >= r.left && sx <= r.left + r.width
        && sy >= r.top && sy <= r.top + r.height) return boxes[i].id;
  }
  return null;
}
