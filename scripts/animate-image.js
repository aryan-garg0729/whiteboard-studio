/**
 * The real import pipeline, end to end: raster image -> paint pass -> 1080p MP4.
 *
 *   node scripts/animate-image.js <image> [--out o.mp4] [--seconds 6]
 *                                 [--anim inkPaint|stencilPaint]
 *                                 [--mode zigzag|colorGroups] [--colors 8]
 *                                 [--sweep-from topLeft|topRight|bottomLeft|bottomRight]
 *                                 [--sweep-angle -45]
 *                                 [--group-order largestFirst|darkFirst|readingOrder]
 *                                 [--tolerance 14] [--ink-luma 0.25]
 *                                 [--outline-share 0.45]
 *                                 [--hand hand1|hand2|hand4] [--no-hand]
 *                                 [--frames-only]
 *
 * The mask reveals the ORIGINAL pixels, and every pixel is owned by some group,
 * so the last frame is the source image exactly -- gradients, texture and all.
 * No Python, no tracing.
 */

import { createCanvas, loadImage } from '@napi-rs/canvas';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { setSurfaceFactory } from '../src/engine/render/surfaces.js';
import { createSession, renderFrame } from '../src/engine/render/renderFrame.js';
import { exportVideo } from '../src/engine/export/driver.js';
import { compileErase } from '../src/engine/anim/erase.js';
import { getAnimation } from '../src/engine/anim/registry.js';
import { imagePixels } from '../src/engine/render/rasterize.js';
// Imported for their registration side effect; `getAnimation` only knows what
// has been registered.
import stencilPaint from '../src/engine/anim/stencilPaint.js';
import '../src/engine/anim/inkPaint.js';
import appear from '../src/engine/anim/appear.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

setSurfaceFactory((w, h) => {
  const canvas = createCanvas(w, h);
  return { canvas, ctx: canvas.getContext('2d') };
});

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };
const flag = (n) => argv.includes(n);

const IMAGE = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1]?.startsWith('--') !== true);
if (!IMAGE) {
  console.error('usage: node scripts/animate-image.js <image> [options]');
  process.exit(1);
}

const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 30;
const SECONDS = Number(arg('--seconds', 6));
const HAND = arg('--hand', 'hand1');
const SHOW_HAND = !flag('--no-hand');
const FRAMES_ONLY = flag('--frames-only');
const ERASE = Number(arg('--erase', 0)); // seconds of erase after the draw
// A bare name is one of the pen animations, since that is what this script is
// mostly for; anything with a dot is passed through as a full id, so
// `--anim appear.fade` works too.
const ANIM_ARG = arg('--anim', 'stencilPaint');
const ANIM = ANIM_ARG.includes('.') ? ANIM_ARG : `draw.${ANIM_ARG}`;
const OUT = resolve(ROOT, arg('--out', `${basename(IMAGE).replace(/\.[^.]+$/, '')}.mp4`));

async function main() {
  const params = {};
  if (arg('--mode', null)) params.mode = arg('--mode');
  if (arg('--colors', null)) params.colors = Number(arg('--colors'));
  if (arg('--sweep-from', null)) params.sweepFrom = arg('--sweep-from');
  if (arg('--sweep-angle', null)) params.sweepAngle = Number(arg('--sweep-angle'));
  if (arg('--group-order', null)) params.groupOrder = arg('--group-order');
  // draw.inkPaint's own two.
  if (arg('--tolerance', null)) params.colorTolerance = Number(arg('--tolerance'));
  if (arg('--ink-luma', null)) params.inkLuma = Number(arg('--ink-luma'));
  if (arg('--outline-share', null)) params.outlineShare = Number(arg('--outline-share'));

  console.log(`reading ${IMAGE} ...`);
  const src = await loadImage(resolve(IMAGE));
  const asset = { id: 'img', image: imagePixels(src, src.width, src.height) };

  // Fit the artwork into the frame with a margin.
  const aw = src.width;
  const ah = src.height;
  const fit = Math.min((WIDTH * 0.72) / aw, (HEIGHT * 0.78) / ah);

  const project = {
    meta: { fps: FPS, width: WIDTH, height: HEIGHT, background: '#fdfdfb' },
    pages: [{ id: 'p1', cameraKeyframes: [{ t: 0, x: 0, y: 0, zoom: 1 }] }],
    clips: [{
      id: 'c1', assetId: 'img', animId: ANIM,
      start: 0, duration: SECONDS,
      ...(ERASE ? { erase: { start: SECONDS + 0.4, duration: ERASE } } : {}),
      transform: { x: -(aw * fit) / 2, y: -(ah * fit) / 2, scale: fit, rotation: 0 },
    }],
  };

  const handStyle = JSON.parse(readFileSync(join(ROOT, `assets/hands/${HAND}.json`), 'utf8'));
  const images = new Map();
  for (const src of handStyle.sources) images.set(src.file, await loadImage(join(ROOT, src.file)));

  const session = createSession({
    hands: new Map([[handStyle.id, handStyle]]),
    resolveImage: (src) => images.get(src.file),
  });

  const t0 = Date.now();
  const plan = await getAnimation(ANIM).compile(asset, {
    fillBrushWidth: Math.max(8, 16 / fit),
    ...params,
  });
  session.plans.set('c1', plan);
  if (ERASE) session.erasePlans.set('c1', compileErase(plan, { id: 'c1' }));
  console.log(plan.strokes.length
    ? `plan: ${plan.phases.outline.i1} outline strokes, `
      + `${plan.strokes.length - plan.phases.outline.i1} paint strokes `
      + `(${((Date.now() - t0) / 1000).toFixed(1)}s)`
    : `plan: ${ANIM}, nothing to draw -- the artwork simply arrives`);

  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');

  // Warm up so surfaces exist, then install the SOURCE IMAGE as the artwork the
  // paint pass reveals, at its own resolution and otherwise untouched.
  renderFrame(session, project, 0, ctx, { width: WIDTH, height: HEIGHT, showHand: false });
  const sf = session.surfaces.get('c1');
  sf.ensureArt().ctx.drawImage(src, 0, 0, aw, ah);
  sf.resetAll();

  const frames = Math.round((SECONDS + (ERASE ? ERASE + 0.6 : 0)) * FPS);

  if (FRAMES_ONLY) {
    const dir = join(ROOT, '.preview');
    mkdirSync(dir, { recursive: true });
    for (let n = 0; n < frames; n++) {
      renderFrame(session, project, n, ctx, {
        width: WIDTH, height: HEIGHT, showHand: SHOW_HAND, handStyleId: handStyle.id,
      });
      writeFileSync(join(dir, `frame_${String(n).padStart(4, '0')}.png`),
        canvas.toBuffer('image/png'));
    }
    console.log(`wrote ${frames} frames to ${dir}`);
    return;
  }

  const t1 = Date.now();
  await exportVideo({
    frames, width: WIDTH, height: HEIGHT, fps: FPS, out: OUT,
    renderFrameRGBA(n) {
      renderFrame(session, project, n, ctx, {
        width: WIDTH, height: HEIGHT, showHand: SHOW_HAND, handStyleId: handStyle.id,
      });
      return canvas.data();
    },
    onProgress: ({ frame, total }) => process.stdout.write(`\rencoding ${frame}/${total}`),
  });
  const secs = (Date.now() - t1) / 1000;
  console.log(`\nwrote ${OUT} — ${frames} frames in ${secs.toFixed(1)}s`);
}

main().catch((e) => { console.error(e); process.exit(1); });
