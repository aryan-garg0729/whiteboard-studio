/**
 * Hand rig: places a hand sprite so its pen nib sits exactly on the current
 * drawing point, while guaranteeing the forearm always runs off a frame edge
 * so the hand never reads as a detached floating hand.
 *
 * The hand is positioned in SCREEN space, after the camera transform is
 * popped. A world-space hand would scale with the artwork and become a
 * 40-foot hand at 8x zoom; a real hand stays the same apparent size.
 */

const DEG = Math.PI / 180;

/**
 * @typedef {Object} HandSource
 * @property {number} w @property {number} h
 * @property {string} file
 * @property {[number,number]} tipPx      nib, in this source's pixels
 * @property {[number,number]} [armExitPx] where the limb crosses the asset edge
 * @property {number} [armLenPx]          |armExitPx - tipPx|
 * @property {[number,number,number,number]} opaqueBBox
 */

/**
 * @typedef {Object} HandStyle
 * @property {string} id @property {string} label
 * @property {'edge'|'none'} constraint
 * @property {'top'|'bottom'|'left'|'right'|null} anchorEdge
 * @property {number} naturalAngleDeg  rest direction of the shaft (nib -> body),
 *                                     degrees from screen-down, +ve clockwise
 * @property {number} alignFactor      how much of the stroke tangent to follow
 * @property {number} maxRotationDeg
 * @property {[number,number]|null} stretchBand  source rows safe to stretch
 * @property {HandSource[]} sources
 */

/** Clearance, in screen px, by which the elbow must clear the frame. */
export const EDGE_MARGIN = 24;

/** Above this scale the sprite is uncomfortably large; stretch the arm instead. */
export const COMFORT_SCALE = 0.7;

/**
 * Angle between the asset's nib->elbow vector and the outward normal of its
 * anchor edge, in radians. Assets are hand-drawn, so the limb is never exactly
 * perpendicular to the edge it exits through: hand1's V is (-80.7, 1920),
 * i.e. 2.4deg off straight-down.
 */
export function assetTilt(style, source) {
  if (!source.armExitPx) return 0;
  const vx = source.armExitPx[0] - source.tipPx[0];
  const vy = source.armExitPx[1] - source.tipPx[1];
  switch (style.anchorEdge) {
    case 'bottom': return Math.atan2(vx, vy);
    case 'top': return Math.atan2(vx, -vy);
    case 'right': return Math.atan2(vy, vx);
    case 'left': return Math.atan2(vy, -vx);
    default: return 0;
  }
}

/**
 * Minimum uniform scale at which the limb is guaranteed to exit the frame for
 * *any* nib position in the frame.
 *
 * With the nib at P and the elbow at Q = P + s*R(theta)*V, "not detached"
 * means Q lies outside the frame. The distance from P to the boundary along a
 * unit direction u is a ray/AABB exit; the worst case is u as far off the
 * anchor-edge normal as it can get, with P on the opposite edge, giving
 * H / cos(worst). Hence:
 *
 *     s_min = (H + margin) / (|V| * cos(theta_max + |assetTilt|))
 *
 * The `assetTilt` term matters and is easy to miss: the applied rotation is
 * clamped to +/-theta_max, but it compounds with the asset's own lean. For
 * hand1 that lean is 2.4deg, so the true worst case is 27.4deg rather than
 * 25deg -- and omitting it leaves the arm ~22px short of the edge with the nib
 * at the top of the frame, which is visible as a floating detached hand in
 * exactly the situation the constraint exists to prevent.
 *
 * For hand1 at 1080p (|V| = 1921.7, margin = 24) this gives ~0.647 -- a 422px
 * hand on a 1920px frame, about 22% of frame width, where reference products sit.
 *
 * This is still meaningfully tighter than the naive "render the sprite at least
 * as tall as the frame", which ignores the rotation clamp entirely and
 * overestimates the required scale by roughly 55%.
 */
export function minScale(style, source, frameH, margin = EDGE_MARGIN) {
  if (style.constraint === 'none' || !source.armLenPx) return 1;
  const worst = (style.maxRotationDeg ?? 25) * DEG + Math.abs(assetTilt(style, source));
  // Beyond 90deg off the normal the limb never reaches the edge at any scale.
  const c = Math.cos(Math.min(worst, 1.5533)); // cap at 89deg
  return (frameH + margin) / (source.armLenPx * c);
}

/**
 * Distance from P to the frame boundary along unit direction u.
 * Standard ray/AABB exit against [0,W]x[0,H].
 */
export function exitDistance(px, py, ux, uy, w, h) {
  const tx = ux > 1e-12 ? (w - px) / ux : ux < -1e-12 ? -px / ux : Infinity;
  const ty = uy > 1e-12 ? (h - py) / uy : uy < -1e-12 ? -py / uy : Infinity;
  return Math.min(tx, ty);
}

/**
 * Pick the source variant to draw at this output size.
 *
 * The goal is the largest sprite that still fits inside the comfort scale, so
 * the limb reaches the frame edge on its own geometry. Ranking purely by
 * "closest to 1" instead picks the smallest variant, whose required scale then
 * exceeds COMFORT_SCALE and forces the procedural arm stretch -- lower
 * resolution *and* synthetic geometry, when a bigger source would have needed
 * neither. Stretching is the fallback for portrait output, not the default.
 */
