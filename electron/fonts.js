/**
 * The faces the Text tab offers.
 *
 * These are bundled with the app rather than discovered on the machine. Font
 * enumeration sounds friendlier -- use whatever the user already has -- but a
 * stock Linux box lists a couple of hundred families of which none is a
 * handwriting face, and handwriting is the whole point here: skeletonising a
 * modulated serif gives lumpy centrelines, while a script face reads as writing.
 * A fixed set also means a project opened elsewhere writes in the face it was
 * authored in, which a path into /usr/share/fonts cannot promise.
 *
 * `assets/fonts/fonts.json` is the manifest, and its order is the picker's
 * order. See the README beside it for what is in the set and why.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import opentype from 'opentype.js';

const FONT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'fonts');

/** Absolute path of a bundled face, or null if `file` is not one of them. */
export function bundledFontPath(file) {
  const p = join(FONT_DIR, file);
  return p.startsWith(FONT_DIR + '/') ? p : null;
}

/**
 * Can opentype.js actually read this face?
 *
 * Not every well-formed font survives the parser -- Roboto and Lora both throw
 * on their GSUB coverage tables ("lookupType: 6 substFormat: 2"). Offering one
 * of those means the user picks it and gets a parser message instead of
 * handwriting, with nothing pointing at the font. Checking nine files at
 * startup is cheap.
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
 *          the bundled faces, in manifest order, minus any the parser rejects.
 */
export function listFonts() {
  const manifest = JSON.parse(readFileSync(join(FONT_DIR, 'fonts.json'), 'utf8'));
  return manifest
    .map((f) => ({
      path: join(FONT_DIR, f.file),
      family: f.family,
      style: 'Regular',
      hand: !!f.hand,
    }))
    .filter((f) => isUsable(f.path));
}
