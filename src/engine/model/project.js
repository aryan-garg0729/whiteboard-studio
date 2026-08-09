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
  // `name` is the authored project title, independent of the filename so it
  // survives a Save As and a copied file.
  meta: { version: SCHEMA_VERSION, name: '', fps: 30, width: 1920, height: 1080,
          background: '#fdfdfb', handStyleId: 'hand3', showHand: true },
  transform: { x: 0, y: 0, scale: 1, rotation: 0 },
  camera: { t: 0, x: 0, y: 0, zoom: 1 },
  // Burned-in narration text. A printed face, not a handwriting face: these are
  // read at a glance while the hand is drawing something else, so legibility
  // beats matching the whiteboard's texture.
  subtitles: {
    enabled: true,
    style: 'karaoke',
    words: [],
    font: 'assets/fonts/Montserrat.ttf',
    fontSize: 56,
    bold: true,
    color: '#ffffff',
    highlight: '#ffd54a',
    background: '#000000cc',
    marginBottom: 0.08,
    maxChars: 42,
    maxWords: 7,
    gapSplit: 0.6,
    holdTail: 0.25,
  },
};

/**
 * How the narration's words are presented.
 *
 * `bar` shows the whole cue at once and swaps it; `karaoke` shows the whole cue
 * and recolours each word as it is spoken; `pop` reveals one word at a time.
 * Kept as data so the check stays honest.
 */
export const SUBTITLE_STYLES = new Set(['bar', 'karaoke', 'pop']);

/** Asset kinds the renderer knows how to build. */
export const ASSET_KINDS = new Set(['image', 'vector', 'text']);

/** Animation ids that ship today. Kept as data so the check stays honest. */
export const KNOWN_ANIMATIONS = new Set([
  'draw.stencilPaint', 'draw.inkPaint', 'draw.textReveal', 'draw.handwrite',
  'appear.instant', 'appear.fade', 'appear.pop', 'appear.slide',
]);

/**
 * Retired animation ids, and what they become.
 *
 * `draw.imageReveal` and `draw.outlineFill` were the two ways artwork used to be
 * drawn, both planned from traced geometry. `draw.stencilPaint` replaces both.
 * Documents are migrated on load rather than rejected: the examples, every
 * project anyone has saved, and the MCP scripts in the wild all name the old
 * ids, and a document that used to render should not stop rendering.
 */
export const RETIRED_ANIMATIONS = {
  'draw.imageReveal': 'draw.stencilPaint',
  'draw.outlineFill': 'draw.stencilPaint',
};

/**
 * Parameter names that moved with them.
 *
 * `scribbleAngle` is the same quantity as `sweepAngle`, so it is renamed. The
 * rest are dropped rather than mapped onto something they are not: `brushWidth`
 * and `outlineShare` both described the pencil stencil, which no longer exists
 * -- `draw.stencilPaint` paints and nothing else -- and `orderStyle` ordered its
 * contours. Dropping is the honest migration when the thing a parameter
 * controlled is gone; carrying it onto the nearest survivor would silently
 * change what a document does.
 *
 * These apply only to documents naming a *retired* animation id, so nothing
 * here can reach `draw.inkPaint`, which has an `outlineShare` of its own.
 */
const RETIRED_PARAMS = { scribbleAngle: 'sweepAngle' };
const DROPPED_PARAMS = new Set(['orderStyle', 'brushWidth', 'outlineShare', 'pencilWidth']);

/** Bring a clip's animation and parameters up to date, in place of rejecting it. */
export function migrateAnimation(animId, params) {
  const id = RETIRED_ANIMATIONS[animId] || animId;
  if (id === animId) return { animId: id, params };
  const out = {};
  for (const [k, v] of Object.entries(params || {})) {
    if (DROPPED_PARAMS.has(k)) continue;
    out[RETIRED_PARAMS[k] || k] = v;
  }
  return { animId: id, params: out };
}

/** Entrances: no pen, no drawing, so they suit every asset kind alike. */
const APPEAR = ['appear.instant', 'appear.fade', 'appear.pop', 'appear.slide'];

