/**
 * Knock the paper out of a raster asset's artwork surface.
 *
 * A whiteboard drawing arrives as an opaque PNG: the ink is a few percent of
 * the pixels and the rest is white. Blitting that whole rectangle paints a
 * panel over the paper, which is why `composite()` used to intersect the
 * artwork with the pen's own marks -- the marks were standing in for a
 * silhouette the artwork did not carry.
 *
 * That works only as long as the marks cover every inked pixel, and they do
 * not: a region too thin to hold a scribble pass, or too small to be worth
 * one, leaves a permanent hole in the finished image. Giving the artwork a
 * real alpha channel removes the need for the intersection entirely -- the
 * reveal mask can then be as generous as it likes, because paper is
 * transparent wherever the mask lands on it.
 *
 * Run once per clip when the artwork is installed, never per frame.
 */

/** At or above this channel minimum a pixel is certainly paper. */
export const PAPER_LEVEL = 250;

/**
 * At or below this it is certainly ink, and survives at full alpha.
 *
 * 255 - `backgroundTolerance` from `vectorize.py`, deliberately: anything the
 * vectorizer would not call background must not be dissolved here either, or
 * the traced geometry would describe marks the artwork no longer has.
 */
export const KEEP_LEVEL = 229;

/**
 * @param {{ctx:CanvasRenderingContext2D}} surface the raw artwork surface
 * @param {number} w device width
 * @param {number} h device height
 * @param {{paperLevel?:number, keepLevel?:number}} [opts]
 */
export function knockOutPaper(surface, w, h, opts = {}) {
  const paper = opts.paperLevel ?? PAPER_LEVEL;
  const keep = opts.keepLevel ?? KEEP_LEVEL;
  const range = Math.max(1, paper - keep);
  if (w <= 0 || h <= 0) return;

  // The artwork surface carries a standing -origin translate, and this pair has
  // to run in device space. `getImageData` ignores the CTM everywhere, but
  // `putImageData` is not portable: the spec says it ignores the transform and
  // browsers do, while node canvases apply it -- which silently slid the whole
  // artwork by the origin, so the mask lined up with nothing and the finished
  // picture was the drawing offset by 32px. Neutralise the transform instead of
  // trusting either behaviour.
  const ctx = surface.ctx;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;

  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    if (a === 0) continue;
    // The minimum channel, not a perceptual luminance: this is the same test
    // the vectorizer uses to find its background cluster, and it is the one
    // that keeps a pale saturated colour (a light yellow highlight) alive
    // where a luminance test would eat it.
    const m = d[i] < d[i + 1]
      ? (d[i] < d[i + 2] ? d[i] : d[i + 2])
      : (d[i + 1] < d[i + 2] ? d[i + 1] : d[i + 2]);
    if (m <= keep) continue;
    if (m >= paper) { d[i + 3] = 0; continue; }
    // A ramp rather than a threshold, so antialiased edges and light greys
    // keep partial alpha instead of the artwork acquiring a jagged silhouette.
    // Multiplied into the existing alpha, never assigned over it: a PNG that
    // already has transparency must keep its own.
    d[i + 3] = Math.round((a * (paper - m)) / range);
  }

  ctx.putImageData(img, 0, 0);
  ctx.restore();
}

/**
 * Whether a traced asset's artwork should have its paper knocked out.
 *
 * Line art is drawn on white and its background is meaningless. A photograph
 * has no paper -- its light pixels are the picture -- so dissolving them would
 * punch holes in a sky.
 */
export const wantsPaperKnockout = (traceMode) => traceMode !== 'photo';
