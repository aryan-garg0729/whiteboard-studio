/**
 * Electron main process: window, IPC, filesystem and the Python sidecar.
 *
 * The renderer owns the engine; main owns everything the renderer is not
 * allowed to touch. Keeping the split here means the preview canvas and the
 * CLI exporter run byte-identical rendering code.
 *
 * The editor holds the project document in the renderer and asks main to
 * `project:prepare` it whenever geometry changes. Timing and transform edits
 * never round-trip -- they are pure `renderFrame` inputs.
 */

import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeProject, projectFrames } from '../src/engine/model/project.js';
import { HAND_STYLE_IDS } from '../src/engine/hand/styles.js';
import { Sidecar } from '../src/engine/sidecar/client.js';
import { prepareProject, prepareHand } from './prepare.js';
import { bundledFontPath, listFonts } from './fonts.js';
import { describeFile, hasFfmpeg, AUDIO_EXT, IMAGE_EXT } from './media.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEV_URL = process.env.VITE_DEV_SERVER_URL;

// Headless X servers report an arbitrary DPI, so the smoke screenshot would be
// laid out at a scale no real display uses. Pin it, and only for the test.
if (process.env.WB_SMOKE) app.commandLine.appendSwitch('force-device-scale-factor', '1');

let sidecar = null;
const getSidecar = () => (sidecar ??= new Sidecar({ root: ROOT, cacheDir: join(ROOT, '.cache') }));

/** Shipped sample projects. Read by both the File menu and `project:examples`. */
const EXAMPLES = [
  join(ROOT, 'examples', 'demo.project.json'),
  join(ROOT, 'examples', 'svg.project.json'),
  join(ROOT, 'examples', 'pages.project.json'),
];

/**
 * The application menu.
 *
 * Installing one is not decoration. Electron fits a default menu when the app
 * never sets its own, and that default fights the editor: its Edit roles claim
 * Ctrl+Z / Ctrl+Shift+Z and run the *DOM* undo instead of the document's, and
 * Ctrl+R reloads the window, silently discarding unsaved work. It also duplicated
 * the app's own in-page menu bar, so every command appeared twice on screen.
 *
 * Items are never disabled here. Doing that would mean streaming editor state
 * (can-undo, has-clips, selection) into main and rebuilding the menu on every
 * keystroke; instead the renderer simply ignores a command that does not apply,
 * which it already does -- `ed.redo` with nothing to redo returns the same state.
 */
