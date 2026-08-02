import React from 'react';
import { ANIMATIONS_FOR_KIND, pageAt, pageWindows } from '../../engine/model/project.js';
import { cameraAt } from '../../engine/render/renderFrame.js';
import { localToWorld } from '../stageGeom.js';
import { Field, Group, Icon, Num, PATH, Soon } from './common.jsx';
import FontPicker from './FontPicker.jsx';
import { getAnimation } from '../../engine/anim/registry.js';

/**
 * Breathing room left around a clip by "Zoom to selection", as a multiple of
 * its bounding box. Framing artwork edge to edge looks like a crop, not a shot.
 */
const FRAME_MARGIN = 1.24;

const ANIMATION_LABELS = {
  'draw.imageReveal': 'Draw (the artwork appears)',
  'draw.outlineFill': 'Outline, then colour (legacy)',
  'draw.textReveal': 'Write (letters appear)',
  'draw.handwrite': 'Trace letterforms',
  'appear.instant': 'Appear (instantly)',
  'appear.fade': 'Appear (fade in)',
  'appear.pop': 'Appear (pop in)',
  'appear.slide': 'Appear (slide in)',
};

/**
 * The selected animation's own settings.
 *
 * Every animation has always declared a `paramSchema` and nothing ever rendered
 * it, so pen width, fill brush, scribble angle and draw order were unreachable
 * from the app -- and a new animation could not take a setting at all without
 * growing its own control. Driving the controls from the schema means an
 * animation declares what it needs and the Inspector shows it.
 */
