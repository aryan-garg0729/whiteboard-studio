#!/usr/bin/env node
/**
 * MCP server for the whiteboard studio.
 *
 * Exposes the authoring loop over stdio: build a document, look at rendered
 * frames, refine, export. The engine underneath is the same one the app and the
 * CLI use -- `buildNodeSession` is shared with `scripts/render-project.js`, so a
 * frame an agent inspects here is the frame that ends up in the MP4.
 *
 * Everything the server writes stays inside `mcp-workspace/`.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';

import * as edits from '../src/engine/model/edits.js';
import { parseSvg } from '../src/engine/compile/svgDoc.js';
import { capabilities, animations, fonts, checkHandStyle } from './capabilities.js';
import { AUTHORING_GUIDE } from './guide.js';
import { Exports } from './export.js';
import { Studio } from './studio.js';
import { renderContactSheet, renderOne, resolveFrame } from './render.js';
import { storyboard } from './storyboard.js';
import {
  ROOT, WORKSPACE, ensureWorkspace, importAsset, listProjects, readablePath, writablePath,
} from './workspace.js';
import { HAND_STYLE_IDS } from '../src/engine/hand/styles.js';
import { TRANSITIONS } from '../src/engine/model/project.js';

const studio = new Studio({ root: ROOT });
const exports_ = new Exports();

ensureWorkspace();

const server = new McpServer(
  { name: 'whiteboard-studio', version: '0.1.0' },
  {
    instructions:
      'Authors whiteboard animation videos: a hand draws artwork and writes captions on '
      + 'sheets of paper. Call list_capabilities first, then create_project and storyboard '
      + 'to lay out a whole script in one call, then render_contact_sheet to see the result. '
      + 'Read whiteboard://guide/authoring before your first project.',
  });

// ── plumbing ──────────────────────────────────────────────────────────

const json = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

const image = (png, note) => ({
  content: [
    { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
    ...(note ? [{ type: 'text', text: note }] : []),
  ],
});

/**
 * Turn a thrown error into a tool result rather than a protocol failure.
 *
 * The validator's messages are the feedback channel -- they name the field and
 * explain the conflict in a sentence ("erase begins at 4.1s but the clip is
 * still drawing until 5.2s"), which is more useful to an agent than anything
 * this layer could add. So they pass through verbatim, tagged with the error
 * class so a caller can tell a rule violation from a bug.
 */
const tool = (fn) => async (args) => {
  try {
    return await fn(args);
  } catch (e) {
    const known = ['ProjectError', 'EditError', 'InvalidInput', 'WorkspaceError'];
    if (!known.includes(e.name)) throw e;
    return {
      isError: true,
      content: [{ type: 'text', text: `${e.name}: ${e.message}` }],
    };
  }
};

/** Every mutating tool answers the same way: what happened, and what now holds. */
const after = async (name, extra = {}) => {
  const view = await studio.describe(name);
  return json({
    ok: true,
    ...extra,
    project: {
      name: view.name,
      duration: view.duration,
      frames: view.frames,
      clips: view.clips.map((c) => ({
        id: c.id, kind: c.kind, label: c.label, start: c.start, end: c.end,
        pageId: c.pageId, rect: c.rect,
      })),
      pageBreaks: view.pageBreaks,
    },
    warnings: view.warnings,
  });
};

// ── discovery ─────────────────────────────────────────────────────────

server.registerTool('list_capabilities', {
  title: 'List capabilities',
  description:
    'Everything the studio can do: animation ids with their parameter schemas and the asset '
    + 'kinds each suits, bundled fonts, hand styles, page transitions, schema defaults, and '
    + 'whether ffmpeg and the Python sidecar are installed. Call this once before authoring.',
  inputSchema: {},
}, tool(async () => json(await capabilities(studio.sidecar()))));

// ── lifecycle ─────────────────────────────────────────────────────────

