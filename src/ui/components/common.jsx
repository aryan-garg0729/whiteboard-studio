import React, { useEffect, useRef, useState } from 'react';

export function Group({ title, right, children }) {
  return (
    <section className="group">
      <h4>{title}{right ? <span className="spacer">{right}</span> : null}</h4>
      <div className="fields">{children}</div>
    </section>
  );
}

export function Field({ label, stack, children }) {
  return (
    <div className={stack ? 'field stack' : 'field'}>
      <label>{label}</label>
      {children}
    </div>
  );
}

/**
 * Numeric input that commits on blur/Enter rather than on every keystroke.
 *
 * Committing per keystroke makes "1.5" unreachable -- the intermediate "1."
 * parses to 1 and the field rewrites itself under the caret. Local text state
 * plus a commit boundary is the only way to keep typing usable.
 */
export function Num({ value, onChange, step = 1, min, max, suffix }) {
  const [text, setText] = useState(String(value));
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setText(String(value));
  }, [value]);

  const commit = () => {
    const n = Number.parseFloat(text);
    if (!Number.isFinite(n)) { setText(String(value)); return; }
    const clamped = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));
    setText(String(clamped));
    if (clamped !== value) onChange(clamped);
  };

  return (
    <input
      type="number"
      value={text}
      step={step}
      min={min}
      max={max}
      title={suffix}
      onFocus={() => { focused.current = true; }}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => { focused.current = false; commit(); }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') { setText(String(value)); e.currentTarget.blur(); }
        e.stopPropagation();   // keep Space/arrows out of the transport shortcuts
      }}
    />
  );
}

/** Marks a control that is wired to nothing yet, so the gap is honest. */
export const Soon = () => <span className="pill soon">Soon</span>;

export function Icon({ d, size = 13 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth="2" strokeLinecap="round"
         strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

export const PATH = {
  play: 'M6 4l14 8-14 8z',
  pause: 'M8 5v14M16 5v14',
  start: 'M18 5v14L7 12zM5 5v14',
  end: 'M6 5v14l11-7zM19 5v14',
  plus: 'M12 5v14M5 12h14',
  trash: 'M4 7h16M9 7V5h6v2M7 7l1 13h8l1-13',
  image: 'M3 5h18v14H3zM3 15l5-5 4 4 3-3 6 6',
  type: 'M5 6h14M12 6v12M9 18h6',
  audio: 'M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4',
  speaker: 'M4 9h4l5-4v14l-5-4H4zM17 9a4 4 0 010 6',
  speakerOff: 'M4 9h4l5-4v14l-5-4H4zM17 9l4 6M21 9l-4 6',
  hand: 'M8 12V5a1.5 1.5 0 013 0v6M11 11V4a1.5 1.5 0 013 0v7M14 11V6a1.5 1.5 0 013 0v8'
      + 'M8 12l-2 2 3 6h7l3-7v-3',
  eraser: 'M5 15l7-7 6 6-4 4H8zM4 20h16',
  export: 'M12 3v12M8 11l4 4 4-4M4 19h16',
  undo: 'M9 7L4 12l5 5M4 12h11a5 5 0 010 10h-3',
  redo: 'M15 7l5 5-5 5M20 12H9a5 5 0 000 10h3',
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  page: 'M6 3h9l4 4v14H6zM15 3v4h4',
  close: 'M6 6l12 12M18 6L6 18',
};
