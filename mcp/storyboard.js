/**
 * Script in, draft video out.
 *
 * This is the tool that makes the server worth using. Building a two-minute
 * explainer clip by clip is thirty tool calls before there is anything to look
 * at; here it is one, and the fine-grained tools become what they should be --
 * refinement rather than construction.
 *
 * The defaults deliberately mirror what the app does when a person clicks the
 * same buttons, so a generated draft is paced like a hand-made one:
 * `textDuration` from App.jsx, four seconds for artwork, swipeLeft over 0.6s
 * between sections.
 *
 * The layout policy is the part with no precedent in the UI. Everything
 * `placeInFrame` places lands at the centre of the frame, because that is the
 * right answer for one drawable added by a person who will then drag it. A beat
 * with both a caption and a picture would put them on top of each other, and an
 * agent has no cursor to fix it with -- so a caption is fitted into a band
 * across the top and the artwork into the space left underneath.
 */

import { cameraAt } from '../src/engine/render/renderFrame.js';
import { compileClip } from '../src/engine/host/nodeSession.js';
import * as edits from '../src/engine/model/edits.js';

/** Rough writing time; a long line should not race by at a fixed duration. */
export const textDuration = (s) =>
  Math.min(12, Math.max(1.6, s.replace(/\s/g, '').length * 0.16));

/** What the app gives a drawable added from the library. */
const ART_SECONDS = 4;

/**
 * Vertical bands, as fractions of frame height.
 *
 * A caption gets the top quarter and artwork the rest. The split is generous to
 * the artwork on purpose: a whiteboard video is a drawing with a label, not a
 * slide with an illustration.
 */
const CAPTION_BAND = 0.26;
const BAND_FILL = 0.86;

/**
 * Fit a drawable into a horizontal band of the frame.
 *
 * `placeInFrame` centres in the whole frame; this centres in a slice of it, by
 * handing it a shorter frame and then shifting the result to that slice's
 * middle. Same shrink-only rule -- nothing is ever blown up to fill a band.
 */
function placeInBand(bbox, meta, band, grow) {
  const height = meta.height * (band.to - band.from);
  const placed = edits.placeInFrame(bbox, { x: 0, y: 0, zoom: 1 },
    { width: meta.width, height }, BAND_FILL, grow);
  // placeInFrame centred it on y=0 of a frame `height` tall; move that centre
  // to where the band actually sits, measured from the frame's middle.
  const centre = meta.height * ((band.from + band.to) / 2 - 0.5);
  return { ...placed, y: Math.round(placed.y + centre) };
}

/**
 * @param {Object} o
 * @param {Object} o.doc document to build on (usually empty, but appending to
 *   an existing one is legal and lands after everything already authored)
 * @param {Array} o.beats `{text?, image?, svg?, seconds?, animId?, erase?, page?}`
 * @param {Object} o.ctx compile context for measuring: {root, sidecar, rel}
 * @returns {Promise<{doc: Object, notes: string[]}>}
 */
export async function storyboard({ doc, beats, ctx }) {
  if (!Array.isArray(beats) || !beats.length) {
    throw new Error('storyboard needs at least one beat');
  }

  let next = doc;
  const notes = [];

  for (const [i, beat] of beats.entries()) {
    if (!beat || (!beat.text && !beat.image && !beat.svg)) {
      throw new Error(`beats[${i}] needs at least one of text, image or svg`);
    }

    // A new page between sections. Never before the first beat: that would
    // transition onto the page the video already opens on.
    if (beat.page && i > 0) {
      next = edits.addPageBreak(next, {
        transition: beat.transition || 'swipeLeft',
        duration: beat.transition === 'cut' ? 0 : 0.6,
      });
    }

    const both = !!beat.text && !!(beat.image || beat.svg);
    const art = beat.image || beat.svg;

    if (beat.text) {
      const seconds = beat.seconds ?? textDuration(beat.text);
      next = await place(next, {
        asset: {
          kind: 'text',
          text: beat.text,
          ...(beat.font ? { font: beat.font } : {}),
          ...(beat.fontSize ? { fontSize: beat.fontSize } : {}),
          ...(beat.color ? { color: beat.color } : {}),
        },
        animId: beat.animId && beat.animId.startsWith('draw.') && !art
          ? beat.animId
          : (beat.textAnimId || 'draw.handwrite'),
        duration: seconds,
        band: both ? { from: 0, to: CAPTION_BAND } : { from: 0.2, to: 0.8 },
        erase: beat.erase,
        ctx,
      });
    }

    if (art) {
      next = await place(next, {
        asset: { kind: beat.svg ? 'vector' : 'image', src: art },
        animId: beat.animId && !beat.animId.startsWith('draw.handwrite')
          ? beat.animId
          : 'draw.imageReveal',
        duration: beat.seconds ?? ART_SECONDS,
        band: both ? { from: CAPTION_BAND, to: 1 } : { from: 0.1, to: 0.9 },
        erase: beat.erase,
        ctx,
      });
    }
  }

  return { doc: next, notes };
}

/** Add one clip and put it in its band. */
async function place(doc, { asset, animId, duration, band, erase, ctx }) {
  const before = new Set(doc.clips.map((c) => c.id));
  let next = edits.addClipTo(doc, asset, { animId, duration });
  const clip = next.clips.find((c) => !before.has(c.id));

  const built = await compileClip(clip, next.assets[clip.assetId], ctx);
  const page = next.pages.find((p) => p.id === clip.pageId) ?? next.pages[0];
  const cam = cameraAt(page, clip.start);
  // Vector artwork is scaled up to fill its band; see placeInFrame for why it
  // is the only kind that may be.
  const placed = placeInBand(built.plan.bbox, next.meta, band, asset.kind === 'vector');
  // The band is computed against the composition; a camera that has moved means
  // the whole layout travels with it.
  next = edits.patchTransform(next, clip.id, {
    ...placed,
    x: Math.round(placed.x + cam.x),
    y: Math.round(placed.y + cam.y),
  });

  if (erase) {
    const end = clip.start + duration;
    next = edits.patchClip(next, clip.id, {
      erase: { start: Math.round((end + (erase.after ?? 0.4)) * 10) / 10,
               duration: erase.duration ?? 1.5 },
    });
  }
  return next;
}
