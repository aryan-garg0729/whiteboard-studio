/**
 * Full-feature demo: an image is drawn and coloured in, a caption is
 * handwritten beneath it, then both are erased.
 *
 *   node scripts/demo-reel.js [--image path.png] [--text "Caption"]
 *                             [--out demo.mp4] [--audio track.mp3]
 *                             [--frames-only] [--no-hand]
 *
 * Exercises every finished subsystem at once: the Python vectorizer, the
 * outline-then-scribble animation, glyph skeletonisation, the hand rig, the
 * erase modifier, multi-clip timeline scheduling, and MP4 export.
 */

import { createCanvas, loadImage } from '@napi-rs/canvas';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import opentype from 'opentype.js';

import { setSurfaceFactory } from '../src/engine/render/surfaces.js';
import { createSession, renderFrame } from '../src/engine/render/renderFrame.js';
import { Sidecar, toAsset } from '../src/engine/sidecar/client.js';
import { layoutText } from '../src/engine/compile/text.js';
import { compileErase } from '../src/engine/anim/erase.js';
import { exportVideo } from '../src/engine/export/driver.js';
import outlineFill from '../src/engine/anim/outlineFill.js';
import handwrite from '../src/engine/anim/handwrite.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

setSurfaceFactory((w, h) => {
  const canvas = createCanvas(w, h);
  return { canvas, ctx: canvas.getContext('2d') };
});

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };
const flag = (n) => argv.includes(n);

const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 30;

const IMAGE = resolve(arg('--image', join(ROOT, 'assets/demo/lineart.png')));
const TEXT = arg('--text', 'Fresh coffee');
const FONT = arg('--font', join(ROOT, 'assets/fonts/Caveat.ttf'));
const HAND = arg('--hand', 'hand1');
const SHOW_HAND = !flag('--no-hand');
const FRAMES_ONLY = flag('--frames-only');
const AUDIO = arg('--audio', null);
const OUT = resolve(ROOT, arg('--out', 'demo.mp4'));

// --- timeline -------------------------------------------------------------
const T = {
  imageStart: 0.2, imageDur: 4.2,
  textStart: 4.8, textDur: 3.4,
  eraseStart: 8.8, eraseDur: 2.4,
  tail: 0.7,
};
const TOTAL = T.eraseStart + T.eraseDur + T.tail;

