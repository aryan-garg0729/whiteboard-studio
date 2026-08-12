/**
 * Stage coordinate maths for direct manipulation.
 *
 * Three spaces are in play and mixing them up is the whole difficulty:
 *
 *   local   the drawable's own units, which is what plan.bbox is in
 *   world   the page; a clip sits at transform.{x,y} under its own matrix
 *   screen  CSS pixels in the stage, i.e. canvas pixels times the fit scale
 *
 * `renderFrame` composes these as:
 *   canvas = size/2 + (world - camera) * camera.zoom
 *   world  = T(transform.x, transform.y) . R(rotation) . diag(sx, sy) . local
 *
 * The local->world half lives in `engine/model/transform.js` and is imported
 * rather than restated: the renderer uses the same functions, so handles cannot
 * drift away from the pixels.
 *
 * Kept DOM-free so the mapping can be tested directly -- an off-by-one here
 * shows up as handles that drift away from the artwork, which is tedious to
 * chase by eye.
 */

import {
  DEG, applyTransform, effectiveScale, pointInQuad, transformCorners,
} from '../engine/model/transform.js';

/** @typedef {{x:number, y:number, scale:number, scaleX?:number, scaleY?:number, rotation?:number}} Transform */
/** @typedef {{width:number, height:number}} Meta */
/** @typedef {{x:number, y:number, zoom:number}} Camera */

// Placement moved to the engine: a headless host places clips too, and needs it
// more than the stage does -- there is no drag to correct a bad initial guess.
export { placeInFrame } from '../engine/model/edits.js';
export { applyTransform, transformCorners } from '../engine/model/transform.js';

