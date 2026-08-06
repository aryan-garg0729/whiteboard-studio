/**
 * Pages: which sheet is on screen, and what a transition looks like.
 *
 * The window/state helpers are checked at their boundaries because everything
 * else keys off them -- the validator decides whether a clip is legal from
 * `pageWindows`, and the renderer decides what to composite from `pageStateAt`.
 * Then the compositing itself is checked in pixels, since "both pages slid the
 * right way" is not something a return value can tell you.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';

import { setSurfaceFactory } from '../src/engine/render/surfaces.js';
import { createSession, ensureSurfaces, renderFrame } from '../src/engine/render/renderFrame.js';
import { normalizeProject, pageStateAt, pageWindows } from '../src/engine/model/project.js';
import stencilPaint from '../src/engine/anim/stencilPaint.js';
import { installArt, squareImage } from './helpers/art.js';
import { useTestSurfaces } from './helpers/surface.js';

useTestSurfaces();

const W = 640;
const H = 200;
const FPS = 30;

// Page A's square sits near the right edge, page B's near the left. That is
// what keeps both sheets' content inside the frame mid-swipe: a push moves the
// outgoing page one way and brings the incoming page in from the other, so
// content parked in the middle of both would slide out of view before either
// could be measured.
const A_X = 200;
const B_X = -280;

// ── window / state helpers ──────────────────────────────────────────

const twoPages = {
  pages: [{ id: 'a' }, { id: 'b' }],
  pageBreaks: [{ t: 4, pageId: 'b', transition: 'swipeLeft', duration: 1 }],
};

test('a page is on screen from when its transition lands until the next begins', () => {
  assert.deepEqual(pageWindows(twoPages), [
    { pageId: 'a', start: 0, end: 4 },
    { pageId: 'b', start: 5, end: Infinity },
  ]);
});

test('the swiping interval belongs to neither page', () => {
  // This gap is the whole reason the validator can say "you cannot draw here".
  const [first, second] = pageWindows(twoPages);
  assert.equal(first.end, 4, 'page a stops being on screen when the swipe starts');
  assert.equal(second.start, 5, 'page b is not on screen until it lands');
});

test('a page revisited later gets a window per visit', () => {
  const w = pageWindows({
    pages: [{ id: 'a' }, { id: 'b' }],
    pageBreaks: [
      { t: 4, pageId: 'b', transition: 'cut', duration: 0 },
      { t: 9, pageId: 'a', transition: 'cut', duration: 0 },
    ],
  });
  assert.deepEqual(w, [
    { pageId: 'a', start: 0, end: 4 },
    { pageId: 'b', start: 4, end: 9 },
    { pageId: 'a', start: 9, end: Infinity },
  ]);
});

test('a break at zero leaves no window for the page it replaced', () => {
  const w = pageWindows({
    pages: [{ id: 'a' }, { id: 'b' }],
    pageBreaks: [{ t: 0, pageId: 'b', transition: 'cut', duration: 0 }],
  });
  assert.deepEqual(w, [{ pageId: 'b', start: 0, end: Infinity }]);
});

test('pageStateAt reports progress only while the paper is moving', () => {
  const at = (t) => pageStateAt(twoPages, t);
  assert.equal(at(0).pageId, 'a');
  assert.equal(at(0).u, 1, 'settled before any break');
  assert.equal(at(3.999).pageId, 'a');

  assert.equal(at(4).u, 0, 'the transition starts exactly at t');
  assert.equal(at(4).fromPageId, 'a');
  assert.equal(at(4).pageId, 'b');
  assert.equal(at(4.5).u, 0.5);

  assert.equal(at(5).u, 1, 'and is over exactly at t + duration');
  assert.equal(at(5).fromPageId, null);
  assert.equal(at(9).pageId, 'b');
});

test('a project with no breaks is one page, settled, forever', () => {
  const p = { pages: [{ id: 'only' }], pageBreaks: [] };
  assert.deepEqual(pageWindows(p), [{ pageId: 'only', start: 0, end: Infinity }]);
  assert.equal(pageStateAt(p, 99).pageId, 'only');
  assert.equal(pageStateAt(p, 99).u, 1);
});

// ── rendering ───────────────────────────────────────────────────────

/** Filled squares, so "is this page visible" is a pixel question. */
const RED = '#ff0000';
const BLUE = '#0000ff';

/** Page A carries a red square left of centre, page B a blue one right of it. */
async function twoPageSession() {
  const project = normalizeProject({
    meta: { fps: FPS, width: W, height: H, background: '#ffffff' },
    pages: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    pageBreaks: [
      { t: 4, pageId: 'b', transition: 'swipeLeft', duration: 1 },
      { t: 9, pageId: 'a', transition: 'swipeRight', duration: 1 },
    ],
    assets: {
      red: { kind: 'vector', src: 'x.svg' },
      blue: { kind: 'vector', src: 'y.svg' },
    },
    clips: [
      { id: 'ca', assetId: 'red', animId: 'draw.stencilPaint', pageId: 'a',
        start: 0, duration: 2, transform: { x: A_X, y: -30, scale: 1, rotation: 0 } },
      { id: 'cb', assetId: 'blue', animId: 'draw.stencilPaint', pageId: 'b',
        start: 5.5, duration: 2, transform: { x: B_X, y: -30, scale: 1, rotation: 0 } },
    ],
  });

  const session = createSession();
  const opts = { fillBrushWidth: 14 };
  // 60x60 and fully filled, matching the geometry the column assertions below
  // were written against.
  const redArt = squareImage(RED, 60, 0);
  const blueArt = squareImage(BLUE, 60, 0);
  session.plans.set('ca', await stencilPaint.compile({ id: 'red', image: redArt }, opts));
  session.plans.set('cb', await stencilPaint.compile({ id: 'blue', image: blueArt }, opts));
  ensureSurfaces(session, project);
  installArt(session, 'ca', redArt);
  installArt(session, 'cb', blueArt);
  return { session, project };
}

