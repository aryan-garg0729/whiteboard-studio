import React from 'react';
import { ANIMATIONS_FOR_KIND, pageAt, pageWindows } from '../../engine/model/project.js';
import { MIN_AUDIO } from '../../engine/model/edits.js';
import { cameraAt } from '../../engine/render/renderFrame.js';
import { aroundCentre, transformCorners } from '../stageGeom.js';
import { Field, Group, Icon, Num, PATH, Soon } from './common.jsx';
import FontPicker from './FontPicker.jsx';
import { getAnimation } from '../../engine/anim/registry.js';

/**
 * Breathing room left around a clip by "Zoom to selection", as a multiple of
 * its bounding box. Framing artwork edge to edge looks like a crop, not a shot.
 */
const FRAME_MARGIN = 1.24;

const ANIMATION_LABELS = {
  'draw.inkPaint': 'Ink outline, then colour',
  'draw.stencilPaint': 'Paint the artwork in',
  'draw.textReveal': 'Write (letters appear)',
  'draw.handwrite': 'Trace letterforms',
  'appear.instant': 'Appear (instantly)',
  'appear.fade': 'Appear (fade in)',
  'appear.pop': 'Appear (pop in)',
  'appear.slide': 'Appear (slide in)',
};

/**
 * Controls for a `{key: spec}` schema, whatever declared it.
 *
 * Split out from `AnimParams` so the subtitle panel drives the same three
 * controls off its own schema instead of growing a second copy of them.
 */
function SchemaFields({ schema, value, onSet }) {
  return Object.entries(schema || {}).map(([key, spec]) => (
    <Field key={key} label={spec.label || key}>
      {spec.type === 'enum' ? (
        <select value={value(key, spec)} onChange={(e) => onSet(key, e.target.value)}>
          {spec.options.map((o) => (
            <option key={o.value ?? o} value={o.value ?? o}>{o.label ?? o}</option>
          ))}
        </select>
      ) : spec.type === 'color' ? (
        <input type="color" value={value(key, spec)}
               onChange={(e) => onSet(key, e.target.value)} />
      ) : (
        <Num value={value(key, spec)} min={spec.min} max={spec.max} step={spec.step}
             onChange={(v) => onSet(key, v)} />
      )}
    </Field>
  ));
}

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
  if (!Object.keys(schema || {}).length) return null;

  return (
    <SchemaFields
      schema={schema}
      value={(key, spec) => clip.params?.[key] ?? spec.default}
      onSet={(key, v) => ed.patchClip(clip.id, { params: { ...(clip.params || {}), [key]: v } })}
    />
  );
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

/** A quarter turn, kept in (-180, 180] so the field never reads 450°. */
const quarter = (t, by) => ((((t.rotation ?? 0) + by + 180) % 360) + 360) % 360 - 180;

