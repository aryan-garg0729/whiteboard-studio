/**
 * The workspace: the only directory the server may touch.
 *
 * Everything the server writes -- project documents, generated SVG, exported
 * video -- lands under `mcp-workspace/`, and every path that arrives in a tool
 * call is resolved against it and rejected if it escapes. The guard is the same
 * shape as `bundledFontPath` in electron/fonts.js: join first so `..` is
 * normalised away, then require the prefix. Testing the raw string instead
 * would let `mcp-workspace/../../etc/passwd` through.
 *
 * Reads are additionally allowed from a few read-only directories inside the
 * repo (bundled fonts, hand manifests, the example projects) because the engine
 * needs them to build anything at all.
 *
 * `import_asset` is the one sanctioned door inward: it copies a file from
 * anywhere on disk into the workspace and hands back the interior path. Without
 * it, strict sandboxing would mean no user image could ever enter a project.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const WORKSPACE = join(ROOT, 'mcp-workspace');
export const ASSET_DIR = join(WORKSPACE, 'assets');
export const EXPORT_DIR = join(WORKSPACE, 'exports');

/** Repo directories a project may legitimately read from but never write to. */
const READABLE = [
  join(ROOT, 'assets'),
  join(ROOT, 'examples'),
];

export class WorkspaceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

const within = (dir, p) => p === dir || p.startsWith(dir + '/');

export function ensureWorkspace() {
  for (const d of [WORKSPACE, ASSET_DIR, EXPORT_DIR]) mkdirSync(d, { recursive: true });
  const ignore = join(WORKSPACE, '.gitignore');
  // Generated projects, artwork and video are the agent's scratch space, not
  // repo content; committing them would be noise in every diff.
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n');
  return WORKSPACE;
}

/**
 * Resolve a path for writing. Must land inside the workspace.
 *
 * A bare name is interpreted relative to the workspace, which is what makes
 * `write_svg("arrow.svg")` work without the caller knowing where the workspace
 * lives.
 */
export function writablePath(p, { base = WORKSPACE } = {}) {
  if (typeof p !== 'string' || !p) throw new WorkspaceError('a path is required');
  const full = isAbsolute(p) ? resolve(p) : resolve(base, p);
  if (!within(WORKSPACE, full)) {
    throw new WorkspaceError(
      `${p} resolves outside the workspace; the server may only write inside mcp-workspace/`);
  }
  return full;
}

/** Resolve a path for reading: the workspace, or one of the repo's own dirs. */
export function readablePath(p) {
  if (typeof p !== 'string' || !p) throw new WorkspaceError('a path is required');
  const full = isAbsolute(p) ? resolve(p) : resolve(WORKSPACE, p);
  if (within(WORKSPACE, full) || READABLE.some((d) => within(d, full))) return full;
  throw new WorkspaceError(
    `${p} is outside the workspace; copy it in with import_asset first`);
}

/**
 * Copy a file from anywhere on disk into the workspace.
 *
 * Deliberately the only function here that reads an unconstrained path. The
 * destination name is `basename`d so a crafted source cannot steer the write,
 * and collisions get a numeric suffix rather than silently overwriting artwork
 * an earlier clip is already using.
 */
export function importAsset(src) {
  const from = resolve(src);
  if (!existsSync(from) || !statSync(from).isFile()) {
    throw new WorkspaceError(`no such file: ${src}`);
  }
  ensureWorkspace();
  const ext = extname(from);
  const stem = basename(from, ext).replace(/[^\w.-]+/g, '_') || 'asset';
  let name = `${stem}${ext}`;
  for (let i = 2; existsSync(join(ASSET_DIR, name)); i++) name = `${stem}-${i}${ext}`;
  const to = join(ASSET_DIR, name);
  copyFileSync(from, to);
  return to;
}

// ── project files ─────────────────────────────────────────────────────

const SUFFIX = '.project.json';

/** Project names are filenames; keep them to something that cannot escape. */
export function projectPath(name) {
  if (!/^[\w-]{1,64}$/.test(name || '')) {
    throw new WorkspaceError(
      `invalid project name ${JSON.stringify(name)}; use letters, digits, - and _`);
  }
  return join(WORKSPACE, `${name}${SUFFIX}`);
}

export function listProjects() {
  ensureWorkspace();
  return readdirSync(WORKSPACE)
    .filter((f) => f.endsWith(SUFFIX))
    .map((f) => {
      const path = join(WORKSPACE, f);
      return { name: f.slice(0, -SUFFIX.length), path, modified: statSync(path).mtime.toISOString() };
    })
    .sort((a, b) => b.modified.localeCompare(a.modified));
}

export function loadProject(name) {
  const path = projectPath(name);
  if (!existsSync(path)) throw new WorkspaceError(`no project named ${JSON.stringify(name)}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Write a document out.
 *
 * Asset paths are stored absolute, matching what the app does on load
 * (`absolutize`, electron/main.js). Saves are verbatim in both hosts, so a
 * relative path would resolve against whatever directory the next reader
 * happens to be in.
 */
export function saveProject(name, doc) {
  ensureWorkspace();
  const path = projectPath(name);
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
  return path;
}
