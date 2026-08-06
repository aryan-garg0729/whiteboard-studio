/**
 * The authoring session: open documents, their compiled sessions, and the
 * rules for changing them.
 *
 * Three ideas carry the whole file.
 *
 * **Edits are transactional.** Every mutation applies a pure transform, runs
 * the result through `normalizeProject`, and keeps it only if that succeeds.
 * A rejected edit leaves the document exactly as it was, and the validator's
 * own message goes back to the caller unchanged -- those messages already name
 * the field and explain the conflict in a sentence, which is a better error
 * than anything this layer could synthesise.
 *
 * **Rebuilds are avoided, not tolerated.** A compiled session is cached and
 * invalidated only by a structural edit, exactly the split `isStructural`
 * already encodes for the UI. Retiming a clip or moving it is free; changing
 * its text is not.
 *
 * **A new clip is placed, not dropped at the origin.** A drawable's origin is
 * its bounding-box corner and its natural size is often bigger than the frame,
 * so a clip added at the default transform sits mostly off screen. The UI fixes
 * this with a second pass once the trace comes back from the main process; here
 * the compile is in-process, so the clip can be compiled, measured and placed
 * before the edit is ever committed.
 */

import { cameraAt, ensureSurfaces } from '../src/engine/render/renderFrame.js';
import { normalizeProject, projectDuration, projectFrames } from '../src/engine/model/project.js';
import { buildNodeSession, compileClip, installNodeSurfaces } from '../src/engine/host/nodeSession.js';
import { Sidecar } from '../src/engine/sidecar/client.js';
import * as edits from '../src/engine/model/edits.js';
import { checkAnimForKind, checkParams, checkTransform } from './capabilities.js';
import { ROOT, loadProject, readablePath, saveProject } from './workspace.js';

/** How much of the visible frame a newly placed drawable may fill. */
const PLACE_FILL = 0.8;

/** Undo depth. Documents are small; twenty is a session's worth of mistakes. */
const HISTORY_LIMIT = 20;

const clone = (o) => JSON.parse(JSON.stringify(o));

export class Studio {
  constructor({ root = ROOT } = {}) {
    this.root = root;
    this.open = new Map();
    this._sidecar = null;
    installNodeSurfaces();
  }

  /**
   * One sidecar for the life of the process.
   *
   * Startup is ~0.4s of interpreter plus numpy and cv2 imports -- fine once,
   * intolerable per image. Created lazily so a session that only writes text
   * and SVG never pays for Python at all, and never fails because it is absent.
   */
  sidecar() {
    if (!this._sidecar) {
      this._sidecar = new Sidecar({ root: this.root, cacheDir: `${this.root}/.cache` });
    }
    return this._sidecar;
  }

  stop() {
    this._sidecar?.stop();
    this._sidecar = null;
  }

  // ── documents ───────────────────────────────────────────────────────

  entry(name) {
    let e = this.open.get(name);
    if (!e) {
      e = { doc: normalizeProject(loadProject(name)), built: null, history: [], rev: 0 };
      this.open.set(name, e);
    }
    return e;
  }

  create(name, meta = {}) {
    const doc = normalizeProject({
      ...edits.EMPTY_PROJECT,
      meta: { ...edits.EMPTY_PROJECT.meta, name, ...meta },
    });
    this.open.set(name, { doc, built: null, history: [], rev: 0 });
    saveProject(name, doc);
    return doc;
  }

  doc(name) { return this.entry(name).doc; }

  /**
   * Apply a transform, validate, persist.
   *
   * `structural` marks edits that change compiled geometry. Anything else keeps
   * the compiled plans, which is what keeps a retime instant -- but it still
   * bumps `rev`, because the cached session is holding the *old* document and
   * would otherwise go on rendering it. See `built()`.
   */
  commit(name, fn, { structural = false } = {}) {
    const e = this.entry(name);
    const next = normalizeProject(fn(e.doc));
    e.history = [...e.history, e.doc].slice(-HISTORY_LIMIT);
    e.doc = next;
    e.rev++;
    if (structural) e.built = null;
    saveProject(name, next);
    return next;
  }

  undo(name) {
    const e = this.entry(name);
    if (!e.history.length) return null;
    e.doc = e.history[e.history.length - 1];
    e.history = e.history.slice(0, -1);
    e.rev++;
    // No record of whether the undone edit was structural, and a stale session
    // renders the wrong artwork. Rebuilding is cheap -- the sidecar caches by
    // content hash -- and always correct.
    e.built = null;
    saveProject(name, e.doc);
    return e.doc;
  }

  // ── compiled session ────────────────────────────────────────────────