server.registerTool('create_project', {
  title: 'Create project',
  description: 'Start a new, empty project in the workspace.',
  inputSchema: {
    name: z.string().describe('filename-safe: letters, digits, - and _'),
    fps: z.number().min(1).max(240).optional(),
    width: z.number().min(16).max(7680).optional(),
    height: z.number().min(16).max(4320).optional(),
    background: z.string().optional().describe('CSS colour of the paper'),
    handStyleId: z.enum(HAND_STYLE_IDS).optional(),
    showHand: z.boolean().optional(),
  },
}, tool(async ({ name, ...meta }) => {
  checkHandStyle(meta.handStyleId);
  const clean = Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== undefined));
  const doc = studio.create(name, clean);
  return json({ ok: true, name, meta: doc.meta,
    hint: 'use storyboard to lay out a whole script in one call' });
}));

server.registerTool('list_projects', {
  title: 'List projects',
  description: 'Projects in the workspace, newest first.',
  inputSchema: {},
}, tool(async () => json({ workspace: WORKSPACE, projects: listProjects() })));

server.registerTool('get_project', {
  title: 'Get project',
  description:
    'The full document plus a computed view: per clip its time range, page, lane and '
    + 'world-space rect, the total duration, and warnings for clips that run off the frame '
    + 'or overlap another clip while both are on screen.',
  inputSchema: { name: z.string() },
}, tool(async ({ name }) => json(await studio.describe(name))));

server.registerTool('undo', {
  title: 'Undo',
  description: 'Revert the last edit to a project.',
  inputSchema: { name: z.string() },
}, tool(async ({ name }) => {
  const doc = studio.undo(name);
  if (!doc) return json({ ok: false, reason: 'nothing to undo' });
  return after(name, { undone: true });
}));

// ── artwork ───────────────────────────────────────────────────────────

server.registerTool('write_svg', {
  title: 'Write SVG artwork',
  description:
    'Write SVG markup into the workspace and return a path usable as a vector asset. '
    + 'Vector artwork keeps its own geometry as the artwork it paints -- exactly as written -- '
    + 'so this is the best way to make diagrams, arrows, boxes and icons, and it needs no '
    + 'image files and no Python. Keep paths simple: every subpath becomes a pen stroke.',
  inputSchema: {
    name: z.string().describe('filename, e.g. "arrow.svg"'),
    markup: z.string().describe('a complete <svg> document'),
  },
}, tool(async ({ name, markup }) => {
  const path = writablePath(name.endsWith('.svg') ? name : `${name}.svg`);
  // Parse before writing: a typo that yields no geometry would otherwise only
  // surface as an empty clip several calls later, with nothing pointing here.
  const parsed = parseSvg(markup, { eps: 0.2 });
  if (!parsed.subpaths.length) {
    return json({ ok: false, error: 'that SVG has no drawable geometry — '
      + 'check for a missing viewBox, zero-size shapes, or fill/stroke set to none' });
  }
  writeFileSync(path, markup);
  return json({ ok: true, path, subpaths: parsed.subpaths.length,
    regions: parsed.regions.length, bbox: parsed.bbox });
}));

server.registerTool('import_asset', {
  title: 'Import asset',
  description:
    'Copy an image or audio file from anywhere on disk into the workspace and return the '
    + 'interior path. The server reads only from its own workspace, so any external file has '
    + 'to come through here first.',
  inputSchema: { path: z.string().describe('absolute path to the source file') },
}, tool(async ({ path }) => json({ ok: true, path: importAsset(path) })));

// ── editing ───────────────────────────────────────────────────────────

const eraseSchema = z.object({
  start: z.number().min(0),
  duration: z.number().min(0.01).default(1.5),
}).describe('wipe the ink away; must begin after the clip finishes drawing');

