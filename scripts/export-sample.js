/**
 * Export the sample project to a real 1080p MP4.
 *
 *   node scripts/export-sample.js [--out out.mp4] [--seconds 4] [--audio track.mp3]
 */

import { createCanvas, loadImage } from '@napi-rs/canvas';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { setSurfaceFactory } from '../src/engine/render/surfaces.js';
import { createSession, renderFrame } from '../src/engine/render/renderFrame.js';
import { flattenPath } from '../src/engine/compile/svgPath.js';
import { exportVideo } from '../src/engine/export/driver.js';
import stencilPaint from '../src/engine/anim/stencilPaint.js';
import { vectorPixels } from '../src/engine/render/rasterize.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

setSurfaceFactory((w, h) => {
  const canvas = createCanvas(w, h);
  return { canvas, ctx: canvas.getContext('2d') };
});

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };

const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 30;
const SECONDS = Number(arg('--seconds', 4));
const OUT = resolve(ROOT, arg('--out', 'out.mp4'));
const AUDIO = arg('--audio', null);

const ring = (...xy) => Float64Array.from(xy);

const asset = {
  id: 'house',
  bbox: [140, 200, 660, 720],
  subpaths: flattenPath(
    'M 200 400 L 200 700 L 600 700 L 600 400 Z '
    + 'M 160 410 L 400 220 L 640 410 Z '
    + 'M 330 700 L 330 560 L 450 560 L 450 700 Z '
    + 'M 480 470 L 560 470 L 560 550 L 480 550 Z', { eps: 0.2 }),
  regions: [
    { rings: [ring(200, 400, 600, 400, 600, 700, 200, 700),
              ring(330, 560, 450, 560, 450, 700, 330, 700),
              ring(480, 470, 560, 470, 560, 550, 480, 550)],
      bbox: [200, 400, 600, 700], color: '#f0c987' },
    { rings: [ring(160, 410, 400, 220, 640, 410)],
      bbox: [160, 220, 640, 410], color: '#c1553f' },
  ],
};

const project = {
  meta: { fps: FPS, width: WIDTH, height: HEIGHT, background: '#fdfdfb' },
  pages: [{ id: 'p1', cameraKeyframes: [{ t: 0, x: 400, y: 460, zoom: 1.25 }] }],
  clips: [{ id: 'c1', assetId: 'house', animId: 'draw.stencilPaint',
            start: 0, duration: SECONDS, transform: { x: 0, y: 0, scale: 1, rotation: 0 } }],
};

async function main() {
  const handStyle = JSON.parse(readFileSync(join(ROOT, 'assets/hands/hand1.json'), 'utf8'));
  const images = new Map();
  for (const src of handStyle.sources) images.set(src.file, await loadImage(join(ROOT, src.file)));

  const session = createSession({
    hands: new Map([[handStyle.id, handStyle]]),
    resolveImage: (src) => images.get(src.file),
  });
  session.plans.set('c1', await stencilPaint.compile(
    { id: asset.id, image: vectorPixels({ width: 660, height: 720, ...asset }) },
    { fillBrushWidth: 16 }));

  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');

  // warm up so surfaces exist, then paint the artwork the fill reveals
  renderFrame(session, project, 0, ctx, { width: WIDTH, height: HEIGHT, showHand: false });
  const sf = session.surfaces.get('c1');
  const art = sf.ensureArt().ctx;
  for (const region of asset.regions) {
    art.beginPath();
    for (const r of region.rings) {
      art.moveTo(r[0], r[1]);
      for (let i = 2; i < r.length; i += 2) art.lineTo(r[i], r[i + 1]);
      art.closePath();
    }
    art.fillStyle = region.color;
    art.fill('evenodd');
  }
  sf.resetAll();

  const frames = Math.round(SECONDS * FPS);
  const t0 = Date.now();
  await exportVideo({
    frames, width: WIDTH, height: HEIGHT, fps: FPS, out: OUT,
    audio: AUDIO ? [{ file: resolve(AUDIO), start: 0, gain: 1 }] : [],
    renderFrameRGBA(n) {
      renderFrame(session, project, n, ctx, {
        width: WIDTH, height: HEIGHT, showHand: true, handStyleId: handStyle.id,
      });
      return canvas.data();
    },
    onProgress: ({ frame, total }) => {
      process.stdout.write(`\rencoding ${frame}/${total}`);
    },
  });
  const secs = (Date.now() - t0) / 1000;
  console.log(`\nwrote ${OUT} — ${frames} frames in ${secs.toFixed(1)}s `
            + `(${(frames / secs).toFixed(1)} fps)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
