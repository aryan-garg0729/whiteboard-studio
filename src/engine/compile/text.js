/**
 * Text -> ordered handwriting strokes.
 *
 * Split of responsibilities: JS owns typography (glyph selection, advance
 * widths, kerning, line layout) via opentype.js; the Python sidecar owns the
 * CV (skeletonisation into centrelines). The sidecar is sent glyph *outlines*
 * rather than characters, so it never needs the font file and two fonts
 * sharing a glyph share one cache entry.
 *
 * Stroke ordering and direction are applied here rather than in the sidecar so
 * they can be tuned without a round trip.
 */

import { makeStroke } from './geometry.js';

/** Stable cache key for a glyph outline at given options. */
export function glyphKey(commands, upem, opts = {}) {
  let h = 2166136261 >>> 0;
  const push = (s) => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
  };
  push(`u${upem}|s${opts.supersample ?? 2}|p${opts.pruneFactor ?? 1.4}|`);
  for (const c of commands) {
    push(c.type);
    for (const k of ['x', 'y', 'x1', 'y1', 'x2', 'y2']) {
      if (c[k] != null) push(`${Math.round(c[k] * 4) / 4},`);
    }
  }
  return (h >>> 0).toString(16);
}

/**
 * Classify a glyph's strokes so they can be ordered the way a person writes.
 *
 * Crossbars and tittles last is the single highest-value ordering rule -- it
 * is what makes a 't' or an 'i' read as handwriting rather than as assembly.
 */
export function classifyStrokes(strokes, emSize) {
  const boxes = strokes.map((s) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of s.pts) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return [x0, y0, x1, y1];
  });
  const maxLen = Math.max(1e-6, ...strokes.map((s) => s.length ?? 0));
  const overlaps = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

  return strokes.map((s, i) => {
    const b = boxes[i];
    const diag = Math.hypot(b[2] - b[0], b[3] - b[1]);
    const dx = Math.abs(b[2] - b[0]);
    const dy = Math.abs(b[3] - b[1]);
    const touchesOther = boxes.some((o, j) => j !== i && overlaps(b, o));

    let role = 'main';
    if (diag < 0.18 * emSize && !touchesOther) role = 'dot';
    else if ((s.length ?? 0) < 0.45 * maxLen && dy < 0.25 * dx && touchesOther) role = 'bar';
    return { ...s, role, bbox: b };
  });
}

/** Signed area; positive means counter-clockwise in y-up font units. */
function ringArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

/**
 * Orient a stroke the way a right-handed writer would draw it.
 *
 * Open strokes run predominantly down, tie-breaking to the right. Closed rings
 * (o, the bowl of a d) start at the top and run counter-clockwise on screen --
 * getting that backwards is instantly noticeable to a viewer even though they
 * usually cannot say why.
 */
export function orientStroke(s) {
  const pts = s.pts.slice();
  const closed = pts.length > 3
    && Math.hypot(pts[0][0] - pts[pts.length - 1][0],
                  pts[0][1] - pts[pts.length - 1][1]) < 4;

  if (closed) {
    // font units are y-up; screen-space counter-clockwise is clockwise here
    if (ringArea(pts) > 0) pts.reverse();
    let top = 0;
    for (let i = 1; i < pts.length; i++) if (pts[i][1] > pts[top][1]) top = i;
    const rotated = pts.slice(top).concat(pts.slice(0, top));
    rotated.push(rotated[0]);
    return { ...s, pts: rotated, closed: true };
  }

  const a = pts[0];
  const b = pts[pts.length - 1];
  const dy = b[1] - a[1];
  const dx = b[0] - a[0];
  // y-up: "downward" means decreasing y
  const flip = dy > Math.abs(dx) * 0.2 || (Math.abs(dy) <= Math.abs(dx) * 0.2 && dx < 0);
  return { ...s, pts: flip ? pts.reverse() : pts, closed: false };
}

/** main strokes first (top-down, left-right), then crossbars, then tittles. */
export function orderGlyphStrokes(strokes) {
  const rank = { main: 0, bar: 1, dot: 2 };
  return strokes.slice().sort((p, q) => {
    const r = rank[p.role] - rank[q.role];
    if (r) return r;
    const py = p.pts[0][1];
    const qy = q.pts[0][1];
    if (Math.abs(py - qy) > 1e-6) return qy - py;      // y-up: higher first
    return p.pts[0][0] - q.pts[0][0];
  });
}