server.registerTool('add_clip', {
  title: 'Add clip',
  description:
    'Add an asset and a clip that draws it, appended after everything already authored. '
    + 'Omit `transform` and the clip is compiled, measured and fitted to the frame for you — '
    + 'strongly preferred, since a drawable\'s origin is its bounding-box corner and a raw '
    + '(0,0) puts it off centre.',
  inputSchema: {
    name: z.string(),
    kind: z.enum(['text', 'image', 'vector']),
    text: z.string().optional().describe('for kind=text'),
    src: z.string().optional().describe('workspace path, for kind=image or vector'),
    font: z.string().optional(),
    fontSize: z.number().optional(),
    penWidth: z.number().optional(),
    color: z.string().optional(),
    bold: z.boolean().optional().describe('for kind=text'),
    animId: z.string().optional(),
    duration: z.number().min(0.01).optional(),
    transform: z.object({
      x: z.number().optional(), y: z.number().optional(),
      scale: z.number().positive().optional(), rotation: z.number().optional(),
    }).optional(),
    params: z.record(z.string(), z.any()).optional(),
  },
}, tool(async ({ name, kind, text, src, font, fontSize, penWidth, color, bold, ...rest }) => {
  if (kind === 'text' && !text) throw new edits.EditError('kind=text needs `text`');
  if (kind !== 'text' && !src) throw new edits.EditError(`kind=${kind} needs \`src\``);

  const asset = kind === 'text'
    ? { kind, text,
        ...(font ? { font: readablePath(font) } : {}),
        ...(fontSize !== undefined ? { fontSize } : {}),
        ...(penWidth !== undefined ? { penWidth } : {}),
        ...(color ? { color } : {}),
        ...(bold !== undefined ? { bold } : {}) }
    : { kind, src: readablePath(src) };

  const duration = rest.duration
    ?? (kind === 'text' ? Math.min(12, Math.max(1.6, text.replace(/\s/g, '').length * 0.16)) : 4);

  const r = await studio.addClip(name, asset, { ...rest, duration });
  return after(name, { clipId: r.clipId, assetId: r.assetId, notes: r.notes });
}));

server.registerTool('update_clip', {
  title: 'Update clip',
  description:
    'Change a clip\'s timing, placement, animation, parameters or erase sweep. Pass '
    + '`erase: null` to remove a sweep. To change what a caption says, use update_asset.',
  inputSchema: {
    name: z.string(),
    clipId: z.string(),
    start: z.number().min(0).optional(),
    duration: z.number().min(0.01).optional(),
    pageId: z.string().optional(),
    trackId: z.string().optional(),
    animId: z.string().optional(),
    transform: z.object({
      x: z.number().optional(), y: z.number().optional(),
      scale: z.number().positive().optional(), rotation: z.number().optional(),
    }).optional(),
    params: z.record(z.string(), z.any()).optional(),
    erase: eraseSchema.nullable().optional(),
  },
}, tool(async ({ name, clipId, ...patch }) => {
  const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  const notes = studio.updateClip(name, clipId, clean);
  return after(name, { clipId, notes });
}));

server.registerTool('update_asset', {
  title: 'Update asset',
  description:
    'Change the material a clip draws: the words of a caption, its font, size, pen width, '
    + 'colour or weight, or an image\'s source file. This is how you reword text — the string '
    + 'lives on the asset, not the clip. Every clip sharing the asset changes with it.',
  inputSchema: {
    name: z.string(),
    assetId: z.string(),
    text: z.string().optional(),
    font: z.string().optional(),
    fontSize: z.number().optional(),
    penWidth: z.number().optional(),
    color: z.string().optional(),
    bold: z.boolean().optional(),
    src: z.string().optional(),
  },
}, tool(async ({ name, assetId, ...patch }) => {
  const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  if (!Object.keys(clean).length) throw new edits.EditError('nothing to change');
  studio.updateAsset(name, assetId, clean);
  return after(name, { assetId });
}));

server.registerTool('remove_clip', {
  title: 'Remove clip',
  description: 'Delete a clip, and its asset if nothing else uses it.',
  inputSchema: { name: z.string(), clipId: z.string() },
}, tool(async ({ name, clipId }) => {
  studio.removeClip(name, clipId);
  return after(name, { removed: clipId });
}));