async function main() {
  const sidecar = new Sidecar({ root: ROOT, cacheDir: join(ROOT, '.cache') });

  // --- image ---
  console.log(`tracing ${IMAGE}`);
  const traced = await sidecar.vectorize(IMAGE, {});
  console.log(`  mode=${traced.mode}  regions=${traced.regions.length}`
            + `  contours=${traced.subpaths.length}`);
  const imgAsset = toAsset('img', traced);

  // --- text ---
  const fontBuf = readFileSync(FONT);
  const font = opentype.parse(fontBuf.buffer.slice(
    fontBuf.byteOffset, fontBuf.byteOffset + fontBuf.byteLength));
  const FONT_SIZE = 120;
  const layout = await layoutText(font, TEXT, {
    fontSize: FONT_SIZE,
    penWidth: 5,
    getSkeleton: (commands, key) => sidecar.skeletonizeGlyph(commands, {
      key, unitsPerEm: font.unitsPerEm, size: 256, supersample: 2,
    }),
  });
  console.log(`caption "${TEXT}": ${layout.strokes.filter((s) => !s.lift).length} strokes`);
  sidecar.stop();

  // --- layout on the page ---
  // Image sits in the upper half, caption centred beneath it.
  const aw = traced.width;
  const ah = traced.height;
  const fit = Math.min((WIDTH * 0.42) / aw, (HEIGHT * 0.52) / ah);
  const imgW = aw * fit;
  const imgH = ah * fit;
  const imgY = -HEIGHT * 0.30;

  const project = {
    meta: { fps: FPS, width: WIDTH, height: HEIGHT, background: '#fdfdfb' },
    pages: [{ id: 'p1', cameraKeyframes: [{ t: 0, x: 0, y: 0, zoom: 1 }] }],
    clips: [
      {
        id: 'img', assetId: 'img', animId: 'draw.outlineFill',
        start: T.imageStart, duration: T.imageDur,
        erase: { start: T.eraseStart, duration: T.eraseDur },
        transform: { x: -imgW / 2, y: imgY, scale: fit, rotation: 0 },
      },
      {
        id: 'txt', assetId: 'text', animId: 'draw.handwrite',
        start: T.textStart, duration: T.textDur,
        // Slightly later and quicker, so the two erases read as one sweep
        // travelling down the page rather than as two separate events.
        erase: { start: T.eraseStart + 0.5, duration: T.eraseDur - 0.5 },
        transform: {
          x: -layout.width / 2,
          y: imgY + imgH + HEIGHT * 0.16,
          scale: 1, rotation: 0,
        },
      },
    ],
  };

  // --- session ---
  const handStyle = JSON.parse(readFileSync(join(ROOT, `assets/hands/${HAND}.json`), 'utf8'));
  const images = new Map();
  for (const src of handStyle.sources) images.set(src.file, await loadImage(join(ROOT, src.file)));

  const session = createSession({
    hands: new Map([[handStyle.id, handStyle]]),
    resolveImage: (src) => images.get(src.file),
  });

  const imgPlan = await outlineFill.compile(imgAsset, {
    brushWidth: Math.max(1.5, 2.4 / fit),
    fillBrushWidth: Math.max(8, 15 / fit),
  });
  const txtPlan = await handwrite.compile({ layout });
  session.plans.set('img', imgPlan);
  session.plans.set('txt', txtPlan);
  session.erasePlans.set('img', compileErase(imgPlan, { id: 'img' }));
  session.erasePlans.set('txt', compileErase(txtPlan, { id: 'txt' }));

  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');

  const frames = Math.round(TOTAL * FPS);

  // Warm up so surfaces exist, then install the source image as the artwork
  // the scribble reveals. This must run at the LAST frame, not frame 0: clips
  // that have not started yet are skipped entirely, so warming at t=0 would
  // leave every delayed clip without surfaces.
  renderFrame(session, project, frames - 1, ctx,
    { width: WIDTH, height: HEIGHT, showHand: false });
  session.surfaces.get('img').ensureArt().ctx
    .drawImage(await loadImage(IMAGE), 0, 0, aw, ah);
  session.surfaces.forEach((s) => s.resetAll());
  const draw = (n) => renderFrame(session, project, n, ctx, {
    width: WIDTH, height: HEIGHT, showHand: SHOW_HAND, handStyleId: handStyle.id,
  });

  if (FRAMES_ONLY) {
    const dir = join(ROOT, '.preview');
    mkdirSync(dir, { recursive: true });
    for (let n = 0; n < frames; n++) {
      draw(n);
      writeFileSync(join(dir, `frame_${String(n).padStart(4, '0')}.png`),
        canvas.toBuffer('image/png'));
    }
    console.log(`wrote ${frames} frames to ${dir}`);
    return;
  }

  const t0 = Date.now();
  await exportVideo({
    frames, width: WIDTH, height: HEIGHT, fps: FPS, out: OUT,
    audio: AUDIO ? [{ file: resolve(AUDIO), start: 0, gain: 1, duration: TOTAL }] : [],
    renderFrameRGBA(n) { draw(n); return ctx.getImageData(0, 0, WIDTH, HEIGHT).data; },
    onProgress: ({ frame, total }) => process.stdout.write(`\rencoding ${frame}/${total}`),
  });
  const secs = (Date.now() - t0) / 1000;
  console.log(`\nwrote ${OUT} — ${frames} frames / ${TOTAL.toFixed(1)}s `
            + `in ${secs.toFixed(1)}s (${(frames / secs).toFixed(1)} fps)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