function AnimParams({ ed, clip }) {
  let schema;
  try {
    schema = getAnimation(clip.animId).paramSchema;
  } catch {
    return null;                    // an id this build does not know: say nothing
  }
  const entries = Object.entries(schema || {});
  if (!entries.length) return null;

  const set = (key, value) =>
    ed.patchClip(clip.id, { params: { ...(clip.params || {}), [key]: value } });
  const valueOf = (key, spec) => clip.params?.[key] ?? spec.default;

  return entries.map(([key, spec]) => (
    <Field key={key} label={spec.label || key}>
      {spec.type === 'enum' ? (
        <select value={valueOf(key, spec)} onChange={(e) => set(key, e.target.value)}>
          {spec.options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : spec.type === 'color' ? (
        <input type="color" value={valueOf(key, spec)}
               onChange={(e) => set(key, e.target.value)} />
      ) : (
        <Num value={valueOf(key, spec)} min={spec.min} max={spec.max} step={spec.step}
             onChange={(v) => set(key, v)} />
      )}
    </Field>
  ));
}

const TRANSITION_LABELS = [
  ['swipeLeft', 'Swipe left'],
  ['swipeRight', 'Swipe right'],
  ['swipeUp', 'Swipe up'],
  ['swipeDown', 'Swipe down'],
  ['cut', 'Cut (no animation)'],
];

/** Lane picker. Only lanes of the matching kind; the validator rejects the rest. */
function TrackField({ tracks, kind, value, onChange }) {
  return (
    <Field label="Lane">
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {tracks.filter((t) => t.kind === kind).map((t) => (
          <option key={t.id} value={t.id}>{t.name}</option>
        ))}
      </select>
    </Field>
  );
}

function ClipInspector({ ed, clip, asset, fonts, frame, fps, selection, bboxes }) {
  const t = clip.transform || {};
  const erase = clip.erase;
  const drawEnd = clip.start + clip.duration;

  return (
    <>
      <Group title={`${asset.kind} clip`} right={<span className="pill">{clip.id}</span>}>
        <Field label="Animation">
          <select
            value={clip.animId}
            onChange={(e) => ed.patchClip(clip.id, { animId: e.target.value })}
          >
            {/* Only the animations that suit this asset. The list used to be
                flat, which offered handwriting on a photograph. */}
            {(ANIMATIONS_FOR_KIND[asset.kind] ?? Object.keys(ANIMATION_LABELS))
              .map((v) => <option key={v} value={v}>{ANIMATION_LABELS[v]}</option>)}
          </select>
        </Field>
        {asset.kind !== 'text' && clip.animId === 'draw.outlineFill' && (
          <div className="hint">
            Draws a pen-ink stand-in and crossfades to the real asset when it
            finishes — so the picture changes at the end, and anything the pen
            missed stays missing. “Draw” reveals the artwork itself instead.
          </div>
        )}
        {asset.kind === 'text' && clip.animId === 'draw.handwrite' && (
          <div className="hint">
            Traces a centreline through each letter. Faithful on near-monoline
            faces; on a modulated one it reads as traced type rather than
            handwriting — “Write” draws the real letterforms instead.
          </div>
        )}
        <AnimParams ed={ed} clip={clip} />
        <TrackField tracks={ed.doc.tracks} kind="clip" value={clip.trackId}
          onChange={(trackId) => ed.patchClip(clip.id, { trackId })} />
        <Field label="Page">
          <select value={clip.pageId}
                  onChange={(e) => ed.patchClip(clip.id, { pageId: e.target.value })}>
            {ed.doc.pages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <div className="pair">
          <Field label="Start"><Num value={clip.start} step={0.1} min={0}
            onChange={(start) => ed.patchClip(clip.id, { start })} /></Field>
          <Field label="Length"><Num value={clip.duration} step={0.1} min={0.1}
            onChange={(duration) => ed.patchClip(clip.id, { duration })} /></Field>
        </div>
        <div className="hint">
          Retiming only restretches the pen's arc-length pacing — nothing is
          recompiled, so the motion stays identical at any speed.
        </div>
      </Group>

      <Group title="Transform">
        <div className="pair">
          <Field label="X"><Num value={t.x ?? 0} step={10}
            onChange={(x) => ed.patchTransform(clip.id, { x })} /></Field>
          <Field label="Y"><Num value={t.y ?? 0} step={10}
            onChange={(y) => ed.patchTransform(clip.id, { y })} /></Field>
        </div>
        <div className="pair">
          <Field label="Scale"><Num value={t.scale ?? 1} step={0.05} min={0.01}
            onChange={(scale) => ed.patchTransform(clip.id, { scale })} /></Field>
          <Field label="Rotate"><Num value={t.rotation ?? 0} step={5}
            onChange={(rotation) => ed.patchTransform(clip.id, { rotation })} /></Field>
        </div>
      </Group>

      <Group title="Erase">
        <label className="check">
          <input
            type="checkbox"
            checked={!!erase}
            onChange={(e) => ed.patchClip(clip.id, {
              // The validator rejects an erase that starts before the draw has
              // finished, so seed it just after the last stroke lands.
              erase: e.target.checked
                ? { start: Math.round((drawEnd + 0.4) * 10) / 10, duration: 1.6 }
                : undefined,
            })}
          />
          Wipe this clip away afterwards
        </label>
        {erase && (
          <div className="pair">
            <Field label="Start"><Num value={erase.start} step={0.1} min={drawEnd}
              onChange={(start) => ed.patchClip(clip.id, { erase: { ...erase, start } })} /></Field>
            <Field label="Length"><Num value={erase.duration} step={0.1} min={0.1}
              onChange={(duration) => ed.patchClip(clip.id, { erase: { ...erase, duration } })} /></Field>
          </div>
        )}
      </Group>

      {asset.kind === 'text' ? (
        <Group title="Text">
          <Field label="Content" stack>
            <textarea
              value={asset.text}
              onChange={(e) => ed.patchAsset(asset.id, { text: e.target.value })}
              onKeyDown={(e) => e.stopPropagation()}
            />
          </Field>
          <div className="pair">
            <Field label="Size"><Num value={asset.fontSize ?? 120} min={8} max={600} step={4}
              onChange={(fontSize) => ed.patchAsset(asset.id, { fontSize })} /></Field>
            <Field label="Pen"><Num value={asset.penWidth ?? 5} min={0.5} max={40} step={0.5}
              onChange={(penWidth) => ed.patchAsset(asset.id, { penWidth })} /></Field>
          </div>
          <Field label="Ink">
            <input type="color" value={asset.color || '#1a1a1a'}
                   onChange={(e) => ed.patchAsset(asset.id, { color: e.target.value })} />
          </Field>
          {/* Keyed on the asset so switching clips closes an open list rather
              than leaving the previous clip's picker hanging open. */}
          <Field label="Face" stack>
            <FontPicker
              key={asset.id}
              fonts={fonts}
              value={asset.font}
              onPick={(f) => ed.patchAsset(asset.id, { font: f.path, fontFamily: f.family })}
            />
          </Field>
          <div className="hint">
            Changing the face re-lays the letters out, so the clip is traced again.
          </div>
        </Group>
      ) : (
        <Group title="Artwork">
          <div className="hint" title={asset.src}>{asset.src?.split('/').pop()}</div>
          {asset.kind === 'vector'
            ? <div className="hint">
                Vector geometry is exact, so it skips the tracer entirely.
              </div>
            : (
              <>
                <Field label="Colours"><input type="number" disabled value={8} /></Field>
                <Field label="Min area"><input type="number" disabled value={24} /></Field>
                <div className="hint">
                  Tracer tuning <Soon /> — imports currently use the default
                  quantisation.
                </div>
              </>
            )}
        </Group>
      )}

      {/* Repeated here rather than left to the project panel: "zoom to this"
          only means anything once something is selected, and selecting is
          exactly what swaps the project panel out. */}
      <CameraGroup ed={ed} frame={frame} fps={fps} selection={selection} bboxes={bboxes} />
    </>
  );
}

function AudioInspector({ ed, index, track }) {
  return (
    <Group title="Audio track" right={<span className="pill">#{index + 1}</span>}>
      <div className="hint" title={track.src}>{track.src.split('/').pop()}</div>
      <TrackField tracks={ed.doc.tracks} kind="audio" value={track.trackId}
        onChange={(trackId) => ed.patchAudio(index, { trackId })} />
      <div className="pair">
        <Field label="Start"><Num value={track.start ?? 0} step={0.1} min={0}
          onChange={(start) => ed.patchAudio(index, { start })} /></Field>
        <Field label="Trim in"><Num value={track.trimIn ?? 0} step={0.1} min={0}
          onChange={(trimIn) => ed.patchAudio(index, { trimIn })} /></Field>
      </div>
      <Field label="Gain">
        <input type="range" min={0} max={2} step={0.05} value={track.gain ?? 1}
               style={{ '--fill': `${((track.gain ?? 1) / 2) * 100}%` }}
               onChange={(e) => ed.patchAudio(index, { gain: Number(e.target.value) })} />
      </Field>
      <div className="hint">
        Preview mixes these live through WebAudio and export mixes them in
        ffmpeg, but both read the same four fields — start, trim, length, gain —
        so what you hear while scrubbing is what lands in the MP4.
      </div>
      <button className="btn danger wide" onClick={() => ed.removeAudio(index)}>
        <Icon d={PATH.trash} /> Remove track
      </button>
    </Group>
  );
}

function PageBreakInspector({ ed, index, brk }) {
  const cut = brk.transition === 'cut';
  return (
    <Group title="Page break" right={<span className="pill">#{index + 1}</span>}>
      <Field label="Go to">
        <select value={brk.pageId}
                onChange={(e) => ed.patchPageBreak(index, { pageId: e.target.value })}>
          {ed.doc.pages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </Field>
      <Field label="Transition">
        <select value={brk.transition}
                onChange={(e) => ed.patchPageBreak(index, { transition: e.target.value })}>
          {TRANSITION_LABELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </Field>
      <div className="pair">
        <Field label="At"><Num value={brk.t} step={0.1} min={0}
          onChange={(t) => ed.patchPageBreak(index, { t })} /></Field>
        <Field label="Length">
          {cut
            ? <input type="number" disabled value={0} />
            : <Num value={brk.duration} step={0.1} min={0.1}
                   onChange={(duration) => ed.patchPageBreak(index, { duration })} />}
        </Field>
      </div>
      <div className="hint">
        Both sheets travel together, so the same swipe reversed reads as going
        back. Nothing may be drawn while the paper is moving.
      </div>
      <button className="btn danger wide" onClick={() => ed.removePageBreak(index)}>
        <Icon d={PATH.trash} /> Remove break
      </button>
    </Group>
  );
}

/** One camera keyframe: a framing, and the moment the camera is to hold it. */
function CameraInspector({ ed, pageId, index }) {
  const page = ed.doc.pages.find((p) => p.id === pageId);
  const k = page?.cameraKeyframes?.[index];
  if (!k) return null;
  const patch = (p) => ed.patchCameraKeyframe(pageId, index, p);
  return (
    <Group title="Camera keyframe" right={<span className="pill">{page.name}</span>}>
      <div className="pair">
        <Field label="At"><Num value={k.t} step={0.1} min={0}
          onChange={(t) => patch({ t })} /></Field>
        <Field label="Zoom"><Num value={k.zoom} step={0.1} min={0.01} max={100}
          onChange={(zoom) => patch({ zoom })} /></Field>
      </div>
      <div className="pair">
        <Field label="X"><Num value={k.x} step={10} onChange={(x) => patch({ x })} /></Field>
        <Field label="Y"><Num value={k.y} step={10} onChange={(y) => patch({ y })} /></Field>
      </div>
      <div className="hint">
        X and Y are the world point the frame centres on, so a zoom of 2 shows
        half as much of the page around it. The move into this framing eases
        from the keyframe before it — put one just ahead to hold the previous
        shot until then.
      </div>
      <button className="btn danger wide"
              onClick={() => ed.removeCameraKeyframe(pageId, index)}>
        <Icon d={PATH.trash} /> Remove keyframe
      </button>
    </Group>
  );
}

/**
 * Project-level camera controls.
 *
 * "Zoom to selection" is the whole feature in one button: park the playhead
 * where a clip begins, pick the artwork you want written large, and the camera
 * arrives on it just in time.
 */
function CameraGroup({ ed, frame, fps, selection, bboxes }) {
  const doc = ed.doc;
  const t = frame / fps;
  const pageId = pageAt(doc, t);
  const page = doc.pages.find((p) => p.id === pageId);
  const cam = cameraAt(page, t);

  const clip = selection?.type === 'clip'
    ? doc.clips.find((c) => c.id === selection.id)
    : null;
  const bbox = clip && bboxes?.get(clip.id);
  // Only artwork on the page being shown can be framed: the keyframe would go
  // on this page, and pointing it at a drawable on another sheet frames blank
  // paper.
  const framable = bbox && clip.pageId === pageId;

  const frameClip = () => {
    const tr = clip.transform || { x: 0, y: 0, scale: 1 };
    const a = localToWorld(tr, bbox[0], bbox[1]);
    const b = localToWorld(tr, bbox[2], bbox[3]);
    const w = Math.abs(b.x - a.x) * FRAME_MARGIN;
    const h = Math.abs(b.y - a.y) * FRAME_MARGIN;
    // renderPage maps world to canvas as `size/2 + (world - cam) * zoom`, so a
    // world span of `w` covers `w * zoom` pixels. Fit whichever axis is tighter.
    const zoom = Math.min(100, Math.max(0.01,
      Math.min(doc.meta.width / Math.max(1, w), doc.meta.height / Math.max(1, h))));
    ed.setCameraAt(pageId, t, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, zoom });
  };

  return (
    <Group title="Camera" right={<span className="pill">{cam.zoom}×</span>}>
      <div className="hint">
        The page moves under the camera; the hand keeps its size on screen, so
        writing looks the same however far in you are.
      </div>
      <button className="btn wide" disabled={!framable} onClick={frameClip}
              title={framable
                ? 'Frame the selected clip at the playhead, easing in over the second before it'
                : 'Select a clip on the page currently showing'}>
        <Icon d={PATH.plus} /> Zoom to selection
      </button>
      <button className="btn wide" disabled={!page}
              title="Pin the framing that is live right now, so a later move starts from here"
              onClick={() => ed.addCameraKeyframe(pageId, t)}>
        <Icon d={PATH.plus} /> Hold this framing
      </button>
      <button className="btn wide" disabled={cam.zoom === 1 && cam.x === 0 && cam.y === 0}
              title="Ease back out to the whole page at the playhead"
              onClick={() => ed.setCameraAt(pageId, t, { x: 0, y: 0, zoom: 1 })}>
        Back to full page
      </button>
      <div className="hint">
        Or press <b>C</b> and drag the stage to pan, scroll to zoom. Keyframes
        appear on the timeline’s camera lane.
      </div>
    </Group>
  );
}

/** Pages, and where each one is on screen. */
function PagesGroup({ ed, frame, fps }) {
  const doc = ed.doc;
  const windows = pageWindows(doc);
  const used = (id) => windows.filter((w) => w.pageId === id).length;
  return (
    <Group title="Pages" right={<span className="pill">{doc.pages.length}</span>}>
      {doc.pages.map((p) => (
        <Field key={p.id} label={`${used(p.id)}×`}>
          <input
            type="text"
            value={p.name}
            onChange={(e) => ed.renamePage(p.id, e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
          />
        </Field>
      ))}
      <div className="hint">
        The count is how many times a page comes on screen — a page you return
        to later appears more than once.
      </div>
      <button className="btn wide"
              onClick={() => ed.addPageBreak({ t: frame / fps })}>
        <Icon d={PATH.page} /> Add page
      </button>
    </Group>
  );
}

function ProjectInspector({ ed, hands, frame, fps, selection, bboxes }) {
  const m = ed.doc.meta;
  return (
    <>
      <Group title="Composition">
        <div className="pair">
          <Field label="Width"><Num value={m.width} step={16} min={16} max={7680}
            onChange={(width) => ed.patchMeta({ width })} /></Field>
          <Field label="Height"><Num value={m.height} step={16} min={16} max={4320}
            onChange={(height) => ed.patchMeta({ height })} /></Field>
        </div>
        <Field label="Frame rate">
          <select value={m.fps} onChange={(e) => ed.patchMeta({ fps: Number(e.target.value) })}>
            {[24, 25, 30, 50, 60].map((f) => <option key={f} value={f}>{f} fps</option>)}
          </select>
        </Field>
        <Field label="Paper">
          <input type="color" value={m.background || '#fdfdfb'}
                 onChange={(e) => ed.patchMeta({ background: e.target.value })} />
        </Field>
        <Field label="Hand">
          <select value={m.handStyleId}
                  onChange={(e) => ed.patchMeta({ handStyleId: e.target.value })}>
            {hands.map((h) => <option key={h.id} value={h.id}>{h.label}</option>)}
          </select>
        </Field>
      </Group>

      <CameraGroup ed={ed} frame={frame} fps={fps} selection={selection}
                   bboxes={bboxes} />

      <PagesGroup ed={ed} frame={frame} fps={fps} />
    </>
  );
}

export default function Inspector({ ed, selection, hands, fonts, frame, fps, bboxes }) {
  const clip = selection?.type === 'clip'
    ? ed.doc.clips.find((c) => c.id === selection.id)
    : null;
  const track = selection?.type === 'audio' ? ed.doc.audio[selection.index] : null;
  const brk = selection?.type === 'pageBreak' ? ed.doc.pageBreaks[selection.index] : null;
  const key = selection?.type === 'camera' ? selection : null;

  return (
    <aside className="panel">
      <div className="panel-head">
        <span className="panel-title">
          {clip ? 'Clip' : track ? 'Audio' : brk ? 'Page break'
            : key ? 'Camera' : 'Project'}
        </span>
      </div>
      <div className="panel-body">
        <div className="insp">
          {clip && <ClipInspector ed={ed} clip={clip} asset={ed.doc.assets[clip.assetId]}
                                  fonts={fonts} frame={frame} fps={fps}
                                  selection={selection} bboxes={bboxes} />}
          {track && <AudioInspector ed={ed} index={selection.index} track={track} />}
          {brk && <PageBreakInspector ed={ed} index={selection.index} brk={brk} />}
          {key && <CameraInspector ed={ed} pageId={key.pageId} index={key.index} />}
          {!clip && !track && !brk && !key
            && <ProjectInspector ed={ed} hands={hands} frame={frame} fps={fps}
                                 selection={selection} bboxes={bboxes} />}
        </div>
      </div>
    </aside>
  );
}
