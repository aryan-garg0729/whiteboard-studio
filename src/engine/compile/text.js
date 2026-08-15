/**
 * Text -> letterforms, in pure JS.
 *
 * Typography -- glyph selection, advance widths, kerning, line layout, variable
 * weight -- all via opentype.js. `outlineText` keeps the real glyph outline and
 * `traceText` adds the writing guides a hand follows over it, so the letters on
 * screen are always the font's own.
 *
 * There used to be a second route that shipped glyph outlines to a Python
 * process to be skeletonised into centrelines, and drew *those*. It is gone,
 * along with the sidecar: a centreline only reads correctly on a near-monoline
 * face, and the guides in `textGuides.js` give the same gesture without
 * replacing the letterform. Nothing here needs Python, or is asynchronous.
 */

import { makeStroke } from './geometry.js';
import { flattenCommands } from './svgPath.js';
import { guideForCharacter } from './textGuides.js';

/** Weight asked of a variable face for bold, and for regular. */
const BOLD_WGHT = 700;
const REGULAR_WGHT = 400;

/**
 * Centre, because a whiteboard caption is a title rather than a paragraph.
 *
 * Ragged-right is the right default for body copy, which is read in bulk and
 * benefits from an even left margin to return to. A caption here is two or
 * three short lines sitting on their own in the frame, usually beside a drawing,
 * and centring is what makes that read as one deliberate block rather than as
 * text that ran out. It is also what every clip in the example projects was
 * hand-placed to look like.
 *
 * Single-line text is unaffected whatever this says -- there is nothing to
 * align it against.
 */
export const DEFAULT_TEXT_ALIGN = 'center';

/** Share of the slack a line is pushed right by. */
const ALIGN_FRACTION = { left: 0, center: 0.5, right: 1 };

/**
 * Synthetic emboldening width, as a fraction of the font size.
 *
 * Only reached on a face with no `wght` axis. Stroking a glyph's own outline at
 * this width thickens the stems and shrinks the counters by the same amount,
 * which is what "fake bold" is; five of the nine bundled faces have no axis and
 * this is the only way they get a bold at all.
 */
export const SYNTHETIC_BOLD_FRAC = 0.055;

/** The face's `wght` variation axis, or null if it is a single-weight font. */
export function weightAxis(font) {
  const axes = font?.tables?.fvar?.axes;
  return (axes && axes.find((a) => a.tag === 'wght')) || null;
}

/** Letters the weight-axis soundness check is run on. */
const PROBE_CHARS = 'oeacn';

/**
 * Least the ink of a probe glyph must grow between regular and bold for the
 * face's interpolation to be believed. Sound faces clear this by a wide margin
 * (1.3x and up); the failure this exists to catch comes in at 0.91.
 */
const BOLD_AREA_GAIN = 1.05;

const ringArea2 = (pts) => {
  let a = 0;
  for (let i = 0; i < pts.length; i += 2) {
    const j = (i + 2) % pts.length;
    a += pts[i] * pts[j + 1] - pts[j] * pts[i + 1];
  }
  return a / 2;
};

/**
 * How much ink a glyph lays down, under the even-odd rule the artwork is filled
 * with: the largest contour is the letter, everything inside it is a counter.
 */
function glyphInk(font, ch) {
  const path = font.charToGlyph(ch).getPath(0, 0, 100, {}, font);
  const areas = flattenCommands(path.commands, { eps: 0.25 })
    .map((s) => Math.abs(ringArea2(s.pts)))
    .sort((a, b) => b - a);
  if (!areas.length) return 0;
  return areas[0] - areas.slice(1).reduce((s, v) => s + v, 0);
}

/**
 * Whether this face's `wght` axis can actually be trusted to produce a bold.
 *
 * It usually can, and where it can a real bold beats a stroked-on one. But
 * opentype.js 2.0.0 mis-interpolates the odd glyph -- Montserrat's `o` comes out
 * with its counter almost as large as the letter, so a bold caption renders a
 * thin, notched ring where an `o` should be, and `o` is not a letter anyone can
 * avoid. There is no newer release to upgrade to.
 *
 * So the face is probed instead of trusted: a handful of round letters are
 * flattened at both weights, and if any of them fails to gain ink the whole face
 * drops to synthetic bold. Per face and not per glyph deliberately -- mixing the
 * two inside one word is more obviously wrong than a uniformly blunter bold.
 *
 * Pure geometry, so it runs anywhere the engine does: no canvas, no rasterising,
 * and the same answer in the app, the CLI and the tests.
 */
