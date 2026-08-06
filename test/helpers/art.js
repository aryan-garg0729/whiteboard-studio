/**
 * Synthetic artwork for tests.
 *
 * `draw.stencilPaint` plans from pixels, so a test that needs a drawable clip
 * needs an image rather than the hand-written subpaths-and-regions object the
 * old traced-geometry animations took. These build one directly, with no file
 * and no decoder involved.
 */

import { createCanvas } from '@napi-rs/canvas';

/** Parse `#rrggbb` into a byte triple. */
function rgb(hex) {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/**
 * A filled square on a transparent field.
 *
 * Transparent rather than white, so the drawable's ink bounds are the square
 * itself -- a white field would be artwork too, and every clip would be as big
 * as its canvas.
 *
 * @param {string} color `#rrggbb`
 * @param {number} size overall image size
 * @param {number} inset border of transparent pixels around the square
 */
export function squareImage(color = '#3366cc', size = 200, inset = 20) {
  const [r, g, b] = rgb(color);
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = inset; y < size - inset; y++) {
    for (let x = inset; x < size - inset; x++) {
      const i = (y * size + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    }
  }
  return { width: size, height: size, data };
}

/**
 * Two nested squares in different colours, so a plan has more than one colour
 * group and `colorGroups` ordering has something to order.
 */
export function twoToneImage(outer = '#3366cc', inner = '#cc3333', size = 200) {
  const img = squareImage(outer, size, 20);
  const [r, g, b] = rgb(inner);
  const lo = Math.round(size * 0.35);
  const hi = size - lo;
  for (let y = lo; y < hi; y++) {
    for (let x = lo; x < hi; x++) {
      const i = (y * size + x) * 4;
      img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
    }
  }
  return img;
}

/**
 * Paint synthetic artwork into a clip's art surface.
 *
 * Required, not optional: `draw.stencilPaint` lays down a *mask* and
 * `composite()` shows the artwork through it, so a clip whose `art` was never
 * populated renders as nothing at all however far the pen has travelled. The
 * hosts do this via `ensureSurfaces` + `drawImage`; a test that builds a
 * session by hand has to do it too.
 */
export function installArt(session, clipId, image) {
  const sf = session.surfaces.get(clipId);
  if (!sf) throw new Error(`installArt: no surfaces for clip ${clipId}`);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  const id = ctx.createImageData(image.width, image.height);
  id.data.set(image.data);
  ctx.putImageData(id, 0, 0);
  sf.ensureArt().ctx.drawImage(canvas, 0, 0);
  return sf;
}
