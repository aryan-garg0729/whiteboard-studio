/**
 * Per-clip drawing surfaces and the committed/active raster strategy.
 *
 * Ink is inherently accumulative, but `renderFrame(t)` must stay a pure
 * function of t. Two wrong ways to reconcile that:
 *
 *   - Clear and replay every stroke each frame. Correct, but O(strokes) per
 *     frame; a 1080p export crawls.
 *   - Append only the newly-revealed segment each frame. Fast, but drawing one
 *     polyline in N per-frame chunks antialiases differently at the joins than
 *     drawing it in one pass -- you get visible seams and darker overlap dots.
 *
 * So each layer is a *pair*: completed strokes are drawn once, in full, into
 * `committed`; the single in-progress stroke is redrawn from its first vertex
 * into `active` every frame. That is O(1) amortised and pixel-identical to a
 * single-pass draw. Seeking backward clears `committed` and replays -- correct,
 * and only ever hit while scrubbing, never during export.
 */

/**
 * Canvas factory. The browser supplies one backed by OffscreenCanvas; the
 * headless harness supplies one backed by @napi-rs/canvas. The engine itself
 * never imports either.
 * @type {(w:number, h:number) => {canvas:any, ctx:any}}
 */
let createSurface = () => {
  throw new Error('surfaces: call setSurfaceFactory() before rendering');
};

export function setSurfaceFactory(fn) {
  createSurface = fn;
}

export function newSurface(w, h) {
  return createSurface(Math.max(1, Math.ceil(w)), Math.max(1, Math.ceil(h)));
}

/**
 * Clear a whole surface regardless of the origin transform currently applied
 * to it. Animations draw in object-local coordinates, so drawing contexts
 * carry a standing translation; clearRect would otherwise clear the wrong
 * rectangle and leave a band of stale ink along two edges.
 */
function clearAll(ctx, w, h) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.restore();
}

/** A committed/active pair plus the bookkeeping to keep them consistent. */
export class Layer {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.committed = newSurface(w, h);
    this.active = newSurface(w, h);
    /** strokes with index < committedUpTo have been drawn into `committed` */
    this.committedUpTo = 0;
    /**
     * Whether this layer has any ink at all, committed or in progress.
     *
     * Not derivable from `committedUpTo`: a sweep that is one long stroke
     * (the eraser is exactly this) leaves the counter at its phase start for
     * the whole animation, so gating compositing on the counter drops the
     * layer entirely until the very last frame.
     */
    this.used = false;
  }

  /**
   * Shift this layer so object-local coordinates land correctly on a surface
   * that only covers the drawable's bounding box.
   */
  setOrigin(ox, oy) {
    this.committed.ctx.setTransform(1, 0, 0, 1, -ox, -oy);
    this.active.ctx.setTransform(1, 0, 0, 1, -ox, -oy);
  }

  /**
   * Discard all accumulated ink. Used on a backward seek.
   *
   * Clears `active` as well as `committed`. Leaving `active` behind strands
   * the last in-progress stroke on a layer nothing is currently driving: an
   * animation only calls clearActive() on the layer it is presently drawing
   * into, so during an outline pass the fill layer is never touched and a
   * stale fill mask keeps compositing. That is what made a region appear
   * pre-coloured before its outline had even been drawn.
   */
  reset(base = 0) {
    clearAll(this.committed.ctx, this.w, this.h);
    clearAll(this.active.ctx, this.w, this.h);
    this.committedUpTo = base;
    this.used = false;
  }

  clearActive() {
    clearAll(this.active.ctx, this.w, this.h);
  }

  /** Flag that something was drawn this frame, so compositing includes us. */
  markUsed() {
    this.used = true;
  }

  /**
   * Bring `committed` up to (but excluding) stroke `index`, drawing each newly
   * completed stroke exactly once and in full.
   *
   * `i0` is the first stroke index belonging to this layer's phase. It is not
   * optional bookkeeping: stroke indices are global across the whole plan, so
   * a fill layer told to commit "through stroke 7" would otherwise stamp the
   * seven *outline* strokes into the fill mask.
   *
   * @param {number} i0 first stroke index owned by this layer
   * @param {number} index exclusive upper bound
   * @param {(ctx:any, strokeIndex:number) => void} drawWhole
   */
  commitRange(i0, index, drawWhole) {
    if (this.committedUpTo < i0) this.committedUpTo = i0;
    if (index < this.committedUpTo) this.reset(i0); // backward seek: replay
    for (let i = this.committedUpTo; i < index; i++) {
      drawWhole(this.committed.ctx, i);
      this.used = true;
    }
    this.committedUpTo = Math.max(this.committedUpTo, index);
  }
}

