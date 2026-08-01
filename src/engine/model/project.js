/**
 * Project document: schema, defaults and validation.
 *
 * The project is plain JSON and is the single source of truth for
 * renderFrame(). This module is the seam the editor UI will sit on -- the UI's
 * job is to produce this shape, and nothing downstream needs to know whether it
 * came from a file, an editor or a test.
 *
 * Deliberately dependency-free and DOM-free so it can be used from the renderer
 * process, the main process, or a CLI.
 */

export const SCHEMA_VERSION = 1;

export const DEFAULTS = {
  meta: { version: SCHEMA_VERSION, fps: 30, width: 1920, height: 1080,
          background: '#fdfdfb', handStyleId: 'hand1', showHand: true },
  transform: { x: 0, y: 0, scale: 1, rotation: 0 },
  camera: { t: 0, x: 0, y: 0, zoom: 1 },
};

/** Asset kinds the renderer knows how to build. */
export const ASSET_KINDS = new Set(['image', 'vector', 'text']);

/** Animation ids that ship today. Kept as data so the check stays honest. */
export const KNOWN_ANIMATIONS = new Set(['draw.outlineFill', 'draw.handwrite']);

/** What a timeline track can hold. */
export const TRACK_KINDS = new Set(['clip', 'audio']);

/**
 * Page transitions that ship today. Kept as data so the check stays honest.
 *
 * The four swipes are one implementation with a direction vector; `cut` is the
 * degenerate case of the same path with a zero duration, not a separate branch.
 */
export const TRANSITIONS = new Set([
  'cut', 'swipeLeft', 'swipeRight', 'swipeUp', 'swipeDown',
]);

/** Unit push direction per transition: where the *outgoing* page travels. */
export const TRANSITION_DIR = {
  swipeLeft: [-1, 0],
  swipeRight: [1, 0],
  swipeUp: [0, -1],
  swipeDown: [0, 1],
};

/**
 * Tracks a document gets when it does not declare any.
 *
 * Tracks are pure layout -- they group clips into timeline lanes and nothing
 * downstream of `renderFrame` reads them. That is why every pre-tracks project
 * file still loads: the normaliser invents these and assigns everything to them.
 */
export const DEFAULT_TRACKS = [
  { id: 'v1', name: 'Video 1', kind: 'clip' },
  { id: 'a1', name: 'Audio 1', kind: 'audio' },
];

