/**
 * Editor shell.
 *
 * Two pipelines meet here:
 *
 *   document -> main -> prepared geometry -> render session   (structural)
 *   document -------------------------------> renderFrame()   (every frame)
 *
 * Only the first is expensive, and only asset-level edits trigger it. Dragging
 * a clip, retiming it or moving it on the page goes straight down the second
 * path, which is why the timeline feels immediate.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { normalizeProject, pageStateAt, projectFrames } from '../engine/model/project.js';
import { cameraAt } from '../engine/render/renderFrame.js';
import { buildSession, renderFrame } from './engineHost.js';
import { useAudioClock } from './audioClock.js';
import { useEditor, EMPTY_PROJECT } from './state/editor.js';

import Menubar from './components/Menubar.jsx';
import Library from './components/Library.jsx';
import Stage from './components/Stage.jsx';
import Inspector from './components/Inspector.jsx';
import Timeline from './components/Timeline.jsx';

const DEFAULT_TEXT = {
  text: '', font: null, fontFamily: null,
  fontSize: 120, penWidth: 5, color: '#1a1a1a',
};

/** Rough writing time; a long line should not race by at a fixed duration. */
const textDuration = (s) => Math.min(12, Math.max(1.6, s.replace(/\s/g, '').length * 0.16));

