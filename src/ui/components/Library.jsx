import React, { useState } from 'react';
import { Field, Group, Icon, Num, PATH, Soon } from './common.jsx';
import { FontList } from './FontPicker.jsx';

const TABS = [
  ['media', 'Media'],
  ['text', 'Text'],
  ['hand', 'Hand'],
];

function MediaTab({ library, onImport, onPlace, onAddAudio, onRemove }) {
  return (
    <>
      <div className="lib-section">
        <div className="row">
          <button className="btn wide" onClick={() => onImport('image')}>
            <Icon d={PATH.image} /> Image / SVG
          </button>
          <button className="btn wide" onClick={() => onImport('audio')}>
            <Icon d={PATH.audio} /> Audio
          </button>
        </div>
        <div className="hint">Drop files anywhere in the window to import.</div>
      </div>

      {library.length === 0 ? (
        <div className="lib-hint">
          Nothing imported yet.<br />
          PNG, JPG, WebP and SVG become drawings; MP3 and WAV become the
          soundtrack.
        </div>
      ) : (
        <div className="asset-grid">
          {library.map((a) => (
            // The remove control is a sibling of the card, not a child: the
            // card is itself a button, and a button inside a button is invalid
            // markup that browsers resolve by dropping one of them.
            <div className="asset-cell" key={a.path}>
            <button
              className="asset-card"
              title={`${a.path}\nClick to add, or drag onto the canvas to place it`}
              // Artwork can be dragged onto the stage to land at a chosen spot;
              // audio has no position, so it is click-to-add only.
              draggable={a.kind !== 'audio'}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'copy';
                e.dataTransfer.setData('application/x-studio-asset',
                  JSON.stringify({ path: a.path, kind: a.kind }));
              }}
              onClick={() => (a.kind === 'audio' ? onAddAudio(a) : onPlace(a))}
            >
              <div className={a.kind === 'audio' ? 'thumb audio-thumb' : 'thumb'}>
                {a.kind === 'audio'
                  ? <Icon d={PATH.audio} size={22} />
                  : <img src={a.thumb} alt="" />}
              </div>
              <div className="meta">
                {a.name}
                {a.kind === 'audio' && a.duration
                  ? ` · ${a.duration.toFixed(1)}s`
                  : ''}
              </div>
            </button>
            <button
              className="asset-x"
              title={'Remove from the library\n'
                + 'Your file is not deleted, and any clip already using it keeps working'}
              onClick={(e) => { e.stopPropagation(); onRemove(a.path); }}
            >
              <Icon d={PATH.close} size={10} />
            </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function TextTab({ fonts, draft, setDraft, onAdd }) {
  return (
    <div className="lib-section" style={{ borderBottom: 0 }}>
      <Field label="Text" stack>
        <textarea
          value={draft.text}
          placeholder={'Type a line…\nEnter starts a new line'}
          onChange={(e) => setDraft({ ...draft, text: e.target.value })}
          onKeyDown={(e) => e.stopPropagation()}
        />
      </Field>

      {/* A short curated set, not the machine's font book: a couple of hundred
          system families is a search problem, and none of them writes by hand.
          Open here rather than behind a disclosure as in the Inspector --
          choosing the face is part of composing the line, not a later edit. */}
      <Field label="Font" stack>
        <FontList
          fonts={fonts}
          value={draft.font}
          onPick={(f) => setDraft({ ...draft, font: f.path, fontFamily: f.family })}
        />
      </Field>

      <div className="pair">
        <Field label="Size">
          <Num value={draft.fontSize} min={8} max={600} step={4}
               onChange={(fontSize) => setDraft({ ...draft, fontSize })} />
        </Field>
        <Field label="Pen">
          <Num value={draft.penWidth} min={0.5} max={40} step={0.5}
               onChange={(penWidth) => setDraft({ ...draft, penWidth })} />
        </Field>
      </div>
      <Field label="Ink">
        <input type="color" value={draft.color}
               onChange={(e) => setDraft({ ...draft, color: e.target.value })} />
      </Field>

      <button className="btn primary wide" disabled={!draft.text.trim()} onClick={onAdd}>
        <Icon d={PATH.plus} /> Add text clip
      </button>
      <div className="hint">
        Letters follow a handwriting guide while their real font shapes reveal
        smoothly, character by character.
      </div>
    </div>
  );
}

function HandTab({ hands, meta, onMeta }) {
  return (
    <>
      <div className="lib-section">
        <label className="check">
          <input type="checkbox" checked={meta.showHand !== false}
                 onChange={(e) => onMeta({ showHand: e.target.checked })} />
          Show hand while drawing
        </label>
        <div className="hint">
          With the hand off, ink simply appears at the pen front. Rendering is
          otherwise identical.
        </div>
      </div>

      <div>
        {hands.map((h) => (
          <button
            key={h.id}
            className="hand-row"
            aria-selected={meta.handStyleId === h.id}
            onClick={() => onMeta({ handStyleId: h.id })}
          >
            <Icon d={h.tool === 'eraser' ? PATH.eraser : PATH.hand} size={15} />
            <span>
              {h.label}
              <br /><span className="sub">{h.id} · {h.tool}</span>
            </span>
          </button>
        ))}
      </div>
    </>
  );
}

export default function Library(props) {
  const [tab, setTab] = useState('media');
  return (
    <aside className="panel">
      <div className="panel-head"><span className="panel-title">Library</span></div>
      <div className="tabs">
        {TABS.map(([id, label]) => (
          <button key={id} aria-selected={tab === id} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      <div className="panel-body">
        {tab === 'media' && <MediaTab {...props} />}
        {tab === 'text' && <TextTab {...props} />}
        {tab === 'hand' && <HandTab {...props} />}
      </div>
    </aside>
  );
}
