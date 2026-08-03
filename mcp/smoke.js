#!/usr/bin/env node
/**
 * Does it actually work as an MCP server?
 *
 *   node mcp/smoke.js
 *
 * Spawns the real server over real stdio and drives a real session: create,
 * author some SVG, storyboard it, look at the result. Nothing is mocked, which
 * is the point -- the unit tests cover the pure layer, and this covers the part
 * that only breaks over the wire (schemas the SDK rejects, a tool that throws
 * before it can answer, an image block that comes back malformed).
 *
 * Needs no display, no ffmpeg and no Python: text and SVG compile in pure JS.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NAME = 'smoke_project';

const ARROW = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">
  <path d="M10 50 H160" stroke="#1a1a1a" stroke-width="6" fill="none"/>
  <path d="M160 50 L135 32 L135 68 Z" fill="#1a1a1a"/>
</svg>`;

const text = (r) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const data = (r) => JSON.parse(text(r));

let step = 0;
const ok = (msg) => console.log(`  ${++step}. ${msg}`);

async function main() {
  const client = new Client({ name: 'smoke', version: '1.0.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [join(ROOT, 'mcp', 'server.js')],
    stderr: 'inherit',
  }));
  ok('connected');

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  for (const required of ['list_capabilities', 'create_project', 'storyboard',
    'render_contact_sheet', 'write_svg', 'update_asset', 'export_video']) {
    assert.ok(names.includes(required), `missing tool ${required}`);
  }
  ok(`${tools.length} tools: ${names.join(', ')}`);

  const { resources } = await client.listResources();
  assert.ok(resources.some((r) => r.uri === 'whiteboard://guide/authoring'));
  const guide = await client.readResource({ uri: 'whiteboard://guide/authoring' });
  assert.ok(guide.contents[0].text.includes('bounding-box corner'));
  ok(`${resources.length} resources, guide reads back`);

  const caps = data(await client.callTool({ name: 'list_capabilities', arguments: {} }));
  assert.equal(caps.animations.length, 8);
  assert.equal(caps.fonts.length, 9);
  ok(`capabilities: ${caps.animations.length} animations, ${caps.fonts.length} fonts, `
    + `ffmpeg=${caps.environment.ffmpeg}, sidecar=${caps.environment.sidecar.available}`);

  const created = data(await client.callTool({
    name: 'create_project',
    arguments: { name: NAME, fps: 30, width: 1280, height: 720 },
  }));
  assert.equal(created.ok, true);
  ok(`created ${NAME} at ${created.meta.width}x${created.meta.height}`);

  const svg = data(await client.callTool({
    name: 'write_svg', arguments: { name: 'arrow.svg', markup: ARROW },
  }));
  assert.equal(svg.ok, true);
  assert.ok(svg.subpaths > 0);
  ok(`wrote arrow.svg (${svg.subpaths} subpaths, ${svg.regions} regions)`);

  const board = data(await client.callTool({
    name: 'storyboard',
    arguments: {
      name: NAME,
      beats: [
        { text: 'Ideas need direction' },
        { text: 'So point them somewhere', svg: svg.path, page: true },
      ],
    },
  }));
  assert.equal(board.ok, true);
  assert.equal(board.project.clips.length, 3);
  assert.ok(board.project.duration > 5);
  ok(`storyboard: ${board.project.clips.length} clips over ${board.project.duration}s`);

  // The layout policy exists so a caption and its artwork do not collide.
  assert.deepEqual(board.warnings, [],
    `storyboard produced warnings: ${board.warnings.join('; ')}`);
  ok('no overlap or off-frame warnings');

  const sheet = await client.callTool({
    name: 'render_contact_sheet', arguments: { name: NAME, count: 6 },
  });
  const img = sheet.content.find((c) => c.type === 'image');
  assert.ok(img, 'no image came back');
  assert.equal(img.mimeType, 'image/png');
  assert.ok(img.data.length > 5000, 'image suspiciously small');
  ok(`contact sheet: ${Math.round(img.data.length / 1024)}KB of base64 PNG`);

  const frame = await client.callTool({
    name: 'render_frame', arguments: { name: NAME, time: 2 },
  });
  assert.ok(frame.content.find((c) => c.type === 'image'));
  ok(`frame at 2s — ${text(frame).split('\n')[1]}`);

  // Rewording goes through the asset, and the document has to stay valid.
  const view = data(await client.callTool({ name: 'get_project', arguments: { name: NAME } }));
  const firstText = view.clips.find((c) => c.kind === 'text');
  const assetId = view.document.clips.find((c) => c.id === firstText.id).assetId;
  const reworded = data(await client.callTool({
    name: 'update_asset', arguments: { name: NAME, assetId, text: 'Rewritten caption' },
  }));
  assert.equal(reworded.ok, true);
  assert.ok(reworded.project.clips.some((c) => c.label === 'Rewritten caption'));
  ok('update_asset reworded a caption and re-prepared');

  // A rejected edit must leave the document exactly as it was.
  const bad = await client.callTool({
    name: 'update_clip',
    arguments: { name: NAME, clipId: firstText.id, animId: 'draw.imageReveal' },
  });
  assert.equal(bad.isError, true);
  assert.match(text(bad), /does not suit a text asset/);
  const still = data(await client.callTool({ name: 'get_project', arguments: { name: NAME } }));
  assert.equal(still.clips.length, view.clips.length);
  ok('an invalid edit was refused and changed nothing');

  // A camera move is non-structural, so it exercises the path where the cached
  // session was left holding the previous document and went on rendering it.
  const cam = data(await client.callTool({
    name: 'set_camera',
    arguments: { name: NAME, pageId: 'page1', t: 6, x: 0, y: 0, zoom: 1.5, moveDuration: 1 },
  }));
  assert.equal(cam.ok, true);
  assert.equal(cam.page.cameraKeyframes.length, 3,
    'the camera move did not reach the rendered document');
  const moved = data(await client.callTool({ name: 'get_project', arguments: { name: NAME } }));
  assert.ok(moved.duration >= 6, 'the timeline did not grow to fit the camera move');
  ok(`a camera move is visible immediately (${moved.duration}s)`);

  const escape = await client.callTool({
    name: 'write_svg', arguments: { name: '../../etc/evil.svg', markup: ARROW },
  });
  assert.equal(escape.isError, true);
  assert.match(text(escape), /outside the workspace/);
  ok('a path escaping the workspace was refused');

  await client.close();
  console.log('\nsmoke OK');
}

main().catch((e) => {
  console.error('\nsmoke FAILED:', e);
  process.exit(1);
});
