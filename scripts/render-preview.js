/**
 * Headless render of a sample project to a PNG sequence.
 *
 * This is the Phase 1 exit criterion: outline draws in a sane order, colour
 * scribbles in afterwards, and the hand tracks the nib with the forearm always
 * leaving frame. It is a visual judgement, so the output is meant to be looked
 * at, not asserted on.
 *
 *   node scripts/render-preview.js [--frames 60] [--out .preview] [--no-hand]
 */

import { createCanvas, loadImage } from '@napi-rs/canvas';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { setSurfaceFactory } from '../src/engine/render/surfaces.js';
import { createSession, renderFrame } from '../src/engine/render/renderFrame.js';
import { flattenPath } from '../src/engine/compile/svgPath.js';
import outlineFill from '../src/engine/anim/outlineFill.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The engine never imports a canvas implementation; the host supplies one.
setSurfaceFactory((w, h) => {
  const canvas = createCanvas(w, h);
  return { canvas, ctx: canvas.getContext('2d') };
});

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i === -1 ? dflt : argv[i + 1];
};
const FRAMES = Number(arg('--frames', 60));
const OUT = join(ROOT, arg('--out', '.preview'));
const SHOW_HAND = !argv.includes('--no-hand');
const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 30;

// A simple house: outline contours plus two fillable regions. Stands in for
// vectorizer output until the Python sidecar lands.
const HOUSE_OUTLINE = 'M 200 400 L 200 700 L 600 700 L 600 400 Z '
                    + 'M 160 410 L 400 220 L 640 410 Z '
                    + 'M 330 700 L 330 560 L 450 560 L 450 700 Z '
                    + 'M 480 470 L 560 470 L 560 550 L 480 550 Z';

const ring = (...xy) => Float64Array.from(xy);

const asset = {
  id: 'house',
  bbox: [140, 200, 660, 720],
  subpaths: flattenPath(HOUSE_OUTLINE, { eps: 0.2 }),
  regions: [
    { // wall
      rings: [ring(200, 400, 600, 400, 600, 700, 200, 700),
              ring(330, 560, 450, 560, 450, 700, 330, 700)],
      bbox: [200, 400, 600, 700],
      color: '#f0c987',
    },
    { // roof
      rings: [ring(160, 410, 400, 220, 640, 410)],
      bbox: [160, 220, 640, 410],
      color: '#c1553f',
    },
  ],
};

const project = {
  meta: { fps: FPS, width: WIDTH, height: HEIGHT, background: '#fdfdfb' },
  pages: [{ id: 'p1', cameraKeyframes: [{ t: 0, x: 400, y: 460, zoom: 1.25 }] }],
  clips: [{
    id: 'c1',
    assetId: 'house',
    animId: 'draw.outlineFill',
    start: 0,
    duration: FRAMES / FPS,
    transform: { x: 0, y: 0, scale: 1, rotation: 0 },
  }],
};

async function main() {
  mkdirSync(OUT, { recursive: true });

  const handStyle = JSON.parse(readFileSync(join(ROOT, 'assets/hands/hand1.json'), 'utf8'));
  const images = new Map();
  for (const src of handStyle.sources) {
    images.set(src.file, await loadImage(join(ROOT, src.file)));
  }

  const session = createSession({
    hands: new Map([[handStyle.id, handStyle]]),
    resolveImage: (src) => images.get(src.file),
  });

  const plan = await outlineFill.compile(asset, { brushWidth: 3, fillBrushWidth: 16 });
  session.plans.set('c1', plan);

  // Paint the artwork the fill reveals. In the real pipeline this comes from
  // the imported raster or the vector regions; here we fill the region rings.
  const sfKey = 'c1';
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');

  // one warm-up frame so the clip's surfaces exist, then paint `art` into them
  renderFrame(session, project, 0, ctx, { width: WIDTH, height: HEIGHT, showHand: false });
  const sf = session.surfaces.get(sfKey);
  // ensureArt() already carries the -origin translation, so region rings can
  // be filled straight in object-local coordinates.
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

  const stats = { outlineStrokes: plan.phases.outline.i1, fillStrokes: 0, verts: 0 };
  for (const s of plan.strokes) stats.verts += s.pts.length >> 1;
  stats.fillStrokes = plan.strokes.length - plan.phases.outline.i1;

  console.log(`plan: ${stats.outlineStrokes} outline strokes, ${stats.fillStrokes} fill strokes, `
            + `${stats.verts} vertices`);
  console.log(`outline phase length ${plan.phases.outline.length.toFixed(0)} px, `
            + `fill phase ${plan.phases.fill.length.toFixed(0)} px`);

  for (let n = 0; n < FRAMES; n++) {
    renderFrame(session, project, n, ctx, {
      width: WIDTH, height: HEIGHT, showHand: SHOW_HAND, handStyleId: handStyle.id,
    });
    writeFileSync(join(OUT, `frame_${String(n).padStart(4, '0')}.png`), canvas.toBuffer('image/png'));
  }
  console.log(`wrote ${FRAMES} frames to ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
