/**
 * Clips that arrive rather than being drawn.
 *
 * Not everything on a whiteboard should be hand-drawn. A logo, a photograph, a
 * caption that supports something else being drawn -- forcing a pen through all
 * of them costs seconds of screen time each and makes the drawn things matter
 * less. These are the plain entrances: the artwork is simply there, or it fades,
 * or it pops, or it slides in.
 *
 * Mechanically they are the cheapest possible animation. `sf.fill` is a mask
 * that `ClipSurfaces.composite()` intersects with `art`, so filling it whole
 * yields the untouched artwork -- there is nothing to compile, nothing to pace,
 * and no pen. What varies between the four is entirely in `present()`, which the
 * renderer applies when it blits the finished clip.
 *
 * The entrance must be applied at blit time and not drawn into the surface: the
 * surfaces only extend 32px past the drawable's bbox, so a pop or a slide would
 * be clipped by its own canvas.
 */

import { register, IDLE_PEN } from './registry.js';
import { makePhase } from '../compile/geometry.js';

/** Smoothstep. Linear opacity reads as a light being switched, not a fade. */
const ease = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/** How far a slide travels, as a fraction of the drawable's size. */
const SLIDE_DISTANCE = 0.25;

/** Scale a pop starts from. Below about 0.85 it reads as a zoom, not an entrance. */
const POP_FROM = 0.92;

const SLIDE_AXIS = {
  up: [0, 1], down: [0, -1], left: [1, 0], right: [-1, 0],
};

/**
 * The plan every entrance shares.
 *
 * Shaped like `textReveal`'s: no strokes, empty phases, and an explicit
 * `inkBbox` -- `compileErase` reads that first precisely because an animation
 * can lay ink without laying strokes, and wiping an appeared clip has to work
 * exactly as it does for a drawn one.
 *
 * An asset arrives in one of two shapes, and both have to work. Text is
 * compiled from a layout and hands over `bbox`/`inkBbox` ready-made. **Artwork
 * is compiled from pixels** -- the hosts call `compile({id, image})`, exactly as
 * they do for `draw.inkPaint` and `draw.stencilPaint`, and there is no bbox in
 * that at all. Falling back to a zero box there is not a harmless default: the
 * surfaces are allocated from `plan.bbox`, so a degenerate box means a
 * zero-sized canvas and the clip renders as nothing whatsoever. It also gives
 * the eraser nothing to sweep and a slide no distance to travel, since travel
 * is a fraction of the drawable's own size.
 */
function appearPlan(asset) {
  const bbox = asset.bbox
    ?? (asset.image ? [0, 0, asset.image.width, asset.image.height] : [0, 0, 0, 0]);
  const ink = asset.inkBbox
    ?? inkFromRegions(asset.regions)
    ?? inkFromImage(asset.image)
    ?? bbox;
  return {
    strokes: [],
    regions: asset.regions ?? [],
    bbox,
    inkBbox: ink,
    // What the eraser sizes its sweep from. There is no pen here, so it is
    // taken from the artwork: a wide mark for a big drawable, a fine one for a
    // small one.
    penWidth: asset.penWidth
      ?? Math.max(3, Math.min(ink[2] - ink[0], ink[3] - ink[1]) * 0.06),
    outlineShare: 0,
    phases: {
      outline: makePhase([], 0, 0, 'OUTLINE'),
      fill: makePhase([], 0, 0, 'FILL'),
    },
  };
}

/**
 * The bounds of the pixels that are actually there.
 *
 * The whole rectangle would do for showing the clip -- `revealAll` fills the
 * surface regardless -- but not for erasing it: a cut-out PNG is mostly
 * transparent, and sweeping the eraser across its full rectangle wipes a great
 * deal of empty paper and takes far longer than rubbing out the drawing.
 *
 * Any alpha at all counts, matching `ALPHA_FLOOR` in `pixels.js`: a pixel that
 * is faintly there is there, and the eraser has to reach it.
 */
