/**
 * THE contract. Everything else in the engine exists to make this a pure
 * function of (project, frameIndex).
 *
 * `frameIndex` is the parameter rather than `t` on purpose: accumulating
 * `t += 1/fps` drifts, deriving `t = n/fps` does not. Preview maps a wall
 * clock to a frame index and calls this; export counts. Same function, so an
 * exported frame is identical to the previewed one.
 *
 * Rules this file enforces, because every determinism guarantee depends on them:
 *   - no Math.random, no Date.now, no performance.now below this line
 *   - no state carried between calls except semantically transparent caches
 *   - the hand is drawn in screen space, outside the camera transform
 */

import { getAnimation, IDLE_PEN } from '../anim/registry.js';
import { ClipSurfaces, newSurface } from './surfaces.js';
import { drawHand } from './drawHand.js';
import { advanceErase } from '../anim/erase.js';
import { TRANSITION_DIR, pageStateAt } from '../model/project.js';

/**
 * @typedef {Object} RenderSession
 * @property {Map<string, Object>} plans     compiled DrawPlan per clip
 * @property {Map<string, ClipSurfaces>} surfaces
 * @property {Map<string, any>} hands        hand style manifests by id
 * @property {(src:Object) => any} resolveImage
 */

export function createSession({ hands = new Map(), resolveImage = () => null } = {}) {
  return { plans: new Map(), erasePlans: new Map(), surfaces: new Map(), hands, resolveImage };
}

/**
 * Resolve which hand sprite to use for the active tool.
 *
 * Faking a missing tool with a pen sprite looks worse than showing nothing -- a
 * viewer plainly sees a pen erasing -- so a tool with no matching style falls
 * back to no hand at all.
 *
 * This scans `session.hands`, so it only works if the host actually loaded the
 * tool styles alongside the chosen drawing hand; see hand/styles.js.
 */
function pickStyleForTool(session, preferredId, tool) {
  const preferred = session.hands.get(preferredId);
  if (!tool || tool === 'pen') return preferred;
  if (preferred?.tool?.type === tool) return preferred;
  for (const style of session.hands.values()) {
    if (style.tool?.type === tool) return style;
  }
  return null;
}

/** Ease used for every interpolated motion, so camera and paper agree. */
const smoothstep = (u) => u * u * (3 - 2 * u);

/**
 * Camera state at time t, interpolated from the page's keyframes.
 *
 * `x`/`y` interpolate linearly but `zoom` interpolates *geometrically*. Zoom is
 * a ratio, not a distance: lerping 1 -> 4 spends the first half of the move
 * covering 1x-2.5x and the second half covering 2.5x-4x, which on screen reads
 * as a zoom that lurches and then crawls. Stepping by a constant *factor*
 * instead makes the apparent rate constant, which is what "smooth zoom" means.
 * Endpoints are unchanged, so seeking to a keyframe is still exact.
 */
export function cameraAt(page, t) {
  const kfs = page?.cameraKeyframes;
  if (!kfs || !kfs.length) return { x: 0, y: 0, zoom: 1 };
  if (t <= kfs[0].t) return kfs[0];
  const last = kfs[kfs.length - 1];
  if (t >= last.t) return last;
  let i = 0;
  while (i < kfs.length - 1 && kfs[i + 1].t <= t) i++;
  const a = kfs[i];
  const b = kfs[i + 1];
  const span = b.t - a.t;
  const raw = span > 1e-9 ? (t - a.t) / span : 0;
  const u = smoothstep(raw);
  return {
    x: a.x + (b.x - a.x) * u,
    y: a.y + (b.y - a.y) * u,
    // Safe as a ratio: the validator clamps zoom to [0.01, 100], so it is
    // always finite and strictly positive.
    zoom: a.zoom * ((b.zoom / a.zoom) ** u),
  };
}

/**
 * How long the clip takes to swap the drawn surrogate for the source artwork,
 * in seconds. Short enough to read as the drawing "settling", long enough not
 * to pop. Kept as time (not frames) so it looks the same at any fps.
 */
export const SETTLE_SECONDS = 0.35;

/** Crossfade progress from the drawn look to the original artwork. */
export function settleAt(clip, t) {
  const end = clip.start + clip.duration;
  if (t <= end) return 0;
  return Math.min(1, (t - end) / SETTLE_SECONDS);
}

