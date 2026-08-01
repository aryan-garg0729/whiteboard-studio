/**
 * SVG path data -> flattened subpaths.
 *
 * `svgpath` normalises the messy parts of the spec for us (relative commands,
 * shorthand curves, elliptical arcs) so the flattener below only ever sees
 * M / L / C / Z.
 */

import svgpath from 'svgpath';
import { flattenCubic } from './geometry.js';

/**
 * @param {string} d path data
 * @param {Object} [opts]
 * @param {number} [opts.eps=0.2] flattening tolerance, in the same units as `d`
 *   *after* any transform. Express it in device pixels at the maximum zoom the
 *   object will reach, or curves go visibly faceted once the camera moves in.
 * @param {number[]} [opts.matrix] optional 6-element affine applied first
 * @returns {Array<{pts:Float64Array, closed:boolean}>}
 */
export function flattenPath(d, opts = {}) {
  const eps = opts.eps ?? 0.2;
  let p = svgpath(d).abs().unarc().unshort();
  if (opts.matrix) p = p.matrix(opts.matrix);

  const subpaths = [];
  let cur = null;
  let cx = 0, cy = 0;
  let sx = 0, sy = 0;

  const flush = (closed) => {
    if (cur && cur.length >= 4) subpaths.push({ pts: Float64Array.from(cur), closed });
    cur = null;
  };

  p.iterate((seg) => {
    const cmd = seg[0];
    if (cmd === 'M') {
      flush(false);
      cx = sx = seg[1]; cy = sy = seg[2];
      cur = [cx, cy];
    } else if (cmd === 'L') {
      if (!cur) cur = [cx, cy];
      cx = seg[1]; cy = seg[2];
      cur.push(cx, cy);
    } else if (cmd === 'H') {
      if (!cur) cur = [cx, cy];
      cx = seg[1];
      cur.push(cx, cy);
    } else if (cmd === 'V') {
      if (!cur) cur = [cx, cy];
      cy = seg[1];
      cur.push(cx, cy);
    } else if (cmd === 'C') {
      if (!cur) cur = [cx, cy];
      flattenCubic(cur, cx, cy, seg[1], seg[2], seg[3], seg[4], seg[5], seg[6], eps);
      cx = seg[5]; cy = seg[6];
    } else if (cmd === 'Q') {
      if (!cur) cur = [cx, cy];
      flattenCubic(cur, cx, cy,
        cx + (2 / 3) * (seg[1] - cx), cy + (2 / 3) * (seg[2] - cy),
        seg[3] + (2 / 3) * (seg[1] - seg[3]), seg[4] + (2 / 3) * (seg[2] - seg[4]),
        seg[3], seg[4], eps);
      cx = seg[3]; cy = seg[4];
    } else if (cmd === 'Z' || cmd === 'z') {
      if (cur) {
        // Only re-close if we are not already back at the start; a duplicate
        // vertex would add a zero-length segment and skew arc-length pacing.
        if (Math.hypot(cx - sx, cy - sy) > 1e-9) cur.push(sx, sy);
        flush(true);
      }
      cx = sx; cy = sy;
    }
  });
  flush(false);
  return subpaths;
}

/** Rough polygon area via the shoelace formula; sign gives winding direction. */
export function signedArea(pts) {
  let a = 0;
  const n = pts.length >> 1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += pts[2 * i] * pts[2 * j + 1] - pts[2 * j] * pts[2 * i + 1];
  }
  return a / 2;
}