function inkFromImage(image) {
  if (!image) return null;
  const { width, height, data } = image;
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] < 1) continue;
      if (x < x0) x0 = x;
      if (x + 1 > x1) x1 = x + 1;
      if (y < y0) y0 = y;
      if (y + 1 > y1) y1 = y + 1;
    }
  }
  // Fully transparent artwork has no ink, and must report a degenerate box so
  // the eraser declines it rather than sweeping blank paper.
  return Number.isFinite(x0) ? [x0, y0, x1, y1] : [0, 0, 0, 0];
}

function inkFromRegions(regions) {
  if (!regions?.length) return null;
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const r of regions) {
    if (!r.bbox) continue;
    if (r.bbox[0] < x0) x0 = r.bbox[0];
    if (r.bbox[1] < y0) y0 = r.bbox[1];
    if (r.bbox[2] > x1) x1 = r.bbox[2];
    if (r.bbox[3] > y1) y1 = r.bbox[3];
  }
  return Number.isFinite(x0) ? [x0, y0, x1, y1] : null;
}

/**
 * Reveal everything, every frame.
 *
 * Redrawn rather than committed: it is one rectangle, so it costs nothing next
 * to the stroke replay `commitRange` exists to avoid, and it makes a backward
 * seek exact by construction. `markUsed` is required because `Layer.used` is
 * only set by `commitRange`, which this never calls -- without it the clip
 * composites as empty.
 */
function revealAll(sf) {
  const ctx = sf.fill.active.ctx;
  sf.fill.clearActive();
  ctx.fillStyle = '#ffffff';        // the fill layer is alpha, never colour
  ctx.globalAlpha = 1;
  ctx.fillRect(sf.originX, sf.originY, sf.w, sf.h);
  sf.fill.markUsed();
  return IDLE_PEN;                  // no pen, so no hand
}

/**
 * @param {{id:string, label:string, paramSchema?:Object,
 *          present?:(plan:Object, u:number, p:Object) => Object}} spec
 */
function registerAppear(spec) {
  return register({
    id: spec.id,
    label: spec.label,
    paramSchema: spec.paramSchema ?? {},

    async compile(asset) {
      return appearPlan(asset);
    },

    advance: (sf) => revealAll(sf),

    ...(spec.present
      ? {
        present(plan, u, params = {}) {
          return spec.present(plan, u, { ...defaultsOf(spec.paramSchema), ...params });
        },
      }
      : {}),
  });
}

const defaultsOf = (schema = {}) =>
  Object.fromEntries(Object.entries(schema).map(([k, v]) => [k, v.default]));

registerAppear({
  id: 'appear.instant',
  label: 'Appear (instantly)',
});

registerAppear({
  id: 'appear.fade',
  label: 'Appear (fade in)',
  present: (plan, u) => ({ alpha: ease(u) }),
});

registerAppear({
  id: 'appear.pop',
  label: 'Appear (pop in)',
  paramSchema: {
    scaleFrom: { type: 'number', min: 0.5, max: 1, step: 0.01,
                 default: POP_FROM, label: 'Start scale' },
  },
  present: (plan, u, p) => {
    const t = ease(u);
    return { alpha: t, scale: p.scaleFrom + (1 - p.scaleFrom) * t };
  },
});

registerAppear({
  id: 'appear.slide',
  label: 'Appear (slide in)',
  paramSchema: {
    direction: { type: 'enum', options: ['up', 'down', 'left', 'right'],
                 default: 'up', label: 'From' },
    distance: { type: 'number', min: 0, max: 2, step: 0.05,
                default: SLIDE_DISTANCE, label: 'Travel' },
  },
  present: (plan, u, p) => {
    const t = ease(u);
    const [ax, ay] = SLIDE_AXIS[p.direction] ?? SLIDE_AXIS.up;
    const b = plan.bbox;
    // Travel is a fraction of the drawable's own size, so the same setting
    // reads the same whether the clip is a postage stamp or a full page.
    const reach = (1 - t) * p.distance;
    return {
      alpha: t,
      dx: ax * (b[2] - b[0]) * reach,
      dy: ay * (b[3] - b[1]) * reach,
    };
  },
});

export const isAppear = (animId) => String(animId ?? '').startsWith('appear.');
