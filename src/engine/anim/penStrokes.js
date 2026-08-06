/**
 * The brush primitives every drawing animation shares.
 *
 * These used to live in `outlineFill.js`, which meant erase, handwriting and
 * text reveal all imported the *image* animation to get at a five-line easing
 * function. When the image path was rewritten they would all have had to move
 * anyway, so they live here instead: no animation owns them, and nothing has to
 * import one animation to draw like another.
 */

/**
 * Ease only the first and last few percent of a phase, so the pen doesn't
 * start and stop with infinite jerk. The middle stays linear -- constant pen
 * speed is the entire point of arc-length pacing, and easing the whole phase
 * would undo it.
 */
export function easeEnds(u, edge = 0.04) {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  if (edge <= 0) return u;
  const smooth = (t) => t * t * (3 - 2 * t);
  if (u < edge) return smooth(u / edge) * edge;
  if (u > 1 - edge) return 1 - edge + smooth((u - (1 - edge)) / edge) * edge;
  return u;
}

/**
 * Draw a stroke from its first vertex up to `vertex`+`frac`.
 *
 * Rebuilding a truncated path beats setLineDash/lineDashOffset here:
 * dash phase is computed in device space after the CTM, so a dash array
 * authored in object units drifts as the camera zooms; the phase accumulates
 * float error over the 200k+ px paths a full-page vector reaches; and the hand
 * rig needs the exact tip position anyway, so the dash route would compute the
 * reveal front twice in two code paths that eventually disagree by a pixel.
 */
export function strokePartial(ctx, st, vertex, frac) {
  if (st.pts.length < 4) return;
  ctx.beginPath();
  ctx.moveTo(st.pts[0], st.pts[1]);
  for (let i = 1; i <= vertex; i++) ctx.lineTo(st.pts[2 * i], st.pts[2 * i + 1]);
  const x = st.pts[2 * vertex] + (st.pts[2 * vertex + 2] - st.pts[2 * vertex]) * frac;
  const y = st.pts[2 * vertex + 1] + (st.pts[2 * vertex + 3] - st.pts[2 * vertex + 1]) * frac;
  ctx.lineTo(x, y);
  ctx.stroke();
}

export function strokeWhole(ctx, st) {
  if (st.pts.length < 4) return;
  ctx.beginPath();
  ctx.moveTo(st.pts[0], st.pts[1]);
  for (let i = 1; i < st.pts.length >> 1; i++) ctx.lineTo(st.pts[2 * i], st.pts[2 * i + 1]);
  ctx.stroke();
}

export function applyBrush(ctx, st, color, widthScale = 1) {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = st.width * widthScale;
  ctx.strokeStyle = color || st.color;
}

/**
 * Fill a stroke's `closure` geometry: the exact shapes it is responsible for
 * having covered by the time it finishes.
 *
 * A scribble is a good enough *pen* -- it is what a person colouring in
 * actually does -- but it is not a guaranteed cover, and under a reveal every
 * uncovered pixel is a permanent hole in the finished picture rather than a
 * slightly patchy fill. Painting the shape's own polygon as its scribble
 * completes closes that without changing what the pen is seen to do.
 *
 * A shape carrying `dilate` is also stroked at that width, which is how
 * synthetically-emboldened text gets its thickened stems revealed: the rings
 * are the regular letterform, and the dilation lives outside them.
 */
export function paintClosure(ctx, closure, color = '#ffffff') {
  ctx.fillStyle = color;
  for (const shape of closure) {
    ctx.beginPath();
    for (const ring of shape.rings) {
      if (ring.length < 6) continue;
      ctx.moveTo(ring[0], ring[1]);
      for (let i = 2; i < ring.length; i += 2) ctx.lineTo(ring[i], ring[i + 1]);
      ctx.closePath();
    }
    // evenodd, so a region's holes stay holes -- the same rule paintVectorArt
    // uses on the artwork this mask reveals.
    ctx.fill('evenodd');
    if (shape.dilate > 0) {
      ctx.strokeStyle = color;
      ctx.lineWidth = shape.dilate;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke();
    }
  }
}

/**
 * Blit a stroke's exact coverage rectangles into the mask.
 *
 * The pixel-grid counterpart to `paintClosure`, for the animations that plan
 * from pixels rather than from geometry: `rects` are run-length coverage in
 * mask-grid coordinates and `sx`/`sy` scale them back to object space.
 *
 * Snapped outward to whole object pixels, and that is what makes the mask
 * *opaque* rather than merely dense. The mask grid is coarser than the artwork,
 * so a rectangle's edges land on fractional coordinates; a fractional `fillRect`
 * is antialiased, and two antialiased rectangles overlapping a pixel do not add
 * up to full coverage -- source-over of 0.6 onto 0.6 is 0.84, not 1. That
 * shortfall survives into the finished frame as a pixel a shade off the source,
 * which is exactly the kind of near-miss this pipeline exists to rule out.
 *
 * Snapping costs at most one source pixel of overshoot onto a neighbour that is
 * itself going to be revealed, and buys an exactly opaque mask.
 */
export function paintRects(ctx, closure, color = '#ffffff') {
  if (!closure) return;
  ctx.fillStyle = color;
  for (const part of closure) {
    const { rects, sx, sy } = part;
    for (let i = 0; i < rects.length; i += 4) {
      const x0 = Math.floor(rects[i] * sx);
      const y0 = Math.floor(rects[i + 1] * sy);
      const x1 = Math.ceil(rects[i + 2] * sx);
      const y1 = Math.ceil(rects[i + 3] * sy);
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    }
  }
}

/**
 * How much wider than its nominal width a mask stroke actually covers.
 *
 * Spilling costs nothing -- the mask only ever uncovers artwork, and past the
 * edge of a shape there is nothing to uncover -- while a brush exactly its own
 * width leaves visible lattice gaps between passes at the moment they are laid
 * down, which the closure then has to fix all at once.
 */
export const PAINT_GAIN = 1.12;

/**
 * The bounds of everything a pixel-planned animation reveals.
 *
 * What the eraser sweeps, so it has to cover the whole picture rather than the
 * part drawn so far. A fully transparent image has no groups and therefore no
 * ink; erase must see a degenerate box and decline, rather than sweeping empty
 * paper.
 */
export function artworkInkBbox(analysis) {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const g of analysis.groups) {
    if (g.bbox[0] < x0) x0 = g.bbox[0];
    if (g.bbox[1] < y0) y0 = g.bbox[1];
    if (g.bbox[2] > x1) x1 = g.bbox[2];
    if (g.bbox[3] > y1) y1 = g.bbox[3];
  }
  return Number.isFinite(x0) ? [x0, y0, x1, y1] : [0, 0, 0, 0];
}
