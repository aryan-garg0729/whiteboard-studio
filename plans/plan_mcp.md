# An MCP server so Claude can author whiteboard videos

## Status

**Implemented, 2026-08-03.** All five sections are done: `src/engine/host/nodeSession.js`,
`src/engine/model/edits.js`, `mcp/` (8 modules, 21 tools), `.mcp.json`, and tests
(`test/nodeSession.test.js`, `test/mcp.test.js`, `mcp/smoke.js`). 277 unit tests pass, the
stdio smoke passes end to end, and a real MP4 exports.

Two things found during implementation and fixed in the shared transforms, both reachable
from two ordinary button presses in the app: a clip appended right after a page break began
inside its own transition, and snapping a time to a tenth could round it back below the ink
it was meant to follow. See the "Two bugs this surfaced" section in `doc.md`.

Two deviations from the plan below, both documented in `doc.md`:
`placeInFrame` gained a `grow` flag, because shrink-only left every generated SVG the size of
a postage stamp — an SVG viewBox has no natural scale, unlike a raster or a fontSize; and the
contact sheet registers a bundled font, because with none registered its timestamps rendered
as tofu.

One pre-existing test failure is unrelated and untouched: `project.test.js` expects
`examples/demo.project.json` to have 2 clips and it has 3.

## Context

The studio is scriptable in principle — `normalizeProject`, `renderFrame` and the document
transforms in `editor.js` are DOM-free and importable from Node — but there is **no headless
authoring entry point**. Every authoring path runs through `ipcMain` handlers in
`electron/main.js`, and the only CLI (`scripts/render-project.js`) renders a finished document
and nothing else. Claude can edit the engine but cannot use it.

An MCP server closes that: Claude builds a project document, *looks at rendered frames*,
refines, and exports an MP4. stdio, driven from a `.mcp.json` in this repo.

The original plan's core claims all check out against the code, and its §1/§2 extractions are
right. What follows keeps them and fixes five things that decide whether the result is usable
rather than merely working:

1. **A clip Claude adds lands in the wrong place.** The UI adds a clip, waits for the traced
   bbox, then patches the transform with `placeInFrame` (`App.jsx:180-193`, `stageGeom.js:134`)
   — a clip's origin is its bbox *corner*, and its natural size is often larger than the frame.
   Without that second pass every headless clip sits at `{x:0,y:0,scale:1}`, mostly off screen.
   The original plan never mentions it. Headless we can do it in *one* pass, because the
   session is built synchronously and the bbox is right there.
2. **Claude needs numbers, not just pixels.** `engineHost.js:144-147` already derives a
   per-clip bbox map. Returning world-space rects alongside the image lets Claude detect
   overlap and off-screen artwork arithmetically instead of squinting at a contact sheet.
3. **Image payload size.** A 1920×1080 PNG is over a megabyte of base64 per look. Frames must
   be downscaled by default or the feedback loop is unaffordable.
4. **No way to reword a caption.** Text, font, size, colour all live on the *asset*
   (`normalizeProject` :185-205, `patchAsset` `editor.js:380`), and the plan's `update_clip`
   only reaches clip fields. Rewording is the single most likely refinement.
5. **`normalizeProject` validates less than the plan assumes.** Confirmed unvalidated:
   `clip.params` (`project.js:356`, passed through verbatim), `transform` numerics (`:355`,
   spread raw — a string `scale` survives), `meta.handStyleId`, and `animId`-vs-asset-kind
   (`ANIMATIONS_FOR_KIND` `:43` is advisory UI data, never enforced). The MCP layer is the only
   place these can be caught.

---

## 1. Extract a headless session — `src/engine/host/nodeSession.js` (new)

`scripts/render-project.js:121-191` already does the whole job: normalise → per-kind compile
(vector via `parseSvg`, image via the sidecar, text via `outlineText`/`traceText`) → load hand
styles for `styleIdsFor` → `createSession` → `ensureSurfaces` → install artwork with
`knockOutPaper`. Lift `:121-191` into:

```js
buildNodeSession(project, { root, sidecar, rel })
  -> { session, project, frames, bboxes, handStyleId }
```

and have `render-project.js` call it, keeping steps 13-15 (the draw closure, `--frames-only`,
`exportVideo`) in the CLI.

Three constraints on the extraction:

- **Keep the five side-effect imports** (`render-project.js:32-36`). `getAnimation` only knows
  what has been imported; drop them and every clip fails with "unknown animation type".
