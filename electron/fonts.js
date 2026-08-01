/**
 * System font discovery.
 *
 * Handwriting quality depends on the face: skeletonising a modulated serif
 * gives lumpy centrelines, so the picker reports each face's monoline-ness and
 * the UI can steer users toward the good ones.
 *
 * fc-list is the reliable enumerator on Linux; the directory walk is a fallback
 * for boxes without fontconfig.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import opentype from 'opentype.js';

const FONT_DIRS = [
  '/usr/share/fonts',
  '/usr/local/share/fonts',
  join(process.env.HOME || '', '.local/share/fonts'),
  join(process.env.HOME || '', '.fonts'),
];

/** Faces whose names suggest a script/handwriting design, surfaced first. */
const HAND_HINT = /(hand|script|comic|caveat|indie|patrick|shadows|gloria|architect|marker|brush|casual|dancing|kalam|neucha)/i;

function viaFontconfig() {
  const out = execFileSync('fc-list', ['--format', '%{file}\t%{family[0]}\t%{style[0]}\n'],
    { encoding: 'utf8', maxBuffer: 8 << 20 });
  return out.split('\n').filter(Boolean).map((line) => {
    const [file, family, style] = line.split('\t');
    return { path: file, family: family || '', style: style || 'Regular' };
  });
}

function viaScan() {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 4 || !existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      try {
        if (statSync(p).isDirectory()) walk(p, depth + 1);
        else if (['.ttf', '.otf'].includes(extname(name).toLowerCase())) {
          found.push({ path: p, family: name.replace(/\.[^.]+$/, ''), style: 'Regular' });
        }
      } catch { /* unreadable entry, skip */ }
    }
  };
  for (const d of FONT_DIRS) walk(d, 0);
  return found;
}

/**
 * Can opentype.js actually read this face?
 *
 * A handful of installed fonts cannot be parsed -- broken GSUB coverage
 * tables, colour-emoji faces with no outlines. Listing them means the user
 * picks one and gets "Coverage format must be 1 or 2" instead of handwriting,
 * with nothing pointing at the font. Checking costs a couple of seconds once.
 */
export function isUsable(path) {
  try {
    const b = readFileSync(path);
    const font = opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    // A face with no outline for 'a' cannot write anything we care about.
    return !!font.charToGlyph('a')?.path;
  } catch {
    return false;
  }
}

/**
 * @returns {Array<{path:string, family:string, style:string, hand:boolean}>}
 *          one usable entry per family, preferring the regular weight.
 */
export function listFonts() {
  let faces = [];
  try { faces = viaFontconfig(); } catch { faces = viaScan(); }

  // opentype.js parses TrueType/CFF only; .pfb and bitmap fonts would throw at
  // layout time, which is far too late to tell the user.
  faces = faces.filter((f) => ['.ttf', '.otf'].includes(extname(f.path).toLowerCase()));

  const byFamily = new Map();
  for (const f of faces) {
    const regular = /^(Book|Regular|Normal|Medium)$/i.test(f.style);
    const prev = byFamily.get(f.family);
    if (!prev || (regular && !prev.regular)) byFamily.set(f.family, { ...f, regular });
  }

  return [...byFamily.values()]
    .filter((f) => isUsable(f.path))
    .map(({ regular, ...f }) => ({ ...f, hand: HAND_HINT.test(f.family) }))
    // Script-like families first: skeletonising one of those reads as
    // handwriting, where a text face reads as traced type.
    .sort((a, b) => (b.hand - a.hand) || a.family.localeCompare(b.family));
}