export default function App() {
  const ed = useEditor();
  const canvasRef = useRef(null);
  const sessionRef = useRef(null);
  const lastGoodRef = useRef(null);

  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selection, setSelection] = useState(null);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [zoom, setZoom] = useState('fit');
  const [guides, setGuides] = useState(false);
  // Which gesture the stage answers to. 'select' moves and resizes clips;
  // 'camera' pans and zooms the document camera instead. A mode rather than a
  // modifier because framing a shot is a sustained activity -- you nudge, play
  // back, nudge again -- and holding a key through all of that is miserable.
  const [tool, setTool] = useState('select');
  const [tlHeight, setTlHeight] = useState(232);
  const [dropping, setDropping] = useState(false);
  // Clip bounds must live in state, not on sessionRef: the selection overlay
  // has to re-render when a rebuild changes them.
  const [bboxes, setBboxes] = useState(null);

  const [examples, setExamples] = useState([]);
  const [fonts, setFonts] = useState([]);
  const [hands, setHands] = useState([]);
  const [library, setLibrary] = useState([]);
  const [peaksBySrc, setPeaks] = useState({});
  const [draft, setDraft] = useState(DEFAULT_TEXT);
  const [exporting, setExporting] = useState(false);
  // Monitoring only -- deliberately not document state, so muting the preview
  // neither dirties the project nor changes what export renders.
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [mutedTracks, setMutedTracks] = useState(() => new Set());

  useEffect(() => {
    const s = window.studio;
    if (!s) return;
    s.listExamples().then(setExamples);
    s.listHands().then(setHands);
    s.listFonts().then((f) => {
      setFonts(f);
      // Prefer a script face (listFonts sorts those first), then the engine's
      // own fallback, and only then whatever happens to be installed first --
      // an arbitrary system font is usually a poor handwriting model.
      const pick = f.find((x) => x.hand)
        || f.find((x) => /^DejaVu Sans$/.test(x.family))
        || f[0];
      setDraft((d) => (d.font ? d : { ...d, font: pick?.path || null, fontFamily: pick?.family }));
    });
  }, []);

  // ── the live, validated document ──────────────────────────────────
  const { project, docError } = useMemo(() => {
    try {
      return { project: normalizeProject(ed.doc), docError: null };
    } catch (e) {
      return { project: null, docError: e.message };
    }
  }, [ed.doc]);

  // Keep painting the last valid document while the user is mid-edit, rather
  // than blanking the stage on a transiently illegal value.
  if (project) lastGoodRef.current = project;
  const live = project || lastGoodRef.current;
  const frames = live ? projectFrames(live) : 0;
  const meta = live?.meta || EMPTY_PROJECT.meta;
  const showHand = meta.showHand !== false;

  // Which sheet is on screen. Declared here rather than beside the camera it
  // feeds, because the state hooks further down close over it and a `const`
  // named in a dependency array before its declaration throws a
  // temporal-dead-zone ReferenceError at render time.
  const pageState = live ? pageStateAt(live, frame / meta.fps) : { pageId: null };
  const livePage = live?.pages?.find((p) => p.id === pageState.pageId) || live?.pages?.[0];

  // ── structural rebuild ────────────────────────────────────────────
  const rebuild = useCallback(async (doc, path, rev) => {
    if (!doc.clips.length) {
      sessionRef.current = null;
      setBboxes(null);
      setError(null);
      ed.markPrepared(rev);
      return;
    }
    setStatus({ title: 'Preparing artwork', detail: 'Tracing images and skeletonising glyphs…' });
    try {
      const loaded = await window.studio.prepareProject(doc, path);
      if (loaded?.error) { setError(loaded.error); return; }
      const built = await buildSession(loaded);
      sessionRef.current = built;
      setBboxes(built.bboxes);
      setError(null);
      ed.markPrepared(rev);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setStatus(null);
    }
  }, [ed]);

  useEffect(() => {
    if (!window.studio || !ed.needsPrepare) return undefined;
    // Debounced: typing in the text field bumps structuralRev per keystroke,
    // and every rebuild spawns sidecar work.
    const rev = ed.structuralRev;
    const id = setTimeout(() => { rebuild(ed.doc, ed.path, rev); }, 260);
    return () => clearTimeout(id);
    // `doc` and `path` are read at fire time on purpose; only the revision
    // decides whether a rebuild is owed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ed.structuralRev, ed.needsPrepare, rebuild]);

  // ── painting ──────────────────────────────────────────────────────
  const draw = useCallback((n) => {
    const built = sessionRef.current;
    const canvas = canvasRef.current;
    if (!canvas || !live) return;

    if (canvas.width !== meta.width || canvas.height !== meta.height) {
      canvas.width = meta.width;
      canvas.height = meta.height;
    }
    const ctx = canvas.getContext('2d');
    if (!built) {
      ctx.fillStyle = meta.background || '#fdfdfb';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return;
    }
    renderFrame(built.session, live, n, ctx, {
      width: meta.width,
      height: meta.height,
      showHand,
      handStyleId: built.hand.id,
    });
  }, [live, meta.width, meta.height, meta.background, showHand]);

  useEffect(() => { draw(frame); }, [frame, draw, ed.rev]);

  useEffect(() => {
    if (frames && frame > frames - 1) setFrame(frames - 1);
  }, [frames, frame]);

  // ── playback ──────────────────────────────────────────────────────
  // The frame index is derived from elapsed time rather than incremented, so a
  // dropped frame skips ahead instead of playing in slow motion -- and the time
  // it elapses against is the audio clock whenever there is audio to hear.
  const { hasAudio } = useAudioClock({
    tracks: live?.audio || EMPTY_PROJECT.audio,
    fps: meta.fps,
    frames,
    playing,
    frame,
    setFrame,
    setPlaying,
    muted,
    volume,
    mutedTracks,
  });

  // ── commands ──────────────────────────────────────────────────────
  const open = useCallback(async (path) => {
    setPlaying(false);
    setSelection(null);
    setStatus({ title: 'Opening project', detail: path ? path.split('/').pop() : '' });
    try {
      const loaded = await window.studio.openProject(path);
      if (!loaded) return;
      if (loaded.error) { setError(loaded.error); return; }
      const built = await buildSession(loaded);
      sessionRef.current = built;
      setBboxes(built.bboxes);
      // `prepared` flag: the session we just built IS this document, so the
      // rebuild effect must not immediately redo all of that work.
      ed.load(loaded.project, loaded.path, true);
      setFrame(0);
      setError(null);
      // Waveforms are keyed by path and only ever filled in on import, so a
      // project opened from disk drew flat audio lanes. Probing is slow enough
      // (it decodes the whole file) that it must not hold up the open.
      const srcs = loaded.project.audio.map((a) => a.src);
      if (srcs.length) {
        window.studio.describeFiles(srcs).then((described) => setPeaks((cur) => {
          const next = { ...cur };
          for (const f of described) if (f.peaks) next[f.path] = f.peaks;
          return next;
        })).catch(() => { /* a lane without a waveform is still usable */ });
      }
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setStatus(null);
    }
  }, [ed]);

  const ingest = useCallback((files) => {
    const usable = files.filter((f) => f.kind !== 'unsupported');
    if (!usable.length) return;
    setLibrary((cur) => {
      const seen = new Set(cur.map((a) => a.path));
      return [...cur, ...usable.filter((a) => !seen.has(a.path))];
    });
    setPeaks((cur) => {
      const next = { ...cur };
      for (const f of usable) if (f.peaks) next[f.path] = f.peaks;
      return next;
    });
  }, []);

  const importAssets = useCallback(async (kind) => {
    ingest(await window.studio.importAssets(kind));
  }, [ingest]);

  const placeArt = useCallback((a, world) => {
    // A dropped asset should land where it was dropped. The drawable's own
    // origin is its bbox corner, not its centre, so this puts the top-left of
    // the artwork at the cursor -- close enough to feel intentional, and the
    // handles are right there to adjust.
    ed.addClip(
      { kind: a.kind === 'vector' ? 'vector' : 'image', src: a.path },
      { duration: 4, transform: world ? { x: Math.round(world.x), y: Math.round(world.y) } : undefined },
    );
  }, [ed]);

  const addAudioTrack = useCallback((a) => {
    ed.addAudio({ src: a.path, start: 0, trimIn: 0, gain: 1, duration: a.duration || undefined });
  }, [ed]);

  const addText = useCallback(() => {
    const text = draft.text.trim();
    if (!text) return;
    ed.addClip({
      kind: 'text',
      text,
      font: draft.font || undefined,
      fontSize: draft.fontSize,
      penWidth: draft.penWidth,
      color: draft.color,
    }, { duration: textDuration(text) });
    setDraft((d) => ({ ...d, text: '' }));
  }, [draft, ed]);

  const save = useCallback(async (saveAs) => {
    const r = await window.studio.saveProject(ed.doc, ed.path, saveAs);
    if (r?.path) ed.markSaved(r.path);
    else if (r?.error) setError(r.error);
  }, [ed]);

  const exportVideo = useCallback(async () => {
    if (!live?.clips.length) return;
    setPlaying(false);
    setExporting(true);
    setStatus({ title: 'Exporting MP4', detail: 'Rendering frames…', progress: 0 });
    const off = window.studio.onExportProgress(({ frame: n, total }) => {
      setStatus({
        title: 'Exporting MP4',
        detail: `Frame ${n} of ${total}`,
        progress: total ? n / total : 0,
      });
    });
    try {
      const r = await window.studio.startExport(live);
      if (r?.error) setError(r.error);
      else if (r?.path) window.studio.reveal(r.path);
    } finally {
      off();
      setExporting(false);
      setStatus(null);
    }
  }, [live]);

  const deleteSelected = useCallback(() => {
    if (selection?.type === 'clip') { ed.removeClip(selection.id); setSelection(null); }
    if (selection?.type === 'audio') { ed.removeAudio(selection.index); setSelection(null); }
    if (selection?.type === 'pageBreak') { ed.removePageBreak(selection.index); setSelection(null); }
    if (selection?.type === 'camera') {
      ed.removeCameraKeyframe(selection.pageId, selection.index);
      setSelection(null);
    }
  }, [ed, selection]);

  // ── shortcuts ─────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e) => {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === 'z') { e.preventDefault(); (e.shiftKey ? ed.redo : ed.undo)(); return; }
      if (mod && key === 's') { e.preventDefault(); save(e.shiftKey); return; }
      if (mod && key === 'o') { e.preventDefault(); open(); return; }
      if (mod && key === 'e') { e.preventDefault(); exportVideo(); return; }
      if (mod) return;

      if (e.code === 'Space') { e.preventDefault(); setPlaying((p) => !p); }
      else if (e.code === 'ArrowRight') setFrame((f) => Math.min(frames - 1, f + (e.shiftKey ? 10 : 1)));
      else if (e.code === 'ArrowLeft') setFrame((f) => Math.max(0, f - (e.shiftKey ? 10 : 1)));
      else if (e.code === 'Home') setFrame(0);
      else if (e.code === 'End') setFrame(Math.max(0, frames - 1));
      else if (key === 'h') ed.patchMeta({ showHand: !showHand });
      else if (key === 'g') setGuides((g) => !g);
      else if (key === 'c') setTool((t) => (t === 'camera' ? 'select' : 'camera'));
      else if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ed, frames, showHand, save, open, exportVideo, deleteSelected]);

  // ── drag & drop import ────────────────────────────────────────────
  useEffect(() => {
    // Chromium only fires `drop` if the default is prevented on BOTH dragenter
    // and dragover; miss either and the window silently navigates to the file
    // instead of handing it to the page.
    const enter = (e) => { e.preventDefault(); };
    const over = (e) => {
      e.preventDefault();
      // Internal drags carry our own type; they are the stage's business, and
      // showing the "drop to import" curtain over them is misleading.
      if (e.dataTransfer.types.includes('application/x-studio-asset')) return;
      e.dataTransfer.dropEffect = 'copy';
      // dragover fires continuously; only re-render on the transition.
      setDropping((cur) => cur || true);
    };
    // relatedTarget is null only when the pointer leaves the window itself;
    // without that check every internal element boundary clears the overlay.
    const leave = (e) => { if (e.relatedTarget === null) setDropping(false); };

    const drop = async (e) => {
      setDropping(false);
      if (e.defaultPrevented) return;             // the stage took it
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();

      const files = [...e.dataTransfer.files];
      // Prefer the file's real path -- a saved project then points at the
      // user's own asset rather than a copy. But getPathForFile returns "" for
      // anything the browser holds without a filesystem path, so fall back to
      // shipping the bytes across and letting main write them out. The drop
      // must never just fail.
      const paths = [];
      const copies = [];
      for (const f of files) {
        let p = '';
        try { p = window.studio.pathForFile(f); } catch { p = ''; }
        if (p) paths.push(p); else copies.push(f);
      }

      const described = [];
      if (paths.length) described.push(...await window.studio.describeFiles(paths));
      if (copies.length) {
        const payload = await Promise.all(copies.map(async (f) => ({
          name: f.name,
          bytes: new Uint8Array(await f.arrayBuffer()),
        })));
        described.push(...await window.studio.ingestFiles(payload));
      }

      const unsupported = described.filter((d) => d.kind === 'unsupported');
      if (unsupported.length) {
        setError(`Unsupported file type: ${unsupported.map((d) => d.name).join(', ')}. `
          + 'Images (PNG, JPG, WebP, SVG) and audio (MP3, WAV, M4A, OGG, FLAC) only.');
      } else if (!described.length) {
        setError(`Could not read ${files.map((f) => f.name).join(', ')}.`);
      }
      ingest(described);
    };

    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [ingest]);

  // Read-only view of editor state for headless interaction tests. Asserting
  // against the document is far more reliable than scraping input values,
  // which lag behind by a commit boundary.
  useEffect(() => {
    window.__studioState = () => ({
      clips: ed.doc.clips.map((c) => ({
        id: c.id, ...c.transform, start: c.start, duration: c.duration, trackId: c.trackId,
      })),
      tracks: ed.doc.tracks,
      audio: ed.doc.audio,
      pages: ed.doc.pages,
      pageBreaks: ed.doc.pageBreaks,
      activePage: pageState.pageId,
      selection,
      frame,
      bboxes: bboxes ? Object.fromEntries(bboxes) : null,
    });
  }, [ed.doc, selection, frame, bboxes]);

  // Smoke-test hook (WB_SMOKE). Declared after the callbacks it closes over:
  // a dependency array naming a `const` defined further down evaluates it at
  // render time and throws a temporal-dead-zone ReferenceError.
  useEffect(() => {
    window.__studioSmoke = async (path) => {
      await open(path);
      if (!sessionRef.current) return false;
      const n = Math.floor((frames || 100) * 0.6);
      setFrame(n);
      draw(n);
      // capturePage() reads the compositor, so yield until the canvas resize
      // and the drawn frame have actually been painted -- otherwise the
      // screenshot races ahead and shows an empty default-sized canvas.
      //
      // Raced against a timeout because a headless X server does not always
      // drive the compositor, and an rAF that never fires would hang the whole
      // test rather than merely risking an early screenshot.
      await Promise.race([
        new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
        new Promise((r) => setTimeout(r, 500)),
      ]);
      return true;
    };
  }, [open, draw, frames]);

  const cmd = {
    examples,
    open,
    save,
    exportVideo,
    importAssets,
    addText,
    addPage: () => ed.addPageBreak({ t: frame / meta.fps }),
    deleteSelected,
    selectedId: selection?.type === 'clip' ? selection.id : null,
    showHand,
    guides,
    toggleHand: () => ed.patchMeta({ showHand: !showHand }),
    toggleGuides: () => setGuides((g) => !g),
    newProject: () => {
      sessionRef.current = null;
      setBboxes(null);
      ed.load(EMPTY_PROJECT, null);
      setSelection(null);
      setFrame(0);
      setError(null);
    },
  };

  const seek = (n) => { setPlaying(false); setFrame(Math.max(0, Math.min(frames - 1, n))); };

  // The overlay must use the same page and camera renderFrame does, or handles
  // drift away from the artwork -- or hover over a sheet that is not showing.
  const camera = cameraAt(livePage, frame / meta.fps);

  return (
    <div className="app">
      <Menubar ed={ed} cmd={cmd} busy={exporting} />

      <div className="workspace">
        <Library
          library={library}
          onImport={importAssets}
          onPlace={placeArt}
          onAddAudio={addAudioTrack}
          fonts={fonts}
          draft={draft}
          setDraft={setDraft}
          onAdd={addText}
          hands={hands}
          meta={meta}
          onMeta={ed.patchMeta}
        />

        <Stage
          canvasRef={canvasRef}
          meta={meta}
          frame={frame}
          frames={frames}
          playing={playing}
          onPlay={() => setPlaying((p) => !p)}
          onSeek={seek}
          zoom={zoom}
          setZoom={setZoom}
          guides={guides}
          setGuides={setGuides}
          showHand={showHand}
          setShowHand={(v) => ed.patchMeta({ showHand: v })}
          status={status}
          error={error || docError}
          exporting={exporting}
          dropping={dropping}
          hasAudio={hasAudio}
          muted={muted}
          setMuted={setMuted}
          volume={volume}
          setVolume={setVolume}
          ed={ed}
          cam={camera}
          tool={tool}
          setTool={setTool}
          // Camera keyframes belong to a page, and mid-swipe there are two on
          // screen and no single one to attach a framing to.
          canCamera={pageState.u >= 1 && !!livePage}
          time={frame / meta.fps}
          pageId={livePage?.id}
          pageName={livePage?.name}
          pageCount={live?.pages?.length || 1}
          bboxes={bboxes}
          selection={selection}
          setSelection={setSelection}
          onDropAsset={placeArt}
        />

        <Inspector ed={ed} selection={selection} hands={hands}
                   frame={frame} fps={meta.fps} bboxes={bboxes} />
      </div>

      <Timeline
        ed={ed}
        selection={selection}
        setSelection={setSelection}
        frame={frame}
        fps={meta.fps}
        frames={frames}
        onSeek={seek}
        peaksBySrc={peaksBySrc}
        height={tlHeight}
        setHeight={setTlHeight}
        mutedTracks={mutedTracks}
        setMutedTracks={setMutedTracks}
      />
    </div>
  );
}
