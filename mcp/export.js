/**
 * Video export, as a background job.
 *
 * A minute of video is thousands of frames and takes minutes to encode. An MCP
 * client will not wait that long for a tool result, so `export_video` starts
 * the work and returns a handle; `export_status` reports on it. The agent gets
 * to do something useful in between instead of holding the channel open.
 *
 * A draft `scale` renders the composition at full size and shrinks each frame
 * on the way into ffmpeg, rather than rendering small. Same reason as the
 * contact sheet: `renderFrame` treats its canvas size as the composition size,
 * so a smaller canvas would crop the shot rather than shrink it, and a draft
 * that is framed differently from the final is worse than no draft.
 */

import { createCanvas } from '@napi-rs/canvas';
import { join } from 'node:path';

import { exportVideo } from '../src/engine/export/driver.js';
import { renderFrame } from '../src/engine/render/renderFrame.js';
import { EXPORT_DIR, ensureWorkspace, readablePath } from './workspace.js';

/** Even dimensions: h264 chroma subsampling cannot represent an odd one. */
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

export class Exports {
  constructor() {
    this.jobs = new Map();
    this.seq = 0;
  }

  get(id) { return this.jobs.get(id); }

  list() {
    return [...this.jobs.values()].map(({ id, name, state, frame, total, out, error }) =>
      ({ id, name, state, frame, total, out, error }));
  }

  /**
   * @param {Object} built the compiled session from Studio
   * @param {Object} o
   * @param {string} o.name project name, used for the output filename
   * @param {number} [o.scale=1] 0.5 for a fast draft
   * @param {number} [o.fps] override, for a cheaper draft
   */
  start(built, { name, scale = 1, fps: fpsOverride } = {}) {
    ensureWorkspace();
    const { project, session } = built;
    const fps = fpsOverride || project.meta.fps;
    const srcW = project.meta.width;
    const srcH = project.meta.height;
    const width = even(srcW * scale);
    const height = even(srcH * scale);

    // Retiming for a draft changes how many frames cover the same seconds; the
    // duration has to stay put or the draft is not the same video.
    const seconds = built.frames / project.meta.fps;
    const frames = Math.max(1, Math.round(seconds * fps));

    const id = `export${++this.seq}`;
    const out = join(EXPORT_DIR, `${name}${scale === 1 ? '' : `-draft${Math.round(scale * 100)}`}.mp4`);
    const job = { id, name, state: 'running', frame: 0, total: frames, out, error: null,
                  startedAt: Date.now(), finishedAt: null };
    this.jobs.set(id, job);

    const full = createCanvas(srcW, srcH);
    const fullCtx = full.getContext('2d');
    const small = width === srcW && height === srcH ? null : createCanvas(width, height);
    const smallCtx = small?.getContext('2d');

    const render = (n) => {
      // The draft's frame n is the same instant as the original's, not the same
      // index -- otherwise a halved fps would play at double speed.
      const at = fpsOverride ? Math.round((n / fps) * project.meta.fps) : n;
      renderFrame(session, project, at, fullCtx, {
        width: srcW,
        height: srcH,
        showHand: project.meta.showHand !== false,
        handStyleId: project.meta.handStyleId,
      });
      job.frame = n;
      if (!small) return full.data();
      smallCtx.drawImage(full, 0, 0, width, height);
      return small.data();
    };

    // Deliberately not awaited: the tool call returns the handle immediately.
    exportVideo({
      frames, width, height, fps, out,
      audio: project.audio.map((a) => ({ ...a, file: readablePath(a.src) })),
      renderFrameRGBA: render,
      onProgress: ({ frame }) => { job.frame = frame; },
    }).then(() => {
      job.state = 'done';
      job.frame = frames;
      job.finishedAt = Date.now();
    }).catch((e) => {
      job.state = 'failed';
      job.error = `${e.message}`.slice(0, 2000);
      job.finishedAt = Date.now();
    });

    return {
      id,
      out,
      width,
      height,
      fps,
      frames,
      duration: Math.round(seconds * 100) / 100,
    };
  }
}