function surfacesFor(session, clip, plan) {
  let sf = session.surfaces.get(clip.id);
  if (!sf) {
    const b = plan.bbox;
    const pad = 32;
    sf = new ClipSurfaces(b[2] - b[0] + pad * 2, b[3] - b[1] + pad * 2, b[0] - pad, b[1] - pad);
    session.surfaces.set(clip.id, sf);
  }
  return sf;
}

/**
 * Create the surface set for every clip that has a compiled plan.
 *
 * Hosts install each clip's source artwork into `sf.art` before rendering, which
 * needs the surfaces to exist first. They used to get them by rendering the last
 * frame and throwing the ink away -- a hack that worked only because every clip
 * was drawn on every frame. Now that `renderPage` skips clips on other pages,
 * such a warm-up would leave every page but the last one without surfaces, and
 * their artwork would silently never be installed.
 */
export function ensureSurfaces(session, project) {
  for (const clip of project.clips || []) {
    const plan = session.plans.get(clip.id);
    if (plan) surfacesFor(session, clip, plan);
  }
}

/**
 * Render one page, whole, into `ctx`.
 *
 * This is the seam the page transitions are built on: a transition needs both
 * the outgoing and the incoming page as finished images before it can slide
 * them, and having exactly one function that turns (page, t) into pixels is
 * what keeps a transitioning frame identical to a settled one.
 *
 * It paints its own background rather than inheriting the caller's. That is not
 * incidental tidiness -- a page drawn onto a transparent surface and then blitted
 * mid-swipe shows the other page straight through the paper.
 *
 * The hand is *returned*, not drawn. It lives in screen space at a constant
 * apparent size, so it must be placed after compositing, by the caller that
 * knows where the pages ended up.
 *
 * @returns {{tip:{x:number,y:number}, tangent:number, tool:string}|null} where
 *   the hand should go, or null when nothing on this page is being drawn.
 */
export function renderPage(session, project, pageId, t, ctx, opts) {
  const { width, height } = opts;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.fillStyle = project.meta?.background ?? '#ffffff';
  ctx.fillRect(0, 0, width, height);

  const page = project.pages?.find((p) => p.id === pageId) ?? project.pages?.[0];
  const cam = cameraAt(page, t);

  /** @type {{tip:{x:number,y:number}, tangent:number, tool:string}|null} */
  let handAt = null;

  for (const clip of project.clips || []) {
    if (t < clip.start) continue;
    // Clips on other sheets are skipped outright, which is also what makes
    // revisiting a page cheap: while page 1 is off screen its clips advance
    // not at all, and on return `u` is already 1 so the backward-seek reset
    // below never fires and the ink is simply still there.
    //
    // A clip with no page falls back to the first one, matching what
    // normalizeProject fills in. This function must also work on the hand-built
    // literals the engine tests and the demo scripts pass it, and silently
    // rendering nothing is the worst possible response to a missing field.
    if ((clip.pageId ?? project.pages?.[0]?.id) !== pageId) continue;
    const plan = session.plans.get(clip.id);
    if (!plan) continue;

    const u = Math.min(1, (t - clip.start) / Math.max(1e-9, clip.duration));
    const sf = surfacesFor(session, clip, plan);

    // A backward seek invalidates the accumulated ink; replaying is correct
    // and pixel-identical to forward playback. Export never takes this path.
    if (u < sf.lastProgress) sf.resetAll();

    const anim = getAnimation(clip.animId);
    let pen = u >= 0 ? anim.advance(sf, plan, u, sf.lastProgress) : IDLE_PEN;
    sf.lastProgress = u;

    // The drawing hand is only present while the draw is in progress.
    let handLive = u < 1;

    // Erase is a modifier on an already-drawn clip, not an animation type, so
    // it works identically for images and text without either knowing about it.
    if (clip.erase && t >= clip.erase.start) {
      const ep = session.erasePlans.get(clip.id);
      if (ep) {
        const eu = Math.min(1, (t - clip.erase.start)
          / Math.max(1e-9, clip.erase.duration));
        const epen = advanceErase(sf, ep, eu);
        if (eu < 1) {
          // The eraser owns the hand while it runs. Note this must also
          // re-open hand visibility: by now the draw's own u is 1, so the
          // draw-phase test alone would suppress the eraser's hand entirely.
          pen = epen;
          handLive = true;
        }
      }
    }

    const out = sf.composite(settleAt(clip, t));

    // world -> screen
    const tr = clip.transform || { x: 0, y: 0, scale: 1, rotation: 0 };
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.translate(width / 2, height / 2);
    ctx.scale(cam.zoom, cam.zoom);
    ctx.translate(-cam.x, -cam.y);
    ctx.translate(tr.x, tr.y);
    if (tr.rotation) ctx.rotate(tr.rotation);
    ctx.scale(tr.scale, tr.scale);
    ctx.drawImage(out, sf.originX, sf.originY);
    ctx.restore();

    // Visibility follows `active`, not `down`: during a pen-up travel move the
    // hand is hopping between letters and must stay on screen. `down` governs
    // whether ink is laid, not whether the hand exists.
    if (pen.active && handLive) {
      // Convert the object-local pen point into screen space by hand, since
      // the sprite must NOT inherit the camera scale.
      const wx = tr.x + (pen.x * tr.scale);
      const wy = tr.y + (pen.y * tr.scale);
      handAt = {
        tip: {
          x: width / 2 + (wx - cam.x) * cam.zoom,
          y: height / 2 + (wy - cam.y) * cam.zoom,
        },
        tangent: pen.tangent,
        tool: pen.tool,
      };
    }
  }

  return handAt;
}