/**
 * All surfaces belonging to one clip.
 *
 * `art` holds the finished artwork at object resolution and is built once;
 * `fill` accumulates the scribble *mask*, not colour, and is intersected with
 * `art` at composite time so the reveal shows the real gradients and texture
 * rather than a flat fill.
 */
export class ClipSurfaces {
  constructor(w, h, originX = 0, originY = 0) {
    this.w = w;
    this.h = h;
    // Surfaces cover only the drawable's padded bbox, but animations emit
    // object-local coordinates. Every *drawing* target therefore carries a
    // standing -origin translation. `reveal` and `out` deliberately do not:
    // they only ever blit whole canvases at 0,0.
    this.originX = originX;
    this.originY = originY;
    this.art = null;          // built lazily; holds the true colours to reveal
    this.fill = new Layer(w, h);
    this.erase = new Layer(w, h);
    for (const l of [this.fill, this.erase]) l.setOrigin(originX, originY);
    this.maskUnion = newSurface(w, h);
    this.reveal = newSurface(w, h);
    this.out = newSurface(w, h);
    this.lastProgress = -1;
  }

  ensureArt() {
    if (!this.art) {
      this.art = newSurface(this.w, this.h);
      this.art.ctx.setTransform(1, 0, 0, 1, -this.originX, -this.originY);
    }
    return this.art;
  }

  resetAll() {
    this.fill.reset();
    this.erase.reset();
    this.lastProgress = -1;
  }

  /**
   * Compose this clip's layers into `out`.
   *
   * Every animation lays a *mask* into `fill` and `art` holds the true colours,
   * so the whole of compositing is: union the mask, intersect the artwork with
   * it, then subtract the eraser.
   *
   * There used to be more -- a pencil stencil in its own `ink` layer, knocked
   * out as paint covered it, and a crossfade from the pen's heavier surrogate
   * to the real artwork once a clip finished. Both are gone: no animation draws
   * a surrogate any more, so there is nothing to knock out and nothing to fade
   * to. See `doc.md` for the history.
   */
  composite() {
    const o = this.out.ctx;
    o.setTransform(1, 0, 0, 1, 0, 0);
    o.globalCompositeOperation = 'copy';
    o.clearRect(0, 0, this.w, this.h);
    o.globalCompositeOperation = 'source-over';
    o.globalAlpha = 1;

    if (this.art) {
      // `destination-in` keeps the DESTINATION's colour, masked by the
      // source's alpha. So the artwork must be the destination and the mask the
      // source -- the other way round reveals a flat white scribble instead of
      // the artwork's real colours.
      //
      // The two mask halves must also be unioned into their own surface first.
      // Applying `destination-in` twice would intersect the committed and
      // active masks with each other, leaving only their overlap.
      const m = this.maskUnion.ctx;
      m.globalCompositeOperation = 'copy';
      m.drawImage(this.fill.committed.canvas, 0, 0);
      m.globalCompositeOperation = 'source-over';
      m.drawImage(this.fill.active.canvas, 0, 0);

      const r = this.reveal.ctx;
      r.globalCompositeOperation = 'copy';
      r.drawImage(this.art.canvas, 0, 0);
      r.globalCompositeOperation = 'destination-in';
      r.drawImage(this.maskUnion.canvas, 0, 0);
      r.globalCompositeOperation = 'source-over';

      o.drawImage(this.reveal.canvas, 0, 0);
    }

    if (this.erase.used) {
      // `destination-out` on *this clip's* layer only. Applying it to the page
      // would punch a hole through the background and every clip beneath it.
      o.globalCompositeOperation = 'destination-out';
      o.drawImage(this.erase.committed.canvas, 0, 0);
      o.drawImage(this.erase.active.canvas, 0, 0);
      o.globalCompositeOperation = 'source-over';
    }
    return this.out.canvas;
  }
}
