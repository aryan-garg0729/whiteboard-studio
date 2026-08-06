/**
 * Render a project file to MP4 (or a PNG sequence).
 *
 *   node scripts/render-project.js examples/demo.project.json [--out o.mp4]
 *                                  [--frames-only] [--no-hand]
 *
 * This is the generic, data-driven path: every hardcoded demo script collapses
 * into a JSON document plus this renderer.
 *
 * The build itself lives in `src/engine/host/nodeSession.js` -- the app spawns
 * this script for export (electron/main.js), and the MCP server builds the same
 * session in-process, so the two must not be able to drift. What is left here
 * is argv, the frame pump and the two output modes.
 *
 * The stdout `encoding n/total` lines are a contract: electron/main.js scrapes
 * them for its progress bar.
 */

import { createCanvas } from '@napi-rs/canvas';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildNodeSession, installNodeSurfaces } from '../src/engine/host/nodeSession.js';
import { renderFrame } from '../src/engine/render/renderFrame.js';
import { exportVideo } from '../src/engine/export/driver.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

installNodeSurfaces();

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

async function main() {
  // No sidecar: nothing on this path needs Python any more.
  const { session, project, frames } = await buildNodeSession(
    JSON.parse(readFileSync(projectPath, 'utf8')),
    {
      root: ROOT,
      rel,
      onClip: (clipId, asset) =>
        console.log(`  ${clipId}: ${asset.kind} "${asset.src || asset.text}"`),
    });

  const { width, height, fps } = project.meta;
  if (!frames) throw new Error('project has no clips, nothing to render');

  const showHand = !flag('--no-hand') && project.meta.showHand !== false;
  const handStyleId = project.meta.handStyleId;
  const out = resolve(arg('--out', projectPath.replace(/\.json$/, '.mp4')));

  console.log(`${project.clips.length} clip(s), ${(frames / fps).toFixed(1)}s `
            + `@ ${width}x${height} ${fps}fps`);

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const draw = (n) => renderFrame(session, project, n, ctx,
    { width, height, showHand, handStyleId });

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
    // @napi-rs/canvas returns a raw RGBA snapshot without constructing an
    // ImageData wrapper for every frame.
    renderFrameRGBA(n) { draw(n); return canvas.data(); },
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
