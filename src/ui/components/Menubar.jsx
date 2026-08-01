import React, { useEffect, useRef, useState } from 'react';
import { Icon, PATH } from './common.jsx';

function Menu({ label, open, setOpen, children }) {
  return (
    <div className={open ? 'menu open' : 'menu'}>
      <button
        onMouseDown={(e) => { e.preventDefault(); setOpen(open ? null : label); }}
        // Hovering another title while a menu is open switches to it, which is
        // what every desktop menubar does.
        onMouseEnter={() => setOpen((cur) => (cur ? label : cur))}
      >
        {label}
      </button>
      {open && <div className="menu-pop">{children}</div>}
    </div>
  );
}

const Item = ({ children, onClick, keys, disabled }) => (
  <button disabled={disabled} onClick={onClick}>
    {children}{keys && <span className="key">{keys}</span>}
  </button>
);

export default function Menubar({ ed, cmd, busy }) {
  const [open, setOpen] = useState(null);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(null); };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  const run = (fn) => () => { setOpen(null); fn(); };
  const has = ed.doc.clips.length > 0;

  return (
    <div className="menubar" ref={ref}>
      <div className="brand"><span className="mark">W</span>Whiteboard Studio</div>

      <Menu label="File" open={open === 'File'} setOpen={setOpen}>
        <Item onClick={run(cmd.newProject)} keys="Ctrl N">New project</Item>
        <Item onClick={run(() => cmd.open())} keys="Ctrl O">Open…</Item>
        <div className="menu-sep" />
        {cmd.examples.map((p) => (
          <Item key={p} onClick={run(() => cmd.open(p))}>
            Example: {p.split('/').pop().replace('.project.json', '')}
          </Item>
        ))}
        <div className="menu-sep" />
        <Item onClick={run(() => cmd.save(false))} keys="Ctrl S" disabled={!has}>Save</Item>
        <Item onClick={run(() => cmd.save(true))} keys="Ctrl ⇧ S" disabled={!has}>Save as…</Item>
        <div className="menu-sep" />
        <Item onClick={run(cmd.exportVideo)} keys="Ctrl E" disabled={!has || busy}>
          Export MP4…
        </Item>
      </Menu>

      <Menu label="Edit" open={open === 'Edit'} setOpen={setOpen}>
        <Item onClick={run(ed.undo)} keys="Ctrl Z" disabled={!ed.canUndo}>Undo</Item>
        <Item onClick={run(ed.redo)} keys="Ctrl ⇧ Z" disabled={!ed.canRedo}>Redo</Item>
        <div className="menu-sep" />
        <Item onClick={run(cmd.deleteSelected)} keys="Del" disabled={!cmd.selectedId}>
          Delete clip
        </Item>
      </Menu>

      <Menu label="Insert" open={open === 'Insert'} setOpen={setOpen}>
        <Item onClick={run(() => cmd.importAssets('image'))}>Image or SVG…</Item>
        <Item onClick={run(cmd.addText)}>Text</Item>
        <Item onClick={run(() => cmd.importAssets('audio'))}>Audio track…</Item>
        <div className="menu-sep" />
        <Item onClick={run(cmd.addPage)}>Page break</Item>
        <Item disabled>Camera keyframe <span className="key">soon</span></Item>
      </Menu>

      <Menu label="View" open={open === 'View'} setOpen={setOpen}>
        <Item onClick={run(cmd.toggleHand)} keys="H">
          {cmd.showHand ? 'Hide hand' : 'Show hand'}
        </Item>
        <Item onClick={run(cmd.toggleGuides)} keys="G">
          {cmd.guides ? 'Hide guides' : 'Show guides'}
        </Item>
      </Menu>

      <div className="doc-name">
        <b>{ed.path ? ed.path.split('/').pop() : 'Untitled'}</b>
        {ed.dirty && <span className="dot" title="Unsaved changes"> ●</span>}
      </div>

      <div className="spacer" />
      <button className="btn quiet icon" title="Undo (Ctrl Z)"
              disabled={!ed.canUndo} onClick={ed.undo}>
        <Icon d={PATH.undo} />
      </button>
      <button className="btn quiet icon" title="Redo (Ctrl Shift Z)"
              disabled={!ed.canRedo} onClick={ed.redo}>
        <Icon d={PATH.redo} />
      </button>
      <button className="btn primary" onClick={cmd.exportVideo} disabled={!has || busy}>
        <Icon d={PATH.export} /> Export
      </button>
    </div>
  );
}
