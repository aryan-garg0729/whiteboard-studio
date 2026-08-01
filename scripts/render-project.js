/**
 * Render a project file to MP4 (or a PNG sequence).
 *
 *   node scripts/render-project.js examples/demo.project.json [--out o.mp4]
 *                                  [--frames-only] [--no-hand]
 *
 * This is the generic, data-driven path: every hardcoded demo script collapses
 * into a JSON document plus this renderer. It is also the seam the editor UI
 * will sit on -- the UI's job is to produce the same JSON.
 */

import { createCanvas, loadImage } from '@napi-rs/canvas';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import opentype from 'opentype.js';

import { setSurfaceFactory } from '../src/engine/render/surfaces.js';
import { createSession, ensureSurfaces, renderFrame } from '../src/engine/render/renderFrame.js';
import { normalizeProject, projectFrames } from '../src/engine/model/project.js';
import { Sidecar, toAsset } from '../src/engine/sidecar/client.js';
import { layoutText, outlineText } from '../src/engine/compile/text.js';
import { parseSvg } from '../src/engine/compile/svgDoc.js';
import { paintVectorArt } from '../src/engine/render/vectorArt.js';
import { compileErase } from '../src/engine/anim/erase.js';
import { exportVideo } from '../src/engine/export/driver.js';
import { styleIdsFor } from '../src/engine/hand/styles.js';
import outlineFill from '../src/engine/anim/outlineFill.js';
import handwrite from '../src/engine/anim/handwrite.js';
import textReveal from '../src/engine/anim/textReveal.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

setSurfaceFactory((w, h) => {
  const canvas = createCanvas(w, h);
  return { canvas, ctx: canvas.getContext('2d') };
});

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };
const flag = (n) => argv.includes(n);

const FILE = argv.find((a) => !a.startsWith('--') && a.endsWith('.json'));
if (!FILE) {
  console.error('usage: node scripts/render-project.js <project.json> [--out o.mp4] [--frames-only]');
  process.exit(1);
}

const projectPath = resolve(FILE);
const projectDir = dirname(projectPath);
/** Asset paths are relative to the project file, so documents stay portable. */
const rel = (p) => (isAbsolute(p) ? p : resolve(projectDir, p));

/**
 * Vectors skip the sidecar: the geometry is already exact, so tracing it would
 * only throw information away.
 */
async function buildVectorClip(clip, asset) {
  const parsed = parseSvg(readFileSync(rel(asset.src), 'utf8'), { eps: 0.2 });
  if (!parsed.subpaths.length) throw new Error(`${asset.src}: no drawable geometry`);
  const plan = await outlineFill.compile(toAsset(clip.assetId, parsed), {
    brushWidth: Math.max(1.5, 2.4 / clip.transform.scale),
    fillBrushWidth: Math.max(8, 15 / clip.transform.scale),
    ...clip.params,
  });
  return { plan, traced: parsed, vector: parsed };
}

async function buildImageClip(session, sidecar, project, clip, asset) {
  const traced = await sidecar.vectorize(rel(asset.src), asset.trace || {});
  const plan = await outlineFill.compile(toAsset(clip.assetId, traced), {
    brushWidth: Math.max(1.5, 2.4 / clip.transform.scale),
    fillBrushWidth: Math.max(8, 15 / clip.transform.scale),
    ...clip.params,
  });
  return { plan, traced, artSrc: rel(asset.src) };
}

async function buildTextClip(session, sidecar, project, clip, asset) {
  const fontPath = rel(asset.font || '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf');
  const buf = readFileSync(fontPath);
  // loadSync is deprecated in opentype.js and silently returns undefined.
  const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

  const opts = {
    fontSize: asset.fontSize ?? 120,
    penWidth: asset.penWidth ?? Math.max(2, (asset.fontSize ?? 120) * 0.045),
    color: asset.color,
  };

  // Same branch as electron/prepare.js, and it has to stay that way: preview and
  // export must build byte-identical plans from the same document.
  if (clip.animId === 'draw.textReveal') {
    const layout = outlineText(font, asset.text, opts);
    return { plan: await textReveal.compile({ id: clip.id, layout }), layout, vector: layout };
  }

  const layout = await layoutText(font, asset.text, {
    ...opts,
    getSkeleton: (commands, key) => sidecar.skeletonizeGlyph(commands, {
      key, unitsPerEm: font.unitsPerEm, size: 256, supersample: 2,
    }),
  });
  if (!layout.monoline) {
    console.log(`  note: ${asset.id} uses a modulated face; centrelines will read as `
              + 'traced type rather than handwriting');
  }
  return { plan: await handwrite.compile({ layout }), layout };
}