/** local -> world */
export function localToWorld(tr, lx, ly) {
  return applyTransform(tr, lx, ly);
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
 * The clip's four corners in screen space, in nw, ne, se, sw order.
 *
 * This -- not an axis-aligned rectangle -- is what the outline and the handles
 * are built from, so a rotated or mirrored clip gets a box that actually sits
 * on its artwork.
 */
export function clipCorners(meta, cam, fit, tr, bbox) {
  return transformCorners(bbox, tr)
    .map((p) => worldToScreen(meta, cam, fit, p.x, p.y));
}

/**
 * Handles offered on a selected clip.
 *
 * Corners scale uniformly, edges squeeze the one axis they face. Order is the
 * ring nw, n, ne, e, se, s, sw, w so a renderer can walk it alongside the
 * corner ring without a lookup.
 */
export const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** The four corner handles, kept separate because only they lock the aspect. */
export const CORNERS = ['nw', 'ne', 'se', 'sw'];

const OPPOSITE = {
  nw: 'se', n: 's', ne: 'sw', e: 'w', se: 'nw', s: 'n', sw: 'ne', w: 'e',
};

/** The local-space point a handle refers to. */
function handlePoint(bbox, handle) {
  const [x0, y0, x1, y1] = bbox;
  const mx = (x0 + x1) / 2;
  const my = (y0 + y1) / 2;
  return {
    nw: [x0, y0], n: [mx, y0], ne: [x1, y0], e: [x1, my],
    se: [x1, y1], s: [mx, y1], sw: [x0, y1], w: [x0, my],
  }[handle];
}

/**
 * The local point a handle grabs, and the point held still while it drags.
 *
 * An edge handle anchors on the opposite edge's midpoint, which shares one
 * coordinate with the grabbed point -- that shared coordinate is exactly what
 * makes the resize maths below leave the other axis alone, with no special
 * casing.
 */
export function handlePoints(bbox, handle) {
  return {
    grabbed: handlePoint(bbox, handle),
    anchor: handlePoint(bbox, OPPOSITE[handle]),
  };
}

/** Back-compat alias; corners are the handles that existed first. */
export const cornerPoints = handlePoints;

export const MIN_SCALE = 0.02;

/** Keep a factor's sign but never let it collapse to nothing. */
function clampScale(v) {
  if (!Number.isFinite(v) || v === 0) return MIN_SCALE;
  return Math.sign(v) * Math.max(MIN_SCALE, Math.abs(v));
}

/**
 * Solve `transform.{x,y}` so that `local` maps to `world` under `tr`.
 *
 * Every gesture here is defined by a point that must not move -- the anchor
 * corner of a resize, the centre of a rotation -- and the transform's origin is
 * the drawable's bbox corner, not that point. So the origin is re-derived
 * afterwards rather than the matrix being given a pivot it does not have.
 */
function originHolding(tr, local, world) {
  const at = applyTransform({ ...tr, x: 0, y: 0 }, local[0], local[1]);
  return { x: world.x - at.x, y: world.y - at.y };
}

/**
 * New transform for dragging `handle` to world point `(wx, wy)`.
 *
 * Anchored on the opposite corner or edge, so that point stays put under the
 * pointer's expectations.
 *
 * Three behaviours, from one solve:
 *   - a corner drag scales uniformly, changing `scale` and leaving the squeeze
 *     alone, which is the aspect lock the tool has always had;
 *   - `free` (shift held) on a corner, or any edge handle, solves each axis on
 *     its own and writes the result into `scaleX`/`scaleY`;
 *   - dragging past the anchor gives a negative factor, which *is* the mirror.
 *     Flip is not a separate mode; it is the far side of a squeeze.
 *
 * @param {Transform} tr
 * @param {number[]} bbox local [x0, y0, x1, y1]
 * @param {string} handle one of HANDLES
 * @param {number} wx
 * @param {number} wy
 * @param {{free?:boolean}} [opts]
 * @returns {Transform}
 */
export function resizeTransform(tr, bbox, handle, wx, wy, opts = {}) {
  const { grabbed, anchor } = handlePoints(bbox, handle);
  const anchorWorld = applyTransform(tr, anchor[0], anchor[1]);
  const base = {
    scale: tr.scale ?? 1,
    scaleX: tr.scaleX ?? 1,
    scaleY: tr.scaleY ?? 1,
    rotation: tr.rotation ?? 0,
  };

  const dLx = grabbed[0] - anchor[0];
  const dLy = grabbed[1] - anchor[1];
  if (Math.abs(dLx) < 1e-9 && Math.abs(dLy) < 1e-9) {
    return { ...base, x: tr.x, y: tr.y };
  }

  // Undo the rotation so the drag can be read off the drawable's own axes.
  const a = base.rotation * DEG;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const ddx = wx - anchorWorld.x;
  const ddy = wy - anchorWorld.y;
  const v = { x: ddx * c + ddy * s, y: -ddx * s + ddy * c };

  const { sx, sy } = effectiveScale(base);
  let next;

  if (!opts.free && CORNERS.includes(handle)) {
    // Uniform: the least-squares factor along the current diagonal. Projecting
    // rather than comparing lengths means a drag sideways off the diagonal
    // grows the clip by how far it went *along* it, instead of by its distance
    // from the anchor -- and it carries a sign, so crossing the anchor mirrors.
    const d = { x: dLx * sx, y: dLy * sy };
    const dd = d.x * d.x + d.y * d.y;
    const k = dd > 1e-12 ? (v.x * d.x + v.y * d.y) / dd : 1;
    // Clamp the resulting scale, not the factor: the floor is an absolute size
    // below which the clip is unfindable, and it must not depend on how big the
    // clip happened to be when the drag started.
    const sign = k < 0 ? -1 : 1;
    next = {
      scale: Math.max(MIN_SCALE, base.scale * Math.abs(k)),
      scaleX: base.scaleX * sign,
      scaleY: base.scaleY * sign,
    };
  } else {
    // Per axis. A handle that does not span an axis leaves it untouched,
    // because dLx (or dLy) is zero there.
    const nsx = Math.abs(dLx) > 1e-9 ? clampScale(v.x / dLx) : sx;
    const nsy = Math.abs(dLy) > 1e-9 ? clampScale(v.y / dLy) : sy;
    next = {
      scale: base.scale,
      scaleX: nsx / base.scale,
      scaleY: nsy / base.scale,
    };
  }

  const out = { ...next, rotation: base.rotation };
  return { ...out, ...originHolding(out, anchor, anchorWorld) };
}

/**
 * Apply a transform patch while holding the drawable's centre still.
 *
 * The matrix pivots on the origin corner, so setting a rotation or a mirror
 * outright swings the artwork bodily across the page -- correct arithmetic,
 * and not at all what "flip this" means. Every numeric control and quick
 * action goes through here so the artwork turns in place.
 *
 * @returns {Object} the patch, plus the `x`/`y` that keep the centre put
 */
export function aroundCentre(tr, bbox, patch) {
  if (!bbox) return patch;
  const cx = (bbox[0] + bbox[2]) / 2;
  const cy = (bbox[1] + bbox[3]) / 2;
  const centre = applyTransform(tr, cx, cy);
  return { ...patch, ...originHolding({ ...tr, ...patch }, [cx, cy], centre) };
}

/** Rotation snap, in degrees, while shift is held. */
export const ROTATE_SNAP = 15;

/**
 * New transform for dragging the rotate handle to world point `(wx, wy)`.
 *
 * Turns about the drawable's centre, which is where a person expects a rotate
 * handle to pivot -- the matrix pivots on the origin corner, so the origin is
 * re-solved to hold the centre still.
 *
 * The handle sits *above* the top edge, hence the quarter turn: pointing the
 * handle straight up must read as zero rotation.
 */
export function rotateTransform(tr, bbox, wx, wy, opts = {}) {
  const centre = applyTransform(tr, (bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2);
  let deg = Math.atan2(wy - centre.y, wx - centre.x) / DEG + 90;
  if (opts.snap) deg = Math.round(deg / ROTATE_SNAP) * ROTATE_SNAP;
  // Keep it in (-180, 180] so the Inspector never shows 720 degrees.
  deg = ((deg + 180) % 360 + 360) % 360 - 180;
  return {
    scale: tr.scale ?? 1,
    scaleX: tr.scaleX ?? 1,
    scaleY: tr.scaleY ?? 1,
    ...aroundCentre(tr, bbox, { rotation: deg }),
  };
}

/** How far past the top edge the rotate handle floats, in screen pixels. */
export const ROTATE_GAP = 26;

/**
 * Where each handle sits on screen, given the clip's four screen corners.
 *
 * Corners come straight from the quad and edges from its midpoints, so the
 * handles ride the artwork through a rotation instead of a rectangle drawn
 * around it. The rotate handle floats along the outward normal of the top edge
 * -- derived from the quad rather than assumed to be "up", so it stays outside
 * the shape at any angle and on either side of a mirror.
 */
export function handleAnchors(corners, gap = ROTATE_GAP) {
  const [nw, ne, se, sw] = corners;
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const n = mid(nw, ne);
  const centre = mid(nw, se);
  const out = { nw, n, ne, e: mid(ne, se), se, s: mid(se, sw), sw, w: mid(sw, nw) };
  const dx = n.x - centre.x;
  const dy = n.y - centre.y;
  const len = Math.hypot(dx, dy) || 1;
  out.rot = { x: n.x + (dx / len) * gap, y: n.y + (dy / len) * gap };
  return out;
}

/**
 * Topmost clip whose quad contains a screen point.
 *
 * Later clips are drawn on top, so the search runs backwards -- picking the
 * first match would select whatever happens to be underneath.
 *
 * Tested against the corners rather than the bounding rect: on a rotated clip
 * the rect includes a lot of blank paper, and clicking that paper used to
 * select the clip instead of what was actually under the cursor.
 */
export function hitTest(boxes, sx, sy) {
  for (let i = boxes.length - 1; i >= 0; i--) {
    if (pointInQuad(boxes[i].corners, sx, sy)) return boxes[i].id;
  }
  return null;
}
