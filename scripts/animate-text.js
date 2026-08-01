/**
 * Handwriting pipeline end to end: string + font -> centreline strokes -> MP4.
 *
 *   node scripts/animate-text.js "Hello world" [--font path.ttf] [--size 150]
 *                                [--seconds 6] [--frames-only] [--no-hand]
 */

import { createCanvas, loadImage } from '@napi-rs/canvas';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import opentype from 'opentype.js';

import { setSurfaceFactory } from '../src/engine/render/surfaces.js';
import { createSession, renderFrame } from '../src/engine/render/renderFrame.js';
import { Sidecar } from '../src/engine/sidecar/client.js';
import { layoutText } from '../src/engine/compile/text.js';
import { exportVideo } from '../src/engine/export/driver.js';
import { compileErase } from '../src/engine/anim/erase.js';
import handwrite from '../src/engine/anim/handwrite.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

setSurfaceFactory((w, h) => {
  const canvas = createCanvas(w, h);
  return { canvas, ctx: canvas.getContext('2d') };
});

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };
const flag = (n) => argv.includes(n);

const TEXT = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'Hello';
const FONT = arg('--font', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf');
const SIZE = Number(arg('--size', 150));
const SECONDS = Number(arg('--seconds', 6));
const OUT = resolve(ROOT, arg('--out', 'text.mp4'));
const SHOW_HAND = !flag('--no-hand');
const FRAMES_ONLY = flag('--frames-only');
const ERASE = Number(arg('--erase', 0));

const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 30;

async function main() {
  // loadSync is deprecated in opentype.js 1.x and silently returns undefined;
  // parse(ArrayBuffer) is the supported path.
  const fontBuf = readFileSync(FONT);
  const font = opentype.parse(fontBuf.buffer.slice(
    fontBuf.byteOffset, fontBuf.byteOffset + fontBuf.byteLength));
  const sidecar = new Sidecar({ root: ROOT, cacheDir: join(ROOT, '.cache') });

  console.log(`writing "${TEXT}" in ${font.names.fullName?.en || FONT}`);
  const t0 = Date.now();
  const layout = await layoutText(font, TEXT, {
    fontSize: SIZE,
    penWidth: Math.max(2, SIZE * 0.05),
    getSkeleton: (commands, key) => sidecar.skeletonizeGlyph(commands, {
      key, unitsPerEm: font.unitsPerEm, size: 256, supersample: 2,
    }),
  });
  sidecar.stop();

  const drawn = layout.strokes.filter((s) => !s.lift).length;
  console.log(`  ${layout.strokes.length} strokes (${drawn} drawn, `
            + `${layout.strokes.length - drawn} pen-lifts) in `
            + `${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (!layout.monoline) {
    console.log('  note: this face is modulated (serif/high-contrast); '
              + 'centrelines will read as traced type rather than handwriting');
  }
  if (!drawn) throw new Error('no strokes produced');

  const project = {
    meta: { fps: FPS, width: WIDTH, height: HEIGHT, background: '#fdfdfb' },
    pages: [{ id: 'p1', cameraKeyframes: [{ t: 0, x: 0, y: 0, zoom: 1 }] }],
    clips: [{
      id: 't1', assetId: 'text', animId: 'draw.handwrite',
      start: 0, duration: SECONDS,
      ...(ERASE ? { erase: { start: SECONDS + 0.4, duration: ERASE } } : {}),
      transform: { x: -layout.width / 2, y: layout.height / 2, scale: 1, rotation: 0 },
    }],
  };

  const handStyle = JSON.parse(readFileSync(join(ROOT, 'assets/hands/hand1.json'), 'utf8'));
  const images = new Map();
  for (const src of handStyle.sources) images.set(src.file, await loadImage(join(ROOT, src.file)));

  const session = createSession({
    hands: new Map([[handStyle.id, handStyle]]),
    resolveImage: (src) => images.get(src.file),
  });
  const textPlan = await handwrite.compile({ layout });
  session.plans.set('t1', textPlan);
  if (ERASE) session.erasePlans.set('t1', compileErase(textPlan, { id: 't1' }));

  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');
  const frames = Math.round((SECONDS + (ERASE ? ERASE + 0.6 : 0)) * FPS);
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

  await exportVideo({
    frames, width: WIDTH, height: HEIGHT, fps: FPS, out: OUT,
    renderFrameRGBA(n) { draw(n); return ctx.getImageData(0, 0, WIDTH, HEIGHT).data; },
    onProgress: ({ frame, total }) => process.stdout.write(`\rencoding ${frame}/${total}`),
  });
  console.log(`\nwrote ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
