/**
 * Whiteboard artwork: ink the black outline, then colour the shapes.
 *
 * `draw.stencilPaint` draws any picture at all and therefore assumes nothing
 * about it: it cuts the colours into a fixed number of boxes and paints across
 * them. This one assumes a great deal -- that the artwork was drawn the way a whiteboard illustration is
 * drawn, shapes outlined in black and filled flat -- and gets three things back
 * for it that the general animation cannot have.
 *
 *   - **The colours are the drawing's own.** Groups are anchored on the flat
 *     fills rather than cut to a count, so a five-colour picture makes five
 *     groups and a fill that was never quite flat is still one colour.
 *   - **The outline is inked, not sketched.** There is no grey surrogate to rub
 *     out later: the pen runs down the middle of the linework and the real
 *     black appears behind it, at its real thickness.
 *   - **Colour goes on one shape at a time**, so the pen fills the shirt and
 *     then moves to the shoe instead of scribbling across every red pixel in
 *     the picture at once.
 *
 * Both passes lay a white mask into `sf.fill` and `composite()` shows the
 * artwork through it, so nothing is ever drawn in a stand-in colour.
 *
 * The exactness guarantee is the same one `stencilPaint` makes and is inherited
 * whole: every pixel is owned by some stroke's closure, the closures are blitted
 * as the strokes finish, and the union of them is the image. Where the pen went
 * never decides what is visible.
 */

import { locate, makePhase, tangentAt } from '../compile/geometry.js';
import { analyzeArtwork } from '../compile/pixels.js';
import { buildInkPasses } from '../compile/inkPasses.js';
import {
  applyBrush, artworkInkBbox, easeEnds, PAINT_GAIN, paintRects, strokePartial, strokeWhole,
} from './penStrokes.js';
import { register } from './registry.js';

/**
 * Fraction of the clip spent inking the outline.
 *
 * Close to half, because the outline *is* half the finished drawing and it is
 * the half that reads as drawing -- a viewer sees the picture appear when the
 * linework lands, and the colour that follows confirms it rather than revealing
 * it. Much below a third and the inking looks hurried against a long slow fill.
 */
export const DEFAULT_OUTLINE_SHARE = 0.45;

export const inkPaint = register({
  id: 'draw.inkPaint',
  label: 'Ink outline, then colour',

  paramSchema: {
    colorTolerance: { type: 'number', min: 0, max: 60, step: 1,
                      default: 14, label: 'Colour merge' },
    inkLuma: { type: 'number', min: 0, max: 0.6, step: 0.05,
               default: 0.25, label: 'Outline darkness' },
    // `largestFirst`, where `stencilPaint` defaults to `darkFirst`. That
    // default exists so the dark linework and shadows go down first and give
    // the picture its structure -- but here the linework has its own pass and
    // is already finished, so the argument for it is spent. What is left is
    // lightness for its own sake, which put the bulb icon's one big yellow body
    // last and filled the largest shape in the picture in the closing second.
    // Biggest first is also simply how colouring in goes: the main shapes, then
    // the details on top.
    groupOrder: { type: 'enum', options: ['largestFirst', 'darkFirst', 'readingOrder'],
                  default: 'largestFirst', label: 'Colour order' },
    sweepAngle: { type: 'number', min: -90, max: 90, step: 5,
                  default: -45, label: 'Fill angle' },
    outlineShare: { type: 'number', min: 0, max: 0.9, step: 0.05,
                    default: DEFAULT_OUTLINE_SHARE, label: 'Outline share' },
    inkWidthGain: { type: 'number', min: 0.3, max: 3, step: 0.1,
                    default: 1, label: 'Pen width' },
    fillBrushWidth: { type: 'number', min: 2, max: 64, step: 1,
                      default: 14, label: 'Colour brush' },
  },

  /**
   * @param {{id:string, image:{width:number,height:number,data:Uint8ClampedArray}}} asset
   *   the decoded artwork. A vector is rasterised by the host first, so both
   *   asset kinds arrive here as pixels and there is one pipeline, not two.
   */
  async compile(asset, params = {}) {
    if (!asset.image) throw new Error('draw.inkPaint: asset has no decoded image');
    const analysis = analyzeArtwork(asset.image, {
      palette: 'flat',
      tolerance: params.colorTolerance,
      pieces: true,
    });
    const { ink, paint } = buildInkPasses(analysis, { ...params, seedKey: asset.id || 'art' });

    const strokes = [...ink, ...paint];
    const share = ink.length ? (params.outlineShare ?? DEFAULT_OUTLINE_SHARE) : 0;

    return {
      strokes,
      // Named `outline`/`fill` because that is the shape every other part of the
      // engine already reads, even though both are laid into the same layer.
      phases: {
        outline: makePhase(strokes, 0, ink.length, 'OUTLINE'),
        fill: makePhase(strokes, ink.length, strokes.length, 'FILL'),
      },
      regions: [],
      outlineShare: paint.length ? share : 1,
      penWidth: ink.length ? ink[0].width : (params.fillBrushWidth ?? 14),
      paintGain: PAINT_GAIN,
      bbox: [0, 0, analysis.width, analysis.height],
      inkBbox: artworkInkBbox(analysis),
      width: analysis.width,
      height: analysis.height,
    };
  },

  advance(sf, plan, u) {
    const share = plan.outlineShare;
    const inOutline = u < share || plan.phases.fill.length === 0;
    const phase = inOutline ? plan.phases.outline : plan.phases.fill;

    if (phase.length === 0) {
      return { x: 0, y: 0, tangent: 0, down: false, active: true, tool: 'pen' };
    }

    const local = inOutline
      ? easeEnds(share > 0 ? u / share : 1)
      : easeEnds(share < 1 ? (u - share) / (1 - share) : 1);
    const s = local * phase.length;
    const at = locate(plan.strokes, phase, s);
    const layer = sf.fill;

    const drawWhole = (ctx, i) => {
      const st = plan.strokes[i];
      if (!st.lift) {
        applyBrush(ctx, st, '#ffffff', plan.paintGain);
        strokeWhole(ctx, st);
      }
      // A stroke's coverage joins the mask the moment it finishes, so the
      // picture closes progressively rather than popping at the end.
      if (st.closure) paintRects(ctx, st.closure);
    };

    // Both passes share one layer, so a single commit from the very first stroke
    // covers crossing between them -- there is no second surface whose contents
    // have to be flushed at the boundary.
    layer.commitRange(0, at.strokeIndex, drawWhole);

    layer.clearActive();
    const st = plan.strokes[at.strokeIndex];
    const ctx = layer.active.ctx;
    if (!st.lift) {
      applyBrush(ctx, st, '#ffffff', plan.paintGain);
      strokePartial(ctx, st, at.vertex, at.frac);
    }
    // The last stroke of a phase is never committed, so its closure has to be
    // painted here or the final shape would be the one hole left in an
    // otherwise complete picture.
    if (local >= 1 && st.closure) paintRects(ctx, st.closure);
    // commitRange only marks a layer used when it actually commits something,
    // so the opening frames -- where everything is still active -- would
    // otherwise composite as an empty clip.
    layer.markUsed();

    return {
      x: at.x,
      y: at.y,
      tangent: tangentAt(plan.strokes, phase, s),
      down: !st.lift,
      active: true,
      tool: 'pen',
    };
  },
});

export default inkPaint;