- **Name it `buildNodeSession`.** `src/ui/engineHost.js:44` already exports a `buildSession`
  (the browser copy, rebuilding from the prepared IPC payload rather than from files). The two
  cannot be unified — different inputs, different surface factory — but they must return the
  same shape, which is why `bboxes` is in the signature above.
- **`render-project.js` must stay CLI-compatible.** `electron/main.js:345-383` spawns it as a
  child process for app export, deliberately, so preview and export share one frame pump.
  Breaking its argv or stdout `encoding n/total` lines breaks export in the app.

While extracting, pass a **cache key** to `sidecar.vectorize(path, opts, key)` —
`sha256(file bytes + JSON.stringify(opts))`. `client.js:88` already accepts a third `key` arg
and `server.py:31-48` has an atomic disk cache behind it, but all four call sites pass two args
(`render-project.js:83`, `prepare.js:99`, `animate-image.js:75`, `demo-reel.js:68`), so every
trace recomputes. One-line fix, seconds saved per rebuild. Apply it in `prepare.js` too — the
app gets the same win.

## 2. Lift the document transforms out of the React hook

`editor.js` already exports the valuable pure ones — `addClipTo`, `afterTransition`,
`packTrack`, `withCameraAt`, `clipEnd`, `uniqueId`, `removeClipFrom`, `isStructural`,
`TIMING_FIELDS`, `EMPTY_PROJECT`. Reuse them rather than reinventing timing rules: `addClipTo`
alone encodes "append after everything, snap to 0.1s, skip past any transition, pack a lane,
land on the page actually on screen".

The rest are inline closures in `useEditor` (`editor.js:354-612`). Every one is already a
self-contained `doc => doc` capturing nothing but `edit`, so lifting is mechanical. Lift all of
them, not just four — the server needs `patchAsset` (§4 gap) and `patchAudio`/`removePageBreak`
/`patchCameraKeyframe` too:

`patchClip`, `patchTransform`, `patchAsset`, `patchMeta`, `addAudio`, `patchAudio`,
`removeAudio`, `addTrack`, `renameTrack`, `removeTrack`, `addPageBreak`, `patchPageBreak`,
`removePageBreak`, `patchCameraKeyframe`, `removeCameraKeyframe`, `renamePage`, `removePage`.

Move them plus the existing pure transforms to **`src/engine/model/edits.js`**, and also move
**`placeInFrame`** there from `src/ui/stageGeom.js:134` — the server needs it and must not
import from `src/ui/`. Re-export from `editor.js` and `stageGeom.js` so the app and
`test/editor.test.js` / `test/stage.test.js` are untouched.

**One behaviour change:** `removePage` (`:591-593`) and `removeTrack` (`:602`) currently
`return doc` unchanged when they refuse. That is fine behind a disabled button and wrong over
MCP — Claude would be told the call succeeded. The lifted functions throw a `ProjectError`-
shaped error with the reason ("page `p2` still has 3 clips on it"); the hook wrappers catch and
no-op, preserving today's UI behaviour exactly.

## 3. The server — `mcp/server.js` (new), `@modelcontextprotocol/sdk` over stdio

A `Studio` holding, per open project, `{ doc, session, bboxes, dirty, history }`, plus **one
long-lived sidecar** for the process (0.4s once, not per call) — the same singleton shape as
`main.js:36`.

**Every mutation is transactional:** apply the lifted transform → `normalizeProject` → on
`ProjectError`, discard the edit and return the message verbatim. Those messages are the
feedback channel and are already written for a human
(`clips[2].erase.start: erase begins at 4.1s but the clip is still drawing until 5.2s`). An
invalid document is never persisted. Keep the last 20 docs so an `undo` tool is nearly free.

A mutation invalidates the cached session only when `isStructural(patch)` says so — a timing or
transform edit re-renders with no sidecar round trip, exactly the split the editor makes.

Saved to `mcp-workspace/<name>.project.json` with **absolute** asset paths, matching
`main.js:165-174`: saves are verbatim, so relative paths would resolve against the wrong dir.

### Sandbox — strict workspace

All reads and writes resolve inside `mcp-workspace/`, guard shape copied from
`bundledFontPath` (`electron/fonts.js:24-27`: `join` first, then `startsWith(DIR + '/')`, so
normalised `..` escapes fail the prefix test). Read-only exceptions for the repo's own
`assets/fonts/`, `assets/hands/` and `examples/`, which the engine needs anyway.

One sanctioned door in: **`import_asset(path)`** copies a file from anywhere on disk into
`mcp-workspace/assets/` and returns the interior path. Without it, strict-workspace means
Claude can never place a user's PNG at all — the user would have to copy files in by hand
before every session. Everything after the copy is workspace-interior.

