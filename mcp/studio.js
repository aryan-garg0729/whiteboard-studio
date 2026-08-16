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
 * reconciled clip by clip: `built()` diffs the document against the session it
 * is holding and recompiles only the clips whose `clipKey` moved. Retiming a
 * clip, moving it, or nudging the camera is free; rewording one caption costs
 * that caption. Nothing has to declare what it changed.
 *
 * **A new clip is placed, not dropped at the origin.** A drawable's origin is
 * its bounding-box corner and its natural size is often bigger than the frame,
 * so a clip added at the default transform sits mostly off screen. The UI fixes
 * this with a second pass once the trace comes back from the main process; here
 * the compile is in-process, so the clip can be compiled, measured and placed
 * before the edit is ever committed.
 */

import { cameraAt } from '../src/engine/render/renderFrame.js';
import { normalizeProject, projectDuration, projectFrames } from '../src/engine/model/project.js';
import {
  compileClip, installNodeSurfaces, updateNodeSession,
} from '../src/engine/host/nodeSession.js';
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
    installNodeSurfaces();
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
   * Callers used to have to declare whether an edit was "structural", and the
   * cached session was thrown away whenever one said yes. They no longer do:
   * `built()` diffs the document against the session it is holding and
   * recompiles exactly the clips whose geometry moved. That is strictly more
   * accurate than the flag was -- it catches an asset edited underneath a clip,
   * and it does *not* fire for a rescale that leaves the pen width alone -- and
   * it removes the failure mode where a caller mis-classified an edit and the
   * server quietly rendered stale artwork.
   *
   * Bumping `rev` is what tells `built()` there is something to reconcile.
   */
  commit(name, fn) {
    const e = this.entry(name);
    const next = normalizeProject(fn(e.doc));
    e.history = [...e.history, e.doc].slice(-HISTORY_LIMIT);
    e.doc = next;
    e.rev++;
    saveProject(name, next);
    return next;
  }

  undo(name) {
    const e = this.entry(name);
    if (!e.history.length) return null;
    e.doc = e.history[e.history.length - 1];
    e.history = e.history.slice(0, -1);
    e.rev++;
    // No need to know what the undone edit was: the same diff that handles a
    // forward edit handles going back, and an undo that changed no geometry --
    // a retime, a camera move -- now costs nothing to reverse.
    saveProject(name, e.doc);
    return e.doc;
  }

  // ── compiled session ────────────────────────────────────────────────

  /**
   * The compiled session for the *current* document.
   *
   * `renderFrame(session, project, ...)` takes the document as a separate
   * argument, so a session cached alongside an older document keeps rendering
   * that older document -- silently and correctly, which is what makes it hard
   * to spot. Every edit therefore has to come through here before anything is
   * rendered or exported, or a camera move is saved to disk and then simply does
   * not appear.
   *
   * `updateNodeSession` does the reconciling: it keeps the plans and surfaces of
   * every clip whose compiled inputs are unchanged and recompiles only the rest.
   * That is what makes authoring linear instead of quadratic -- adding the N-th
   * clip used to recompile all N, at 13.4s per edit on a 56-clip document.
   */
  async built(name) {
    const e = this.entry(name);
    if (e.built && e.built.rev === e.rev) return e.built;

    e.built = {
      ...await updateNodeSession(e.built, e.doc, { root: this.root, rel: readablePath }),
      rev: e.rev,
    };
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
        { root: this.root, rel: readablePath });
      const page = next.pages.find((p) => p.id === clip.pageId) ?? next.pages[0];
      const cam = cameraAt(page, clip.start);
      // Vector artwork may be scaled up as well as down; see placeInFrame.
      const placed = edits.placeInFrame(built.plan.bbox, cam, next.meta, PLACE_FILL,
        asset.kind === 'vector');
      next = edits.patchTransform(next, clip.id, { ...placed, ...checked });
    }

    this.commit(name, () => next);
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

    // Nothing here declares whether the edit re-traces anything: `clipKey`
    // reads the same fields (`animId`, `params`, and the scale through
    // `penScale`) off the committed document and decides for itself.
    this.commit(name, (d) => edits.patchClip(d, id, out));
    return notes;
  }

  removeClip(name, id) {
    const doc = this.doc(name);
    if (!doc.clips.some((c) => c.id === id)) {
      throw new edits.EditError(`no such clip ${JSON.stringify(id)}`);
    }
    this.commit(name, (d) => edits.removeClipFrom(d, id));
  }

  /** Reword a caption, change its face, size, colour or alignment. */
  updateAsset(name, id, patch) {
    const allowed = ['text', 'font', 'fontSize', 'penWidth', 'color', 'bold', 'align', 'src'];
    for (const k of Object.keys(patch)) {
      if (!allowed.includes(k)) {
        throw new edits.EditError(`an asset has no field ${JSON.stringify(k)}; `
          + `it takes ${allowed.join(', ')}`);
      }
    }
    const next = { ...patch };
    if (next.font) next.font = readablePath(next.font);
    if (next.src) next.src = readablePath(next.src);
    this.commit(name, (d) => edits.patchAsset(d, id, next));
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
