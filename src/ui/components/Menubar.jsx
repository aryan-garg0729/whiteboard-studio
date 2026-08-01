/**
 * The app's own top row.
 *
 * It used to carry a full File/Edit/Insert/View menu bar, which was drawn
 * directly beneath the operating system's own menu bar showing the same
 * commands -- the app never installed an application menu, so Electron fitted
 * its default one. Those menus now live where they belong, in the real menu bar
 * (see `buildMenu` in electron/main.js), and this row keeps only what a menu
 * cannot do: identity, the project name, and the one action worth a permanent
 * button.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Icon, PATH } from './common.jsx';

/**
 * What to call this project.
 *
 * `meta.name` is the authored title and wins. Failing that the filename stands
 * in, minus the `.project.json` suffix -- the suffix is noise in a title bar,
 * and every project has it.
 */
export function projectTitle(doc, path) {
  const named = doc.meta?.name?.trim();
  if (named) return named;
  if (path) return path.split('/').pop().replace(/\.project\.json$/, '');
  return 'Untitled';
}

/** Click (or Edit -> Rename project) to retitle; Enter commits, Escape cancels. */
function Title({ ed, path, editing, setEditing }) {
  const title = projectTitle(ed.doc, path);
  const inputRef = useRef(null);

  // Selecting the text as well as focusing it: renaming almost always means
  // replacing the name outright, not appending to "Untitled".
  useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="doc-rename"
        autoFocus
        defaultValue={title}
        // The transport listens for Space on window; without this, typing a
        // space in the title would start playback instead.
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') setEditing(false);
        }}
        onBlur={(e) => {
          const name = e.target.value.trim();
          if (name && name !== title) ed.patchMeta({ name });
          setEditing(false);
        }}
      />
    );
  }

  return (
    <button className="doc-name" onClick={() => setEditing(true)}
            title="Rename this project (F2)">
      <b>{title}</b>
      {ed.dirty && <span className="dot" title="Unsaved changes"> ●</span>}
    </button>
  );
}

export default function Menubar({ ed, cmd, busy, renaming, setRenaming }) {
  const has = ed.doc.clips.length > 0;
  const title = projectTitle(ed.doc, ed.path);

  // Keep the OS window title in step, so the taskbar and window switcher name
  // the project rather than the application.
  useEffect(() => {
    document.title = `${title}${ed.dirty ? ' •' : ''} — Whiteboard Studio`;
  }, [title, ed.dirty]);

  return (
    <div className="menubar">
      <div className="brand"><span className="mark">W</span>Whiteboard Studio</div>

      <Title ed={ed} path={ed.path} editing={renaming} setEditing={setRenaming} />

      <div className="spacer" />
      <button className="btn quiet icon" title="Undo (Ctrl Z)"
              disabled={!ed.canUndo} onClick={ed.undo}>
        <Icon d={PATH.undo} />
      </button>
      <button className="btn quiet icon" title="Redo (Ctrl Y)"
              disabled={!ed.canRedo} onClick={ed.redo}>
        <Icon d={PATH.redo} />
      </button>
      <button className="btn primary" onClick={cmd.exportVideo} disabled={!has || busy}>
        <Icon d={PATH.export} /> Export
      </button>
    </div>
  );
}