### Tools

**Discovery** — one call, so Claude learns the vocabulary up front:

| tool | returns |
|---|---|
| `list_capabilities` | the 8 animations with `label` + `paramSchema` from `listAnimations()` (`registry.js:58`), each tagged with the kinds it suits from `ANIMATIONS_FOR_KIND` (`project.js:43`); the 9 bundled fonts (`listFonts()`, `electron/fonts.js:53`); `HAND_STYLE_IDS`; `TRANSITIONS`; schema defaults; and an environment check — ffmpeg via `hasFfmpeg()` (`electron/media.js:92`) and the sidecar via its `ping` op, which is what proves the venv exists |

`list_capabilities` **must import all five animation modules** before calling `listAnimations()`
— registration is an import side effect, so without them the list comes back empty.

**Lifecycle:** `create_project` (name, fps/size/background/hand), `list_projects`,
`open_project`, `get_project`, `undo`.

`get_project` returns the normalised doc **plus** a computed view Claude cannot derive itself:
per clip `start→end`, page, lane, and its **world-space rect** (`bboxes.get(id)` composed with
`clip.transform`), plus `projectDuration`/`projectFrames` and a flag per clip for "extends
outside the frame" and "overlaps clip X while both are visible". This is the numeric half of
the feedback loop and costs nothing — the session already holds it.

**Editing** — thin wrappers over §2, each validating before it writes:

- `add_clip` (image | vector | text), `update_clip` (timing, transform, animId, params, erase),
  `remove_clip`
- **`update_asset`** — text, font, fontSize, penWidth, color, trace opts. Rewording a caption
  has no other route; structural, so it re-prepares.
- **`write_svg(name, markup)`** — writes SVG into the workspace and returns a path usable as a
  `vector` asset. `buildVectorClip` (`render-project.js:71`) parses SVG straight through
  `parseSvg` with no sidecar, so Claude can author exact artwork with no Python installed and
  no image files. This is what makes the server self-sufficient.
- **`import_asset`** — see sandbox above.
- `add_audio`, `remove_audio`, `add_page`, `add_page_break`, `set_camera` (via `withCameraAt`,
  which plants the hold keyframe so the move *arrives* on time), `set_meta`.

**Auto-placement.** `add_clip` with no explicit `transform` compiles the clip, reads
`plan.bbox`, and applies `placeInFrame(bbox, camera-at-start, meta, 0.8)` in the same call —
the one-pass version of `App.jsx:180-193`. Text needs no sidecar for this: `textBbox`
(`compile/text.js:180`) derives from the layout. Without this, everything Claude adds is
mispositioned; with it, the first render is already roughly right.

**Validation the MCP layer must add**, because `normalizeProject` does not:
`clip.params` clamped to each animation's `paramSchema` ranges with unknown keys rejected;
`transform.{x,y,scale,rotation}` required finite; `animId` checked against
`ANIMATIONS_FOR_KIND[asset.kind]`; `meta.handStyleId` against `HAND_STYLE_IDS`.

**`storyboard`** — the highest-value tool. Takes `beats[]` (`{text?, image?, svg?, seconds?,
animId?, erase?}`) and lays out a complete draft: captions, artwork, timing, page breaks
between sections. Defaults mirror the UI so a storyboard looks like something a person made —
`textDuration` = `min(12, max(1.6, nonSpaceChars * 0.16))` (`App.jsx:64`), artwork 4s
(`App.jsx:376`), `swipeLeft`/0.6s breaks (`editor.js:471`).

Because everything is centred by `placeInFrame`, `storyboard` needs an explicit **layout
policy** or a caption lands on top of its artwork: caption in the upper band, artwork centred
in the remaining area, both fitted with `placeInFrame` against a reduced target rect. After
laying out, it re-checks the composed bboxes and reports any overlap in its result rather than
leaving Claude to discover it in a contact sheet.

**Seeing:**

| tool | cost | returns |
|---|---|---|
| `render_frame` | ms once warm | one PNG at a time or frame index, **downscaled to 720px wide by default** (`width` param to override), plus the world-space rects for that instant |
| `render_contact_sheet` | ms × N | **one** image: an N-up grid across the timeline with timestamps, ~1200px total — the whole video in a single look, far cheaper than N images |
| `export_video` | background | returns a job id immediately; renders via `exportVideo` (`export/driver.js:27`). Accepts `scale`/`fps` overrides for a fast draft |
| `export_status` | ms | progress, and the MP4 path + duration/fps/size when done |

