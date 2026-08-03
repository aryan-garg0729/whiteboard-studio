/**
 * Turning a session into something an agent can look at.
 *
 * The whole feedback loop rests on this, so the sizing matters more than it
 * seems. A 1920x1080 PNG is well over a megabyte once base64'd, and an agent
 * that spends its context on four of those has none left to reason with. So
 * frames go out at 720px wide by default and a contact sheet at 1200px total --
 * enough to see composition, timing and whether the hand is where it should be,
 * which is what these are actually for. Anything finer is a job for
 * `export_video` and a real player.
 *
 * Downscaling is a second blit rather than a smaller render. `renderFrame`
 * treats its width and height as the composition size, so asking it for a
 * smaller canvas crops the frame instead of shrinking it -- the camera maths
 * maps world to canvas through `size/2`, not through a scale factor.
 */

import { GlobalFonts, createCanvas } from '@napi-rs/canvas';
import { join } from 'node:path';

import { renderFrame } from '../src/engine/render/renderFrame.js';
import { projectFrames } from '../src/engine/model/project.js';
import { ROOT } from './workspace.js';

/**
 * The contact sheet's own label font.
 *
 * Nothing else here draws text, so no font is registered and the timestamps
 * come out as tofu boxes -- which is worse than useless, because the sheet
 * still looks fine at a glance and the one piece of information it carries
 * beyond the pixels is silently gone. A bundled face is used rather than a
 * system one so this behaves identically wherever it runs.
 */
const LABEL_FAMILY = 'wb-sheet-label';
GlobalFonts.registerFromPath(join(ROOT, 'assets/fonts/OpenSans.ttf'), LABEL_FAMILY);

/** Default long edge for a single frame. */
export const FRAME_WIDTH = 720;

/** Default long edge for a whole contact sheet, not per cell. */
export const SHEET_WIDTH = 1200;

/**
 * Paint one frame at full composition size.
 *
 * Callers reuse the returned canvas across frames; allocating a 1920x1080
 * canvas per frame of a contact sheet is most of the cost of making one.
 */
export function paintFrame(built, frameIndex, canvas) {
  const { session, project } = built;
  const { width, height } = project.meta;
  const c = canvas ?? createCanvas(width, height);
  renderFrame(session, project, frameIndex, c.getContext('2d'), {
    width,
    height,
    showHand: project.meta.showHand !== false,
    handStyleId: project.meta.handStyleId,
  });
  return c;
}

const scaleTo = (src, width) => {
  const height = Math.max(1, Math.round((src.height / src.width) * width));
  const out = createCanvas(width, height);
  const ctx = out.getContext('2d');
  ctx.drawImage(src, 0, 0, width, height);
  return out;
};

/** Clamp a time or frame request to something the project actually has. */
export function resolveFrame(project, { time, frame }) {
  const total = projectFrames(project);
  const last = Math.max(0, total - 1);
  if (frame !== undefined && frame !== null) {
    return Math.min(last, Math.max(0, Math.round(frame)));
  }
  const fps = project.meta.fps;
  return Math.min(last, Math.max(0, Math.round((time ?? 0) * fps)));
}

export function renderOne(built, frameIndex, { width = FRAME_WIDTH } = {}) {
  const full = paintFrame(built, frameIndex);
  const out = width >= full.width ? full : scaleTo(full, width);
  return {
    png: out.toBuffer('image/png'),
    frame: frameIndex,
    time: Math.round((frameIndex / built.project.meta.fps) * 100) / 100,
    width: out.width,
    height: out.height,
  };
}

/**
 * The whole video in one image.
 *
 * Cheaper for the model than N separate frames by a wide margin -- one image
 * block, one description, and the comparison between moments is spatial rather
 * than something it has to hold in memory across several attachments. Samples
 * are spread across the timeline rather than taken at clip boundaries, so a
 * long silent stretch shows up as a run of identical cells, which is exactly
 * the pacing problem worth seeing.
 */
export function renderContactSheet(built, { count = 9, width = SHEET_WIDTH, from = 0, to } = {}) {
  const { project } = built;
  const total = projectFrames(project);
  if (!total) throw new Error('project has no clips, nothing to render');

  const fps = project.meta.fps;
  const first = Math.max(0, Math.round(from * fps));
  const last = Math.min(total - 1, to === undefined ? total - 1 : Math.round(to * fps));
  const n = Math.max(1, Math.min(25, Math.round(count)));

  const cols = Math.min(n, Math.ceil(Math.sqrt(n)));
  const rows = Math.ceil(n / cols);

  const gap = 8;
  const label = 22;
  const cellW = Math.floor((width - gap * (cols + 1)) / cols);
  const cellH = Math.round((project.meta.height / project.meta.width) * cellW);

  const sheet = createCanvas(width, rows * (cellH + label + gap) + gap);
  const ctx = sheet.getContext('2d');
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(0, 0, sheet.width, sheet.height);

  // One full-size scratch canvas for every cell; see paintFrame.
  const scratch = createCanvas(project.meta.width, project.meta.height);
  const times = [];

  for (let i = 0; i < n; i++) {
    const frame = n === 1 ? first : Math.round(first + ((last - first) * i) / (n - 1));
    paintFrame(built, frame, scratch);
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = gap + col * (cellW + gap);
    const y = gap + row * (cellH + label + gap);
    ctx.drawImage(scratch, x, y, cellW, cellH);

    const t = frame / fps;
    times.push(Math.round(t * 100) / 100);
    ctx.fillStyle = '#e8e8e8';
    ctx.font = `13px ${LABEL_FAMILY}`;
    ctx.fillText(`${t.toFixed(2)}s  ·  frame ${frame}`, x + 2, y + cellH + 15);
  }

  return {
    png: sheet.toBuffer('image/png'),
    width: sheet.width,
    height: sheet.height,
    times,
  };
}
