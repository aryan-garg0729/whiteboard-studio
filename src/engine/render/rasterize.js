/**
 * Turn an asset into the pixels the drawing pipeline analyses.
 *
 * `draw.stencilPaint` works on pixels, so this is where the two asset kinds
 * stop being different. A raster is decoded by the host and read back; a vector
 * is painted with `paintVectorArt` -- the same call that installs a vector's
 * artwork -- and read back from there. One analysis, one animation, one set of
 * bugs, instead of a geometry pipeline and a pixel pipeline that have to be kept
 * saying the same thing.
 *
 * Canvas-free, like the rest of the engine: surfaces come from the injected
 * factory, so this runs identically over `OffscreenCanvas` in the app and
 * `@napi-rs/canvas` in the CLI and the MCP server.
 *
 * **A vector rasterises at one pixel per SVG user unit.** Object space is user
 * units -- that is what every existing document's `transform.scale` was authored
 * against -- and a clip's artwork surface is allocated from its object-space
 * bounding box, so there is nowhere to put a supersampled copy. An SVG blown up
 * far past its own viewBox therefore softens. Give the SVG a larger viewBox if
 * you need it sharper.
 */

import { paintVectorArt } from './vectorArt.js';
import { newSurface } from './surfaces.js';

/**
 * @param {any} drawable anything the host's canvas can `drawImage`
 * @param {number} width
 * @param {number} height
 * @returns {{width:number, height:number, data:Uint8ClampedArray}}
 */
export function imagePixels(drawable, width, height) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const s = newSurface(w, h);
  s.ctx.drawImage(drawable, 0, 0, w, h);
  return s.ctx.getImageData(0, 0, w, h);
}

/**
 * @param {{width:number, height:number, regions:Array, subpaths:Array}} parsed
 *   the output of `parseSvg`
 * @returns {{width:number, height:number, data:Uint8ClampedArray}}
 */
export function vectorPixels(parsed) {
  const w = Math.max(1, Math.round(parsed.width));
  const h = Math.max(1, Math.round(parsed.height));
  const s = newSurface(w, h);
  paintVectorArt(s.ctx, parsed.regions, parsed.subpaths);
  return s.ctx.getImageData(0, 0, w, h);
}