server.registerTool('add_page', {
  title: 'Add page',
  description:
    'Turn to a fresh sheet, or back to one already used. The break lands after everything '
    + 'already authored — a break dropped into the middle would orphan every later clip still '
    + 'drawing on the outgoing page. Clips added afterwards land on the new sheet.',
  inputSchema: {
    name: z.string(),
    pageId: z.string().optional().describe('an existing page to return to; omit for a new one'),
    transition: z.enum([...TRANSITIONS]).default('swipeLeft'),
    duration: z.number().min(0.01).default(0.6).describe('ignored for a cut'),
    t: z.number().min(0).optional().describe('earliest time; a floor, not a position'),
  },
}, tool(async ({ name, ...opts }) => {
  studio.commit(name, (d) => edits.addPageBreak(d, opts));
  const view = await studio.describe(name);
  return json({ ok: true, pages: view.pages.map((p) => p.id), pageBreaks: view.pageBreaks });
}));

server.registerTool('set_camera', {
  title: 'Set camera',
  description:
    'Frame a page at a moment. The move *arrives* at `t` rather than departing from it: a hold '
    + 'keyframe is planted `moveDuration` earlier, so the camera is settled when the pen lands '
    + 'instead of creeping for the whole video.',
  inputSchema: {
    name: z.string(),
    pageId: z.string(),
    t: z.number().min(0),
    x: z.number().default(0),
    y: z.number().default(0),
    zoom: z.number().min(0.01).max(100).default(1),
    moveDuration: z.number().min(0).default(1),
  },
}, tool(async ({ name, pageId, t, x, y, zoom, moveDuration }) => {
  if (!studio.doc(name).pages.some((p) => p.id === pageId)) {
    throw new edits.EditError(`no such page ${JSON.stringify(pageId)}`);
  }
  studio.commit(name, (d) => edits.withCameraAt(d, pageId, t, { x, y, zoom }, { moveDuration }));
  const view = await studio.describe(name);
  return json({ ok: true, page: view.pages.find((p) => p.id === pageId) });
}));

server.registerTool('set_meta', {
  title: 'Set project meta',
  description: 'Change fps, size, paper colour, hand style, or whether the hand is drawn.',
  inputSchema: {
    name: z.string(),
    fps: z.number().min(1).max(240).optional(),
    width: z.number().min(16).max(7680).optional(),
    height: z.number().min(16).max(4320).optional(),
    background: z.string().optional(),
    handStyleId: z.enum(HAND_STYLE_IDS).optional(),
    showHand: z.boolean().optional(),
  },
}, tool(async ({ name, ...patch }) => {
  checkHandStyle(patch.handStyleId);
  const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  // A different hand needs its sprites loaded, and a resize changes every
  // surface; both mean the cached session is no longer the right one.
  studio.commit(name, (d) => edits.patchMeta(d, clean), { structural: true });
  return after(name, { meta: studio.doc(name).meta });
}));

server.registerTool('add_audio', {
  title: 'Add audio',
  description: 'Lay an audio file onto an audio lane. Import it into the workspace first.',
  inputSchema: {
    name: z.string(),
    src: z.string(),
    start: z.number().min(0).default(0),
    trimIn: z.number().min(0).default(0),
    duration: z.number().min(0.01).optional(),
    gain: z.number().min(0).max(8).default(1),
  },
}, tool(async ({ name, src, ...track }) => {
  studio.commit(name, (d) => edits.addAudio(d, { src: readablePath(src), ...track }));
  return json({ ok: true, audio: studio.doc(name).audio });
}));

server.registerTool('remove_audio', {
  title: 'Remove audio',
  description: 'Drop an audio item by its index.',
  inputSchema: { name: z.string(), index: z.number().min(0) },
}, tool(async ({ name, index }) => {
  studio.commit(name, (d) => edits.removeAudio(d, index));
  return json({ ok: true, audio: studio.doc(name).audio });
}));

// ── storyboard ────────────────────────────────────────────────────────

