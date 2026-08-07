/**
 * Asset preparation, main-process side.
 *
 * The renderer cannot read arbitrary files, so the main process turns a project
 * document into a JSON-safe "prepared" payload: laid-out text, parsed SVG
 * geometry, and data URLs for any pixels. The renderer then compiles and renders
 * entirely on its own, which keeps the engine identical between the app, the CLI
 * and the tests.
 *
 * Typed arrays are flattened to plain arrays deliberately -- structured clone
 * would carry Float64Array across, but the payload also has to survive being
 * written to disk or logged, and a uniform shape is worth the small cost.
 */

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseFont } from '../src/engine/compile/font.js';
import { parseSvg } from '../src/engine/compile/svgDoc.js';
import { outlineText, traceText } from '../src/engine/compile/text.js';
import { styleIdsFor } from '../src/engine/hand/styles.js';

const arr = (a) => (Array.isArray(a) ? a : Array.from(a));

/**
 * The face a text asset falls back to.
 *
 * A bundled one, not a system path: the old default (DejaVu Sans) only exists
 * on Linux, and a project that renders on the author's box and dies on anyone
 * else's is worse than no default at all.
 */
const DEFAULT_FONT = join(dirname(fileURLToPath(import.meta.url)),
  '..', 'assets', 'fonts', 'Caveat.ttf');

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', svg: 'image/svg+xml', gif: 'image/gif',
};

export function dataUrl(path) {
  const ext = path.split('.').pop().toLowerCase();
  return `data:${MIME[ext] || 'image/png'};base64,${readFileSync(path).toString('base64')}`;
}

/** Parse a font file, turning opentype's opaque failures into actionable ones. */
function readFont(fontPath) {
  try {
    return parseFont(readFileSync(fontPath));
  } catch (err) {
    // opentype's own message ("Coverage format must be 1 or 2") names neither
    // the font nor the fix, which leaves the user stuck.
    throw new Error(`${fontPath.split('/').pop()} could not be read `
      + `(${err.message}). Choose a different font.`);
  }
}

/**
 * The subtitle face, as bytes for the renderer to parse.
 *
 * Bytes rather than a laid-out transcript on purpose. The renderer cannot read
 * files, so something has to cross IPC; sending the layout would mean every
 * change to subtitle size or wrapping needed a main-process round trip, which
 * would recompile every clip in the project to renumber some text. Sending the
 * font once lets the renderer re-lay-out locally, so only a change of *face*
 * costs a re-prepare.
 *
 * @returns {string|null} base64, or null when there is nothing to set
 */
export function prepareSubtitleFont(project, root) {
  const subs = project.subtitles;
  if (!subs?.enabled || !subs.words?.length) return null;
  const fontPath = isAbsolute(subs.font) ? subs.font : join(root, subs.font);
  readFont(fontPath);                    // fail here, with a good message
  return readFileSync(fontPath).toString('base64');
}

/**
 * A vector, as the renderer needs it.
 *
 * Only the geometry crosses the wire. The renderer rasterises it and analyses
 * the pixels itself, exactly as the CLI does -- sending an analysis instead
 * would mean shipping every group's coverage mask through IPC for no gain, and
 * would give the app a second place where a plan can be built.
 */
function serializeVector(parsed) {
  return {
    kind: 'vector',
    bbox: arr(parsed.bbox),
    width: parsed.width,
    height: parsed.height,
    subpaths: parsed.subpaths.map((s) => ({
      pts: arr(s.pts),
      closed: s.closed !== false,
      // Spread rather than assign `undefined`: JSON.stringify drops undefined
      // keys, so emitting them makes the payload fail its own round trip.
      ...(s.stroke ? { stroke: s.stroke, strokeWidth: s.strokeWidth ?? 1 } : {}),
    })),
    regions: parsed.regions.map((r) => ({ rings: r.rings.map(arr), color: r.color })),
  };
}

/**
 * @param {Object} project a normalised project
 * @param {string} projectPath used to resolve relative asset paths
 */
export async function prepareProject(project, projectPath) {
  const dir = dirname(projectPath);
  const rel = (p) => (isAbsolute(p) ? p : resolve(dir, p));

  const prepared = {};
  for (const clip of project.clips) {
    const asset = project.assets[clip.assetId];

    if (asset.kind === 'vector') {
      const parsed = parseSvg(readFileSync(rel(asset.src), 'utf8'), { eps: 0.2 });
      if (!parsed.subpaths.length) throw new Error(`${asset.src}: no drawable geometry`);
      prepared[clip.id] = serializeVector(parsed);
    } else if (asset.kind === 'image') {
      // Just the pixels. Nothing is traced here any more -- the renderer decodes
      // the data URL, reads the pixels back and plans the drawing from those,
      // which is the same code path `buildNodeSession` takes.
      prepared[clip.id] = { kind: 'image', art: dataUrl(rel(asset.src)) };
    } else {
      const fontPath = rel(asset.font || DEFAULT_FONT);
      const font = readFont(fontPath);
      const opts = {
        fontSize: asset.fontSize ?? 120,
        penWidth: asset.penWidth ?? Math.max(2, (asset.fontSize ?? 120) * 0.045),
        color: asset.color,
        bold: !!asset.bold,
      };

      // Both text drawing modes reveal real outlines. Trace additionally gets
      // a font-independent writing guide; neither path skeletonises glyphs.
      if (clip.animId !== 'draw.handwrite') {
        const layout = outlineText(font, asset.text, opts);
        prepared[clip.id] = {
          kind: 'text',
          mode: 'reveal',
          bbox: arr(layout.bbox),
          inkBbox: arr(layout.inkBbox),
          width: layout.width,
          height: layout.height,
          penWidth: opts.penWidth,
          lines: layout.lines,
          regions: layout.regions.map((r) => ({ rings: r.rings.map(arr), color: r.color,
            // Spread, not assigned: JSON.stringify drops undefined keys, so a
            // non-bold layout must not emit the key at all.
            ...(r.dilate ? { dilate: r.dilate } : {}) })),
        };
      } else {
        const layout = traceText(font, asset.text, opts);
        prepared[clip.id] = {
          kind: 'text',
          mode: 'trace',
          bbox: arr(layout.bbox),
          inkBbox: arr(layout.inkBbox),
          width: layout.width,
          height: layout.height,
          regions: layout.regions.map((r) => ({ rings: r.rings.map(arr), color: r.color,
            // Spread, not assigned: JSON.stringify drops undefined keys, so a
            // non-bold layout must not emit the key at all.
            ...(r.dilate ? { dilate: r.dilate } : {}) })),
          guides: layout.guides.map((g) => ({ pts: arr(g.pts), glyph: g.glyph,
            lift: g.lift, width: g.width })),
        };
      }
    }
  }
  return prepared;
}

/**
 * Hand style manifests plus their images, ready for the renderer.
 *
 * `styles` carries the chosen drawing hand *and* every tool style (the eraser),
 * because the renderer resolves a non-pen tool by scanning the styles it was
 * given. `style` remains the chosen hand, which is what the editor labels.
 */
export function prepareHand(root, id) {
  const load = (styleId) =>
    JSON.parse(readFileSync(resolve(root, `assets/hands/${styleId}.json`), 'utf8'));

  const styles = styleIdsFor(id).map(load);
  const images = {};
  for (const style of styles) {
    for (const src of style.sources) images[src.file] = dataUrl(resolve(root, src.file));
  }
  return { style: styles[0], styles, images };
}
