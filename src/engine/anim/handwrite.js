/**
 * Text animation: the pen writes each letter along its centreline,
 * left to right.
 *
 * Structurally simpler than the image animation because there is no fill
 * phase -- handwriting is pure outline. It reuses the same stroke/phase
 * machinery, so pen speed, travel discounting and hand tracking all behave
 * identically.
 */

import { makePhase, locate, tangentAt } from '../compile/geometry.js';
import { register } from './registry.js';
import { easeEnds, strokePartial, strokeWhole } from './outlineFill.js';

function applyBrush(ctx, st) {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = st.width;
  ctx.strokeStyle = st.color;
}

export const handwrite = register({
  id: 'draw.handwrite',
  label: 'Handwrite text',

  paramSchema: {
    penWidth: { type: 'number', min: 0.5, max: 20, step: 0.5, default: 3, label: 'Pen width' },
    color: { type: 'color', default: '#1a1a1a', label: 'Ink' },
  },

  /**
   * The heavy lifting happens in compile/text.js, which needs async access to
   * the sidecar. The caller passes the already-laid-out result through as
   * `asset.layout` so this stays a pure assembly step.
   *
   * @param {{layout:{strokes:Array, bbox:number[]}}} asset
   */
  async compile(asset) {
    const strokes = asset.layout.strokes;
    return {
      strokes,
      bbox: asset.layout.bbox,
      outlineShare: 1,
      phases: {
        outline: makePhase(strokes, 0, strokes.length, 'OUTLINE'),
        fill: makePhase(strokes, strokes.length, strokes.length, 'FILL'),
      },
    };
  },

  advance(sf, plan, u) {
    const phase = plan.phases.outline;
    if (phase.length === 0) {
      return { x: 0, y: 0, tangent: 0, down: false, active: true, tool: 'pen' };
    }

    const s = easeEnds(u) * phase.length;
    const at = locate(plan.strokes, phase, s);

    sf.ink.commitRange(phase.i0, at.strokeIndex, (ctx, i) => {
      const st = plan.strokes[i];
      if (st.lift) return;
      applyBrush(ctx, st);
      strokeWhole(ctx, st);
    });

    sf.ink.clearActive();
    const st = plan.strokes[at.strokeIndex];
    if (!st.lift) {
      applyBrush(sf.ink.active.ctx, st);
      strokePartial(sf.ink.active.ctx, st, at.vertex, at.frac);
    }

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

export default handwrite;
