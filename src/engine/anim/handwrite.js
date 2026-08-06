/**
 * Font-faithful letter tracing.
 *
 * The hand follows a small semantic guide for each character, while the mask
 * reveals the selected font's real outline.  Unlike the old skeleton route it
 * never turns a thick or serif glyph into a single centreline.
 */

import { makePhase, locate, makeStroke } from '../compile/geometry.js';
import { register } from './registry.js';
import { easeEnds, paintClosure } from './penStrokes.js';

function boundsOf(region) {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const ring of region?.rings || []) {
    for (let i = 0; i < ring.length; i += 2) {
      x0 = Math.min(x0, ring[i]); y0 = Math.min(y0, ring[i + 1]);
      x1 = Math.max(x1, ring[i]); y1 = Math.max(y1, ring[i + 1]);
    }
  }
  if (!Number.isFinite(x0)) return null;
  // Synthetic bold lives outside the rings, so a wipe sized to the rings alone
  // would leave the thickened stems of a bold glyph permanently unrevealed.
  const grow = (region.dilate || 0) / 2;
  return [x0 - grow, y0 - grow, x1 + grow, y1 + grow];
}

/** Paint a character-local left-to-right alpha wipe with a soft leading edge. */
function paintWipe(ctx, bbox, progress) {
  if (!bbox || progress <= 0) return;
  const [x0, y0, x1, y1] = bbox;
  const w = Math.max(1, x1 - x0);
  // Keep a hint of antialiasing at the frontier without turning the reveal
  // into a visibly soft curtain across narrow glyphs.
  const edge = Math.min(Math.max(1, w * 0.045), 7);
  const frontier = x0 + Math.min(1, progress) * w;
  const start = Math.max(x0, frontier - edge);
  const end = Math.min(x1, frontier + edge);
  const gradient = ctx.createLinearGradient(start, 0, end, 0);
  gradient.addColorStop(0, '#ffffff');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(x0, y0, end - x0, y1 - y0);
}

export const handwrite = register({
  id: 'draw.handwrite',
  label: 'Trace letterforms',

  paramSchema: {},

  async compile(asset) {
    const guides = asset.layout.guides || [];
    const strokes = guides.map((g) => makeStroke(g.pts, {
      kind: g.lift ? 'TRAVEL' : 'OUTLINE', lift: !!g.lift,
      width: g.width ?? 3, regionId: g.glyph ?? -1,
    }));
    const phase = makePhase(strokes, 0, strokes.length, 'OUTLINE');
    const glyphSpans = new Map();
    strokes.forEach((st, i) => {
      if (st.lift || st.regionId < 0) return;
      const span = glyphSpans.get(st.regionId) || { first: i, last: i };
      span.first = Math.min(span.first, i);
      span.last = Math.max(span.last, i);
      glyphSpans.set(st.regionId, span);
    });
    return {
      strokes,
      regions: asset.layout.regions || [],
      bbox: asset.layout.bbox,
      inkBbox: asset.layout.inkBbox,
      outlineShare: 0,
      phases: { outline: phase, fill: makePhase([], 0, 0, 'FILL') },
      glyphSpans,
      glyphBounds: asset.layout.regions.map(boundsOf),
    };
  },

  advance(sf, plan, u) {
    const phase = plan.phases.outline;
    if (!phase.length) return { x: 0, y: 0, tangent: 0, down: false, active: false, tool: 'pen' };
    const s = easeEnds(u) * phase.length;
    const at = locate(plan.strokes, phase, s);
    const ctx = sf.fill.active.ctx;
    sf.fill.clearActive();
    ctx.fillStyle = '#ffffff';

    // Redrawing the modest text mask is intentionally stateless: seeking and
    // exporting produce exactly the same pixels, with no accumulated alpha
    // seams. A completed character is closed by its true outline; while it is
    // being written, a soft glyph-local wipe keeps serifs and counters from
    // breaking into isolated islands around the abstract guide path.
    const completed = new Set();
    for (const [glyph, span] of plan.glyphSpans) {
      const end = phase.cumStroke[span.last + 1];
      if (s >= end - 1e-9) completed.add(glyph);
    }
    for (const glyph of completed) {
      const region = plan.regions[glyph];
      if (region) paintClosure(ctx, [region]);
    }
    const activeGlyph = plan.strokes[at.strokeIndex].regionId;
    const span = plan.glyphSpans.get(activeGlyph);
    if (span && !completed.has(activeGlyph)) {
      const start = phase.cumStroke[span.first];
      const end = phase.cumStroke[span.last + 1];
      const progress = end > start ? (s - start) / (end - start) : 1;
      paintWipe(ctx, plan.glyphBounds[activeGlyph], progress);
    }
    sf.fill.markUsed();

    const st = plan.strokes[at.strokeIndex];
    return {
      x: at.x,
      y: at.y,
      // Curves and reversals move at the wrist.  Passing their tangent to the
      // rig is what previously made the entire forearm whip around each glyph.
      tangent: 0,
      down: !st.lift,
      active: true,
      tool: 'pen',
    };
  },
});

export default handwrite;