export function hasSoundWeightAxis(font) {
  const axis = weightAxis(font);
  if (!axis) return false;
  const lo = Math.max(axis.minValue, Math.min(axis.maxValue, REGULAR_WGHT));
  const hi = Math.max(axis.minValue, Math.min(axis.maxValue, BOLD_WGHT));
  if (!(hi > lo)) return false;

  const before = font.variation.get();
  try {
    for (const ch of PROBE_CHARS) {
      font.variation.set({ wght: lo });
      const light = glyphInk(font, ch);
      font.variation.set({ wght: hi });
      const heavy = glyphInk(font, ch);
      if (light <= 0) continue;                    // no contours to judge
      if (heavy / light < BOLD_AREA_GAIN) return false;
    }
    return true;
  } finally {
    font.variation.set(before);
  }
}

/**
 * `hasSoundWeightAxis` memoised on the font instance.
 *
 * The probe flattens ten glyph outlines, which is cheap but not free, and every
 * layout would otherwise repeat it. Hung off the font object so it lives exactly
 * as long as the parsed face does.
 */
export function boldModeFor(font) {
  if (font.__wbBoldMode === undefined) {
    font.__wbBoldMode = hasSoundWeightAxis(font) ? 'variable' : 'synthetic';
  }
  return font.__wbBoldMode;
}

/**
 * Put the font instance at the requested weight, and say how bold has to be
 * faked for the part the font cannot do itself.
 *
 * Called for *every* layout, not only bold ones, and that is deliberate:
 * Montserrat's `wght` axis defaults to 100, so a face left at its default
 * instance rendered as Thin. Pinning regular to 400 fixes that.
 *
 * @returns {{variable:boolean, dilate:number}} `dilate` is 0 whenever the font
 *   carries a real weight axis -- there is nothing left to fake.
 */
export function applyWeight(font, bold, fontSize = 0) {
  const axis = weightAxis(font);
  // A face whose axis is present but unsound still gets pinned to regular --
  // that half works, and it is what stops Montserrat rendering every caption in
  // Thin. Only the *bold* half falls back to a stroked outline.
  if (axis) {
    const sound = boldModeFor(font) === 'variable';
    const want = bold && sound ? BOLD_WGHT : REGULAR_WGHT;
    font.variation.set({ wght: Math.min(axis.maxValue, Math.max(axis.minValue, want)) });
    if (sound) return { variable: true, dilate: 0 };
  }
  return { variable: false, dilate: bold ? fontSize * SYNTHETIC_BOLD_FRAC : 0 };
}

/**
 * Lay the string out: which glyph goes where, in font units.
 *
 * Shared by both text animations, because typography is typography however the
 * letters are later revealed.
 *
 * @returns {{placements:{glyph:Object, penX:number, lineIndex:number}[],
 *            scale:number, lineHeight:number, maxWidth:number, lineCount:number}}
 */
export function placeGlyphs(font, text, o) {
  const weight = applyWeight(font, o.bold, o.fontSize);
  const scale = o.fontSize / font.unitsPerEm;
  const lineHeight = o.lineHeight ?? o.fontSize * 1.35;

  const lines = String(text).split('\n');
  const placements = [];
  const lineWidths = [];
  let maxWidth = 0;

  lines.forEach((line, lineIndex) => {
    // charToGlyph rather than stringToGlyphs: the latter runs opentype.js's
    // bidi/shaping engine, which throws on GSUB lookup types it does not
    // implement (DejaVu Sans hits "lookupType: 6 substFormat: 2"). Handwriting
    // is drawn character by character anyway, so shaping buys us nothing here
    // -- and kerning still applies, since getKerningValue works on glyph pairs.
    const chars = [...line];
    const glyphs = chars.map((ch) => font.charToGlyph(ch));
    let penX = 0;
    glyphs.forEach((glyph, i) => {
      if (i > 0) {
        // getKerningValue reads both `kern` and GPOS pair positioning
        penX += font.getKerningValue(glyphs[i - 1], glyph) || 0;
      }
      // On a variable face `advanceWidth` is only brought up to date with the
      // HVAR table as a *side effect* of the variation transform, which nothing
      // else here triggers -- reading it straight would lay bold text out on
      // regular metrics and leave the letters overlapping.
      if (weight.variable) font.variation.getTransform(glyph);
      placements.push({ glyph, ch: chars[i], penX, lineIndex });
      penX += glyph.advanceWidth;
    });
    lineWidths[lineIndex] = penX;
    maxWidth = Math.max(maxWidth, penX);
  });

  // Alignment is a second pass because it is defined against the widest line,
  // which is not known until every line has been measured. Shifting `penX` here
  // rather than at draw time means everything downstream -- glyph bounds, the
  // reveal's word spans, `inkBbox`, the handwriting guides -- is already in the
  // right place and knows nothing about alignment.
  //
  // `maxWidth` itself is untouched, so the drawable's bbox and therefore the
  // clip's placement in frame are the same whichever alignment is chosen.
  const share = ALIGN_FRACTION[o.align ?? DEFAULT_TEXT_ALIGN]
    ?? ALIGN_FRACTION[DEFAULT_TEXT_ALIGN];
  if (share) {
    for (const p of placements) {
      p.penX += (maxWidth - lineWidths[p.lineIndex]) * share;
    }
  }

  return { placements, scale, lineHeight, maxWidth, lineCount: lines.length, weight };
}