/**
 * Lay out a string and return the strokes to draw, in object space (y-down).
 *
 * @param {Object} font an opentype.js Font
 * @param {string} text
 * @param {Object} o
 * @param {number} o.fontSize
 * @param {(commands:Array, key:string) => Promise<{strokes:Array}>} o.getSkeleton
 * @param {number} [o.lineHeight]
 * @param {number} [o.penWidth]
 * @param {number} [o.letterGap] pen-lift travel threshold, object units
 */
export async function layoutText(font, text, o) {
  const upem = font.unitsPerEm;
  const scale = o.fontSize / upem;
  const lineHeight = o.lineHeight ?? o.fontSize * 1.35;

  const lines = String(text).split('\n');
  const placements = [];
  let maxWidth = 0;

  lines.forEach((line, lineIndex) => {
    // charToGlyph rather than stringToGlyphs: the latter runs opentype.js's
    // bidi/shaping engine, which throws on GSUB lookup types it does not
    // implement (DejaVu Sans hits "lookupType: 6 substFormat: 2"). Handwriting
    // is drawn character by character anyway, so shaping buys us nothing here
    // -- and kerning still applies, since getKerningValue works on glyph pairs.
    const glyphs = [...line].map((ch) => font.charToGlyph(ch));
    let penX = 0;
    glyphs.forEach((glyph, i) => {
      if (i > 0) {
        // getKerningValue reads both `kern` and GPOS pair positioning
        penX += font.getKerningValue(glyphs[i - 1], glyph) || 0;
      }
      placements.push({ glyph, penX, lineIndex });
      penX += glyph.advanceWidth;
    });
    maxWidth = Math.max(maxWidth, penX);
  });

  // One sidecar request per distinct glyph outline, not per occurrence.
  const unique = new Map();
  for (const p of placements) {
    const commands = p.glyph.path.commands;
    if (!commands.length) continue;
    const key = glyphKey(commands, upem);
    p.key = key;
    if (!unique.has(key)) unique.set(key, commands);
  }

  const skeletons = new Map();
  for (const [key, commands] of unique) {
    skeletons.set(key, await o.getSkeleton(commands, key));
  }

  const strokes = [];
  let pen = null;
  const penWidth = o.penWidth ?? Math.max(1.5, o.fontSize * 0.045);
  const letterGap = o.letterGap ?? penWidth * 2;

  for (const p of placements) {
    const sk = p.key && skeletons.get(p.key);
    if (!sk || !sk.strokes || !sk.strokes.length) continue;

    let glyphStrokes = classifyStrokes(sk.strokes, upem).map(orientStroke);
    glyphStrokes = orderGlyphStrokes(glyphStrokes);

    for (const gs of glyphStrokes) {
      const pts = [];
      for (const [fx, fy] of gs.pts) {
        // font units (y-up) -> object space (y-down), positioned on the line
        pts.push((p.penX + fx) * scale,
                 (p.lineIndex * lineHeight) - fy * scale);
      }
      if (pts.length < 4) continue;

      const start = [pts[0], pts[1]];
      if (pen && Math.hypot(start[0] - pen[0], start[1] - pen[1]) > letterGap) {
        strokes.push(travelArc(pen, start));
      }
      strokes.push(makeStroke(pts, {
        kind: 'OUTLINE', width: penWidth, color: o.color ?? '#1a1a1a',
      }));
      pen = [pts[pts.length - 2], pts[pts.length - 1]];
    }
  }

  const w = maxWidth * scale;
  const h = lines.length * lineHeight;
  return {
    strokes,
    bbox: [-o.fontSize * 0.3, -o.fontSize * 1.1, w + o.fontSize * 0.3, h + o.fontSize * 0.4],
    width: w,
    height: h,
    // Aggregate across the string: a single glyph's modulation is noisy
    // (DejaVu Sans's 'k' scores 0.21 against a 0.22 threshold), but the mean
    // over a font separates cleanly -- Sans ~0.09, Serif ~0.25.
    modulation: meanModulation([...skeletons.values()]),
    monoline: meanModulation([...skeletons.values()]) < 0.22,
  };
}

function meanModulation(list) {
  const vals = list.map((s) => s.modulation).filter((v) => typeof v === 'number');
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
}

/** Pen-up hop between letters, bulged so the hand lifts over the writing. */
function travelArc(a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const gap = Math.hypot(dx, dy) || 1;
  const mx = (a[0] + b[0]) / 2 + (dy / gap) * gap * 0.16;
  const my = (a[1] + b[1]) / 2 - (dx / gap) * gap * 0.16;
  const pts = [];
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    const u = 1 - t;
    pts.push(u * u * a[0] + 2 * u * t * mx + t * t * b[0],
             u * u * a[1] + 2 * u * t * my + t * t * b[1]);
  }
  return makeStroke(pts, { kind: 'TRAVEL', lift: true, width: 0 });
}