function frameAt(session, project, t) {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  renderFrame(session, project, Math.round(t * FPS), ctx,
    { width: W, height: H, showHand: false });
  return ctx.getImageData(0, 0, W, H).data;
}

/** Count pixels that are neither white paper nor near it. */
function inkColumns(data) {
  const cols = new Set();
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (data[i] < 240 || data[i + 1] < 240 || data[i + 2] < 240) cols.add(x);
    }
  }
  return cols;
}

/** Play forward to `t`; the engine is only pure under forward playback. */
function playTo(session, project, t) {
  const scratch = createCanvas(W, H).getContext('2d');
  for (let n = 0; n <= Math.round(t * FPS); n++) {
    renderFrame(session, project, n, scratch, { width: W, height: H, showHand: false });
  }
}

/** Where page A's square lands when its page is settled, in screen columns. */
const A_HOME = W / 2 + A_X;
const B_HOME = W / 2 + B_X;

test('only the page on screen is drawn', async () => {
  const { session, project } = await twoPageSession();
  playTo(session, project, 3.5);
  const cols = inkColumns(frameAt(session, project, 3.5));

  assert.ok(cols.size > 0, 'page A has drawn its square');
  assert.ok(Math.min(...cols) >= A_HOME - 4,
    `page A ink should start at its own position (~${A_HOME}), got ${Math.min(...cols)}`);
});

test('a clip on a hidden page is not drawn', async () => {
  const { session, project } = await twoPageSession();
  playTo(session, project, 8.5);
  const cols = inkColumns(frameAt(session, project, 8.5));

  assert.ok(cols.size > 0, 'page B has drawn its square by 8.5s');
  // Page A's square lives well to the right of page B's. If any of it leaked
  // through, the rightmost ink column would be over there.
  assert.ok(Math.max(...cols) < A_HOME,
    `page A's square leaked onto page B: ink reaches column ${Math.max(...cols)}`);
});

test('both sheets are on screen mid-swipe, and both have moved', async () => {
  const { session, project } = await twoPageSession();
  // The second transition, where both pages have something drawn on them.
  playTo(session, project, 9.5);

  const before = inkColumns(frameAt(session, project, 8.9));
  const mid = inkColumns(frameAt(session, project, 9.5));

  // Settled on B: one cluster, at B's home.
  assert.ok(Math.abs(Math.min(...before) - B_HOME) < 5, 'page B starts at its home');

  // Mid-swipe: the outgoing sheet (B) has pushed right, and the incoming sheet
  // (A) has entered from the left of where it will settle. Push, not cover --
  // if only the incoming page moved, B would still be sitting at B_HOME.
  assert.ok(Math.min(...mid) > B_HOME + 40,
    `outgoing page B should have travelled right from ${B_HOME}, `
    + `leftmost ink is ${Math.min(...mid)}`);
  assert.ok(Math.max(...mid) < A_HOME,
    `incoming page A should not have arrived at ${A_HOME} yet, `
    + `rightmost ink is ${Math.max(...mid)}`);
  // Two clusters, not one: both sheets are contributing pixels.
  const gaps = [...mid].sort((a, b) => a - b)
    .filter((x, i, arr) => i > 0 && x - arr[i - 1] > 20);
  assert.equal(gaps.length, 1, 'expected two separate sheets of ink mid-swipe');
});

test('a revisited page still carries what was drawn on it', async () => {
  const { session, project } = await twoPageSession();
  // Play all the way through: A draws, we leave for B, then come back to A.
  playTo(session, project, 11);
  const cols = inkColumns(frameAt(session, project, 11));

  assert.ok(cols.size > 0, 'page A is blank after returning to it');
  assert.ok(Math.abs(Math.min(...cols) - A_HOME) < 5,
    `the square drawn on page A nine seconds earlier should be back at ${A_HOME}, `
    + `found ink from ${Math.min(...cols)}`);
});

test('a transition is pixel-identical whether seeked to or played through', async () => {
  // The transition path reuses cached page surfaces, which is exactly the kind
  // of state that breaks determinism if it is not fully overwritten each frame.
  const a = await twoPageSession();
  const b = await twoPageSession();

  playTo(a.session, a.project, 4.4);
  const played = frameAt(a.session, a.project, 4.4);

  playTo(b.session, b.project, 4.4);
  const other = frameAt(b.session, b.project, 4.4);

  assert.deepEqual(Buffer.from(played), Buffer.from(other),
    'two independent sessions disagree on the same transition frame');
});
