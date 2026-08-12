/**
 * The clip placement matrix, in one place.
 *
 * A clip maps its own local units into the page as
 *
 *     world = T(x, y) . R(rotation) . diag(sx, sy) . local
 *
 * with `sx = scale * scaleX` and `sy = scale * scaleY`. `scale` is the overall
 * size -- what a corner drag and `placeInFrame` set -- and the two multipliers
 * carry the squeeze, defaulting to 1. A *negative* multiplier mirrors that
 * axis: flip and squeeze are the same field, so dragging a handle past its
 * anchor flips rather than sticking at zero.
 *
 * `rotation` is in **degrees**, positive clockwise on screen (y grows down).
 * Degrees because the document is hand-authored JSON and an MCP argument; the
 * conversion happens here so nothing downstream has to remember.
 *
 * The pivot is the transform origin, which is the drawable's bbox corner rather
 * than its centre. Rotating and resizing *about the centre* is a gesture
 * concern, not a document one: the stage re-solves `x`/`y` so the point it
 * wants to hold still does not move. That keeps the matrix composable and old
 * documents rendering byte-identically.
 *
 * Everything here is pure and DOM-free. It exists because the renderer and the
 * stage each used to build this matrix by hand, and they drifted: the hand's
 * screen position dropped the rotation term and nobody noticed, because every
 * project in the repo was authored with `rotation: 0`.
 */

export const DEG = Math.PI / 180;

/** Effective per-axis scale, folding the uniform scale into the multipliers. */
export function effectiveScale(tr) {
  const s = tr?.scale ?? 1;
  return { sx: s * (tr?.scaleX ?? 1), sy: s * (tr?.scaleY ?? 1) };
}

/**
 * The scalar a stroke width should be divided by.
 *
 * Pen widths are chosen so a stroke is a constant width *on screen*, which is
 * only well defined for a uniform scale. The geometric mean is the honest
 * answer for a squeezed drawable: it is the factor by which area grows, so a
 * stroke comes out too fat on one axis and too thin on the other by the same
 * ratio instead of being wrong by the whole squeeze on both.
 */
export function penScale(tr) {
  const { sx, sy } = effectiveScale(tr);
  return Math.sqrt(Math.abs(sx * sy)) || 1;
}

/** Cached sin/cos of the rotation, so callers in a loop do not retrigonometry. */
function rot(tr) {
  const a = (tr?.rotation ?? 0) * DEG;
  return a ? { c: Math.cos(a), s: Math.sin(a) } : { c: 1, s: 0 };
}

/** local -> world */
export function applyTransform(tr, lx, ly) {
  const { sx, sy } = effectiveScale(tr);
  const { c, s } = rot(tr);
  const x = lx * sx;
  const y = ly * sy;
  return {
    x: (tr?.x ?? 0) + x * c - y * s,
    y: (tr?.y ?? 0) + x * s + y * c,
  };
}

/**
 * world -> local; the exact inverse of `applyTransform`.
 *
 * A zero effective scale would be non-invertible, which is why the validator
 * refuses a zero multiplier -- but a hand-built literal can still get here, so
 * degenerate axes fall back to 0 rather than returning Infinity and poisoning
 * a hit test.
 */
export function invertTransform(tr, wx, wy) {
  const { sx, sy } = effectiveScale(tr);
  const { c, s } = rot(tr);
  const dx = wx - (tr?.x ?? 0);
  const dy = wy - (tr?.y ?? 0);
  // R is orthogonal, so its inverse is its transpose; the scale then divides.
  const rx = dx * c + dy * s;
  const ry = -dx * s + dy * c;
  return { x: sx ? rx / sx : 0, y: sy ? ry / sy : 0 };
}

/**
 * A local stroke direction, in world space.
 *
 * Not simply `tangent + rotation`: a non-uniform scale is not conformal, so it
 * turns directions by an amount that depends on the direction itself. The
 * correct answer is the Jacobian applied to the direction vector, which is what
 * this is -- the same matrix as `applyTransform` with the translation dropped.
 *
 * A mirrored axis reverses the direction along it, which is right: the hand
 * leans along the stroke it is actually drawing on screen. The sprite itself is
 * never mirrored -- a real hand does not turn into a left hand.
 */
export function transformTangent(tr, tangent) {
  const { sx, sy } = effectiveScale(tr);
  const { c, s } = rot(tr);
  const dx = Math.cos(tangent) * sx;
  const dy = Math.sin(tangent) * sy;
  return Math.atan2(dx * s + dy * c, dx * c - dy * s);
}

/**
 * The four world-space corners of a local bbox, in nw, ne, se, sw order.
 *
 * Order matters: the outline polygon and the point-in-quad test below both walk
 * it as a ring. Under a mirror the ring winds the other way, which is why the
 * containment test is written sign-agnostically.
 */
export function transformCorners(bbox, tr) {
  const [x0, y0, x1, y1] = bbox;
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
    .map(([x, y]) => applyTransform(tr, x, y));
}

/** Axis-aligned bounds of a set of points. */
export function boundsOf(pts) {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/**
 * Is (px, py) inside the convex quad `pts`?
 *
 * All four edge cross products must agree in sign. Testing agreement rather
 * than a fixed sign is what makes this work for a mirrored clip, whose corner
 * ring winds counter-clockwise instead of clockwise.
 */
export function pointInQuad(pts, px, py) {
  let neg = false;
  let pos = false;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const cross = (b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x);
    if (cross > 1e-9) pos = true;
    if (cross < -1e-9) neg = true;
    if (pos && neg) return false;
  }
  return true;
}