/** The drawable's bounds, padded for a pen that overshoots its centreline. */
const textBbox = (fontSize, w, h) =>
  [-fontSize * 0.3, -fontSize * 1.1, w + fontSize * 0.3, h + fontSize * 0.4];

/**
 * Text -> filled letterforms, plus the geometry a left-to-right reveal needs.
 *
 * The outline itself, so the letters *are* the font. No centreline is traced
 * anywhere, which is why this is synchronous and instant.
 *
 * @returns {{regions:Array, lines:Array, bbox:number[], width:number,
 *            height:number, inkBbox:number[]}}
 */
export function outlineText(font, text, o) {
  const { placements, scale, lineHeight, maxWidth, lineCount, weight } = placeGlyphs(font, text, o);
  const color = o.color ?? '#1a1a1a';
  // Half the synthetic bold width, which is how far the emboldening stroke
  // reaches outside the letterform's own outline. Zero on a variable face --
  // there the extra weight is already in the rings.
  const dilate = weight.dilate;
  const grow = dilate / 2;
  // Flattening tolerance in object units. Tied to the size the text is drawn at
  // rather than fixed, or a 400px headline goes visibly faceted.
  const eps = Math.max(0.05, o.fontSize * 0.0025);

  const regions = [];
  const glyphs = [];
  /** Per line: the ink band, and the runs of consecutive inked glyphs in it. */
  const lines = Array.from({ length: lineCount }, () => ({
    y0: Infinity, y1: -Infinity, spans: [], broke: true,
  }));

  for (const p of placements) {
    const line = lines[p.lineIndex];
    // A space has an advance but no contours. That is how a word break is
    // detected here -- the character itself is long gone by this point, and
    // guessing from the gap width instead needs a threshold that separates a
    // space from a letter's sidebearings, which no single number does across
    // fonts and sizes.
    if (!p.glyph.path.commands.length) {
      glyphs.push({ ch: p.ch, lineIndex: p.lineIndex, ink: false });
      line.broke = true;
      continue;
    }

    // opentype positions and scales the outline for us, and emits y-down.
    // The 5th argument is what applies the variation: without it opentype.js
    // silently hands back the default instance, and bold would be a no-op on
    // every face that can actually do it.
    const path = p.glyph.getPath(p.penX * scale, p.lineIndex * lineHeight, o.fontSize, {}, font);
    const rings = flattenCommands(path.commands, { eps })
      .map((s) => s.pts)
      .filter((pts) => pts.length >= 6);
    if (!rings.length) {
      glyphs.push({ ch: p.ch, lineIndex: p.lineIndex, ink: false });
      continue;
    }

    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    for (const pts of rings) {
      for (let i = 0; i < pts.length; i += 2) {
        if (pts[i] < x0) x0 = pts[i];
        if (pts[i] > x1) x1 = pts[i];
        if (pts[i + 1] < y0) y0 = pts[i + 1];
        if (pts[i + 1] > y1) y1 = pts[i + 1];
      }
    }
    // Everything downstream sizes itself off these bounds -- the reveal band in
    // `textReveal`, the glyph wipe in `handwrite`, and `inkBbox` for the eraser
    // -- so growing them here is the single place synthetic bold has to be
    // accounted for.
    x0 -= grow; y0 -= grow; x1 += grow; y1 += grow;
    line.y0 = Math.min(line.y0, y0);
    line.y1 = Math.max(line.y1, y1);

    // A span is a *word*, not a letter: the reveal must not stop and restart
    // between the letters of a word, only across the gaps where the pen lifts.
    const last = line.spans[line.spans.length - 1];
    if (last && !line.broke) last[1] = Math.max(last[1], x1);
    else line.spans.push([x0, x1]);
    line.broke = false;

    const regionIndex = regions.length;
    // `dilate` is omitted rather than set to 0 when it does not apply, so a
    // non-bold layout serialises byte-identically to what it did before.
    regions.push(dilate > 0 ? { rings, color, dilate } : { rings, color });
    glyphs.push({ ch: p.ch, lineIndex: p.lineIndex, ink: true, regionIndex,
      rings, bbox: [x0, y0, x1, y1] });
  }

  const w = maxWidth * scale;
  const h = lineCount * lineHeight;

  // A line with no ink at all (a blank line in the middle of a paragraph) still
  // holds a slot in the layout, but has no band and nothing to reveal.
  for (const line of lines) {
    if (!Number.isFinite(line.y0)) { line.y0 = 0; line.y1 = 0; }
  }

  const inked = lines.filter((l) => l.spans.length);
  const inkBbox = inked.length
    ? [
      Math.min(...inked.map((l) => l.spans[0][0])),
      Math.min(...inked.map((l) => l.y0)),
      Math.max(...inked.map((l) => l.spans[l.spans.length - 1][1])),
      Math.max(...inked.map((l) => l.y1)),
    ]
    : [0, 0, 0, 0];

  return {
    regions,
    glyphs,
    // `broke` is loop bookkeeping, not part of the shape the hosts serialise.
    lines: lines.map(({ y0, y1, spans }) => ({ y0, y1, spans })),
    bbox: textBbox(o.fontSize, w, h),
    inkBbox,
    width: w,
    height: h,
  };
}