server.registerTool('storyboard', {
  title: 'Storyboard',
  description:
    'Lay out a whole script in one call: captions, artwork, timing and page breaks between '
    + 'sections. Durations follow the app\'s own conventions (0.16s per character for text, '
    + '~4s for artwork), and a beat with both a caption and a picture puts the caption in a '
    + 'band across the top with the artwork beneath, so they do not collide. This is the '
    + 'intended way to start; the per-clip tools are for refining what it produces.',
  inputSchema: {
    name: z.string(),
    beats: z.array(z.object({
      text: z.string().optional().describe('caption for this beat'),
      image: z.string().optional().describe('workspace path to an image'),
      svg: z.string().optional().describe('workspace path to an SVG (see write_svg)'),
      seconds: z.number().min(0.01).optional().describe('override the derived duration'),
      animId: z.string().optional(),
      textAnimId: z.string().optional(),
      font: z.string().optional(),
      fontSize: z.number().optional(),
      color: z.string().optional(),
      bold: z.boolean().optional().describe('set the caption in bold'),
      page: z.boolean().optional().describe('start this beat on a fresh sheet'),
      transition: z.enum([...TRANSITIONS]).optional(),
      erase: z.object({
        after: z.number().min(0).default(0.4).describe('gap after the ink lands'),
        duration: z.number().min(0.01).default(1.5),
      }).optional().describe('wipe this beat away before the next'),
    })).min(1),
  },
}, tool(async ({ name, beats }) => {
  const ctx = { root: ROOT, sidecar: studio.sidecar(), rel: readablePath };
  const { doc } = await storyboard({ doc: studio.doc(name), beats, ctx });
  studio.commit(name, () => doc, { structural: true });
  return after(name, { beats: beats.length });
}));

// ── seeing ────────────────────────────────────────────────────────────

server.registerTool('render_frame', {
  title: 'Render frame',
  description:
    'Render one frame as a PNG, at a time in seconds or an exact frame index. Downscaled to '
    + '720px wide by default to keep it affordable; raise `width` only when you need detail.',
  inputSchema: {
    name: z.string(),
    time: z.number().min(0).optional(),
    frame: z.number().min(0).optional(),
    width: z.number().min(160).max(3840).default(720),
  },
}, tool(async ({ name, time, frame, width }) => {
  const built = await studio.built(name);
  if (!built.frames) throw new edits.EditError('project has no clips, nothing to render');
  const n = resolveFrame(built.project, { time, frame });
  const r = renderOne(built, n, { width });
  const view = await studio.describe(name);
  const live = view.clips.filter((c) => r.time >= c.visible[0] && r.time <= c.visible[1]);
  return image(r.png,
    `frame ${r.frame} of ${built.frames} · ${r.time}s · ${r.width}x${r.height}\n`
    + `on screen: ${live.map((c) => `${c.id} (${c.kind})`).join(', ') || 'nothing'}`);
}));

server.registerTool('render_contact_sheet', {
  title: 'Render contact sheet',
  description:
    'The whole video as a single image: an N-up grid of frames spread across the timeline, '
    + 'each labelled with its timestamp. Far cheaper than N separate frames and better for '
    + 'judging pacing and composition. Use this as the main way of looking at a draft.',
  inputSchema: {
    name: z.string(),
    count: z.number().min(1).max(25).default(9),
    from: z.number().min(0).default(0).describe('seconds'),
    to: z.number().min(0).optional().describe('seconds; defaults to the end'),
    width: z.number().min(400).max(2400).default(1200),
  },
}, tool(async ({ name, ...opts }) => {
  const built = await studio.built(name);
  const r = renderContactSheet(built, opts);
  const view = await studio.describe(name);
  return image(r.png,
    `${r.times.length} frames across ${view.duration}s · sampled at ${r.times.join('s, ')}s`
    + (view.warnings.length ? `\nwarnings: ${view.warnings.join('; ')}` : ''));
}));

server.registerTool('export_video', {
  title: 'Export video',
  description:
    'Start encoding an MP4. Returns immediately with a job id — poll export_status. Pass '
    + '`scale: 0.5` for a quick draft; the framing is identical, only the resolution differs.',
  inputSchema: {
    name: z.string(),
    scale: z.number().min(0.1).max(1).default(1),
    fps: z.number().min(1).max(120).optional().describe('override for a cheaper draft'),
  },
}, tool(async ({ name, scale, fps }) => {
  const built = await studio.built(name);
  if (!built.frames) throw new edits.EditError('project has no clips, nothing to render');
  return json({ ok: true, ...exports_.start(built, { name, scale, fps }),
    hint: 'poll export_status with this id' });
}));

