/**
 * What the studio can do, and what an agent is allowed to ask it for.
 *
 * Two jobs. First, `capabilities()` answers "what is the vocabulary" in one
 * call, so an agent does not have to discover the animation ids by trial.
 * Second, the validators here enforce the rules `normalizeProject` does not.
 *
 * That second job matters more than it looks. The validator is thorough about
 * timing and structure and silent about everything else: `clip.params` is
 * passed through verbatim, `transform` is spread without a numeric check (a
 * string scale survives all the way to the renderer), `handStyleId` is any
 * string, and `ANIMATIONS_FOR_KIND` is advisory data the schema never consults.
 * A human in the UI cannot hit those cases -- the inspector only offers valid
 * choices -- but an agent writing JSON directly hits them immediately, and the
 * failure is a blank frame rather than an error. So this is the only place they
 * can be caught, and it is worth being strict here.
 */

import { listAnimations } from '../src/engine/anim/registry.js';
import { HAND_STYLE_IDS, TOOL_STYLE_IDS } from '../src/engine/hand/styles.js';
import {
  ANIMATIONS_FOR_KIND, ASSET_KINDS, DEFAULTS, TRANSITIONS,
} from '../src/engine/model/project.js';
import { listFonts } from '../electron/fonts.js';
import { hasFfmpeg } from '../electron/media.js';

// Registration is an import side effect, and `listAnimations()` reports only
// what has been registered. `nodeSession` imports all five animation modules,
// so importing it is what makes the catalogue complete -- without this the
// tool would cheerfully report that the studio has no animations.
import '../src/engine/host/nodeSession.js';

export class InvalidInput extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidInput';
  }
}

/** Animations, each tagged with the asset kinds it actually suits. */
export function animations() {
  const kindsFor = (id) =>
    Object.keys(ANIMATIONS_FOR_KIND).filter((k) => ANIMATIONS_FOR_KIND[k].includes(id));
  return listAnimations().map((a) => ({ ...a, kinds: kindsFor(a.id) }));
}

export function fonts() {
  return listFonts().map((f) => ({
    family: f.family,
    path: f.path,
    // Which faces look handwritten; a whiteboard caption in Open Sans reads as
    // a slide, not as something drawn.
    handwriting: f.hand,
    // 'variable' faces carry a real weight axis; on a 'synthetic' one, bold is
    // the letterform's own outline stroked wider, which is blunter but works.
    boldMode: f.boldMode,
  }));
}

/**
 * Everything an agent needs before its first edit, plus whether the two
 * optional dependencies are actually present.
 *
 * The environment check is not decoration. Everything compiles in pure JS, but
 * *exporting* needs ffmpeg, and that fails late and confusingly when missing.
 * Asking up front turns "the export tool returned an error" into "this machine
 * has no ffmpeg".
 */
export function capabilities() {
  return {
    animations: animations(),
    fonts: fonts(),
    handStyles: HAND_STYLE_IDS,
    toolStyles: TOOL_STYLE_IDS,
    transitions: [...TRANSITIONS],
    assetKinds: [...ASSET_KINDS],
    animationsForKind: ANIMATIONS_FOR_KIND,
    defaults: DEFAULTS,
    environment: {
      ffmpeg: hasFfmpeg(),
    },
  };
}

// ── validation ────────────────────────────────────────────────────────

const animById = () => new Map(animations().map((a) => [a.id, a]));

/** An animation must exist *and* suit the asset it is being asked to draw. */
export function checkAnimForKind(animId, kind) {
  if (animId === undefined) return;
  const allowed = ANIMATIONS_FOR_KIND[kind];
  if (!allowed) throw new InvalidInput(`unknown asset kind ${JSON.stringify(kind)}`);
  if (!allowed.includes(animId)) {
    throw new InvalidInput(
      `animation ${JSON.stringify(animId)} does not suit a ${kind} asset; `
      + `use one of ${allowed.join(', ')}`);
  }
}

/**
 * Clamp and type-check `clip.params` against the animation's own paramSchema.
 *
 * Unknown keys are rejected rather than dropped. A misremembered parameter name
 * is the most likely mistake here, and silently ignoring it would leave the
 * agent believing it had changed something it had not -- it would then look at
 * the frame, see no difference, and try to fix the wrong thing.
 *
 * Out-of-range numbers are clamped rather than refused, because the schema's
 * bounds are taste limits rather than correctness ones, and reporting the clamp
 * is more useful than failing the whole edit.
 */
export function checkParams(animId, params) {
  if (params === undefined) return { params: undefined, notes: [] };
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new InvalidInput('params must be an object');
  }
  const anim = animById().get(animId);
  if (!anim) throw new InvalidInput(`unknown animation ${JSON.stringify(animId)}`);
  const schema = anim.paramSchema || {};

  const known = Object.keys(schema);
  const out = {};
  const notes = [];
  for (const [key, value] of Object.entries(params)) {
    const spec = schema[key];
    if (!spec) {
      throw new InvalidInput(known.length
        ? `${animId} has no parameter ${JSON.stringify(key)}; it takes ${known.join(', ')}`
        : `${animId} takes no parameters`);
    }
    if (spec.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new InvalidInput(`${key} must be a finite number, got ${JSON.stringify(value)}`);
      }
      const lo = spec.min ?? -Infinity;
      const hi = spec.max ?? Infinity;
      const clamped = Math.min(hi, Math.max(lo, value));
      if (clamped !== value) notes.push(`${key} clamped from ${value} to ${clamped}`);
      out[key] = clamped;
    } else if (spec.type === 'enum') {
      const options = (spec.options || []).map((o) => (typeof o === 'string' ? o : o.value));
      if (!options.includes(value)) {
        throw new InvalidInput(
          `${key} must be one of ${options.join(', ')}, got ${JSON.stringify(value)}`);
      }
      out[key] = value;
    } else {
      // Colours and anything a future animation adds: require a string rather
      // than inventing a format check that would go stale.
      if (typeof value !== 'string') {
        throw new InvalidInput(`${key} must be a string, got ${JSON.stringify(value)}`);
      }
      out[key] = value;
    }
  }
  return { params: out, notes };
}

/**
 * A transform must be finite numbers.
 *
 * `normalizeProject` spreads `transform` raw, so a string here reaches the
 * renderer and produces NaN geometry -- an empty frame with no error anywhere.
 */
export function checkTransform(transform) {
  if (transform === undefined) return undefined;
  if (transform === null || typeof transform !== 'object' || Array.isArray(transform)) {
    throw new InvalidInput('transform must be an object');
  }
  const out = {};
  for (const [key, value] of Object.entries(transform)) {
    if (!['x', 'y', 'scale', 'rotation'].includes(key)) {
      throw new InvalidInput(`transform has no field ${JSON.stringify(key)}; `
        + 'it takes x, y, scale, rotation');
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new InvalidInput(`transform.${key} must be a finite number, got ${JSON.stringify(value)}`);
    }
    if (key === 'scale' && value <= 0) {
      throw new InvalidInput(`transform.scale must be positive, got ${value}`);
    }
    out[key] = value;
  }
  return out;
}

export function checkHandStyle(id) {
  if (id === undefined) return;
  if (!HAND_STYLE_IDS.includes(id)) {
    throw new InvalidInput(
      `unknown hand style ${JSON.stringify(id)}; expected one of ${HAND_STYLE_IDS.join(', ')}`);
  }
}
