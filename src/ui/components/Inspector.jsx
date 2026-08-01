import React from 'react';
import { pageWindows } from '../../engine/model/project.js';
import { Field, Group, Icon, Num, PATH, Soon } from './common.jsx';

const ANIMATIONS = [
  ['draw.outlineFill', 'Outline, then colour'],
  ['draw.handwrite', 'Handwriting'],
];

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

function ClipInspector({ ed, clip, asset }) {
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
            {ANIMATIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Field>
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
          <div className="hint" title={asset.font || 'default'}>
            Face: {(asset.font || 'DejaVu Sans').split('/').pop()}
            {' — change it in the Library’s Text tab.'}
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

function ProjectInspector({ ed, hands, frame, fps }) {
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

      <Group title={<>Camera <Soon /></>}>
        <div className="hint">
          The canvas is unbounded and the camera is already a keyframed
          {' '}<code>{'{x, y, zoom}'}</code> track in the document — the editor
          just has no way to author keyframes yet.
        </div>
        <button className="btn wide" disabled>Add camera keyframe</button>
      </Group>

      <PagesGroup ed={ed} frame={frame} fps={fps} />
    </>
  );
}

export default function Inspector({ ed, selection, hands, frame, fps }) {
  const clip = selection?.type === 'clip'
    ? ed.doc.clips.find((c) => c.id === selection.id)
    : null;
  const track = selection?.type === 'audio' ? ed.doc.audio[selection.index] : null;
  const brk = selection?.type === 'pageBreak' ? ed.doc.pageBreaks[selection.index] : null;

  return (
    <aside className="panel">
      <div className="panel-head">
        <span className="panel-title">
          {clip ? 'Clip' : track ? 'Audio' : brk ? 'Page break' : 'Project'}
        </span>
      </div>
      <div className="panel-body">
        <div className="insp">
          {clip && <ClipInspector ed={ed} clip={clip} asset={ed.doc.assets[clip.assetId]} />}
          {track && <AudioInspector ed={ed} index={selection.index} track={track} />}
          {brk && <PageBreakInspector ed={ed} index={selection.index} brk={brk} />}
          {!clip && !track && !brk
            && <ProjectInspector ed={ed} hands={hands} frame={frame} fps={fps} />}
        </div>
      </div>
    </aside>
  );
}