server.registerTool('export_status', {
  title: 'Export status',
  description: 'Progress of an export job, or every job when no id is given.',
  inputSchema: { id: z.string().optional() },
}, tool(async ({ id }) => {
  if (!id) return json({ jobs: exports_.list() });
  const job = exports_.get(id);
  if (!job) return json({ ok: false, error: `no such job ${id}` });
  return json({
    id: job.id,
    state: job.state,
    progress: `${job.frame}/${job.total}`,
    percent: Math.round((job.frame / job.total) * 100),
    out: job.state === 'done' ? job.out : null,
    error: job.error,
    elapsed: Math.round(((job.finishedAt ?? Date.now()) - job.startedAt) / 100) / 10,
  });
}));

// ── resources ─────────────────────────────────────────────────────────

server.registerResource('authoring-guide', 'whiteboard://guide/authoring', {
  title: 'Authoring guide',
  description: 'How to build a whiteboard video: the model, the rules, the conventions.',
  mimeType: 'text/markdown',
}, async (uri) => ({
  contents: [{ uri: uri.href, mimeType: 'text/markdown', text: AUTHORING_GUIDE }],
}));

const catalogue = {
  animations: () => animations(),
  fonts: () => fonts(),
  hands: () => HAND_STYLE_IDS,
};
for (const [key, get] of Object.entries(catalogue)) {
  server.registerResource(`catalog-${key}`, `whiteboard://catalog/${key}`, {
    title: `Catalogue: ${key}`,
    mimeType: 'application/json',
  }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'application/json',
                 text: JSON.stringify(get(), null, 2) }],
  }));
}

// Worked examples. `demo.project.json` is deliberately absent: it points at an
// absolute path outside the repo that does not exist on a clean checkout, so it
// would be an example that cannot be rendered. These two bracket the range
// anyway -- the minimal hand-written form, and pages with transitions.
for (const ex of ['svg', 'pages']) {
  server.registerResource(`example-${ex}`, `whiteboard://examples/${ex}`, {
    title: `Example project: ${ex}`,
    mimeType: 'application/json',
  }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'application/json',
                 text: readFileSync(`${ROOT}/examples/${ex}.project.json`, 'utf8') }],
  }));
}

// ── prompts ───────────────────────────────────────────────────────────

server.registerPrompt('explainer', {
  title: 'Whiteboard explainer',
  description: 'Turn a topic or script into a finished whiteboard video.',
  argsSchema: {
    topic: z.string().describe('the subject, or a full script'),
    seconds: z.string().optional().describe('roughly how long it should run'),
  },
}, ({ topic, seconds }) => ({
  messages: [{
    role: 'user',
    content: {
      type: 'text',
      text: `Make a whiteboard explainer about: ${topic}\n`
        + (seconds ? `Target length: about ${seconds} seconds.\n` : '')
        + `\nRead whiteboard://guide/authoring first. Then:\n`
        + `1. list_capabilities, to check ffmpeg and the sidecar.\n`
        + `2. create_project.\n`
        + `3. Write the script as beats — a short caption each, and a simple SVG diagram `
        + `(write_svg) wherever a picture explains it better than words.\n`
        + `4. storyboard the whole thing in one call, using a page break between sections.\n`
        + `5. render_contact_sheet and look at it. Check get_project's warnings.\n`
        + `6. Fix what is wrong, then export_video with scale 0.5 and report the path.`,
    },
  }],
}));

server.registerPrompt('single-scene', {
  title: 'Single whiteboard scene',
  description: 'One caption and one drawing, refined until it looks right.',
  argsSchema: { subject: z.string() },
}, ({ subject }) => ({
  messages: [{
    role: 'user',
    content: {
      type: 'text',
      text: `Make one whiteboard scene about: ${subject}\n\n`
        + `Create a project, write an SVG for the drawing, add it with a caption, then `
        + `render_frame at the moment it finishes drawing and adjust the placement and `
        + `timing until it reads well. Keep it under fifteen seconds.`,
    },
  }],
}));

// ── run ───────────────────────────────────────────────────────────────

const shutdown = () => { studio.stop(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await server.connect(new StdioServerTransport());
