/**
 * WB_SMOKE_SCRIPT: cutting, trimming and gap-closing work through the real UI.
 *
 * Runs in the renderer after WB_SMOKE has opened a project with two items on
 * one audio lane, the second leaving a gap after the first. Drives the actual
 * DOM -- pointer events on grips, a click on a gap, the razor key -- because
 * the document transforms are already unit-tested and what is left to prove is
 * that the timeline is wired to them.
 *
 *   WB_SMOKE=/tmp/audio.png \
 *   WB_SMOKE_PROJECT=<a project with two audio items and a gap> \
 *   WB_SMOKE_SCRIPT=scripts/smoke/audio-editing.js \
 *   xvfb-run -a npx electron .
 */

const fail = (msg) => { throw new Error(msg); };
const eq = (got, want, what) => {
  if (got !== want) fail(`${what}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};
const near = (got, want, what, tol = 0.11) => {
  if (!(Math.abs(got - want) <= tol)) fail(`${what}: expected ~${want}, got ${got}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const state = () => window.__studioState();
const audio = () => state().audio;
const blocks = () => [...document.querySelectorAll('.tl-clip.audio')];
const gaps = () => [...document.querySelectorAll('.tl-gap')];

/** A pointer gesture across `dx` pixels, in the steps a real drag arrives in. */
async function drag(el, dx) {
  const r = el.getBoundingClientRect();
  const y = r.top + r.height / 2;
  const x0 = r.left + r.width / 2;
  el.dispatchEvent(new PointerEvent('pointerdown',
    { clientX: x0, clientY: y, bubbles: true, pointerId: 1 }));
  // Six steps with room between them. A tighter loop occasionally outran a
  // React commit under xvfb and the gesture landed as a no-op.
  for (let i = 1; i <= 6; i++) {
    window.dispatchEvent(new PointerEvent('pointermove',
      { clientX: x0 + (dx * i) / 6, clientY: y, bubbles: true, pointerId: 1 }));
    await sleep(40);
  }
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
  await sleep(120);
}

/** Move the playhead by scrubbing the ruler, the way a user would. */
async function seek(seconds) {
  const ruler = document.querySelector('.tl-ruler');
  if (!ruler) fail('no timeline ruler');
  const scroll = document.querySelector('.tl-scroll');
  const pxPerSec = Number(document.querySelector('.tl-bar input[type="range"]').value);
  const x = ruler.getBoundingClientRect().left + seconds * pxPerSec - (scroll?.scrollLeft || 0);
  const y = ruler.getBoundingClientRect().top + 4;
  ruler.dispatchEvent(new PointerEvent('pointerdown',
    { clientX: x, clientY: y, bubbles: true, pointerId: 2 }));
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 2 }));
  await sleep(60);
}

const key = async (k) => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  await sleep(80);
};

// ── the document arrived with ids and a default speed ──
const s0 = audio();
if (s0.length !== 2) fail(`expected two audio items to start with, got ${s0.length}`);
for (const a of s0) {
  if (!a.id) fail('an audio item reached the renderer without an id');
  eq(a.speed, 1, 'speed defaults to as-recorded');
}
eq(blocks().length, 2, 'both items drew a block');

// ── the gap between them is offered as a click-target ──
eq(gaps().length, 1, 'the silence between the two items is a closable gap');
gaps()[0].click();
await sleep(120);
near(audio()[1].start, 6, 'closing the gap pulled the second item flush');
eq(gaps().length, 0, 'and the gap is gone');

// ── selecting is by id, and the razor cuts at the playhead ──
blocks()[0].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 3 }));
window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 3 }));
await sleep(80);
eq(state().selection?.type, 'audio', 'clicking a block selects it');
eq(state().selection?.id, s0[0].id, 'selection carries the id, not an index');

await seek(2);
await key('s');
const cut = audio();
eq(cut.length, 3, 'S split the selected item in two');
near(cut[0].duration, 2, 'the left half ends at the playhead');
near(cut[1].start, 2, 'the right half begins there');
near(cut[1].trimIn, 2, 'and skips that much of the file');
eq(blocks().length, 3, 'the new half drew its own block');

// ── deleting a half leaves a gap, which closes ──
blocks()[1].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 4 }));
window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 4 }));
await sleep(80);
await key('Delete');
eq(audio().length, 2, 'the middle piece was deleted');
eq(gaps().length, 1, 'which left a gap');
gaps()[0].click();
await sleep(120);
near(audio()[1].start, 2, 'closing it pulled the survivor back');

// ── trimming by the right grip ──
const before = audio()[0].duration;
const grip = blocks()[0].querySelector('.grip.r');
if (!grip) fail('audio blocks have no right grip');
await drag(grip, -40);
const trimmed = audio()[0];
if (!(trimmed.duration < before)) {
  fail(`right grip did not trim: ${before} -> ${trimmed.duration}`);
}
eq(trimmed.start, 0, 'trimming the tail must not move the head');

// ── speed resizes the block and ripples the lane ──
blocks()[0].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 5 }));
window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 5 }));
await sleep(80);
const chip = [...document.querySelectorAll('.insp .chip')].find((c) => c.textContent === '2×');
if (!chip) fail('no 2x speed preset in the audio inspector');
const wasLong = audio()[0].duration;
const followerWas = audio()[1].start;
chip.click();
await sleep(140);
eq(audio()[0].speed, 2, 'the preset set the rate');
near(audio()[0].duration, wasLong / 2,
  'the block halved rather than keeping its length and padding with silence');
near(audio()[1].start, followerWas - wasLong / 2,
  'and the rest of the lane came with it');

// ── the slider is continuous, and detents at 1x ──
const slider = [...document.querySelectorAll('.insp input[type="range"]')]
  .find((el) => el.max === '1' && el.step === '0.005');
if (!slider) fail('no speed slider in the audio inspector');
// Its own scale: position 0..1 maps logarithmically onto 0.25x..4x.
const setSlider = async (pos) => {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, 'value').set;
  setter.call(slider, String(pos));
  slider.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(90);
};
// The scale is logarithmic over 0.25x..4x, so 0.8 is 2^(-2 + 3.2) ≈ 2.3x. Chosen
// precisely because it is not a round number: the complaint that started this
// was that only the presets were reachable.
await setSlider(0.8);
const mid = audio()[0].speed;
near(mid, 2.3, 'the slider reaches rates between the presets', 0.02);
await setSlider(0.5);
eq(audio()[0].speed, 1, 'the midpoint detents to exactly 1x');
near(audio()[0].duration, wasLong, 'and the block is back to its original length');
chip.click();
await sleep(140);

// ── dragging one block onto another cannot overlap it ──
const [first, second] = audio();
await drag(blocks()[1], -600);
const after = audio();
const firstEnd = (after[0].start || 0) + (after[0].duration || 0);
if (after[1].start < firstEnd - 0.001) {
  fail(`dragging left overlapped: ${after[1].start} < ${firstEnd}`);
}
near(after[1].start, firstEnd, 'it stopped flush against its neighbour');

// ── and the document is still one the validator accepts ──
if (document.querySelector('.stage .overlay .title')?.textContent === 'Could not load project') {
  fail('audio editing produced a document the validator rejects');
}

return {
  ok: true,
  items: audio().map((a) => `${a.id}@${a.start}+${a.duration}${a.speed === 1 ? '' : ` ${a.speed}x`}`),
  startedWith: [first, second].map((a) => `${a.id}@${a.start}`),
};
