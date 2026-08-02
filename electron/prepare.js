/**
 * Asset preparation, main-process side.
 *
 * The renderer cannot spawn Python or read arbitrary files, so the main process
 * turns a project document into a JSON-safe "prepared" payload: plain arrays of
 * geometry plus data URLs for any pixels. The renderer then compiles and
 * renders entirely on its own, which keeps the engine identical between the
 * app, the CLI and the tests.
 *
 * Typed arrays are flattened to plain arrays deliberately -- structured clone
 * would carry Float64Array across, but the payload also has to survive being
 * written to disk or logged, and a uniform shape is worth the small cost.
 */

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import opentype from 'opentype.js';

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

function serializeDrawable(traced, art) {
  return {
    kind: 'drawable',
    bbox: arr(traced.bbox),
    // Which way the vectorizer read the image. The renderer needs it to decide
    // whether the artwork has paper to knock out: line art is ink on white and
    // its background means nothing, a photograph's light pixels are the picture.
    // Named `traceMode` because `mode` is already the text payload's own
    // discriminator, and one key meaning two things across `kind`s is a trap.
    traceMode: traced.mode ?? null,
    detectedTraceMode: traced.detectedMode ?? null,
    width: traced.width,
    height: traced.height,
    subpaths: traced.subpaths.map((s) => ({
      pts: arr(s.pts),
      closed: s.closed !== false,
      // Spread rather than assign `undefined`: JSON.stringify drops undefined
      // keys, so emitting them makes the payload fail its own round trip.
      // `stroke`/`strokeWidth` are the SVG's own paint, used when a clip
      // settles; `width`/`color` are a traced centreline's own weight.
      ...(s.stroke ? { stroke: s.stroke, strokeWidth: s.strokeWidth ?? 1 } : {}),
      ...(s.width ? { width: s.width } : {}),
      ...(s.color ? { color: s.color } : {}),
    })),
    regions: traced.regions.map((r) => ({
      rings: r.rings.map(arr),
      color: r.color,
      bbox: arr(r.bbox),
    })),
    art,
  };
}

/**
 * @param {Object} project a normalised project
 * @param {string} projectPath used to resolve relative asset paths
 * @param {Object} sidecar a started Sidecar instance
 */
export async function prepareProject(project, projectPath, sidecar) {
  const dir = dirname(projectPath);
  const rel = (p) => (isAbsolute(p) ? p : resolve(dir, p));

  const prepared = {};
  for (const clip of project.clips) {
    const asset = project.assets[clip.assetId];

    if (asset.kind === 'vector') {
      const parsed = parseSvg(readFileSync(rel(asset.src), 'utf8'), { eps: 0.2 });
      if (!parsed.subpaths.length) throw new Error(`${asset.src}: no drawable geometry`);
      // No raster exists, so the renderer paints the vector's own fills as the
      // artwork the scribble reveals.
      prepared[clip.id] = serializeDrawable(parsed, null);
    } else if (asset.kind === 'image') {
      const traced = await sidecar.vectorize(rel(asset.src), asset.trace || {});
      prepared[clip.id] = serializeDrawable(traced, dataUrl(rel(asset.src)));
    } else {
      const fontPath = rel(asset.font || DEFAULT_FONT);
      const buf = readFileSync(fontPath);
      let font;
      try {
        // loadSync is deprecated in opentype.js and silently returns undefined.
        font = opentype.parse(
          buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      } catch (err) {
        // opentype's own message ("Coverage format must be 1 or 2") names
        // neither the font nor the fix, which leaves the user stuck.
        throw new Error(`${fontPath.split('/').pop()} could not be read `
          + `(${err.message}). Choose a different font.`);
      }
      const opts = {
        fontSize: asset.fontSize ?? 120,
        penWidth: asset.penWidth ?? Math.max(2, (asset.fontSize ?? 120) * 0.045),
        color: asset.color,
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
          regions: layout.regions.map((r) => ({ rings: r.rings.map(arr), color: r.color })),
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
          regions: layout.regions.map((r) => ({ rings: r.rings.map(arr), color: r.color })),
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