/**
 * Which animations suit which asset kind.
 *
 * The picture animations need decoded pixels and the text animations need a
 * font, so the pairings are not interchangeable -- offering all of them
 * everywhere just invites a clip that renders nothing.
 */
export const ANIMATIONS_FOR_KIND = {
  // `inkPaint` first because it is the default: this tool is pointed at
  // whiteboard artwork, and inking the real outline reads as drawing in a way
  // a scribble sweep does not. `stencilPaint` is the fallback that assumes
  // nothing -- a photograph, or a soft-gradient illustration.
  image: ['draw.inkPaint', 'draw.stencilPaint', ...APPEAR],
  vector: ['draw.inkPaint', 'draw.stencilPaint', ...APPEAR],
  text: ['draw.handwrite', 'draw.textReveal', ...APPEAR],
};

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
  if (typeof meta.name !== 'string') {
    throw new ProjectError('meta.name', `expected a string, got ${JSON.stringify(meta.name)}`);
  }
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
    if (a.bold !== undefined && typeof a.bold !== 'boolean') {
      throw new ProjectError(`${at}.bold`, 'expected true or false');
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
    // Migrate before validating, so a document naming a retired animation loads
    // as its replacement instead of being rejected.
    const migrated = migrateAnimation(c.animId, c.params);
    if (!KNOWN_ANIMATIONS.has(migrated.animId)) {
      throw new ProjectError(`${at}.animId`,
        `unknown animation ${JSON.stringify(c.animId)}; expected one of ${[...KNOWN_ANIMATIONS].join(', ')}`);
    }

    const clip = {
      id,
      assetId: c.assetId,
      animId: migrated.animId,
      pageId: c.pageId || pages[0].id,
      trackId: trackFor(c.trackId, 'clip', at),
      start: num(c.start, 0, `${at}.start`, { min: 0 }),
      duration: num(c.duration, 3, `${at}.duration`, { min: 0.01 }),
      transform: { ...DEFAULTS.transform, ...(c.transform || {}) },
      params: migrated.params || {},
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

  // Audio was addressed by array position until splitting arrived: a split
  // inserts an item and renumbers everything after it, so identity has to be
  // intrinsic. Files written before this have no ids and are given one by
  // position -- deterministic, so the same file always loads the same handles.
  const audioIds = new Set();
  const audio = (raw.audio || []).map((a, i) => {
    const at = `audio[${i}]`;
    if (!a.src) throw new ProjectError(`${at}.src`, 'required');
    let id = typeof a.id === 'string' && a.id ? a.id : `aud${i + 1}`;
    for (let n = 2; audioIds.has(id); n++) id = `aud${i + 1}-${n}`;
    audioIds.add(id);
    return {
      id,
      src: a.src,
      trackId: trackFor(a.trackId, 'audio', at),
      start: num(a.start, 0, `${at}.start`, { min: 0 }),
      trimIn: num(a.trimIn, 0, `${at}.trimIn`, { min: 0 }),
      // Timeline seconds, not source seconds. At speed 2 a 3s block consumes 6s
      // of the file -- keeping `duration` on the timeline's clock is what lets
      // projectDuration, packTrack and the Timeline's block width stay unaware
      // that speed exists at all.
      duration: a.duration === undefined ? undefined : num(a.duration, 0, `${at}.duration`, { min: 0.01 }),
      speed: num(a.speed, 1, `${at}.speed`, { min: 0.25, max: 4 }),
      gain: num(a.gain, 1, `${at}.gain`, { min: 0, max: 8 }),
    };
  });

  // --- subtitles ---
  // Absent stays absent. Materialising a default block here would rewrite every
  // project file that has never used the feature the first time it is saved.
  const subtitles = raw.subtitles === undefined
    ? undefined
    : normalizeSubtitles(raw.subtitles);

  return { meta, assets, pages, pageBreaks, tracks, clips, audio, subtitles };
}

/**
 * Validate the burned-in narration track.
 *
 * This is the transcript, not the artwork: `words` comes from the recogniser and
 * is the one part of a project a human never types. It is validated strictly
 * anyway, because a single out-of-order or NaN timing turns into a subtitle that
 * never leaves the screen.
 */
function normalizeSubtitles(raw) {
  if (!isObj(raw)) throw new ProjectError('subtitles', 'expected an object');
  const s = { ...DEFAULTS.subtitles, ...raw };

  if (!SUBTITLE_STYLES.has(s.style)) {
    throw new ProjectError('subtitles.style',
      `unknown style ${JSON.stringify(s.style)}; expected one of ${[...SUBTITLE_STYLES].join(', ')}`);
  }
  if (typeof s.font !== 'string' || !s.font) {
    throw new ProjectError('subtitles.font', 'expected a font path');
  }
  if (typeof s.enabled !== 'boolean') {
    throw new ProjectError('subtitles.enabled', 'expected true or false');
  }
  if (typeof s.bold !== 'boolean') {
    throw new ProjectError('subtitles.bold', 'expected true or false');
  }
  if (!Array.isArray(s.words)) throw new ProjectError('subtitles.words', 'expected an array');

  const words = s.words.map((w, i) => {
    const at = `subtitles.words[${i}]`;
    if (!isObj(w)) throw new ProjectError(at, 'expected an object');
    // The recogniser calls it `word`; accept that spelling so a timestamps.json
    // straight off faster-whisper can be pasted in without a rename pass.
    const text = w.w ?? w.word;
    if (typeof text !== 'string' || !text.trim()) {
      throw new ProjectError(`${at}.w`, 'expected a non-empty string');
    }
    const start = num(w.start, undefined, `${at}.start`, { min: 0 });
    const end = num(w.end, undefined, `${at}.end`, { min: 0 });
    if (start === undefined) throw new ProjectError(`${at}.start`, 'required');
    if (end === undefined) throw new ProjectError(`${at}.end`, 'required');
    if (end < start) {
      throw new ProjectError(`${at}.end`,
        `must not precede start, got ${round2(end)} < ${round2(start)}`);
    }
    return { w: text.trim(), start, end };
  })
    // Cue building walks these assuming ascending time, the way cameraAt() walks
    // keyframes; sorting means a hand-edited file still behaves.
    .sort((a, b) => a.start - b.start);

  return {
    enabled: s.enabled,
    style: s.style,
    words,
    ...(s.source === undefined ? {} : { source: String(s.source) }),
    font: s.font,
    fontSize: num(s.fontSize, 56, 'subtitles.fontSize', { min: 8, max: 400 }),
    bold: s.bold,
    color: s.color,
    highlight: s.highlight,
    background: s.background,
    marginBottom: num(s.marginBottom, 0.08, 'subtitles.marginBottom', { min: 0, max: 0.9 }),
    maxChars: num(s.maxChars, 42, 'subtitles.maxChars', { min: 8, max: 200 }),
    maxWords: num(s.maxWords, 7, 'subtitles.maxWords', { min: 1, max: 40 }),
    gapSplit: num(s.gapSplit, 0.6, 'subtitles.gapSplit', { min: 0.05, max: 10 }),
    holdTail: num(s.holdTail, 0.25, 'subtitles.holdTail', { min: 0, max: 5 }),
  };
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
  // The transcript is the only record of how long the narration runs: an audio
  // entry counts above just once it has an explicit `duration`, and add_audio
  // leaves that optional. Without this a project that is voiceover plus
  // subtitles -- no clips at all -- computes zero frames and refuses to export.
  // Sorted by `start`, so the last entry is not necessarily the last to finish.
  for (const w of project.subtitles?.words || []) {
    end = Math.max(end, w.end + (project.subtitles.holdTail ?? 0));
  }
  return end > 0 ? end + tail : 0;
}

/** Frame count for a project at its own fps. */
export function projectFrames(project, tail = 0.6) {
  return Math.round(projectDuration(project, tail) * project.meta.fps);
}

export { ProjectError };
