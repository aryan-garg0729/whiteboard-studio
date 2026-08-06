/**
 * Image and vector drawing: paint the artwork in.
 *
 * The general one, for any picture at all -- a photograph, a soft-gradient
 * illustration, artwork whose colours do not sit in flat areas. It assumes
 * nothing about what it is drawing. `draw.inkPaint` is the specialist for
 * whiteboard artwork and is what new clips get; this is what you fall back to
 * when that assumption does not hold.
 *
 * The pen's path and the picture's coverage are separate concerns: the pen
 * scribbles, and each stroke carries the exact pixels it is responsible for
 * having revealed. Together the strokes own every pixel in the image, so `u = 1`
 * is the source image, exactly, whatever the brush did or did not cover. That is
 * the guarantee the tracer-driven animations this replaced (`draw.imageReveal`,
 * and `draw.outlineFill` before it) could not make: they drew geometry a Python
 * tracer had produced, and it dropped small contours, merged colours, discarded
 * the background cluster and simplified the rest.
 *
 * **There is no pencil stencil any more.** It used to sketch the colour-group
 * boundaries in grey into `sf.ink` first, and `composite()` rubbed them out as
 * paint landed over them. A sketch that is guaranteed to be erased is a detour:
 * it spent a third of the clip drawing something that was not the artwork, and
 * on a picture whose group boundaries *are* its linework it laid a second,
 * greyer outline just inside the real one. Artwork that wants its outline drawn
 * first is exactly what `draw.inkPaint` is for -- it inks the real line, at its
 * real thickness, and leaves it there.
 */

import { locate, makePhase, tangentAt } from '../compile/geometry.js';
import { analyzeArtwork } from '../compile/pixels.js';
import { buildPasses } from '../compile/paintPasses.js';
import {
  applyBrush, artworkInkBbox, easeEnds, PAINT_GAIN, paintRects, strokePartial, strokeWhole,
} from './penStrokes.js';
import { register } from './registry.js';

export const stencilPaint = register({
  // The id keeps the old name. It is written into every project file on disk
  // and into the retirement table that loads older ones; renaming it would
  // break those to no purpose, and an id is a key, not a description.
  id: 'draw.stencilPaint',
  label: 'Paint the artwork in',

  paramSchema: {
    mode: { type: 'enum', options: ['zigzag', 'colorGroups'],
            default: 'zigzag', label: 'Paint style' },
    sweepFrom: { type: 'enum', options: ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'],
                 default: 'topLeft', label: 'Sweep from' },
    sweepAngle: { type: 'number', min: -90, max: 90, step: 5,
                  default: -45, label: 'Sweep angle' },
    groupOrder: { type: 'enum', options: ['darkFirst', 'largestFirst', 'readingOrder'],
                  default: 'darkFirst', label: 'Colour order' },
    colors: { type: 'number', min: 2, max: 24, step: 1, default: 8, label: 'Colour groups' },
    fillBrushWidth: { type: 'number', min: 2, max: 64, step: 1,
                      default: 14, label: 'Paint brush' },
  },

  /**
   * @param {{id:string, image:{width:number,height:number,data:Uint8ClampedArray}}} asset
   *   the decoded artwork. A vector is rasterised by the host first, so both
   *   asset kinds arrive here as pixels and there is one pipeline, not two.
   */
  async compile(asset, params = {}) {
    if (!asset.image) throw new Error('draw.stencilPaint: asset has no decoded image');
    const analysis = analyzeArtwork(asset.image, { colors: params.colors });
    const strokes = buildPasses(analysis, { ...params, seedKey: asset.id || 'art' });

    return {
      strokes,
      // One pass, so the outline phase is empty and the whole clip is `fill`.
      // The pair is kept because `locate` and the dev scripts read both.
      phases: {
        outline: makePhase(strokes, 0, 0, 'OUTLINE'),
        fill: makePhase(strokes, 0, strokes.length, 'FILL'),
      },
      regions: [],
      outlineShare: 0,
      penWidth: params.fillBrushWidth ?? 14,
      paintGain: PAINT_GAIN,
      bbox: [0, 0, analysis.width, analysis.height],
      inkBbox: artworkInkBbox(analysis),
      width: analysis.width,
      height: analysis.height,
    };
  },

  advance(sf, plan, u) {
    const phase = plan.phases.fill;

    if (phase.length === 0) {
      return { x: 0, y: 0, tangent: 0, down: false, active: true, tool: 'pen' };
    }

    const local = easeEnds(u);
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

    layer.commitRange(phase.i0, at.strokeIndex, drawWhole);

    layer.clearActive();
    const st = plan.strokes[at.strokeIndex];
    const ctx = layer.active.ctx;
    if (!st.lift) {
      applyBrush(ctx, st, '#ffffff', plan.paintGain);
      strokePartial(ctx, st, at.vertex, at.frac);
    }
    // The last stroke of a phase is never committed, so its closure has to be
    // painted here or the final group would be the one hole left in an
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

export default stencilPaint;