The downscale is not cosmetic. Full-frame PNGs at 1920×1080 cost well over a megabyte of
base64 each; at 720px a contact sheet and several frames fit in the budget one full frame would
have eaten.

### Resources

- `whiteboard://project/<name>` — the current document.
- `whiteboard://catalog/animations|fonts|hands` — the `list_capabilities` data, for clients
  that browse resources.
- `whiteboard://examples/<name>` — **`pages` and `svg` only**. `examples/demo.project.json`
  points at `/home/aryan/Personal/yt/v1/character/manish pabrai.png`, an absolute path outside
  the repo that does not exist on a clean checkout, so it is a broken worked example. `pages`
  (multi-page, transitions, the on-screen-window rule) and `svg` (minimal hand-written form)
  bracket the range anyway.
- `whiteboard://guide/authoring` — **new, written for the model**, and the piece that most
  decides output quality. It must state:
  - the coordinate system — object-space px, `transform.x/y` offsets from the canvas centre,
    a clip's origin is its **bbox corner not its centre**, and world (0,0) is the frame centre
    only at camera identity (`stageGeom.js:115-123`)
  - the timing conventions above
  - `pages` is the set of sheets, `pageBreaks` the itinerary over them; a sheet may be revisited
  - the five hard rules that are errors, not warnings: a clip may not draw while its page is
    mid-transition (checked per *window*, not their union); page breaks may not overlap; an
    erase may not begin before its draw ends; a clip's lane must match its kind; a `cut` has
    duration 0 by definition
  - the workflow: storyboard → contact sheet → refine → export

### Prompts

`explainer` (script → `storyboard` → contact sheet → refine → export) and `single-scene`, so
the workflow is discoverable rather than folklore.

## 4. Wiring

- `package.json`: add `@modelcontextprotocol/sdk` and an `mcp` script (`node mcp/server.js`).
- `.mcp.json` at the repo root, so Claude Code picks it up with no install step.
- `mcp-workspace/` with a `.gitignore`.
- `doc.md`: a section on the server and its tools; the engine map at `:57-102` gains `mcp/`
  and `src/engine/host/nodeSession.js`; the testing table at `:653` gains the new files.

## 5. Verification

- **`node --test test/` must stay green.** §1 and §2 are refactors and are already covered:
  `test/editor.test.js` (24 tests) pins the transforms, `test/determinism.test.js:57-88` pins
  the build path, `test/stage.test.js:245-292` pins `placeInFrame`.
- **`test/nodeSession.test.js`** (new): `buildNodeSession` on `examples/pages.project.json`
  produces the same frame hash as the pre-refactor CLI, and works with `sidecar: null` — the
  vector and text branches need no Python, which is exactly the trick `test/prepare.test.js:34`
  already uses.
- **`test/mcp.test.js`** (new), pure layer only: `storyboard` produces a document
  `normalizeProject` accepts; param clamping rejects out-of-range values and unknown keys;
  `animId`-vs-kind mismatch is refused; a workspace escape (`../../etc/x`) is refused; a
  structural edit invalidates the cached session and a timing edit does not; an edit that fails
  validation leaves the document untouched; `remove_page` on a referenced page returns an error
  rather than silently succeeding; `placeInFrame` auto-placement puts a clip's bbox centre at
  the camera centre.
- **`mcp/smoke.js`**: spawn the server over stdio, `initialize`, `tools/list`, then drive a real
  session — `create_project` → `write_svg` → `storyboard` with two beats →
  `render_contact_sheet` → assert an image comes back and the document validates. Needs no
  display, no ffmpeg, no venv.
- **By hand, end to end:** from Claude Code, ask for a 15-second explainer, look at the contact
  sheet, reword one caption with `update_asset`, adjust a clip's timing, re-render, then
  `export_video` and play the MP4.
- **Confirm the cache key works:** rebuild twice and check the second skips the sidecar. Note
  the 66 entries in `.cache/` today are stale glyph-skeleton keys from a dead path
  (`skeletonizeGlyph` has no JS callers; `layoutText` is only reached from
  `test/text.test.js`), so any new entry is unambiguously the vectorize one.
- **Also confirm app export still works** — `electron/main.js:345-383` spawns
  `render-project.js`, so the §1 extraction is on the app's export path, not just the CLI's.

## Open assumption

Strict workspace sandboxing makes `import_asset` the only way an external image can ever enter
a project. It reads from an arbitrary path by design; if that is not wanted, the alternative is
that the user copies files into `mcp-workspace/assets/` themselves and `import_asset` is
dropped.
