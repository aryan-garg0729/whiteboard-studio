/**
 * Burned-in narration text, drawn in screen space over the finished frame.
 *
 * Subtitles are not clips and not artwork. They sit outside the camera
 * transform for the same reason the hand does: they must keep a constant
 * apparent size and a constant position on the frame however far the camera has
 * zoomed into the paper, and they must survive a page transition rather than
 * sliding off with the sheet. So this runs last, after the hand, against the
 * raw destination context.
 *
 * The letterforms come from `outlineText`, the same path text clips use, rather
 * than from `ctx.fillText`. That is deliberate: @napi-rs/canvas and the
 * browser's OffscreenCanvas resolve `ctx.font` against different font stacks,
 * so a `fillText` subtitle would render one way in the editor's preview and
 * another way in the exported file. Going through the font's own outlines makes
 * the two byte-identical, and it hands us per-glyph geometry for free -- which
 * is what makes recolouring a single word possible at all.
 */

import { outlineText } from '../compile/text.js';
import { buildCues, cueAt } from '../model/subtitles.js';
import { paintVectorArt } from './vectorArt.js';

/** How long a word takes to pop in, and how small it starts. */
const POP_SECONDS = 0.12;
const POP_FROM = 0.72;

/** Padding around the ink for the backing plate, as a fraction of font size. */
const PLATE_PAD_X = 0.42;
const PLATE_PAD_Y = 0.3;

/** Widest the text may run, as a fraction of the frame. */
const FIT_WIDTH = 0.92;

const easeOut = (u) => 1 - (1 - u) * (1 - u);

/**
 * Cues, laid out, cached on the session.
 *
 * A semantically transparent cache, which is what the determinism rules in
 * `renderFrame.js` permit: the pixels written still depend only on (project, t).
 * Keyed on the identity of `project.subtitles` -- every document transform is a
 * pure `doc -> doc` that produces a fresh object, so a changed reference is
 * exactly the signal that the layout is stale, and an unchanged one is a
 * guarantee that it is not.
 *
 * Laying out is not cheap -- it flattens every glyph outline in the transcript
 * -- so it must never happen per frame.
 */
export function subtitlePlan(session, project) {
  const subs = project.subtitles;
  if (!subs?.enabled || !subs.words?.length || !session.subtitleFont) return null;

  const cached = session.subtitleCache;
  if (cached && cached.src === subs) return cached.plan;

  const plan = layOutCues(session.subtitleFont, subs);
  session.subtitleCache = { src: subs, plan };
  return plan;
}

function layOutCues(font, subs) {
  const cues = buildCues(subs).map((cue) => {
    const layout = outlineText(font, cue.text, {
      fontSize: subs.fontSize,
      bold: subs.bold,
      color: subs.color,
    });
    return { ...cue, layout, words: mapWords(cue, layout) };
  });
  return { cues, holdTail: subs.holdTail ?? 0 };
}

/**
 * Attach each word to the glyph regions that were laid out for it.
 *
 * `layout.glyphs` is one entry per character in text order, inked or not, and
 * `regions` are pushed in that same order -- so a word owns a contiguous run of
 * region indices. The walk is by code point rather than by string index because
 * `placeGlyphs` splits with `[...line]`; on any text outside the BMP an index
 * walk would drift by one per astral character and highlight the wrong word.
 */
function mapWords(cue, layout) {
  // Character offset (into `cue.text`) of each glyph, in glyph order.
  const offsets = [];
  const lines = cue.lines.map((line) => [...line]);
  let lineIndex = 0;
  let cursor = 0;                 // offset of the start of the current line
  let within = 0;                 // code-point position inside the current line

  for (const g of layout.glyphs) {
    while (g.lineIndex > lineIndex) {
      // +1 for the "\n" that joins the lines back into `cue.text`.
      cursor += cue.lines[lineIndex].length + 1;
      lineIndex++;
      within = 0;
    }
    let offset = cursor;
    for (let i = 0; i < within; i++) offset += lines[lineIndex][i].length;
    offsets.push(offset);
    within++;
  }

  return cue.words.map((word) => {
    let r0 = Infinity;
    let r1 = -Infinity;
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    for (let i = 0; i < layout.glyphs.length; i++) {
      const g = layout.glyphs[i];
      if (!g.ink) continue;
      if (offsets[i] < word.from || offsets[i] >= word.to) continue;
      r0 = Math.min(r0, g.regionIndex);
      r1 = Math.max(r1, g.regionIndex + 1);
      x0 = Math.min(x0, g.bbox[0]); y0 = Math.min(y0, g.bbox[1]);
      x1 = Math.max(x1, g.bbox[2]); y1 = Math.max(y1, g.bbox[3]);
    }
    // A word of pure whitespace or of glyphs the font has no outline for owns no
    // regions. It still keeps its timing so the cue's word count stays honest.
    const inked = Number.isFinite(r0);
    return {
      ...word,
      regionFrom: inked ? r0 : 0,
      regionTo: inked ? r1 : 0,
      centre: inked ? [(x0 + x1) / 2, (y0 + y1) / 2] : [0, 0],
    };
  });
}

/**
 * Paint the cue on screen at `t`, if there is one.
 *
 * @param {any} ctx destination context, at the *render* size
 * @param {Object} plan from `subtitlePlan`
 * @param {Object} project for `meta` and the presentation settings
 * @param {number} t seconds
 * @param {{width:number, height:number}} opts render size, which is not
 *   necessarily the composition size -- a draft export renders small.
 */
