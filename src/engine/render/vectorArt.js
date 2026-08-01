/**
 * Paint a parsed vector's own appearance onto a context.
 *
 * This serves two jobs at once: it is the artwork the fill scribble reveals,
 * and it is what the clip settles to once the drawing finishes. A raster asset
 * gets both from its source pixels; a vector has no raster, so we reproduce it
 * from the geometry.
 *
 * Lives in the engine rather than the UI host because the CLI exporter needs
 * exactly the same output -- preview and export must not diverge.
 */

/**
 * @param {any} ctx destination context, already carrying the -origin translate
 * @param {Array<{rings:Array<ArrayLike<number>>, color:string}>} regions
 * @param {Array<{pts:ArrayLike<number>, closed?:boolean,
 *                stroke?:string, strokeWidth?:number}>} subpaths
 */
export function paintVectorArt(ctx, regions = [], subpaths = []) {
  // Reverse: regions arrive largest-first, and the largest belongs underneath.
  for (const region of [...regions].reverse()) {
    ctx.beginPath();
    for (const ring of region.rings) {
      ctx.moveTo(ring[0], ring[1]);
      for (let i = 2; i < ring.length; i += 2) ctx.lineTo(ring[i], ring[i + 1]);
      ctx.closePath();
    }
    ctx.fillStyle = region.color;
    ctx.fill('evenodd');
  }

  // Strokes matter as much as fills: a shape with fill="none" contributes no
  // region at all, so a fills-only artwork surface would make it vanish the
  // moment the clip settled.
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const sp of subpaths) {
    if (!sp.stroke) continue;
    ctx.beginPath();
    ctx.moveTo(sp.pts[0], sp.pts[1]);
    for (let i = 2; i < sp.pts.length; i += 2) ctx.lineTo(sp.pts[i], sp.pts[i + 1]);
    if (sp.closed) ctx.closePath();
    ctx.strokeStyle = sp.stroke;
    ctx.lineWidth = sp.strokeWidth || 1;
    ctx.stroke();
  }
}