/**
 * Convert the selected font's glyphs into calm writing gestures.
 *
 * Each route is defined in a unit square and fitted to the glyph's true ink
 * bounds.  This deliberately does not skeletonise the glyph: an Open Sans
 * "a" and a Caveat "a" need different finished pixels, but a viewer still
 * recognises the same hand gesture making both.
 */
export function traceText(font, text, o) {
  const layout = outlineText(font, text, o);
  const guides = [];
  for (const glyph of layout.glyphs) {
    if (!glyph.ink) continue;
    const route = guideForCharacter(glyph.ch);
    const [x0, y0, x1, y1] = glyph.bbox;
    const w = Math.max(1, x1 - x0);
    const h = Math.max(1, y1 - y0);
    const strokes = route || [[ [0.08, 0.5], [0.92, 0.5] ]];
    for (let i = 0; i < strokes.length; i++) {
      const pts = [];
      for (const [gx, gy] of strokes[i]) pts.push(x0 + gx * w, y0 + gy * h);
      if (pts.length >= 4) guides.push({ pts, glyph: glyph.regionIndex, lift: false,
        width: Math.max(o.penWidth ?? 3, Math.min(w, h) * 0.38) });
      if (i < strokes.length - 1) {
        const a = strokes[i][strokes[i].length - 1];
        const b = strokes[i + 1][0];
        guides.push({ pts: travelArc([x0 + a[0] * w, y0 + a[1] * h], [x0 + b[0] * w, y0 + b[1] * h]).pts,
          glyph: glyph.regionIndex, lift: true, width: 0 });
      }
    }
  }
  // Join adjacent glyph routes with pen-up motion.  Guide entries already
  // retain their glyph ownership, which lets the animation close a completed
  // outline exactly when its last route finishes.
  const joined = [];
  for (const guide of guides) {
    const prev = joined[joined.length - 1];
    if (prev && !prev.lift && !guide.lift && prev.glyph !== guide.glyph) {
      const a = [prev.pts[prev.pts.length - 2], prev.pts[prev.pts.length - 1]];
      const b = [guide.pts[0], guide.pts[1]];
      joined.push({ pts: travelArc(a, b).pts, glyph: prev.glyph, lift: true, width: 0 });
    }
    joined.push(guide);
  }
  return { ...layout, guides: joined };
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