  /**
   * The compiled session for the *current* document.
   *
   * There are three cases, and conflating the last two is a bug worth naming:
   * nothing built yet, built but the geometry is stale, and built with good
   * geometry but an out-of-date document.
   *
   * `renderFrame(session, project, ...)` takes the document as a separate
   * argument, so a session cached alongside an older document keeps rendering
   * that older document -- silently and correctly, which is what makes it hard
   * to spot. Every non-structural edit hits this: a camera move, a retime, a
   * page break, a clip nudged across the page. They are saved to disk and then
   * simply do not appear, until some later structural edit happens to force a
   * rebuild. An export can encode the stale version too.
   *
   * The fix is not to rebuild on every edit -- that would re-trace artwork for
   * a change that cannot affect it, which is exactly what the structural split
   * exists to avoid. It is to swap the document in and keep the plans. The
   * surfaces stay valid because `surfacesFor` keys only off `plan.bbox`, and
   * the artwork already painted into them is untouched.
   */
  async built(name) {
    const e = this.entry(name);

    if (e.built && e.built.rev !== e.rev) {
      // A clip that appeared or vanished means a plan is missing or orphaned,
      // and no amount of swapping fixes that. Structural edits already null the
      // cache, so this is a guard against a future caller mis-classifying one
      // rather than a case that arises today -- but it is the check that makes
      // the fast path provably safe.
      const ids = new Set(e.doc.clips.map((c) => c.id));
      const sameClips = ids.size === e.built.session.plans.size
        && [...ids].every((id) => e.built.session.plans.has(id));
      if (sameClips) {
        ensureSurfaces(e.built.session, e.doc);
        e.built = {
          ...e.built,
          project: e.doc,
          frames: projectFrames(e.doc),
          rev: e.rev,
        };
      } else {
        e.built = null;
      }
    }

    if (!e.built) {
      e.built = {
        ...await buildNodeSession(e.doc, {
          root: this.root,
          sidecar: this.sidecar(),
          rel: readablePath,
        }),
        rev: e.rev,
      };
    }
    return e.built;
  }

  // ── clips ───────────────────────────────────────────────────────────

  /**
   * Add an asset and a clip for it, placed to fit the frame.
   *
   * The placement pass is the reason this is not a one-line wrapper over
   * `addClipTo`. The clip is compiled on its own first, purely to learn its
   * bounding box, because there is no other way to know how big the artwork is
   * or where its origin sits relative to its ink. Compiling twice costs one
   * extra pass over geometry that is already cached by then; getting it wrong
   * costs every frame the agent looks at.
   */
  async addClip(name, asset, { animId, duration, transform, params } = {}) {
    checkAnimForKind(animId, asset.kind);
    const checked = checkTransform(transform);
    const paramCheck = animId ? checkParams(animId, params) : { params, notes: [] };

    const doc = this.doc(name);
    const before = new Set(doc.clips.map((c) => c.id));
    let next = edits.addClipTo(doc, asset, { animId, duration, transform: checked });
    const clip = next.clips.find((c) => !before.has(c.id));

    if (paramCheck.params) {
      next = edits.patchClip(next, clip.id, { params: paramCheck.params });
    }

    // Place it, unless the caller said where it goes.
    if (!checked || checked.x === undefined || checked.y === undefined) {
      const built = await compileClip(
        next.clips.find((c) => c.id === clip.id),
        next.assets[clip.assetId],
        { root: this.root, sidecar: this.sidecar(), rel: readablePath });
      const page = next.pages.find((p) => p.id === clip.pageId) ?? next.pages[0];
      const cam = cameraAt(page, clip.start);
      // Vector artwork may be scaled up as well as down; see placeInFrame.
      const placed = edits.placeInFrame(built.plan.bbox, cam, next.meta, PLACE_FILL,
        asset.kind === 'vector');
      next = edits.patchTransform(next, clip.id, { ...placed, ...checked });
    }

    this.commit(name, () => next, { structural: true });
    return { clipId: clip.id, assetId: clip.assetId, notes: paramCheck.notes };
  }

  /**
   * Patch a clip's timing, placement, animation or erase.
   *
   * Structural only when the patch touches something the compile step reads --
   * which for a clip means `animId` and `params`, since the artwork itself
   * lives on the asset.
   */
  updateClip(name, id, patch) {
    const doc = this.doc(name);
    const clip = doc.clips.find((c) => c.id === id);
    if (!clip) throw new edits.EditError(`no such clip ${JSON.stringify(id)}`);
    const asset = doc.assets[clip.assetId];

    const out = {};
    const notes = [];
    if (patch.animId !== undefined) {
      checkAnimForKind(patch.animId, asset.kind);
      out.animId = patch.animId;
    }
    if (patch.params !== undefined) {
      const r = checkParams(out.animId ?? clip.animId, patch.params);
      out.params = r.params;
      notes.push(...r.notes);
    }
    if (patch.transform !== undefined) {
      out.transform = { ...clip.transform, ...checkTransform(patch.transform) };
    }
    for (const k of ['start', 'duration', 'pageId', 'trackId']) {
      if (patch[k] !== undefined) out[k] = patch[k];
    }
    // `erase: null` removes the sweep; leaving it out means "do not touch".
    if (patch.erase !== undefined) out.erase = patch.erase ?? undefined;

    // The transform feeds the brush width (which is authored in screen terms
    // and divides out the scale), so a rescale does change compiled geometry.
    // Only a rescale, though -- a move must stay timing-class, or dragging a
    // clip would re-trace its artwork on every step.
    const rescaled = out.transform !== undefined
      && out.transform.scale !== clip.transform.scale;
    const structural = out.animId !== undefined || out.params !== undefined || rescaled;

    this.commit(name, (d) => edits.patchClip(d, id, out), { structural });
    return notes;
  }

