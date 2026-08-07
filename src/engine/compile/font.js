/**
 * Parsing a font file, in the one way that works.
 *
 * Two details here are load-bearing and were each found the hard way, so they
 * are stated once and shared rather than repeated at every call site:
 *
 *   - `opentype.loadSync` is deprecated and silently returns `undefined`, which
 *     surfaces much later as "cannot read property charToGlyph of undefined".
 *     `parse` on the bytes is the supported path.
 *   - a Node `Buffer` is a *view* into a larger pooled ArrayBuffer, so handing
 *     `buf.buffer` straight to `parse` gives it the whole pool. The slice is
 *     what makes it the font.
 *
 * Deliberately free of `node:fs`: the Electron renderer reaches this with bytes
 * that arrived over IPC, and must be able to import it.
 */

import opentype from 'opentype.js';

/**
 * @param {ArrayBuffer|Uint8Array} bytes
 * @returns {Object} parsed opentype font
 */
export function parseFont(bytes) {
  const ab = bytes instanceof ArrayBuffer
    ? bytes
    : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return opentype.parse(ab);
}
