/**
 * Draws the hand sprite for a solved placement.
 *
 * Runs with an identity transform in SCREEN space, after the camera transform
 * has been popped -- the hand must not scale with the artwork.
 */

import { solveHand } from '../hand/rig.js';

const DEG = Math.PI / 180;

/**
 * @param {any} ctx page context (identity transform expected)
 * @param {import('../hand/rig.js').HandStyle} style
 * @param {{x:number,y:number}} tip nib position in screen px
 * @param {number} tangent stroke direction, radians
 * @param {{w:number,h:number}} frame
 * @param {(src:Object) => any} resolveImage maps a manifest source to an image
 */
export function drawHand(ctx, style, tip, tangent, frame, resolveImage) {
  const sol = solveHand(style, tip, tangent, frame);
  const img = resolveImage(sol.source);
  if (!img) return sol;

  const [tx, ty] = sol.tipPx;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.translate(sol.x, sol.y);
  ctx.rotate(sol.rotation + (style.naturalAngleDeg ?? 0) * DEG * 0);
  ctx.scale(sol.scale, sol.scale);

  if (sol.stretchPx > 0 && style.stretchBand) {
    // Lengthen the forearm rather than inflating the whole sprite. The band is
    // a near-uniform stretch of arm, so scaling only those rows is invisible,
    // and it is what keeps portrait output from producing a hand two-thirds as
    // wide as the frame.
    //
    // The band is stored as a FRACTION of source height, because one manifest
    // serves every resolution variant and the rig picks whichever suits the
    // output. Absolute rows measured on the 1080p art land outside the 720p
    // image, so drawImage clips them away, the stretch draws nothing, and the
    // forearm simply ends mid-frame as a floating stump.
    const b0 = Math.round(style.stretchBand[0] * sol.source.h);
    const b1 = Math.round(style.stretchBand[1] * sol.source.h);
    const bandH = Math.max(1, b1 - b0);
    // rows above the band, unstretched
    ctx.drawImage(img, 0, 0, sol.source.w, b0, -tx, -ty, sol.source.w, b0);
    // the band itself, stretched by the deficit
    ctx.drawImage(img, 0, b0, sol.source.w, bandH,
      -tx, -ty + b0, sol.source.w, bandH + sol.stretchPx);
    // rows below the band, pushed down by the same deficit
    const tailH = sol.source.h - b1;
    if (tailH > 0) {
      ctx.drawImage(img, 0, b1, sol.source.w, tailH,
        -tx, -ty + b0 + bandH + sol.stretchPx, sol.source.w, tailH);
    }
  } else {
    ctx.drawImage(img, -tx, -ty);
  }

  ctx.restore();
  return sol;
}