export function pickSource(style, frameH) {
  let best = style.sources[0];
  let bestCost = Infinity;
  for (const s of style.sources) {
    const k = minScale(style, s, frameH);
    // Within comfort: prefer the largest usable scale (least downscaling).
    // Beyond it: rank after every comfortable option, by how far past it goes.
    const cost = k <= COMFORT_SCALE
      ? COMFORT_SCALE - k
      : 1 + (k - COMFORT_SCALE) * 8;
    if (cost < bestCost) { bestCost = cost; best = s; }
  }
  return best;
}

/**
 * Fold a travel direction onto the pen *shaft* orientation, in (-90, 90].
 *
 * A pen's shaft does not flip end-for-end when the stroke reverses: writing
 * right-to-left holds the pen at the same angle as writing left-to-right. So
 * `d` and `-d` must map to the same pose.
 *
 * This is load-bearing rather than cosmetic. Serpentine fill reverses direction
 * on *every* scan line, so with the raw tangent the hand alternated between
 * roughly -11deg and the +25deg clamp several times a second -- the single
 * biggest source of the "hand rotates a lot" complaint. Folded, both passes of
 * a -45deg scribble map to the same angle and the hand simply holds still.
 */
export function shaftAngle(tangent) {
  let a = Math.atan2(Math.sin(tangent), Math.cos(tangent)); // wrap to (-pi, pi]
  if (a > Math.PI / 2) a -= Math.PI;
  else if (a <= -Math.PI / 2) a += Math.PI;
  return a;
}

/**
 * Rotation to apply to the sprite for a stroke heading in direction `tangent`.
 *
 * Full tangent alignment looks drunk -- a real hand rotates far less than the
 * stroke direction does -- so only a fraction of the *shaft* angle is followed,
 * and it is clamped.
 */
export function rotationFor(style, tangent) {
  const align = style.alignFactor ?? 0.16;
  const maxR = (style.maxRotationDeg ?? 25) * DEG;
  // tangent is measured from +X; the rig's reference pose points along +X too,
  // so no offset is needed here. naturalAngleDeg is baked in separately as the
  // sprite's own rest pose.
  const want = align * shaftAngle(tangent);
  return Math.max(-maxR, Math.min(maxR, want));
}

/**
 * Full placement solution for one frame.
 *
 * @param {HandStyle} style
 * @param {{x:number,y:number}} tip   nib position in SCREEN px
 * @param {number} tangent            stroke direction, radians, from +X
 * @param {{w:number,h:number}} frame
 * @returns {{source:HandSource, scale:number, rotation:number, x:number, y:number,
 *            tipPx:[number,number], stretchPx:number, detached:boolean}}
 */
export function solveHand(style, tip, tangent, frame) {
  const source = pickSource(style, frame.h);
  const rotation = rotationFor(style, tangent);

  if (style.constraint === 'none') {
    // Floating-pen styles (hand4) have no limb reaching an edge, so the
    // never-detached constraint is unsatisfiable by construction. This is a
    // deliberate style, NOT no-hand mode -- no-hand mode draws no sprite.
    return {
      source, scale: frame.h / source.h * 0.55, rotation,
      x: tip.x, y: tip.y, tipPx: source.tipPx, stretchPx: 0, detached: true,
    };
  }

  const required = minScale(style, source, frame.h);
  const scale = Math.min(required, COMFORT_SCALE);

  // When the comfortable scale is too small to reach the edge, make up the
  // deficit by stretching the mid-forearm band rather than inflating the whole
  // sprite. A forearm is near-uniform through that band, so a pure vertical
  // stretch is invisible -- and it is what keeps portrait output (where
  // s_min > 1) from producing a hand two-thirds as wide as the frame.
  const deficit = Math.max(0, required - scale);
  const stretchPx = style.stretchBand ? (deficit * source.armLenPx) / Math.max(scale, 1e-6) : 0;

  return {
    source,
    scale: style.stretchBand ? scale : required,
    rotation,
    x: tip.x,
    y: tip.y,
    tipPx: source.tipPx,
    stretchPx,
    detached: false,
  };
}

/**
 * Verify a placement actually leaves the frame -- the elbow being outside is
 * necessary but not quite sufficient, since the arm is not perfectly straight
 * from nib to exit. Used by the calibration check over a grid of nib positions.
 */
export function elbowOutside(style, solution, frame, margin = EDGE_MARGIN) {
  const src = solution.source;
  if (!src.armExitPx) return false;
  const vx = src.armExitPx[0] - src.tipPx[0];
  const vy = src.armExitPx[1] - src.tipPx[1];
  const c = Math.cos(solution.rotation);
  const s = Math.sin(solution.rotation);
  const rx = vx * c - vy * s;
  const ry = vx * s + vy * c;
  const len = Math.hypot(rx, ry) * solution.scale + solution.stretchPx * solution.scale;
  const ux = rx / Math.hypot(rx, ry);
  const uy = ry / Math.hypot(rx, ry);
  return len >= exitDistance(solution.x, solution.y, ux, uy, frame.w, frame.h) + margin;
}