export function drawSubtitles(ctx, plan, project, t, opts) {
  const cue = cueAt(plan.cues, t, plan.holdTail);
  if (!cue) return;

  const subs = project.subtitles;
  const { width, height } = opts;
  const layout = cue.layout;
  const [ix0, iy0, ix1, iy1] = layout.inkBbox;
  if (ix1 <= ix0) return;

  // Everything below works in text units and lets the transform do the scaling,
  // so a half-size draft export gets half-size subtitles rather than subtitles
  // at composition pixel size on a small frame.
  const fit = Math.min(1, (width * FIT_WIDTH) / ((ix1 - ix0) * (height / project.meta.height)));
  const k = (height / project.meta.height) * fit;

  const padX = subs.fontSize * PLATE_PAD_X;
  const padY = subs.fontSize * PLATE_PAD_Y;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.scale(k, k);
  ctx.translate(
    width / (2 * k) - (ix0 + ix1) / 2,
    height * (1 - subs.marginBottom) / k - iy1,
  );

  const plate = plateBox(cue, subs, t) ?? layout.inkBbox;
  if (subs.background && !/^#[0-9a-f]{6}00$/i.test(subs.background)) {
    ctx.fillStyle = subs.background;
    roundRect(ctx, plate[0] - padX, plate[1] - padY,
      (plate[2] - plate[0]) + padX * 2, (plate[3] - plate[1]) + padY * 2,
      subs.fontSize * 0.18);
    ctx.fill();
  }

  if (subs.style === 'pop') drawPop(ctx, cue, subs, t);
  else drawWhole(ctx, cue, subs, t);

  ctx.restore();
}

/**
 * What the backing plate has to cover.
 *
 * For `bar` and `karaoke` that is the whole cue -- every word is on screen, and
 * a plate that resized as words were highlighted would twitch under text that
 * is not moving. `pop` shows the cue a word at a time, so a whole-cue plate
 * would trail a slab of empty colour where the unspoken words are going to be;
 * it gets a plate around the words actually visible instead. The words keep
 * their final positions either way, so nothing reflows as the plate grows.
 *
 * @returns {number[]|null} `[x0, y0, x1, y1]`, or null to use the cue's own ink
 */
function plateBox(cue, subs, t) {
  if (subs.style !== 'pop') return null;
  const [, y0, , y1] = cue.layout.inkBbox;
  let x0 = Infinity;
  let x1 = -Infinity;
  for (const w of cue.words) {
    if (w.start > t || w.regionTo <= w.regionFrom) continue;
    for (let i = w.regionFrom; i < w.regionTo; i++) {
      for (const ring of cue.layout.regions[i].rings) {
        for (let j = 0; j < ring.length; j += 2) {
          if (ring[j] < x0) x0 = ring[j];
          if (ring[j] > x1) x1 = ring[j];
        }
      }
    }
  }
  return Number.isFinite(x0) ? [x0, y0, x1, y1] : null;
}

/**
 * `bar` and `karaoke`: the whole cue is up, and only the colouring differs.
 *
 * They share a path because they are the same subtitle -- `bar` is `karaoke`
 * with the highlight turned off -- and splitting them would mean two places to
 * get the layout right.
 */
function drawWhole(ctx, cue, subs, t) {
  const regions = cue.layout.regions;
  const spoken = subs.style === 'karaoke' ? new Set() : null;
  if (spoken) {
    for (const w of cue.words) {
      if (w.start <= t) for (let i = w.regionFrom; i < w.regionTo; i++) spoken.add(i);
    }
  }
  // Recolour per region rather than laying the cue out twice: `outlineText`
  // gives every region one uniform colour, but `paintVectorArt` reads
  // `region.color` off each region as it paints it.
  paintVectorArt(ctx, regions.map((r, i) => (
    spoken?.has(i) ? { ...r, color: subs.highlight } : r
  )), []);
}

/** `pop`: each word arrives on its own timestamp, scaling up about its centre. */
function drawPop(ctx, cue, subs, t) {
  for (const w of cue.words) {
    if (w.start > t || w.regionTo <= w.regionFrom) continue;
    const u = POP_SECONDS > 0 ? Math.min(1, (t - w.start) / POP_SECONDS) : 1;
    const e = easeOut(u);
    const scale = POP_FROM + (1 - POP_FROM) * e;
    ctx.save();
    ctx.globalAlpha = e;
    ctx.translate(w.centre[0], w.centre[1]);
    ctx.scale(scale, scale);
    ctx.translate(-w.centre[0], -w.centre[1]);
    // The word being spoken right now carries the highlight; the ones already
    // said settle back to the base colour, so the eye tracks the live word.
    const live = t <= w.end;
    paintVectorArt(ctx, cue.layout.regions.slice(w.regionFrom, w.regionTo).map((r) => (
      live ? { ...r, color: subs.highlight } : r
    )), []);
    ctx.restore();
  }
}

/** `ctx.roundRect` is not on @napi-rs/canvas's 2D context, so: by hand. */
function roundRect(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.lineTo(x + w - rad, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
  ctx.lineTo(x + w, y + h - rad);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
  ctx.lineTo(x + rad, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rad);
  ctx.lineTo(x, y + rad);
  ctx.quadraticCurveTo(x, y, x + rad, y);
  ctx.closePath();
}