  removeClip(name, id) {
    const doc = this.doc(name);
    if (!doc.clips.some((c) => c.id === id)) {
      throw new edits.EditError(`no such clip ${JSON.stringify(id)}`);
    }
    this.commit(name, (d) => edits.removeClipFrom(d, id), { structural: true });
  }

  /** Reword a caption, change its face, size or colour. Always structural. */
  updateAsset(name, id, patch) {
    const allowed = ['text', 'font', 'fontSize', 'penWidth', 'color', 'bold', 'src'];
    for (const k of Object.keys(patch)) {
      if (!allowed.includes(k)) {
        throw new edits.EditError(`an asset has no field ${JSON.stringify(k)}; `
          + `it takes ${allowed.join(', ')}`);
      }
    }
    const next = { ...patch };
    if (next.font) next.font = readablePath(next.font);
    if (next.src) next.src = readablePath(next.src);
    this.commit(name, (d) => edits.patchAsset(d, id, next), { structural: true });
  }

  // ── the view an agent reasons about ─────────────────────────────────

  /**
   * The document plus everything derived from it that an agent cannot compute.
   *
   * The world-space rects are the point. An agent can look at a contact sheet
   * and see that something is wrong, but it cannot measure it -- and the two
   * mistakes that actually happen, artwork running off the canvas and a caption
   * landing on top of a drawing, are both exactly measurable. Reporting them as
   * numbers turns "does this look right?" into a check.
   */
  async describe(name) {
    const { project, bboxes } = await this.built(name);
    const { width, height } = project.meta;
    const duration = projectDuration(project);

    const clips = project.clips.map((c) => {
      const bbox = bboxes.get(c.id);
      const rect = bbox ? edits.worldRect(bbox, c.transform) : null;
      const asset = project.assets[c.assetId];
      return {
        id: c.id,
        kind: asset.kind,
        label: asset.kind === 'text' ? asset.text : asset.src,
        animId: c.animId,
        pageId: c.pageId,
        trackId: c.trackId,
        start: c.start,
        end: c.start + c.duration,
        erase: c.erase ?? null,
        // Ink stays on the page until it is wiped; that is the interval during
        // which this clip can collide with another, not its drawing time.
        visible: [c.start, c.erase ? c.erase.start + c.erase.duration : duration],
        transform: c.transform,
        rect,
      };
    });

    // A rect is in frame when it sits inside the composition at the identity
    // camera. Zoomed shots can legitimately push artwork out, so this is a
    // warning worth reporting rather than an error worth refusing.
    const half = { x: width / 2, y: height / 2 };
    const offscreen = clips.filter((c) => c.rect && (
      c.rect.x < -half.x || c.rect.y < -half.y
      || c.rect.x + c.rect.width > half.x || c.rect.y + c.rect.height > half.y));

    const overlaps = [];
    for (let i = 0; i < clips.length; i++) {
      for (let j = i + 1; j < clips.length; j++) {
        const a = clips[i];
        const b = clips[j];
        if (!a.rect || !b.rect || a.pageId !== b.pageId) continue;
        if (a.visible[1] <= b.visible[0] || b.visible[1] <= a.visible[0]) continue;
        const hit = a.rect.x < b.rect.x + b.rect.width && b.rect.x < a.rect.x + a.rect.width
          && a.rect.y < b.rect.y + b.rect.height && b.rect.y < a.rect.y + a.rect.height;
        if (hit) overlaps.push([a.id, b.id]);
      }
    }

    return {
      name,
      meta: project.meta,
      duration: Math.round(duration * 100) / 100,
      frames: projectFrames(project),
      pages: project.pages.map((p) => ({
        id: p.id, name: p.name, cameraKeyframes: p.cameraKeyframes,
      })),
      pageBreaks: project.pageBreaks,
      tracks: project.tracks,
      clips,
      audio: project.audio,
      warnings: [
        ...offscreen.map((c) => `${c.id} extends outside the frame`),
        ...overlaps.map(([a, b]) => `${a} and ${b} overlap while both are on screen`),
      ],
      document: clone(project),
    };
  }
}
