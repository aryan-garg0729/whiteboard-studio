/**
 * WB_SMOKE_SCRIPT: the stage handles squeeze, mirror and rotate a clip.
 *
 * The geometry is unit-tested in test/stage.test.js; what cannot be tested
 * there is the wiring -- that eight resize handles and a rotate handle are
 * actually mounted, that each drags the field it claims to, and that shift
 * reaches the gesture. Every assertion is against the document rather than a
 * screenshot, because a headless compositor can hand back a stale frame and
 * make a broken build look like a passing test.
 *
 *   WB_SMOKE=/tmp/handles.png \
 *   WB_SMOKE_PROJECT=svg.project.json \
 *   WB_SMOKE_SCRIPT=scripts/smoke/transform-handles.js \
 *   xvfb-run -a npx electron .
 */

const fail = (msg) => { throw new Error(msg); };
const near = (got, want, what, eps = 0.05) => {
  if (!(Math.abs(got - want) <= eps)) fail(`${what}: expected ~${want}, got ${got}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const state = () => window.__studioState();
const clip = (id) => state().clips.find((c) => c.id === id);

// ── select the clip, so the handles mount ─────────────────────────────

const overlay = document.querySelector('.stage-overlay');
if (!overlay) fail('no stage overlay');

const first = state().clips[0];
if (!first) fail('the project has no clips');

const box = overlay.getBoundingClientRect();
const at = (p) => ({ clientX: box.left + p.x, clientY: box.top + p.y });

/** Screen centre of a handle, from its own laid-out position. */
const handleAt = (name) => {
  const el = document.querySelector(`.stage-handle.${name}`);
  if (!el) fail(`no ${name} handle`);
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2 - box.left, y: r.top + r.height / 2 - box.top };
};

/** Press on a handle, move to a point, release. Shift is held throughout. */
async function drag(name, to, { shift = false } = {}) {
  const el = document.querySelector(`.stage-handle.${name}`);
  const from = handleAt(name);
  const opts = { bubbles: true, pointerId: 7, shiftKey: shift };
  el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, ...at(from) }));
  // Two moves: the first is the gesture proper, the second proves a coalesced
  // repaint mid-drag does not knock the maths off its own base.
  window.dispatchEvent(new PointerEvent('pointermove', {
    ...opts, ...at({ x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }),
  }));
  window.dispatchEvent(new PointerEvent('pointermove', { ...opts, ...at(to) }));
  window.dispatchEvent(new PointerEvent('pointerup', { ...opts, ...at(to) }));
  await sleep(120);
}

// Click the middle of the clip's own outline to select it.
const outline = document.querySelector('.stage-box');
if (!outline) fail('no clip outline on the stage');
const ob = outline.getBoundingClientRect();
overlay.dispatchEvent(new PointerEvent('pointerdown', {
  bubbles: true, pointerId: 3,
  clientX: ob.left + ob.width / 2, clientY: ob.top + ob.height / 2,
}));
window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 3 }));
await sleep(120);

if (state().selection?.id !== first.id) {
  fail(`clicking the artwork did not select it (${JSON.stringify(state().selection)})`);
}

// ── every handle is mounted ───────────────────────────────────────────

for (const h of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w', 'rot']) handleAt(h);

// ── an edge handle squeezes one axis only ─────────────────────────────

const before = clip(first.id);
const east = handleAt('e');
const west = handleAt('w');
// Halfway back towards the west anchor: half the width, same height.
await drag('e', { x: (east.x + west.x) / 2, y: east.y });

let now = clip(first.id);
near(now.scaleX, (before.scaleX ?? 1) / 2, 'scaleX after squeezing the east edge');
near(now.scaleY, before.scaleY ?? 1, 'scaleY must not move when the east edge does');
near(now.scale, before.scale, 'the overall scale is not what an edge handle sets');

// ── past the anchor is a mirror, not a collapse ───────────────────────

const w2 = handleAt('w');
await drag('e', { x: w2.x - (east.x - west.x) / 2, y: east.y });
now = clip(first.id);
if (!(now.scaleX < 0)) fail(`dragging past the far edge must mirror, got scaleX ${now.scaleX}`);

// ── a corner locks the aspect; shift frees it ─────────────────────────

const locked = clip(first.id);
const se = handleAt('se');
await drag('se', { x: se.x + 60, y: se.y + 60 });
now = clip(first.id);
near(now.scaleX / now.scaleY, locked.scaleX / locked.scaleY,
  'a plain corner drag must not change the aspect', 1e-6);
if (now.scale === locked.scale) fail('a corner drag must change the overall scale');

const free0 = clip(first.id);
const se2 = handleAt('se');
await drag('se', { x: se2.x + 120, y: se2.y }, { shift: true });
now = clip(first.id);
if (Math.abs(now.scaleX / now.scaleY - free0.scaleX / free0.scaleY) < 1e-6) {
  fail('shift on a corner must stretch one axis without the other');
}

// ── the rotate handle turns the clip ──────────────────────────────────

const spun0 = clip(first.id);
const rot = handleAt('rot');
// Swing the handle a quarter turn clockwise about the clip's centre.
const c = { x: (ob.left + ob.width / 2) - box.left, y: (ob.top + ob.height / 2) - box.top };
const radius = Math.hypot(rot.x - c.x, rot.y - c.y);
await drag('rot', { x: c.x + radius, y: c.y });
now = clip(first.id);
if (Math.abs(now.rotation - (spun0.rotation ?? 0)) < 1) {
  fail(`the rotate handle did not turn the clip (${now.rotation})`);
}

// Shift snaps, so a scruffy angle must land on a multiple of fifteen.
const off = 9 * (Math.PI / 180);
await drag('rot', {
  x: c.x + Math.cos(-Math.PI / 2 + off) * radius,
  y: c.y + Math.sin(-Math.PI / 2 + off) * radius,
}, { shift: true });
now = clip(first.id);
if (Math.abs(now.rotation % 15) > 1e-6) {
  fail(`shift must snap the rotation to 15 degrees, got ${now.rotation}`);
}

// Undo is deliberately not exercised here: Ctrl+Z belongs to the Electron
// application menu, so a synthetic key event in the renderer never reaches it.
// What this file can check about the gesture -- that a coalesced repaint
// part-way through does not knock the maths off its own base -- is covered by
// the two-move drag above.

return `handles squeeze, mirror, rotate and snap; final transform `
  + JSON.stringify(clip(first.id));