class ProjectError extends Error {
  constructor(path, message) {
    super(`${path}: ${message}`);
    this.name = 'ProjectError';
    this.path = path;
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
/** Times in error messages only; float noise in a diagnostic reads as a bug. */
const round2 = (n) => Math.round(n * 100) / 100;

function num(value, fallback, path, { min = -Infinity, max = Infinity } = {}) {
  if (value === undefined) return fallback;
  if (!isNum(value)) throw new ProjectError(path, `expected a number, got ${JSON.stringify(value)}`);
  if (value < min || value > max) {
    throw new ProjectError(path, `must be between ${min} and ${max}, got ${value}`);
  }
  return value;
}

/**
 * The intervals during which each page is *fully* on screen.
 *
 * A window opens when the transition onto the page finishes and closes when the
 * next transition begins, so the mid-swipe interval belongs to neither page.
 * That is deliberate: it is what lets the validator say "you cannot draw here"
 * about a moment when the paper is sliding.
 *
 * Takes `{pages, pageBreaks}` rather than a whole project so the normaliser can
 * call it on half-built state, before there is a project to pass.
 *
 * @returns {{pageId:string, start:number, end:number}[]} ascending; the last
 *   window runs to Infinity because a composition has no inherent end.
 */
export function pageWindows({ pages, pageBreaks = [] }) {
  const out = [];
  let current = pages[0]?.id;
  let start = 0;
  for (const b of pageBreaks) {
    out.push({ pageId: current, start, end: b.t });
    current = b.pageId;
    start = b.t + b.duration;
  }
  out.push({ pageId: current, start, end: Infinity });
  // A break at t=0, or two cuts at the same instant, produce empty windows. A
  // page that is never actually on screen is not a window.
  return out.filter((w) => w.end > w.start);
}

/**
 * Which page is on screen at time `t`, and how far through a transition.
 *
 * `u >= 1` means settled -- there is no transition in progress and `fromPageId`
 * is null. The renderer branches on exactly that.
 *
 * @returns {{pageId:string, fromPageId:string|null, transition:string, u:number}}
 */
export function pageStateAt(project, t) {
  const breaks = project.pageBreaks || [];
  let current = project.pages?.[0]?.id;
  for (const b of breaks) {
    if (t < b.t) break;
    if (t < b.t + b.duration) {
      return {
        pageId: b.pageId,
        fromPageId: current,
        transition: b.transition,
        u: (t - b.t) / b.duration,
      };
    }
    current = b.pageId;
  }
  return { pageId: current, fromPageId: null, transition: 'cut', u: 1 };
}

/** The page on screen at `t`, ignoring transitions. */
export const pageAt = (project, t) => pageStateAt(project, t).pageId;

/**
 * Validate and fill in defaults. Returns a new object; the input is untouched.
 *
 * Throws ProjectError with a path (e.g. "clips[2].duration") rather than
 * returning a boolean -- a malformed project should fail loudly at load time,
 * not silently render an empty video.
 *
 * @param {Object} raw
 * @returns {Object} normalised project
 */
export function normalizeProject(raw) {
  if (!isObj(raw)) throw new ProjectError('project', 'expected an object');

  const meta = { ...DEFAULTS.meta, ...(raw.meta || {}) };
  meta.fps = num(meta.fps, 30, 'meta.fps', { min: 1, max: 240 });
  meta.width = num(meta.width, 1920, 'meta.width', { min: 16, max: 7680 });
  meta.height = num(meta.height, 1080, 'meta.height', { min: 16, max: 4320 });

  // --- assets ---
  const assets = {};
  const rawAssets = raw.assets || {};
  if (!isObj(rawAssets)) throw new ProjectError('assets', 'expected an object keyed by id');
  for (const [id, a] of Object.entries(rawAssets)) {
    const at = `assets.${id}`;
    if (!isObj(a)) throw new ProjectError(at, 'expected an object');
    if (!ASSET_KINDS.has(a.kind)) {
      throw new ProjectError(`${at}.kind`,
        `unknown kind ${JSON.stringify(a.kind)}; expected one of ${[...ASSET_KINDS].join(', ')}`);
    }
    if ((a.kind === 'image' || a.kind === 'vector') && !a.src) {
      throw new ProjectError(`${at}.src`, `required for ${a.kind} assets`);
    }
    if (a.kind === 'text' && typeof a.text !== 'string') {
      throw new ProjectError(`${at}.text`, 'required for text assets');
    }
    // .svg routed through the raster tracer would hit cv2.imread and fail, so
    // normalise the kind from the extension rather than trusting the author.
    const kind = a.kind === 'image' && /\.svg$/i.test(a.src || '') ? 'vector' : a.kind;
    assets[id] = { id, ...a, kind };
  }

  // --- pages ---
  const rawPages = raw.pages?.length ? raw.pages : [{ id: 'page1' }];
  const pageIds = new Set();
  const pages = rawPages.map((p, i) => {
    const at = `pages[${i}]`;
    if (!isObj(p)) throw new ProjectError(at, 'expected an object');
    const pid = p.id || `page${i + 1}`;
    if (pageIds.has(pid)) throw new ProjectError(`${at}.id`, `duplicate page id ${JSON.stringify(pid)}`);
    pageIds.add(pid);
    const kfs = (p.cameraKeyframes?.length ? p.cameraKeyframes : [DEFAULTS.camera])
      .map((k, j) => ({
        t: num(k.t, 0, `${at}.cameraKeyframes[${j}].t`, { min: 0 }),
        x: num(k.x, 0, `${at}.cameraKeyframes[${j}].x`),
        y: num(k.y, 0, `${at}.cameraKeyframes[${j}].y`),
        zoom: num(k.zoom, 1, `${at}.cameraKeyframes[${j}].zoom`, { min: 0.01, max: 100 }),
      }))
      // cameraAt() walks these assuming ascending time; sorting here means a
      // hand-edited file with keyframes out of order still behaves.
      .sort((a, b) => a.t - b.t);
    return { id: pid, name: p.name || `Page ${i + 1}`, cameraKeyframes: kfs };
  });

  // --- page breaks ---
  // When the composition leaves one page for another. `pages` is the set of
  // sheets; this is the *itinerary* over them, and it may visit a sheet more
  // than once -- that is what makes "go back and keep writing" expressible.
  const pageBreaks = (raw.pageBreaks || [])
    .map((b, i) => {
      const at = `pageBreaks[${i}]`;
      if (!isObj(b)) throw new ProjectError(at, 'expected an object');
      if (!TRANSITIONS.has(b.transition)) {
        throw new ProjectError(`${at}.transition`,
          `unknown transition ${JSON.stringify(b.transition)}; expected one of `
          + `${[...TRANSITIONS].join(', ')}`);
      }
      if (!pageIds.has(b.pageId)) {
        throw new ProjectError(`${at}.pageId`, `no such page ${JSON.stringify(b.pageId)}`);
      }
      return {
        t: num(b.t, 0, `${at}.t`, { min: 0 }),
        pageId: b.pageId,
        transition: b.transition,
        // A cut is instantaneous by definition; honouring a duration on it
        // would make the same document mean two different things depending on
        // which field the author edited last.
        duration: b.transition === 'cut'
          ? 0
          : num(b.duration, 0.6, `${at}.duration`, { min: 0.01 }),
      };
    })
    // Same reasoning as cameraKeyframes: everything downstream walks these in
    // ascending time, so a hand-edited file out of order still behaves.
    .sort((a, b) => a.t - b.t);

  for (let i = 1; i < pageBreaks.length; i++) {
    const prev = pageBreaks[i - 1];
    if (prev.t + prev.duration > pageBreaks[i].t) {
      throw new ProjectError(`pageBreaks[${i}].t`,
        `begins at ${pageBreaks[i].t}s but the previous transition is still `
        + `running until ${round2(prev.t + prev.duration)}s`);
    }
  }

  // --- tracks ---
  const rawTracks = raw.tracks?.length ? raw.tracks : DEFAULT_TRACKS;
  const trackIds = new Set();
  const tracks = rawTracks.map((t, i) => {
    const at = `tracks[${i}]`;
    if (!isObj(t)) throw new ProjectError(at, 'expected an object');
    if (!TRACK_KINDS.has(t.kind)) {
      throw new ProjectError(`${at}.kind`,
        `unknown kind ${JSON.stringify(t.kind)}; expected one of ${[...TRACK_KINDS].join(', ')}`);
    }
    const id = t.id || `track${i + 1}`;
    if (trackIds.has(id)) throw new ProjectError(`${at}.id`, `duplicate track id ${JSON.stringify(id)}`);
    trackIds.add(id);
    return { id, name: t.name || `Track ${i + 1}`, kind: t.kind };
  });
  // A document may legally declare only video tracks and then gain an audio
  // clip (or the reverse). Guaranteeing one lane of each kind keeps every
  // `trackId` resolvable without the editor having to special-case an add.
  for (const d of DEFAULT_TRACKS) {
    if (tracks.some((t) => t.kind === d.kind)) continue;
    const id = trackIds.has(d.id) ? `${d.id}-${d.kind}` : d.id;
    tracks.push({ ...d, id });
    trackIds.add(id);
  }
  const firstTrack = (kind) => tracks.find((t) => t.kind === kind).id;

  /** Resolve a declared trackId, or fall back to the first lane of its kind. */
  const trackFor = (id, kind, at) => {
    if (id === undefined) return firstTrack(kind);
    if (!trackIds.has(id)) throw new ProjectError(`${at}.trackId`, `no such track ${JSON.stringify(id)}`);
    const track = tracks.find((t) => t.id === id);
    if (track.kind !== kind) {
      throw new ProjectError(`${at}.trackId`,
        `track ${JSON.stringify(id)} holds ${track.kind}s, not ${kind}s`);
    }
    return id;
  };

  const windows = pageWindows({ pages, pageBreaks });

  /**
   * A clip may only lay ink while its own page is on screen.
   *
   * Checked per *window*, not against the union: drawing across a gap where the
   * page left and came back would look like the pen paused mid-stroke. Draw and
   * erase are checked independently, though, because drawing on one visit and
   * wiping on a later one is a perfectly sensible thing to author.
   */
  const requireOnScreen = (pageId, from, to, at, what) => {
    const mine = windows.filter((w) => w.pageId === pageId);
    if (mine.some((w) => from >= w.start && to <= w.end)) return;
    const page = JSON.stringify(pageId);
    throw new ProjectError(at, mine.length
      ? `${what} runs ${round2(from)}s-${round2(to)}s but page ${page} is only on screen `
        + `${mine.map((w) => `${round2(w.start)}s-${w.end === Infinity ? '∞' : `${round2(w.end)}s`}`).join(', ')}`
      : `${what} is on page ${page}, which no page break ever brings on screen`);
  };

  // --- clips ---
  const seen = new Set();
  const clips = (raw.clips || []).map((c, i) => {
    const at = `clips[${i}]`;
    if (!isObj(c)) throw new ProjectError(at, 'expected an object');

    const id = c.id || `clip${i + 1}`;
    if (seen.has(id)) throw new ProjectError(`${at}.id`, `duplicate clip id ${JSON.stringify(id)}`);
    seen.add(id);

    if (!c.assetId) throw new ProjectError(`${at}.assetId`, 'required');
    if (!assets[c.assetId]) {
      throw new ProjectError(`${at}.assetId`, `no such asset ${JSON.stringify(c.assetId)}`);
    }
    if (!KNOWN_ANIMATIONS.has(c.animId)) {
      throw new ProjectError(`${at}.animId`,
        `unknown animation ${JSON.stringify(c.animId)}; expected one of ${[...KNOWN_ANIMATIONS].join(', ')}`);
    }

    const clip = {
      id,
      assetId: c.assetId,
      animId: c.animId,
      pageId: c.pageId || pages[0].id,
      trackId: trackFor(c.trackId, 'clip', at),
      start: num(c.start, 0, `${at}.start`, { min: 0 }),
      duration: num(c.duration, 3, `${at}.duration`, { min: 0.01 }),
      transform: { ...DEFAULTS.transform, ...(c.transform || {}) },
      params: c.params || {},
    };

    if (c.erase) {
      const eStart = num(c.erase.start, clip.start + clip.duration, `${at}.erase.start`, { min: 0 });
      if (eStart < clip.start + clip.duration) {
        throw new ProjectError(`${at}.erase.start`,
          `erase begins at ${eStart}s but the clip is still drawing until `
          + `${clip.start + clip.duration}s`);
      }
      clip.erase = {
        start: eStart,
        duration: num(c.erase.duration, 2, `${at}.erase.duration`, { min: 0.01 }),
      };
    }

    if (!pageIds.has(clip.pageId)) {
      throw new ProjectError(`${at}.pageId`, `no such page ${JSON.stringify(clip.pageId)}`);
    }
    requireOnScreen(clip.pageId, clip.start, clip.start + clip.duration,
      `${at}.start`, 'the draw');
    if (clip.erase) {
      requireOnScreen(clip.pageId, clip.erase.start, clip.erase.start + clip.erase.duration,
        `${at}.erase.start`, 'the erase sweep');
    }
    return clip;
  });

  const audio = (raw.audio || []).map((a, i) => {
    const at = `audio[${i}]`;
    if (!a.src) throw new ProjectError(`${at}.src`, 'required');
    return {
      src: a.src,
      trackId: trackFor(a.trackId, 'audio', at),
      start: num(a.start, 0, `${at}.start`, { min: 0 }),
      trimIn: num(a.trimIn, 0, `${at}.trimIn`, { min: 0 }),
      duration: a.duration === undefined ? undefined : num(a.duration, 0, `${at}.duration`, { min: 0.01 }),
      gain: num(a.gain, 1, `${at}.gain`, { min: 0, max: 8 }),
    };
  });

  return { meta, assets, pages, pageBreaks, tracks, clips, audio };
}

/**
 * Total timeline length in seconds: the last thing that finishes, plus a tail
 * so the final frame is not the instant the last stroke lands.
 */
export function projectDuration(project, tail = 0.6) {
  let end = 0;
  for (const c of project.clips) {
    end = Math.max(end, c.start + c.duration);
    if (c.erase) end = Math.max(end, c.erase.start + c.erase.duration);
  }
  for (const a of project.audio || []) {
    if (a.duration) end = Math.max(end, a.start + a.duration);
  }
  // A break after the last clip must still get to finish: without this a swipe
  // onto a closing page is cut off partway across the frame.
  for (const b of project.pageBreaks || []) end = Math.max(end, b.t + b.duration);
  // Same for a camera move authored past the last stroke -- a slow pull-out
  // over the finished drawing is a perfectly ordinary way to end a video, and
  // without this the timeline stops before it arrives.
  for (const p of project.pages || []) {
    for (const k of p.cameraKeyframes || []) end = Math.max(end, k.t);
  }
  return end > 0 ? end + tail : 0;
}

/** Frame count for a project at its own fps. */
export function projectFrames(project, tail = 0.6) {
  return Math.round(projectDuration(project, tail) * project.meta.fps);
}

export { ProjectError };
