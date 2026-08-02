# An MCP server so Claude can author whiteboard videos

## Context

The studio is fully scriptable in principle — `normalizeProject`, `prepareProject`,
`renderFrame` and the document transforms in `editor.js` are all DOM-free and importable
from Node — but there is **no headless entry point**: every authoring path runs through
`ipcMain` handlers in `electron/main.js`, and the only CLI is `render-project.js`, which
renders a finished document and nothing else. So Claude can edit the engine but cannot use
it.

An MCP server closes that. The goal is **authoring**: Claude builds a project document,
*looks at rendered frames*, refines, and exports an MP4. It runs over stdio from a
`.mcp.json` in this repo, and it may write only inside a workspace directory it owns.

Two things decide whether this is usable rather than merely possible:

1. **Claude must be able to see what it made.** A tool returning a rendered PNG is the whole
   feedback loop. `renderFrame` is a pure function of `(project, frameIndex)` and seeking is
   pixel-exact (pinned by `test/determinism.test.js:57-88`), so a single frame at any time is
   correct and costs milliseconds.
2. **Rebuilds must not re-trace.** Tracing an image takes seconds, and **no caller passes a
   cache key to `sidecar.vectorize`** today (`render-project.js:83`, `prepare.js:99`, …), so it
   is recomputed every run even though `server.py:21-48` has a disk cache ready for it. The
   server keeps a warm session and passes a key.

---

## 1. Extract a headless session — `src/engine/host/nodeSession.js` (new)

`scripts/render-project.js:56-201` already does the whole job: normalise → per-kind compile
(vector via `parseSvg`, image via the sidecar, text via `outlineText`/`layoutText`) → load
hand styles for `styleIdsFor(handStyleId)` → `ensureSurfaces` → install artwork with
`knockOutPaper`. That logic must not be copied a third time — `doc.md` already warns that the
text branch here and in `electron/prepare.js` have to stay twinned.

Lift it into `buildSession(project, { root, sidecar, setSurfaces })` returning
`{ session, project, frames }`, and have `render-project.js` call it. The MCP server then gets
the identical build for free, which is also what keeps a frame Claude looks at identical to a
frame the CLI exports.

While extracting, pass a **cache key** to `sidecar.vectorize(path, opts, key)` —
`hash(file bytes + JSON.stringify(trace opts))`. No Python change; seconds saved on every
rebuild, and the app benefits too if `prepare.js` adopts it later.

## 2. Lift the document transforms out of the React hook

`src/ui/state/editor.js` already exports the valuable pure ones — `addClipTo`, `afterTransition`,
`packTrack`, `withCameraAt`, `clipEnd`, `uniqueId`, `removeClipFrom`, `isStructural`,
`TIMING_FIELDS`, `EMPTY_PROJECT` — deliberately outside the hook. The server must reuse them
rather than reinvent timing rules: `addClipTo` alone encodes "append after everything, snap to
0.1s, skip past any transition, pack a lane, land on the page that is actually on screen".

Four rules are still trapped as inline closures inside `useEditor` and encode real constraints;
lift them to exported functions and have the hook call them:
`addPageBreak` (clamps `t` past everything authored, forces `duration: 0` for `cut`),
`patchPageBreak`, `removePage` (refuses the last page or one still referenced), `removeTrack`
(reparents, refuses the last lane of a kind).

Move the pure transforms to `src/engine/model/edits.js` so the server does not import from
`src/ui/`; re-export from `editor.js` so the app is untouched.

## 3. The server — `mcp/server.js` (new), `@modelcontextprotocol/sdk` over stdio

State: a `Studio` holding, per open project, `{ doc, sessionCache, dirty }` plus **one
long-lived sidecar** for the process (0.4s once, not per call). A mutation marks the session
stale only when `isStructural(patch)` says so — a timing or transform edit re-renders straight
away with no sidecar round trip, which is exactly the split the editor already makes.

Every write goes through `normalizeProject` and is saved to
`mcp-workspace/<name>.project.json` with **absolute** asset paths (`main.js:165-174` shows why:
saves are verbatim, so relative paths would resolve against the wrong directory). Every mutating
tool returns `{ ok, project summary, warnings }` or the `ProjectError` message unchanged —
those messages are the feedback channel and are already written for a human
(`clips[2].erase.start: erase begins at 4.1s but the clip is still drawing until 5.2s`).

### Tools

**Discovery** — one call, so Claude learns the whole vocabulary up front:

| tool | returns |
|---|---|
| `list_capabilities` | the 8 animation ids with `label` + `paramSchema` (from `listAnimations()`, `registry.js:58`) and which asset kinds each suits; the 9 bundled fonts (`listFonts()`); `HAND_STYLE_IDS`; `TRANSITIONS`; schema defaults; and an environment check — ffmpeg via `hasFfmpeg()` (`electron/media.js:92`) and the sidecar via its `ping` op, which is the thing that proves the venv exists |

**Project lifecycle:** `create_project` (name, fps/size/background/hand), `list_projects`,
`get_project` (the normalised doc **plus** a computed timeline: per clip `start→end`, page,
lane, and `projectDuration`/`projectFrames`).

**Editing** — thin wrappers over §2, each validating before it writes:
`add_clip` (image | vector | text; start/track/page chosen by `addClipTo` unless given),
`update_clip` (timing, transform, animId, params, erase),
`remove_clip`, `add_audio`, `remove_audio`, `add_page`, `add_page_break`,
`set_camera` (via `withCameraAt`, which plants the hold keyframe so the move *arrives* on time),
`set_meta`.

`clip.params` is **not validated by `normalizeProject`** — the MCP layer is the only place the
`paramSchema` ranges can be enforced, so `add_clip`/`update_clip` clamp and reject unknown keys.

**`storyboard`** — the highest-value tool: takes `beats[]` (`{text?, image?, seconds?,
animId?, erase?}`) and lays out a complete draft — captions, artwork, timing, page breaks
between sections. One call turns a script into something Claude can immediately look at, and
the fine-grained tools are then for refinement rather than construction.

**Seeing:**

| tool | cost | returns |
|---|---|---|
| `render_frame` | ms once warm | one PNG at a time or frame index, as MCP image content |
| `render_contact_sheet` | ms × N | **one** image: an N-up grid across the timeline with timestamps — the whole video in a single look, which is far cheaper for the model than N images |
| `export_video` | seconds–minutes, needs ffmpeg | MP4 path + duration/fps/size, via `exportVideo` (`export/driver.js`) |

### Resources

- `whiteboard://project/<name>` — the current document.
- `whiteboard://catalog/animations|fonts|hands` — the same data as `list_capabilities`, for
  clients that browse resources.
- `whiteboard://examples/<name>` — the three shipped projects, as worked examples.
- `whiteboard://guide/authoring` — **new, written for the model**, and the piece that decides
  output quality. It must state the coordinate system (object-space px; `transform.x/y` offsets
  from the canvas centre), the timing conventions the UI uses (`textDuration` in `App.jsx:64`:
  0.16s per non-space character, clamped 1.6–12s; artwork ~4s), and the four hard rules that
  are errors rather than warnings: a clip may not draw while its page is mid-transition, page
  breaks may not overlap, an erase may not begin before its draw ends, and a clip's lane must
  match its kind.

### Prompts

`explainer` (script → `storyboard` → contact sheet → refine → export) and `single-scene`, so
the workflow is discoverable rather than folklore.

## 4. Wiring

- `package.json`: add `@modelcontextprotocol/sdk`, and an `mcp` script (`node mcp/server.js`).
- `.mcp.json` at the repo root pointing at it, so Claude Code picks it up with no install step.
- `mcp-workspace/` with a `.gitignore`; the server refuses any path resolving outside it
  (same guard shape as `bundledFontPath`, `electron/fonts.js:24-27`).
- `doc.md`: a section on the server and its tools, and the engine map gains `mcp/` and
  `src/engine/host/nodeSession.js`.

## 5. Verification

- `node --test test/`: existing suite must stay green (the §1/§2 extractions are refactors —
  `test/editor.test.js` already covers the transforms, and `test/determinism.test.js` covers the
  build path). Add `test/mcp.test.js` for the pure layer: `storyboard` produces a document that
  `normalizeProject` accepts; param clamping rejects out-of-range values; a workspace escape
  (`../../etc/x`) is refused; a structural edit invalidates the cached session and a timing edit
  does not.
- `mcp/smoke.js`: spawn the server over stdio, `initialize`, `tools/list`, then drive a real
  session — `create_project` → `storyboard` with two beats → `render_contact_sheet` → assert an
  image comes back and the document validates. This is the "does it actually work as an MCP
  server" test and needs no display, no ffmpeg.
- End to end, by hand: from Claude Code, ask for a 15-second explainer, look at the contact
  sheet, adjust one clip's timing, re-render, then `export_video` and play the MP4.
- Confirm the cache key works: run a rebuild twice and check the second skips the sidecar
  (`.cache` gains a vectorize entry; today it holds only glyph keys).
