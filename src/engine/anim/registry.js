/**
 * Animation type registry.
 *
 * The seam that makes new animations cheap is `advance()` returning a PenState.
 * The hand rig asks the animation where the pen is rather than knowing
 * anything about what is being drawn, so a new animation type inherits
 * hand-following, erase interop and export for free.
 */

/**
 * @typedef {Object} PenState
 * @property {number} x @property {number} y  object-local
 * @property {number} tangent                 radians, from +X
 * @property {boolean} down                   false during a pen-up travel move
 * @property {boolean} active                 false before start / after end
 * @property {'pen'|'eraser'} tool
 */

/**
 * @typedef {Object} AnimationType
 * @property {string} id
 * @property {string} label
 * @property {Object} paramSchema  drives the inspector UI; {type,min,max,step,default,label}
 * @property {(asset:Object, params:Object, lod:number) => Promise<Object>} compile
 *   pure and cacheable on hash(asset, params, lod); must not depend on time
 * @property {(surfaces:Object, plan:Object, u:number, prev:number) => PenState} advance
 *   incremental raster work for normalised progress u; returns where the pen is
 * @property {(surfaces:Object) => any} [composite] override layer stacking
 * @property {(plan:Object, u:number, params:Object) => {alpha?:number, scale?:number,
 *            dx?:number, dy?:number}} [present] how the finished clip enters the
 *   frame -- opacity and an offset/scale about its centre, applied at blit time.
 *   Absent means it simply appears where it is, fully opaque.
 */

/** @type {Map<string, AnimationType>} */
const REGISTRY = new Map();

export function register(anim) {
  if (!anim || !anim.id) throw new Error('register: animation needs an id');
  for (const fn of ['compile', 'advance']) {
    if (typeof anim[fn] !== 'function') {
      throw new Error(`register(${anim.id}): missing ${fn}()`);
    }
  }
  REGISTRY.set(anim.id, anim);
  return anim;
}

export function getAnimation(id) {
  const a = REGISTRY.get(id);
  if (!a) throw new Error(`unknown animation type: ${id}`);
  return a;
}

export function listAnimations() {
  return [...REGISTRY.values()].map(({ id, label, paramSchema }) => ({ id, label, paramSchema }));
}

/** Inactive pen, for clips outside their time range. */
export const IDLE_PEN = Object.freeze({
  x: 0, y: 0, tangent: 0, down: false, active: false, tool: 'pen',
});