function ClipInspector({ ed, clip, asset, fonts, frame, fps, selection, bboxes }) {
  const t = clip.transform || {};
  const erase = clip.erase;
  const drawEnd = clip.start + clip.duration;

  /**
   * Edit the placement about the drawable's centre.
   *
   * The matrix pivots on the origin corner, so a bare `rotation: 90` would send
   * the artwork somewhere else on the page. `aroundCentre` re-solves the origin
   * so it turns, squeezes and mirrors in place -- matching what the stage
   * handles do, since they hold their anchor still for the same reason.
   */
  const set = (patch) => ed.patchTransform(
    clip.id, aroundCentre(t, bboxes?.get(clip.id), patch));

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
        {asset.kind !== 'text' && clip.animId === 'draw.stencilPaint' && (
          <div className="hint">
            The pen paints across the artwork and the real picture appears
            underneath. Assumes nothing about the image, so it suits photographs
            and soft gradients. The last frame is the source image, exactly —
            nothing the pen misses is left out.
          </div>
        )}
        {asset.kind !== 'text' && clip.animId === 'draw.inkPaint' && (
          <div className="hint">
            For artwork drawn with a black outline and flat colour fills. The pen
            inks the outline first, following its centre, then colours each shape
            in turn. Colours close enough together count as one — raise Colour
            merge if a flat fill is coming out as two.
          </div>
        )}
        {asset.kind === 'text' && clip.animId === 'draw.handwrite' && (
          <div className="hint">
            Follows a calm handwriting guide for each character while revealing
            the selected font’s real letterforms.
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
            onChange={(scale) => set({ scale })} /></Field>
          <Field label="Rotate°"><Num value={t.rotation ?? 0} step={5}
            onChange={(rotation) => set({ rotation })} /></Field>
        </div>
        {/* Stretch is a multiple of Scale, not a size: 1 is the artwork's own
            proportions, and a negative value mirrors that axis. Flip and
            squeeze are one field, which is what lets a handle dragged past its
            far edge do both. */}
        <div className="pair">
          <Field label="Stretch X"><Num value={t.scaleX ?? 1} step={0.05}
            onChange={(scaleX) => set({ scaleX })} /></Field>
          <Field label="Stretch Y"><Num value={t.scaleY ?? 1} step={0.05}
            onChange={(scaleY) => set({ scaleY })} /></Field>
        </div>
        <div className="chips">
          <button className="chip" title="Mirror left to right"
                  onClick={() => set({ scaleX: -(t.scaleX ?? 1) })}>Flip H</button>
          <button className="chip" title="Mirror top to bottom"
                  onClick={() => set({ scaleY: -(t.scaleY ?? 1) })}>Flip V</button>
          <button className="chip" title="Quarter turn anticlockwise"
                  onClick={() => set({ rotation: quarter(t, -90) })}>↺ 90°</button>
          <button className="chip" title="Quarter turn clockwise"
                  onClick={() => set({ rotation: quarter(t, 90) })}>↻ 90°</button>
          <button className="chip" title="Back to the artwork's own proportions"
                  onClick={() => set({ scaleX: 1, scaleY: 1, rotation: 0 })}>Reset</button>
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
          <div className="pair">
            <Field label="Ink">
              <input type="color" value={asset.color || '#1a1a1a'}
                     onChange={(e) => ed.patchAsset(asset.id, { color: e.target.value })} />
            </Field>
            <Field label="Weight">
              <label className="check">
                <input type="checkbox" checked={!!asset.bold}
                       onChange={(e) => ed.patchAsset(asset.id, { bold: e.target.checked })} />
                Bold
              </label>
            </Field>
          </div>
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

/** Speeds worth one click. 1 is in the list so there is a way back to it. */
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

/**
 * The speed slider is logarithmic, so 1x sits at the centre of the track.
 *
 * Linear over 0.25..4 would put unmodified audio a fifth of the way along and
 * give three quarters of the travel to speeding up, which is backwards: halving
 * and doubling are equally large edits and deserve equal room.
 */
const SPEED_MIN = 0.25;
const SPEED_MAX = 4;
const speedToPos = (s) => (Math.log2(s) - Math.log2(SPEED_MIN))
  / (Math.log2(SPEED_MAX) - Math.log2(SPEED_MIN));
const posToSpeed = (p) => {
  // A detent at the midpoint: getting back to unmodified audio must not be a
  // matter of hitting one pixel.
  if (Math.abs(p - 0.5) < 0.02) return 1;
  const raw = 2 ** (Math.log2(SPEED_MIN)
    + p * (Math.log2(SPEED_MAX) - Math.log2(SPEED_MIN)));
  return Math.round(raw * 100) / 100;
};

function AudioInspector({ ed, track, frame, fps, srcDuration, onSplit }) {
  const index = ed.doc.audio.findIndex((a) => a.id === track.id);
  const t = frame / fps;
  const start = track.start ?? 0;
  const speed = track.speed ?? 1;
  const end = start + (track.duration ?? 0);
  // A cut needs a real half on each side, and a length to cut: an item ffprobe
  // could not measure has no end to speak of.
  const canSplit = track.duration != null && t > start + MIN_AUDIO && t < end - MIN_AUDIO;
  // Retiming an item slides the narration out from under a transcript that was
  // timed against it. Worth a word, since nothing else will say so.
  const timed = ed.doc.subtitles?.words?.length > 0;
  // One entry point for all three speed controls, so they cannot drift apart --
  // and so the length rescale and the lane ripple happen exactly once each.
  const setSpeed = (v, opts) => ed.patchAudio(track.id, { speed: v }, opts);

  return (
    <Group title="Audio track" right={<span className="pill">#{index + 1}</span>}>
      <div className="hint" title={track.src}>{track.src.split('/').pop()}</div>
      <TrackField tracks={ed.doc.tracks} kind="audio" value={track.trackId}
        onChange={(trackId) => ed.patchAudio(track.id, { trackId })} />
      <div className="pair">
        <Field label="Start"><Num value={start} step={0.1} min={0}
          onChange={(v) => ed.patchAudio(track.id, { start: v })} /></Field>
        <Field label="Length"><Num value={track.duration ?? 0} step={0.1} min={0.1}
          max={srcDuration != null
            ? Math.max(0.1, (srcDuration - (track.trimIn ?? 0)) / speed)
            : undefined}
          onChange={(v) => ed.patchAudio(track.id, { duration: v })} /></Field>
      </div>
      <div className="pair">
        <Field label="Trim in"><Num value={track.trimIn ?? 0} step={0.1} min={0}
          max={srcDuration != null ? Math.max(0, srcDuration - 0.1) : undefined}
          onChange={(v) => ed.patchAudio(track.id, { trimIn: v })} /></Field>
        <Field label="Speed"><Num value={speed} step={0.05} min={SPEED_MIN} max={SPEED_MAX}
          suffix="×" onChange={(v) => setSpeed(v)} /></Field>
      </div>
      {/* Bare, not in a Field: it belongs to the Speed number field directly
          above it, and a second "Speed" label would just repeat itself. */}
      <input
        type="range" min={0} max={1} step={0.005} value={speedToPos(speed)}
        style={{ '--fill': `${speedToPos(speed) * 100}%` }}
        title={`${speed}× — pitch is preserved`}
        // Coalesced, so a drag is one undo step rather than the fifty edits a
        // range input emits. Each of these also ripples the lane, which makes
        // fifty entries actively confusing to step back through.
        onChange={(e) => setSpeed(posToSpeed(Number(e.target.value)),
          { coalesce: `speed:${track.id}` })}
        onPointerUp={() => ed.endGesture()}
        onBlur={() => ed.endGesture()}
      />
      <div className="chips">
        {SPEEDS.map((s) => (
          <button key={s} className={`chip${Math.abs(speed - s) < 1e-6 ? ' on' : ''}`}
                  onClick={() => setSpeed(s)}>
            {s}×
          </button>
        ))}
      </div>
      <Field label="Gain">
        <input type="range" min={0} max={2} step={0.05} value={track.gain ?? 1}
               style={{ '--fill': `${((track.gain ?? 1) / 2) * 100}%` }}
               onChange={(e) => ed.patchAudio(track.id, { gain: Number(e.target.value) })} />
      </Field>
      <button className="btn wide" disabled={!canSplit} onClick={onSplit}
              title={canSplit ? 'Cut this item in two at the playhead (S)'
                              : 'Put the playhead inside this item to cut it'}>
        <Icon d={PATH.cut} /> Split at playhead
      </button>
      <div className="hint">
        Preview mixes these live through WebAudio and export mixes them in
        ffmpeg, and both read the same fields, so what you hear while scrubbing
        lands in the MP4. Speed preserves pitch in both — a faster take is the
        same voice hurrying, not a higher one. Changing it resizes the block to
        hold the same audio and slides the rest of the lane to match.
      </div>
      {timed && (
        <div className="hint warn">
          This project has a transcript. Subtitles are timed against the
          composition, not against this item, so moving, trimming or retiming it
          will drift them — re-run the transcription afterwards.
        </div>
      )}
      <button className="btn danger wide" onClick={() => ed.removeAudio(track.id)}>
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
    // All four corners, not two: a rotated clip's extent is the hull of its
    // quad, and framing the diagonal of the untilted box crops it.
    const pts = transformCorners(bbox, tr);
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const a = { x: Math.min(...xs), y: Math.min(...ys) };
    const b = { x: Math.max(...xs), y: Math.max(...ys) };
    const w = (b.x - a.x) * FRAME_MARGIN;
    const h = (b.y - a.y) * FRAME_MARGIN;
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

/**
 * How the narration's words are drawn. Declared as a schema so the same three
 * controls that render an animation's parameters render these too.
 */
const SUBTITLE_SCHEMA = {
  style: { label: 'Style', type: 'enum', default: 'karaoke', options: [
    { value: 'bar', label: 'Whole line' },
    { value: 'karaoke', label: 'Highlight each word' },
    { value: 'pop', label: 'One word at a time' },
  ] },
  fontSize: { label: 'Size', type: 'number', default: 56, min: 8, max: 400, step: 2 },
  color: { label: 'Text', type: 'color', default: '#ffffff' },
  highlight: { label: 'Spoken', type: 'color', default: '#ffd54a' },
  maxWords: { label: 'Words per line', type: 'number', default: 7, min: 1, max: 40, step: 1 },
  marginBottom: { label: 'From bottom', type: 'number', default: 0.08,
    min: 0, max: 0.9, step: 0.01 },
};

/**
 * The subtitle track: one per project, so it lives with the project rather than
 * with a selection.
 *
 * The transcript is the only thing in the document a person cannot author by
 * hand -- the timings are the whole value and only the recogniser knows them --
 * so the panel is mostly one button, and the settings only appear once there is
 * something to style.
 */
function SubtitlesGroup({ ed, transcribe, job }) {
  const subs = ed.doc.subtitles;
  const words = subs?.words?.length ?? 0;

  return (
    <Group title="Subtitles">
      <div className="hint">
        The narration&apos;s own words, burned over the whole video. Not the same as a
        text clip the hand writes.
      </div>
      <button className="btn wide" disabled={!!job && !job.error} onClick={transcribe}>
        <Icon d={PATH.audio} />
        {job && !job.error ? `Transcribing… ${job.percent}%`
          : words ? 'Transcribe again' : 'Transcribe narration'}
      </button>
      {job?.error && <div className="hint warn">{job.error}</div>}
      {words > 0 && (
        <>
          <Field label="Show">
            <input type="checkbox" checked={subs.enabled !== false}
                   onChange={(e) => ed.setSubtitles({ enabled: e.target.checked })} />
          </Field>
          <SchemaFields
            schema={SUBTITLE_SCHEMA}
            value={(key, spec) => subs[key] ?? spec.default}
            onSet={(key, v) => ed.setSubtitles({ [key]: v })}
          />
          <div className="hint">{words} words transcribed.</div>
          <button className="btn wide" onClick={() => ed.removeSubtitles()}>
            Remove subtitles
          </button>
        </>
      )}
    </Group>
  );
}

function ProjectInspector({ ed, hands, frame, fps, selection, bboxes, transcribe, transcribing }) {
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

      <SubtitlesGroup ed={ed} transcribe={transcribe} job={transcribing} />
    </>
  );
}

export default function Inspector({ ed, selection, hands, fonts, frame, fps, bboxes,
  mediaBySrc, onSplitAudio, transcribe, transcribing }) {
  const clip = selection?.type === 'clip'
    ? ed.doc.clips.find((c) => c.id === selection.id)
    : null;
  const track = selection?.type === 'audio'
    ? ed.doc.audio.find((a) => a.id === selection.id)
    : null;
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
          {track && <AudioInspector ed={ed} track={track} frame={frame} fps={fps}
                                    srcDuration={mediaBySrc?.[track.src]?.duration}
                                    onSplit={onSplitAudio} />}
          {brk && <PageBreakInspector ed={ed} index={selection.index} brk={brk} />}
          {key && <CameraInspector ed={ed} pageId={key.pageId} index={key.index} />}
          {!clip && !track && !brk && !key
            && <ProjectInspector ed={ed} hands={hands} frame={frame} fps={fps}
                                 selection={selection} bboxes={bboxes}
                                 transcribe={transcribe} transcribing={transcribing} />}
        </div>
      </div>
    </aside>
  );
}
