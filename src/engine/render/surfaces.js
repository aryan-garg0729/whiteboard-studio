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
  // The pooled scratch was built by the outgoing factory. Tests swap factories
  // between suites, and a canvas from the previous one would keep being drawn
  // into by contexts belonging to the new one.
  for (const s of scratchPool.values()) {
    for (const surface of [s.mask, s.reveal, s.out]) disposeSurface(surface);
  }
  scratchPool.clear();
}

export function newSurface(w, h) {
  return createSurface(Math.max(1, Math.ceil(w)), Math.max(1, Math.ceil(h)));
}

/**
 * Release a surface's pixels now rather than whenever the collector gets to it.
 *
 * Canvas memory is native -- skia in the CLI and the MCP server, the browser's
 * own allocator behind `OffscreenCanvas` -- while the JS object holding it is a
 * few dozen bytes. V8 therefore feels almost no pressure from dropping a
 * session and is in no hurry to finalize it, which is why RSS stayed at its
 * peak long after the surfaces were unreachable. Resizing to zero frees the
 * backing store synchronously.
 */
export function disposeSurface(surface) {
  if (!surface?.canvas) return;
  surface.canvas.width = 0;
  surface.canvas.height = 0;
}

/**
 * Scratch for `composite()`, shared between every clip of the same size.
 *
 * The three surfaces compositing needs -- a union of the mask halves, the
 * artwork revealed through it, and the finished output -- carry nothing between
 * calls: each is rewritten from scratch every composite, and the caller consumes
 * the output on the very next line. Giving each clip its own set was three full
 * canvases per clip that only ever held one clip's worth of pixels at a time; on
 * a 56-clip project that measured 1134 MB of the 3.0 GB total. Pooled by size it
 * is 509 MB, because artwork repeats: that project has 56 clips but 29 distinct
 * surface sizes, one of which covers thirteen clips.
 *
 * **Pooled by exact size, not shared as one grow-only buffer.** A single buffer
 * sized to the largest clip is the obvious next step and it is wrong. Bounding
 * the work to the current clip needs a `clip()` region -- `copy` and
 * `destination-in` are defined over the whole clip region, not the source
 * rectangle -- and skia antialiases that region's edge, so the boundary row
 * blends in whatever the previous clip left underneath. It shows up as a
 * one-pixel fringe of another drawing's ink along the edge of the artwork.
 * Dropping the `clip()` is correct but makes every composite a full-buffer
 * operation, which at 3216x1728 is far more memory traffic than the frame is
 * worth. An exactly-sized surface has neither problem: the canvas edge is a hard
 * boundary, so this is pixel-identical to a surface per clip.
 *
 * Module-level rather than hung off the session because `ClipSurfaces` is used
 * standalone (the animation tests build one directly), and because the surface
 * factory this file already keeps in a module-level binding has exactly the same
 * lifetime.
 */
const scratchPool = new Map();

/**
 * How much the pool may hold, in bytes of canvas.
 *
 * Bounded by size rather than by entry count, because the entries are wildly
 * uneven: a caption's set is under a megabyte and a full-bleed illustration's is
 * thirty. A count that is generous enough for the second is far too loose for
 * the first.
 *
 * The number has to clear the working set of the pages that are resident at
 * once, since `renderPage` composites the same clips in the same order on every
 * frame and a pool below that would reallocate rather than save. Two pages of
 * the project this was tuned against ask for at most fifteen distinct sizes,
 * well inside this.
 */
const SCRATCH_POOL_BYTES = 192 * 1024 * 1024;

/** Never evict below this, so a project of very large clips still has a pool. */
const SCRATCH_POOL_FLOOR = 4;

const scratchBytes = (w, h) => w * h * 4 * 3;   // mask + reveal + out