async function main() {
  const project = normalizeProject(JSON.parse(readFileSync(projectPath, 'utf8')));
  const { width, height, fps } = project.meta;
  const frames = projectFrames(project);
  if (!frames) throw new Error('project has no clips, nothing to render');

  const showHand = !flag('--no-hand') && project.meta.showHand !== false;
  const out = resolve(arg('--out', projectPath.replace(/\.json$/, '.mp4')));

  console.log(`${project.clips.length} clip(s), ${(frames / fps).toFixed(1)}s `
            + `@ ${width}x${height} ${fps}fps`);

  const sidecar = new Sidecar({ root: ROOT, cacheDir: join(ROOT, '.cache') });

  // The chosen hand plus every tool style: renderFrame resolves the erase
  // sweep's hand by scanning these, so loading only the pen hand is what leaves
  // an erase running with no hand on screen.
  const styles = styleIdsFor(project.meta.handStyleId).map((id) =>
    JSON.parse(readFileSync(join(ROOT, `assets/hands/${id}.json`), 'utf8')));
  const handStyle = styles[0];
  const images = new Map();
  for (const style of styles) {
    for (const src of style.sources) {
      if (!images.has(src.file)) images.set(src.file, await loadImage(join(ROOT, src.file)));
    }
  }

  const session = createSession({
    hands: new Map(styles.map((s) => [s.id, s])),
    resolveImage: (src) => images.get(src.file),
  });

  // Build every clip's plan up front so a bad asset fails before we render.
  const artwork = [];
  for (const clip of project.clips) {
    const asset = project.assets[clip.assetId];
    console.log(`  ${clip.id}: ${asset.kind} "${asset.src || asset.text}"`);
    let built;
    if (asset.kind === 'vector') built = await buildVectorClip(clip, asset);
    else if (asset.kind === 'image') built = await buildImageClip(session, sidecar, project, clip, asset);
    else built = await buildTextClip(session, sidecar, project, clip, asset);

    session.plans.set(clip.id, built.plan);
    if (clip.erase) session.erasePlans.set(clip.id, compileErase(built.plan, { id: clip.id }));
    if (built.artSrc) artwork.push({ clipId: clip.id, src: built.artSrc, traced: built.traced });
    if (built.vector) artwork.push({ clipId: clip.id, vector: built.vector });
  }
  sidecar.stop();

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Surfaces first, then the source pixels the fill scribble reveals. Asked for
  // directly rather than conjured by rendering a warm-up frame: a clip on a page
  // that frame does not show would get no surfaces and no artwork.
  ensureSurfaces(session, project);
  for (const { clipId, src, traced, vector } of artwork) {
    const sf = session.surfaces.get(clipId);
    if (!sf) continue;
    const art = sf.ensureArt().ctx;
    if (vector) {
      // No raster to reveal, so the vector's own fills and strokes are both
      // the reveal artwork and what the clip settles to.
      paintVectorArt(art, vector.regions, vector.subpaths);
    } else {
      art.drawImage(await loadImage(src), 0, 0, traced.width, traced.height);
    }
  }

  const draw = (n) => renderFrame(session, project, n, ctx,
    { width, height, showHand, handStyleId: handStyle.id });

  if (flag('--frames-only')) {
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
    frames, width, height, fps, out,
    audio: project.audio.map((a) => ({ ...a, file: rel(a.src) })),
    renderFrameRGBA(n) { draw(n); return ctx.getImageData(0, 0, width, height).data; },
    onProgress: ({ frame, total }) => process.stdout.write(`\rencoding ${frame}/${total}`),
  });
  const secs = (Date.now() - t0) / 1000;
  console.log(`\nwrote ${out} — ${frames} frames in ${secs.toFixed(1)}s `
            + `(${(frames / secs).toFixed(1)} fps)`);
}

main().catch((e) => {
  console.error(e.name === 'ProjectError' ? `invalid project — ${e.message}` : e);
  process.exit(1);
});
