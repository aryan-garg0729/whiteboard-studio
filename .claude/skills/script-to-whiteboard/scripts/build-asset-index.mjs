#!/usr/bin/env node
/**
 * Index the whiteboard art library so a beat can be matched to a file by words.
 *
 * The library has no catalogue and never has had one. What it does have is
 * filenames that are keyword soup -- `PeterHandChinThinkingThoughtfulConsider
 * UnsureWorryworriedHighVisibilityJacketLanyardWarehouseWorkerFactoryPPE_out.png`
 * -- which is unreadable to a person and, once split on its capitals, an
 * excellent bag of search terms. So the index is a tokeniser and nothing more:
 * no embeddings, no model, no network, rebuildable in a second.
 *
 * Usage: node build-asset-index.mjs [--force]
 */

import { readdirSync, statSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const INDEX_PATH = join(HERE, '..', '.cache', 'asset-index.json');

/** Where the artwork actually lives. Raster first: it is what the style uses. */
export const PNG_DIR = '/home/aryan/Personal/yt/vid/assets/whiteboard_assets';
export const SVG_DIR = '/home/aryan/Personal/yt/vid/assets/svg';

/**
 * Words that appear in so many filenames they carry no signal, plus the
 * pipeline's own suffix. Scoring these would rank the library's most generic
 * files first for every query.
 */
const STOP = new Set(['out', 'colour', 'color', 'the', 'and', 'a', 'of']);

/**
 * Split a filename into search terms.
 *
 * Two shapes have to survive the same function: CamelCase soup
 * (`AngryManBeardCrossFoldArmsHands`) and the thirty hand-named files
 * (`GreenSackDollar`, `RedRectangle`) that the finished videos actually lean
 * on. Splitting on capitals handles both. A few of the bulk files are entirely
 * lowercase and cannot be split at all -- those fall back to substring matching
 * at query time, which is why `raw` is kept alongside the tokens.
 */
export function tokenize(name) {
  const stem = basename(name, extname(name));
  const words = stem
    // ABCWord -> ABC Word, wordWord -> word Word, word2 -> word 2
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
  return [...new Set(words)];
}

const listing = (dir, ext) => (existsSync(dir)
  ? readdirSync(dir).filter((f) => f.toLowerCase().endsWith(ext))
  : []);

export function build() {
  const pngs = listing(PNG_DIR, '.png');
  const svgs = listing(SVG_DIR, '.svg');

  // An SVG is a twin of a PNG when their stems match, and the PNG is preferred:
  // `draw.inkPaint` over flat-colour raster is what the house style is built
  // on. A stem with no PNG is still worth indexing -- 45 of them exist, and a
  // vector asset draws perfectly well.
  const svgByStem = new Map(svgs.map((f) => [basename(f, '.svg'), join(SVG_DIR, f)]));

  const entries = [];
  for (const f of pngs) {
    const stem = basename(f, '.png');
    entries.push({
      stem,
      path: join(PNG_DIR, f),
      svgPath: svgByStem.get(stem) ?? null,
      kind: 'image',
      // The short hand-named files are the curated ones a person chose and
      // reused; they earn a ranking bonus at query time.
      curated: !stem.endsWith('_out'),
      tokens: tokenize(f),
    });
    svgByStem.delete(stem);
  }
  for (const [stem, path] of svgByStem) {
    entries.push({ stem, path, svgPath: path, kind: 'vector', curated: false, tokens: tokenize(stem) });
  }

  return {
    builtAt: new Date().toISOString(),
    sources: { png: PNG_DIR, svg: SVG_DIR },
    counts: { png: pngs.length, svg: svgs.length, entries: entries.length },
    entries,
  };
}

/** Rebuild when the index is missing or older than either source directory. */
export function stale() {
  if (!existsSync(INDEX_PATH)) return true;
  const built = statSync(INDEX_PATH).mtimeMs;
  return [PNG_DIR, SVG_DIR]
    .filter((d) => existsSync(d))
    .some((d) => statSync(d).mtimeMs > built);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!process.argv.includes('--force') && !stale()) {
    console.log(`index is current: ${INDEX_PATH}`);
  } else {
    const index = build();
    mkdirSync(dirname(INDEX_PATH), { recursive: true });
    writeFileSync(INDEX_PATH, JSON.stringify(index));
    const { png, svg, entries } = index.counts;
    console.log(`wrote ${INDEX_PATH}`);
    console.log(`  ${png} png, ${svg} svg -> ${entries} entries`);
    console.log(`  ${index.entries.filter((e) => e.curated).length} curated (short-named)`);
  }
}