function compositeScratch(w, h) {
  const key = `${w}x${h}`;
  const hit = scratchPool.get(key);
  if (hit) {
    // Re-insert, so `Map` iteration order runs least-recently-used first.
    scratchPool.delete(key);
    scratchPool.set(key, hit);
    return hit;
  }

  const made = {
    bytes: scratchBytes(w, h),
    mask: newSurface(w, h),
    reveal: newSurface(w, h),
    out: newSurface(w, h),
  };
  scratchPool.set(key, made);

  let held = 0;
  for (const s of scratchPool.values()) held += s.bytes;
  while (held > SCRATCH_POOL_BYTES && scratchPool.size > SCRATCH_POOL_FLOOR) {
    const oldest = scratchPool.keys().next().value;
    const evicted = scratchPool.get(oldest);
    scratchPool.delete(oldest);
    held -= evicted.bytes;
    for (const s of [evicted.mask, evicted.reveal, evicted.out]) disposeSurface(s);
  }
  return made;
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
 *
 * Only what a clip has to remember between frames lives here. `art` and `fill`
 * do; `erase` does too but is allocated on first use, since almost no clip has
 * a sweep; and the surfaces compositing merely passes pixels through are shared
 * process-wide -- see `compositeScratch`. A clip therefore costs three canvases
 * rather than eight, which on the 56-clip project this was measured against is
 * 1.17 GB instead of 3.0 GB.
 *
 * The ink layers are also the only ones that can be *given back* while the clip
 * lives on. `art` is painted by the host and could not be reproduced from here;
 * `fill` and `erase` are accumulations of the plan's own strokes, and
 * `commitRange` already knows how to replay the ones a layer is missing. So both
 * are lazy properties rather than fields, and `releaseInk` drops them --
 * see `releaseSurfaces` in renderFrame.js for who asks and why.
 */
export class ClipSurfaces {
  constructor(w, h, originX = 0, originY = 0) {
    this.w = w;
    this.h = h;
    // Surfaces cover only the drawable's padded bbox, but animations emit
    // object-local coordinates. Every *drawing* target therefore carries a
    // standing -origin translation. The pooled compositing surfaces deliberately
    // do not: they only ever blit whole canvases at 0,0.
    this.originX = originX;
    this.originY = originY;
    // The extent a surface for this clip actually gets, which `newSurface`
    // rounds up. The scratch pool is keyed on it, so a clip always gets back a
    // surface the same shape its own layers are.
    this.cw = Math.max(1, Math.ceil(w));
    this.ch = Math.max(1, Math.ceil(h));
    this.art = null;          // built lazily; holds the true colours to reveal
    this._fill = null;        // lazy and releasable; see the class comment
    // Lazy for a stronger reason than the rest: erase is a modifier a clip opts
    // into, so on a real project almost no clip has one. Allocating the pair up
    // front was two of every clip's canvases -- 756 MB of the 3.0 GB an example
    // 56-clip project held, for the one clip that erases.
    this._erase = null;
    this.lastProgress = -1;
  }

  /**
   * The scribble mask. A property rather than a field so that a released clip
   * rebuilds it on the next stroke without every animation having to ask.
   */
  get fill() {
    if (!this._fill) {
      this._fill = new Layer(this.w, this.h);
      this._fill.setOrigin(this.originX, this.originY);
    }
    return this._fill;
  }

  /** The eraser's mask, or null when this clip has never swept. */
  get erase() {
    return this._erase;
  }

  ensureErase() {
    if (!this._erase) {
      this._erase = new Layer(this.w, this.h);
      this._erase.setOrigin(this.originX, this.originY);
    }
    return this._erase;
  }

  /**
   * Give back the accumulated ink, keeping the artwork.
   *
   * Only the masks go: `art` is the host's to install and cannot be rebuilt from
   * here, while `fill` and `erase` are replays of the plan. Resetting
   * `lastProgress` is what makes the return exact -- the next `advance` finds a
   * layer that has committed nothing and `commitRange` draws every stroke up to
   * the current one, in full, which is the same replay a backward seek performs.
   */
  releaseInk() {
    for (const l of [this._fill, this._erase]) {
      if (!l) continue;
      disposeSurface(l.committed);
      disposeSurface(l.active);
    }
    this._fill = null;
    this._erase = null;
    this.lastProgress = -1;
  }

  ensureArt() {
    if (!this.art) {
      this.art = newSurface(this.w, this.h);
      this.art.ctx.setTransform(1, 0, 0, 1, -this.originX, -this.originY);
    }
    return this.art;
  }

  /**
   * Give back everything, artwork included.
   *
   * For a clip that is gone rather than merely off screen -- deleted, or rebuilt
   * from changed artwork. Unlike `releaseInk` this is not recoverable: only the
   * host can put `art` back, so the object must not be rendered again.
   */
  dispose() {
    this.releaseInk();
    disposeSurface(this.art);
    this.art = null;
  }

  resetAll() {
    // Through the private fields: a clip whose ink was released has nothing to
    // reset, and going via the getters would allocate a layer only to clear it.
    this._fill?.reset();
    this._erase?.reset();
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
   *
   * The three surfaces it works on come from a pool keyed on this clip's exact
   * size, so they are the same shape a private set would have been and every
   * step touches exactly the pixels it always did. The only thing the sharing
   * costs is that the output canvas is valid until the next clip composites --
   * which is one line later, at the caller's `drawImage`.
   *
   * @returns {any} the output canvas, live only until the next composite.
   */
  composite() {
    const s = compositeScratch(this.cw, this.ch);

    const o = s.out.ctx;
    o.setTransform(1, 0, 0, 1, 0, 0);
    o.globalCompositeOperation = 'copy';
    o.clearRect(0, 0, this.w, this.h);
    o.globalCompositeOperation = 'source-over';
    o.globalAlpha = 1;

    // `_fill` rather than `fill`: with no mask there is nothing to reveal, and
    // the getter would allocate a layer for the sole purpose of finding it empty.
    if (this.art && this._fill) {
      // `destination-in` keeps the DESTINATION's colour, masked by the
      // source's alpha. So the artwork must be the destination and the mask the
      // source -- the other way round reveals a flat white scribble instead of
      // the artwork's real colours.
      //
      // The two mask halves must also be unioned into their own surface first.
      // Applying `destination-in` twice would intersect the committed and
      // active masks with each other, leaving only their overlap.
      const m = s.mask.ctx;
      m.globalCompositeOperation = 'copy';
      m.drawImage(this.fill.committed.canvas, 0, 0);
      m.globalCompositeOperation = 'source-over';
      m.drawImage(this.fill.active.canvas, 0, 0);

      const r = s.reveal.ctx;
      r.globalCompositeOperation = 'copy';
      r.drawImage(this.art.canvas, 0, 0);
      r.globalCompositeOperation = 'destination-in';
      r.drawImage(s.mask.canvas, 0, 0);
      r.globalCompositeOperation = 'source-over';

      o.drawImage(s.reveal.canvas, 0, 0);
    }

    if (this.erase?.used) {
      // `destination-out` on *this clip's* layer only. Applying it to the page
      // would punch a hole through the background and every clip beneath it.
      o.globalCompositeOperation = 'destination-out';
      o.drawImage(this.erase.committed.canvas, 0, 0);
      o.drawImage(this.erase.active.canvas, 0, 0);
      o.globalCompositeOperation = 'source-over';
    }
    return s.out.canvas;
  }
}