function buildMenu() {
  const send = (id) => () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    win?.webContents.send('menu:command', id);
  };
  const item = (label, id, accelerator) => ({ label, accelerator, click: send(id) });

  /**
   * A menu item that *shows* its key without claiming it.
   *
   * A registered accelerator is global: it fires ahead of the web page even
   * while a text field has focus, so registering `H` would make it impossible
   * to type the letter h anywhere in the app, and `Delete` would remove the
   * selected clip instead of a character. The renderer's own key handler
   * already deals with these, and it can see what has focus -- text inputs
   * stop the event before it reaches the window listener.
   */
  const hint = (label, id, accelerator) =>
    ({ label, accelerator, registerAccelerator: false, click: send(id) });

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        item('New project', 'new', 'CmdOrCtrl+N'),
        item('Open…', 'open', 'CmdOrCtrl+O'),
        {
          label: 'Open example',
          submenu: EXAMPLES.map((p) => ({
            label: p.split('/').pop().replace('.project.json', ''),
            click: send(`open:${p}`),
          })),
        },
        { type: 'separator' },
        item('Save', 'save', 'CmdOrCtrl+S'),
        item('Save as…', 'saveAs', 'CmdOrCtrl+Shift+S'),
        { type: 'separator' },
        item('Export MP4…', 'export', 'CmdOrCtrl+E'),
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        item('Undo', 'undo', 'CmdOrCtrl+Z'),
        // Ctrl+Y, as asked for. A menu item carries one accelerator, so the
        // conventional Ctrl+Shift+Z stays alive as an alias in the renderer's
        // own key handler.
        item('Redo', 'redo', 'CmdOrCtrl+Y'),
        { type: 'separator' },
        item('Rename project…', 'rename', 'F2'),
        hint('Delete selected', 'delete', 'Delete'),
      ],
    },
    {
      label: 'Insert',
      submenu: [
        item('Image or SVG…', 'insert:image'),
        item('Text', 'insert:text'),
        item('Audio track…', 'insert:audio'),
        { type: 'separator' },
        item('Page break', 'insert:page'),
        item('Camera keyframe', 'insert:camera'),
      ],
    },
    {
      label: 'View',
      submenu: [
        hint('Toggle hand', 'view:hand', 'H'),
        hint('Toggle guides', 'view:guides', 'G'),
        hint('Camera tool', 'view:camera', 'C'),
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
  ]));
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#1e1e1e',
    title: 'Whiteboard Studio',
    webPreferences: {
      preload: join(ROOT, 'electron', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (DEV_URL) win.loadURL(DEV_URL);
  else win.loadFile(join(ROOT, 'dist', 'index.html'));
  return win;
}

/**
 * Rewrite asset and audio paths to absolute, relative to the project file.
 *
 * The editor mutates the document in memory and re-prepares it many times; a
 * document whose paths depend on where it was loaded from would break the
 * moment the user imports a file from somewhere else.
 */
function absolutize(project, dir) {
  const abs = (p) => (!p || isAbsolute(p) ? p : resolve(dir, p));
  return {
    ...project,
    assets: Object.fromEntries(Object.entries(project.assets).map(([id, a]) => [
      id, { ...a, src: abs(a.src), font: abs(a.font) },
    ])),
    audio: project.audio.map((a) => ({ ...a, src: abs(a.src) })),
  };
}

/** Normalise + prepare a document. The one path every project load goes through. */
async function prepare(raw, basePath) {
  const project = absolutize(normalizeProject(raw), dirname(basePath));
  const prepared = await prepareProject(project, basePath, getSidecar());
  return {
    project,
    prepared,
    hand: prepareHand(ROOT, project.meta.handStyleId),
    frames: projectFrames(project),
  };
}

/** Report the validator's path-qualified message rather than a stack. */
const asError = (err) => ({
  error: err.name === 'ProjectError' ? err.message : String(err.message || err),
});

ipcMain.handle('project:open', async (_e, requested) => {
  let target = requested;
  if (!target) {
    const r = await dialog.showOpenDialog({
      title: 'Open project',
      defaultPath: join(ROOT, 'examples'),
      filters: [{ name: 'Project', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    target = r.filePaths[0];
  }
  const path = resolve(target);
  try {
    return { path, ...await prepare(JSON.parse(readFileSync(path, 'utf8')), path) };
  } catch (err) {
    return asError(err);
  }
});

/** Re-prepare an edited in-memory document. */
ipcMain.handle('project:prepare', async (_e, { project, basePath }) => {
  try {
    return await prepare(project, basePath || join(ROOT, 'examples', 'untitled.json'));
  } catch (err) {
    return asError(err);
  }
});

ipcMain.handle('project:save', async (_e, { project, path, saveAs }) => {
  let target = path;
  if (!target || saveAs) {
    const r = await dialog.showSaveDialog({
      title: 'Save project',
      defaultPath: target || join(ROOT, 'examples', 'untitled.project.json'),
      filters: [{ name: 'Project', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return null;
    target = r.filePath;
  }
  try {
    writeFileSync(target, `${JSON.stringify(project, null, 2)}\n`);
    return { path: target };
  } catch (err) {
    return asError(err);
  }
});

ipcMain.handle('project:examples', () => EXAMPLES);

ipcMain.handle('asset:import', async (_e, kind) => {
  const filters = kind === 'audio'
    ? [{ name: 'Audio', extensions: AUDIO_EXT }]
    : [{ name: 'Images & vectors', extensions: IMAGE_EXT }];
  const r = await dialog.showOpenDialog({
    title: kind === 'audio' ? 'Import audio' : 'Import artwork',
    filters,
    properties: ['openFile', 'multiSelections'],
  });
  if (r.canceled) return [];
  return Promise.all(r.filePaths.map(describeFile));
});

/** Describe files dropped onto the window, which arrive as paths only. */
ipcMain.handle('asset:describe', async (_e, paths) => {
  const out = [];
  for (const p of paths) {
    try { out.push(await describeFile(p)); } catch { /* skip unreadable */ }
  }
  return out;
});

/**
 * Take dropped file *contents* and give back a real path.
 *
 * `webUtils.getPathForFile` is the tidy route because it keeps the user's own
 * path, so a saved project still points at the original asset. But it returns
 * "" for anything the browser holds without a filesystem path -- which is what
 * made drag-and-drop look broken. Copying the bytes into the app's own import
 * folder always works, so the drop never has to fail.
 *
 * Named by content hash: re-dropping the same file reuses one copy, and a
 * project's asset paths stay stable across sessions.
 */
ipcMain.handle('asset:ingest', async (_e, files) => {
  const dir = join(app.getPath('userData'), 'imported');
  mkdirSync(dir, { recursive: true });

  const out = [];
  for (const f of files) {
    const buf = Buffer.from(f.bytes);
    const hash = createHash('sha1').update(buf).digest('hex').slice(0, 12);
    const safe = (f.name || 'asset').replace(/[^\w.-]+/g, '_').slice(-64);
    const target = join(dir, `${hash}-${safe}`);
    if (!existsSync(target)) writeFileSync(target, buf);
    try { out.push(await describeFile(target)); } catch { /* skip unreadable */ }
  }
  return out;
});

/**
 * Raw bytes of an audio file, for the preview mixer.
 *
 * The renderer cannot read the filesystem, and Chromium blocks `fetch` of a
 * `file://` URL even from a `file://` page, so decoding for playback has to go
 * through IPC. Returns a Buffer, which arrives in the renderer as a Uint8Array.
 */
ipcMain.handle('audio:read', (_e, path) => {
  try {
    return readFileSync(path);
  } catch (err) {
    return asError(err);
  }
});

ipcMain.handle('fonts:list', () => {
  try { return listFonts(); } catch { return []; }
});

/**
 * Raw bytes of a bundled face, so the picker can draw each name in its own type.
 *
 * Same reason as audio:read -- the renderer has no filesystem and cannot fetch
 * `file://` -- but this one is deliberately not a general file read. It resolves
 * the basename inside assets/fonts and nothing else, so a compromised renderer
 * cannot walk out of it with `../`.
 */
ipcMain.handle('fonts:read', (_e, path) => {
  try {
    const p = bundledFontPath(basename(String(path)));
    return p ? readFileSync(p) : asError(new Error('not a bundled font'));
  } catch (err) {
    return asError(err);
  }
});

// Drawing hands only. The eraser is a tool style loaded alongside whichever of
// these is chosen, not an alternative to them.
ipcMain.handle('hands:list', () => HAND_STYLE_IDS.map((id) => {
  const s = JSON.parse(readFileSync(join(ROOT, `assets/hands/${id}.json`), 'utf8'));
  return { id: s.id, label: s.label, tool: s.tool?.type || 'pen' };
}));

ipcMain.handle('export:capabilities', () => ({ ffmpeg: hasFfmpeg() }));

/**
 * Export by driving the same CLI renderer the tests exercise.
 *
 * Rendering in the renderer process and piping frames over IPC would be
 * faster, but it puts a second, subtly different frame pump in the codebase.
 * One pump means preview and export cannot drift.
 */
ipcMain.handle('export:start', async (e, { project, out }) => {
  let target = out;
  if (!target) {
    const r = await dialog.showSaveDialog({
      title: 'Export video',
      defaultPath: join(app.getPath('videos') || ROOT, 'whiteboard.mp4'),
      filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
    });
    if (r.canceled || !r.filePath) return null;
    target = r.filePath;
  }

  const dir = mkdtempSync(join(tmpdir(), 'wb-export-'));
  const tmpProject = join(dir, 'project.json');
  writeFileSync(tmpProject, JSON.stringify(project));

  return new Promise((done) => {
    // ELECTRON_RUN_AS_NODE reuses this binary as plain Node, so the export does
    // not depend on a separate node being installed alongside a packaged app.
    const child = spawn(process.execPath, [
      join(ROOT, 'scripts', 'render-project.js'), tmpProject, '--out', target,
    ], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });

    let tail = '';
    child.stdout.on('data', (b) => {
      const s = b.toString();
      tail += s;
      // render-project.js reports "encoding n/total" after a carriage return.
      const m = /encoding (\d+)\/(\d+)/.exec(s.split('\r').pop() || '');
      if (m) e.sender.send('export:progress', { frame: +m[1], total: +m[2] });
    });
    child.stderr.on('data', (b) => { tail += b.toString(); });
    child.on('close', (code) => {
      done(code === 0
        ? { path: target }
        : { error: tail.trim().split('\n').slice(-8).join('\n') || `exited ${code}` });
    });
  });
});

ipcMain.handle('shell:reveal', (_e, path) => shell.showItemInFolder(path));

/**
 * Headless smoke test: WB_SMOKE=<out.png> opens an example, renders a frame and
 * writes a screenshot. Lets CI prove the app boots and the engine paints, which
 * unit tests cannot cover on their own.
 */
async function runSmoke(win, outPath) {
  win.webContents.on('console-message', (_e, _lvl, msg) => console.log('[renderer]', msg));
  win.webContents.on('render-process-gone', (_e, d) => {
    console.log('renderer gone:', JSON.stringify(d));
  });
  await new Promise((r) => win.webContents.once('did-finish-load', r));

  // The headless X server advertises its own DPI and Chromium honours it, so
  // the layout would be measured in CSS pixels no real display uses. Converge
  // on an effective ratio of 1 by iterating: zoom feeds back into
  // devicePixelRatio non-linearly, so a single 1/dpr correction overshoots.
  let zoom = 1;
  for (let i = 0; i < 6; i++) {
    const dpr = await win.webContents.executeJavaScript('devicePixelRatio');
    if (Math.abs(dpr - 1) < 0.02) break;
    zoom /= Math.sqrt(dpr);
    win.webContents.setZoomFactor(zoom);
  }

  // did-finish-load fires before React has mounted and installed the hook, so
  // poll for it rather than assuming it is there.
  for (let i = 0; i < 100; i++) {
    const ready = await win.webContents.executeJavaScript('typeof window.__studioSmoke');
    if (ready === 'function') break;
    await new Promise((r) => setTimeout(r, 100));
  }

  // A bare name is an example; anything with a separator is a path, resolved
  // like a shell would. Without that second case `examples/x.json` silently
  // became `examples/examples/x.json` and the test ran against a blank project
  // while reporting success on everything it did not check.
  const requested = process.env.WB_SMOKE_PROJECT || 'svg.project.json';
  const example = requested.includes('/')
    ? resolve(requested)
    : join(ROOT, 'examples', requested);
  let ok = true;
  if (!process.env.WB_SMOKE_NO_OPEN) {
    ok = await win.webContents.executeJavaScript(
      `window.__studioSmoke(${JSON.stringify(example)}).catch(e => 'ERR: ' + (e && e.message || e))`);
    if (typeof ok === 'string') { console.log('smoke FAILED:', ok); sidecar?.stop(); app.exit(1); return; }
  }
  // WB_SMOKE_SCRIPT runs an interaction script in the renderer before the
  // screenshot, so UI behaviour can be checked headlessly rather than assumed.
  if (process.env.WB_SMOKE_SCRIPT) {
    const src = readFileSync(resolve(process.env.WB_SMOKE_SCRIPT), 'utf8');
    const out = await win.webContents.executeJavaScript(
      `(async () => { ${src} })().catch((e) => 'ERR: ' + (e && e.stack || e))`);
    console.log('[script]', typeof out === 'string' ? out : JSON.stringify(out));
    if (typeof out === 'string' && out.startsWith('ERR')) { sidecar?.stop(); app.exit(1); return; }
  }

  console.log('[smoke]', await win.webContents.executeJavaScript(
    'JSON.stringify({ dpr: devicePixelRatio, w: innerWidth, h: innerHeight,'
    + ' body: getComputedStyle(document.body).fontSize,'
    + ' title: getComputedStyle(document.querySelector(".panel-title")).fontSize })'));
  // Nudge the compositor: on a headless server it can go idle and capturePage
  // then returns whatever it last composited -- a screenshot of the app as it
  // was before anything loaded, which looks like a passing test.
  win.webContents.invalidate();
  await new Promise((r) => setTimeout(r, 800));
  const img = await win.webContents.capturePage();
  writeFileSync(outPath, img.toPNG());
  // The screenshot is best-effort: a headless compositor can go idle and hand
  // back whatever it last drew. Trust the script's DOM assertions above it.
  console.log(ok ? `smoke ok -> ${outPath} (screenshot best-effort)`
                 : 'smoke FAILED: renderer reported no frame');
  sidecar?.stop();
  app.exit(ok ? 0 : 1);
}

app.whenReady().then(() => {
  buildMenu();
  const win = createWindow();
  if (process.env.WB_SMOKE) runSmoke(win, process.env.WB_SMOKE);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  sidecar?.stop();
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => sidecar?.stop());