/**
 * Full-frame scratch surfaces for the two pages in flight during a transition.
 *
 * A semantically transparent cache, which is what the determinism rules at the
 * top of this file permit: the pixels written depend only on (project, t). A
 * project that never transitions never allocates them.
 */
function pageSurfaces(session, width, height) {
  const cache = session.pageCache;
  if (!cache || cache.width !== width || cache.height !== height) {
    session.pageCache = {
      width,
      height,
      from: newSurface(width, height),
      to: newSurface(width, height),
    };
  }
  return session.pageCache;
}

/**
 * Render the composed frame for `frameIndex` into `ctx`.
 *
 * @param {RenderSession} session
 * @param {Object} project
 * @param {number} frameIndex
 * @param {any} ctx destination 2D context, sized {width, height}
 * @param {{width:number, height:number, showHand?:boolean, handStyleId?:string}} opts
 */
export function renderFrame(session, project, frameIndex, ctx, opts) {
  const { width, height } = opts;
  const showHand = opts.showHand !== false;
  const fps = project.meta?.fps ?? 30;
  const t = frameIndex / fps;

  const state = pageStateAt(project, t);
  let handAt = null;

  if (state.u >= 1 || !TRANSITION_DIR[state.transition]) {
    // The common case, and the whole of any single-page project: exactly the
    // work this function did before pages existed.
    handAt = renderPage(session, project, state.pageId, t, ctx, opts);
  } else {
    // Push: both sheets travel together, locked like a filmstrip, so reversing
    // the direction reads as going back rather than as a different effect.
    const [dx, dy] = TRANSITION_DIR[state.transition];
    const e = smoothstep(state.u);
    const surf = pageSurfaces(session, width, height);

    // Both pages still advance their clips -- a clip is not allowed to draw
    // during a transition (the validator enforces it), but the outgoing page's
    // finished ink and the incoming page's earlier ink both have to be there.
    renderPage(session, project, state.fromPageId, t, surf.from.ctx, opts);
    renderPage(session, project, state.pageId, t, surf.to.ctx, opts);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    // Nothing shows through the gap between the sheets, but paint the paper
    // anyway so a rounding seam is background rather than whatever was here.
    ctx.fillStyle = project.meta?.background ?? '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(surf.from.canvas, dx * width * e, dy * height * e);
    ctx.drawImage(surf.to.canvas, dx * width * (e - 1), dy * height * (e - 1));

    // No hand mid-transition. Nothing is being drawn, and a hand sliding along
    // with the paper reads as a glitch rather than as motion.
  }

  // The hand goes last so it occludes the artwork, and in screen space so it
  // keeps a constant apparent size at any zoom.
  if (showHand && handAt && opts.handStyleId) {
    const style = pickStyleForTool(session, opts.handStyleId, handAt.tool);
    if (style) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      drawHand(ctx, style, handAt.tip, handAt.tangent, { w: width, h: height },
        session.resolveImage);
    }
  }
}
