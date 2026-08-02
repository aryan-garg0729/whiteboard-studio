import React, { useEffect, useRef, useState } from 'react';

/**
 * The list of offered faces, each row set in the face it offers.
 *
 * Shared by the Library's Text tab and the Inspector, because "which face" is
 * the same question whether you are about to write a line or fixing one you
 * already wrote -- and a picker that looks different in the two places reads as
 * two different settings.
 *
 * `cssFamily` is attached in App.jsx once the bytes are registered with the
 * FontFace API. A face that failed to load has none and falls back to the UI
 * font: a cosmetic loss, never a missing row.
 */
export function FontList({ fonts, value, onPick }) {
  return (
    <div className="font-list">
      {fonts.map((f) => (
        <button
          key={f.path}
          aria-selected={value === f.path}
          title={f.family}
          style={f.cssFamily ? { fontFamily: `"${f.cssFamily}"` } : undefined}
          onClick={() => onPick(f)}
        >
          <span className="font-name">{f.family}</span>
          {/* Script-like families make the writing guides read most naturally. */}
          {f.hand && <span className="hand-tag">script</span>}
        </button>
      ))}
      {fonts.length === 0 && <div className="lib-hint">No fonts available</div>}
    </div>
  );
}

/**
 * The same list behind a disclosure, for the Inspector.
 *
 * The Inspector describes one clip and is read top to bottom; nine permanently
 * open rows would push everything below the fold to change a setting that is
 * usually chosen once. Closed, the button doubles as the readout -- and it is
 * set in the clip's own face, so the current choice is legible without opening
 * anything.
 */
export default function FontPicker({ fonts, value, onPick }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const menuRef = useRef(null);
  // A clip with no `font` of its own is written in the first bundled face --
  // `prepare.js` and the manifest agree on which -- so naming it beats showing
  // "Default", which tells the user nothing about what they are looking at.
  const inherited = !value && fonts.length > 0;
  const current = fonts.find((f) => f.path === value) ?? (inherited ? fonts[0] : null);

  // Opening near the foot of the Inspector puts the list past the panel's
  // scroll edge, where it is clipped rather than merely off screen. Bring it
  // into view, and start the list on the current face rather than wherever it
  // last sat.
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' });
    menuRef.current?.scrollIntoView({ block: 'nearest' });
  }, [open]);

  // Click-away, because this overlays the fields below it. (Selecting another
  // clip does not need handling here: the Inspector keys this on the asset, so
  // a picker left open closes by remounting.)
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    // `capture`, so a click that its target stops propagating still closes it.
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [open]);

  return (
    <div className={open ? 'font-pick open' : 'font-pick'} ref={ref}>
      <button
        className="font-pick-head"
        aria-expanded={open}
        title={current ? `${current.family} — click to change` : value}
        style={current?.cssFamily ? { fontFamily: `"${current.cssFamily}"` } : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="font-name">
          {current?.family || value?.split('/').pop()}
        </span>
        {/* The face is the app's, not this clip's: it follows the default if
            that ever changes, and saying so beats looking like a choice. */}
        {inherited && <span className="hand-tag">default</span>}
        <span className="caret" aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className="font-pick-menu" ref={menuRef}>
          <FontList
            fonts={fonts}
            value={value}
            onPick={(f) => { onPick(f); setOpen(false); }}
          />
        </div>
      )}
    </div>
  );
}
