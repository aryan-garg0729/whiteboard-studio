# Whiteboard Animation Studio — status & handoff

A VideoScribe/Doodly-class tool: drop in images, text and audio; arrange them on a timeline;
export a hand-drawn-on-whiteboard video at 1080p. Requirements are in [`req.md`](req.md).

**State: the rendering engine is complete, the editor is usable end to end, and an agent can
author projects without the UI.** Import artwork or audio, add text in one of nine bundled
faces (bold or regular), arrange clips on a drag-and-drop timeline, position and resize clips
on the canvas, move the camera, and export MP4 — all from the app. Multiple pages with swipe
transitions work, including returning to a filled page and drawing on it again. 293 tests, of
which 292 pass — the one failure is a stale assertion about a bundled example, noted under
[Testing](#testing).

**Artwork is drawn from pixels, not from traced geometry.** Two animations draw pictures.
`draw.inkPaint` is the default: it inks the black linework first by running the pen down its
centreline, then colours each connected shape in turn. `draw.stencilPaint` is the fallback for
pictures with no linework and no flat areas — a photograph, a soft gradient — and simply paints
across the artwork. Both work the same way underneath: every pixel belongs to exactly one colour
group, each group closes with its own exact coverage mask, and so **the last frame of a clip is
the source image, byte for byte** — pinned by a test over every bundled raster. The Python
vectorizer that used to downscale, quantise and area-threshold its way to an approximation is
deleted, and with it the last reason any host needed Python.

> Earlier attempts live in `../v1` and `../v2`. They are **out of scope** — do not read or
> reuse them. This is a clean rewrite.

**How to read this document.** [Architecture](#architecture) and [The project
document](#the-project-document) are the model. [Known
limitations](#known-limitations--read-before-fixing-these) and [Bugs already
fixed](#bugs-already-found-and-fixed--do-not-reintroduce) are the expensive part: almost every
entry there was found by looking at rendered output, not by a test, and several look like
bugs until you know why they are that way. Read them before changing anything in the render
path.

---

## Contents

- [Quick start](#quick-start)
- [Architecture](#architecture)
- [The project document](#the-project-document)
- [The three hosts](#the-three-hosts)
- [The MCP server](#the-mcp-server--an-agent-as-author)
- [Hand assets — measured facts](#hand-assets--measured-facts)
- [Subsystem status](#subsystem-status)
- [Known limitations](#known-limitations--read-before-fixing-these)
- [Bugs already found and fixed](#bugs-already-found-and-fixed--do-not-reintroduce)
- [Subtle invariants worth preserving](#subtle-invariants-worth-preserving)
- [Testing](#testing)
- [Next steps](#next-steps)

---

## Quick start

```bash
npm install                  # node deps
npm run sidecar:install      # python venv for the CV sidecar (numpy/scipy/skimage/cv2)
npm test                     # 279 tests
npm run app                  # build + launch the Electron app
npm run demo                 # renders demo.mp4 — draw + colour + handwrite + erase
```

**Nothing needs Python to render.** The sidecar survives only for `layoutText`, the legacy
centreline route that no host calls; images, SVG and text all compile in pure JS. Installing
the venv is optional and no asset kind fails without it.

Verified toolchain on this machine: Node 20.20.2, npm 10.8.2, system **ffmpeg 4.4.2**
(libx264, h264_nvenc, h264_vaapi), Python 3.10.12. `potrace` and `inkscape` are **not**
installed and the system Python has **neither `skimage` nor `cv2`** — hence the venv.

### Scripts

| Command | What it does |
|---|---|
| `npm run app` | **Launch the app** (vite build + electron) |
| `npm run dev` + `npm run app:dev` | Vite dev server, then Electron against it (hot reload) |
| `npm run render:project -- examples/pages.project.json` | **Render a project file** — the generic, data-driven path |
| `npm run mcp` | **The MCP server** — lets an agent author projects |
| `npm run mcp:smoke` | Drives the MCP server over real stdio, end to end |
| `npm test` | The unit suite (`node:test`, no framework) |
| `npm run demo` | Full reel from a hardcoded script (kept for reference) |
| `npm run demo:frames` | Same, as a PNG sequence in `.preview/` (fast to inspect) |
| `npm run animate:image -- pic.png --seconds 6 --erase 2` | One image, sketched and painted |
| `npm run animate:text -- "Hello" --size 200` | Handwriting only |
| `npm run calibrate:hands` | Regenerates `assets/hands/*.json` from `hands/*.png` |
| `node scripts/export-sample.js` | Minimal hard-coded export, for isolating export bugs |
| `node scripts/render-preview.js` | Minimal hard-coded engine preview, no sidecar needed |

Common render flags: `--frames-only` (PNGs instead of MP4), `--no-hand`, `--out path.mp4`.

### Headless UI checks

| Variable | Meaning |
|---|---|
| `WB_SMOKE=out.png xvfb-run -a npx electron .` | Boots the app, loads a project, screenshots |
| `WB_SMOKE_PROJECT=pages.project.json` | Which project to open — a bare name is an example, anything with a `/` is a path |
| `WB_SMOKE_SCRIPT=path.js` | Evaluates an interaction script in the renderer before the screenshot |

Drivers live in `scripts/smoke/`. Assert against `window.__studioState()` — a read-only view
of the document, selection and frame — rather than scraping input values, which lag a commit
boundary behind. Note it spreads each clip's `transform` onto the clip itself, so it is
`clip.x`, not `clip.transform.x`.

---

## Architecture

```
src/
  engine/            # pure JS, no DOM, no canvas import — the host injects a surface factory
    compile/         # asset -> ordered stroke primitives (all time-independent, cacheable)
      geometry.js    #   bezier flattening (Wang), arc-length tables, locate(), tangentAt()
      order.js       #   human-looking stroke sequencing + pen-up travel moves
      scribble.js    #   boustrophedon zig-zag infill (used by paint AND erase)
      pixels.js      #   raster -> colour groups, boundary rings, exact coverage masks
      paintPasses.js #   groups -> the ordered strokes the pen walks
      centerline.js  #   a filled shape -> its centreline, and which stroke owns which pixel
      inkPasses.js   #   linework + shapes -> the ink pass and the colour pass
      svgPath.js     #   SVG path data -> flattened subpaths; opentype commands too
      svgDoc.js      #   whole SVG document -> contours + fillable regions (+ stroke paint)
      text.js        #   opentype.js layout, weight, glyph stroke ordering/orientation
    anim/
      registry.js    #   AnimationType plugin registry; PenState contract
      penStrokes.js  #   the brush primitives every animation shares
      appear.js      #   entrances: instant/fade/pop/slide, no pen at all
      inkPaint.js    #   THE DEFAULT for pictures: ink the outline, then colour shape by shape
      stencilPaint.js#   fallback for photos/gradients: paint across the artwork
      textReveal.js  #   text: filled letterforms revealed left to right (the default)
      handwrite.js   #   text: guided, font-faithful letter tracing
      erase.js       #   erase modifier (not an animation type — see below)
    render/
      renderFrame.js #   THE contract: pure (project, frameIndex) -> pixels;
                     #   renderPage() is the per-sheet seam page transitions composite
      surfaces.js    #   per-clip canvases + committed/active raster strategy
      drawHand.js    #   hand sprite placement
      vectorArt.js   #   a vector's own fills+strokes; the artwork the pen uncovers
      rasterize.js   #   asset -> pixels; where image and vector stop being different
    model/
      project.js     #   document schema, defaults, validation; the seam every host sits on
      edits.js       #   every document transform, as pure doc -> doc; shared by UI and MCP
    host/
      nodeSession.js #   document -> renderable session under Node; CLI and MCP share it
    hand/rig.js      # nib placement, rotation clamp, never-detached scale solve
    hand/styles.js   # which manifests exist: drawing hands vs. tool styles (eraser)
    export/          # ffmpeg arg/filter-graph building + the frame pump
    sidecar/client.js# Node client for the Python process
  ui/                # renderer: React app (plain JS)
    App.jsx          #   shell, transport, command wiring
    stageGeom.js     #   local/world/screen mapping for direct manipulation
    state/editor.js  #   reducer, undo/redo, structural-vs-timing bookkeeping
    engineHost.js    #   rebuilds plans from the IPC payload; OffscreenCanvas surfaces
    components/      #   Menubar, Library, Stage, StageOverlay, Inspector, Timeline
electron/
  main.js            # window, IPC, sidecar lifecycle, menu, export, WB_SMOKE hook
  preload.cjs        # contextBridge surface (no ipcRenderer exposure)
  prepare.js         # project -> JSON-safe payload (geometry + data URLs)
  fonts.js           # bundled face manifest, parse check, path guard
  media.js           # ffprobe duration, waveform peaks, thumbnails, hasFfmpeg()
src/sidecar/         # Python: stdio JSON-RPC — no shipping path needs it
  server.py          #   protocol + disk cache
  skeleton.py        #   glyph outline -> ordered centreline strokes (legacy layoutText)
mcp/                 # MCP server: an agent authoring host
  server.js          #   tools, resources, prompts over stdio
  studio.js          #   open documents, cached sessions, transactional edits
  storyboard.js      #   script -> complete draft in one call
  capabilities.js    #   the vocabulary, and the checks the schema does not make
  render.js          #   frames and contact sheets, sized for a context window
  export.js          #   background encode jobs
  workspace.js       #   the sandbox
  guide.js           #   the authoring guide, served as a resource
  smoke.js           #   spawns the real server over stdio and drives a session
assets/hands/*.json  # generated hand-style manifests (calibrated from the PNGs)
assets/fonts/        # nine bundled faces + fonts.json manifest
hands/*.png          # source hand art (supplied, not generated)
examples/            # worked project documents
```

### The one contract everything hangs off

```js
renderFrame(session, project, frameIndex, ctx, { width, height, showHand, handStyleId })
```

A pure function of `(project, frameIndex)`. Preview and export call it identically; export
just supplies a bigger context. Rules enforced below this line:

- **No `Math.random`, `Date.now`, or `performance.now`** — all jitter is baked at compile
  time with a seeded PRNG (`mulberry32`).
- **`frameIndex` is the parameter, not `t`** — accumulating `t += 1/fps` drifts, deriving
  `t = n/fps` does not.
- **The hand is drawn in screen space**, outside the camera transform, so it keeps a
  constant apparent size at any zoom.

A test stubs `Math.random` to throw during a 20-frame render. Another asserts a backward seek
produces pixels identical to forward playback.

**`session` and `project` are separate arguments**, and that is a trap worth naming up front:
a session cached beside an *older* document will happily go on rendering that older document,
with no error anywhere. See [the staleness trap](#the-staleness-trap-in-the-session-cache).

### The session

A session holds everything compiled from the document that `renderFrame` needs:

| Field | Contents |
|---|---|
| `session.plans` | compiled geometry per clip id |
| `session.erasePlans` | the erase sweep per clip id, where one exists |
| `session.surfaces` | the canvases per clip id (`ClipSurfaces`) |
| `session.hands` | loaded hand manifests, keyed by style id |

Building one is: normalise the document → compile every clip → load the hand styles →
`ensureSurfaces` → paint each clip's source artwork into `sf.art`. That last step is what
the reveal uncovers, and it must be asked for explicitly rather than conjured by rendering a
warm-up frame — a clip on a page that frame does not show would get no surfaces and no
artwork.

### Extensibility seams

- **New animation type** = one file exporting `{id, label, paramSchema, compile, advance}`
  plus a `register()` call, *and* an import somewhere on each host's path — registration is
  an import side effect, so a module nobody imports is invisible to `getAnimation()` and to
  `listAnimations()`. `advance()` returns a `PenState`, which is how the hand rig stays
  decoupled from what is being drawn: a new animation gets hand-following for free.
  `paramSchema` drives the Inspector UI and the MCP layer's parameter validation
  automatically.
- **New hand style** = PNGs, a `STYLES` entry in `scripts/calibrate_hands.py`, and its id in
  the right list in `src/engine/hand/styles.js` — a drawing hand in `HAND_STYLE_IDS`, a
  non-pen tool in `TOOL_STYLE_IDS`. `npm run calibrate:hands` derives tip, arm exit, bbox and
  shaft angle from the alpha channel. That list is not optional bookkeeping: a style no host
  loads is invisible to `pickStyleForTool()`, which is exactly how the eraser sat
  calibrated-but-unused.
- **New asset kind** = a branch in `compileClip` (`host/nodeSession.js`), the twin branch in
  `electron/prepare.js`, and an entry in `ASSET_KINDS` and `ANIMATIONS_FOR_KIND`.

---

## The project document

Defined and validated in `src/engine/model/project.js`. `normalizeProject()` fills defaults
and throws `ProjectError` with a path (`clips[1].animId: unknown animation "draw.wiggle"`)
rather than rendering something wrong. See `examples/pages.project.json` for a worked
document.

```js
{
  meta:   { version, name, fps, width, height, background, handStyleId, showHand },
  assets: {                          // keyed by id
    art1:  { kind: 'image'|'vector', src },
    text1: { kind: 'text', text, font, fontSize, penWidth, color, bold },
  },
  pages:  [{ id, name, cameraKeyframes: [{ t, x, y, zoom }] }],
  pageBreaks: [{ t, pageId, transition, duration }],  // the itinerary over the sheets
  tracks: [{ id, name, kind }],      // 'clip' | 'audio'; timeline lanes, layout only
  clips: [{
    id, assetId,
    animId,                          // registry key, e.g. 'draw.stencilPaint'
    pageId,                          // which sheet it is drawn on
    trackId,                         // which lane it is drawn on
    start, duration,                 // seconds, timeline
    erase: { start, duration },      // optional modifier
    transform: { x, y, scale, rotation },
    params: { … },                   // per-animation, see its paramSchema
  }],
  audio: [{ src, trackId, start, trimIn, duration, gain }],
}
```

Plain JSON, and the single source of truth for `renderFrame`.

**The material lives on the asset, not the clip.** Text, font, size, pen width and colour are
asset fields; a clip only says *when*, *where* and *how* it is drawn. Rewording a caption is
therefore an asset edit, and every clip sharing that asset changes with it.

**Erase is a clip property, not an animation type** — that way it works identically for
images and text without either knowing about it, since both produce the same `ClipSurfaces`.

**`pages` is the set of sheets; `pageBreaks` is the itinerary over them.** Splitting the two
is what makes "go back to page 1 and keep writing" expressible at all — a break may name a
page that has already been visited, so a page gets one *window* per visit rather than a single
lifetime. `pageWindows()` derives those windows and `pageStateAt()` answers "which sheet, and
how far through a swipe" — the renderer asks nothing else.

**Tracks are layout, nothing else.** No code below `renderFrame` reads `trackId`, and
`projectDuration()` ignores tracks entirely, which is what lets a vertical drag on the
timeline be a timing-class edit rather than a re-trace. It is also why every pre-tracks
project file still loads: `normalizeProject` synthesises the default lanes and assigns
everything to them.

### What the validator enforces

These are errors, not warnings. An edit that breaks one is rejected outright.

1. **A clip may only draw while its own page is on screen** — checked per *window*, not
   against their union, so a draw cannot span a gap where the page left and came back. Draw
   and erase are checked separately, because drawing on one visit and wiping on a later one is
   a reasonable thing to author.
2. **The swiping interval belongs to neither page.** A window opens when the transition lands
   and closes when the next one begins, so nothing can be drawn while the paper is moving —
   and the renderer draws no hand there either.
3. **Page breaks may not overlap.** A break cannot begin before the previous transition has
   landed.
4. **An erase may not begin before its clip has finished drawing.**
5. **A clip's lane must match its kind.** Clips on clip tracks, audio on audio.
6. **A `cut` has zero duration by definition** — honouring a duration on it would make the
   same document mean two different things depending on which field was edited last.

The strictness is deliberate, and the editor is what keeps it from being annoying: a clip's
`pageId` travels with it when you drag it past a break (same coalesced patch as the move, so
one undo step and every intermediate frame legal), and "Add page" places the break after
everything already authored rather than orphaning later clips.

### What the validator does *not* enforce

Worth knowing precisely, because a human in the UI cannot reach these cases — the Inspector
only offers valid choices — while anything writing JSON directly hits them immediately, and
the failure mode is a blank frame rather than an error.

| Unchecked | Consequence |
|---|---|
| `clip.params` | Passed through verbatim. Unknown keys are ignored; a wrong type reaches the animation. |
| `transform` numerics | Spread raw. A string `scale` reaches the renderer and produces NaN geometry. |
| `animId` vs asset kind | `ANIMATIONS_FOR_KIND` is advisory UI data the schema never consults. `draw.handwrite` on an image compiles to nothing. |
| `meta.handStyleId` | Any string. An unknown one fails later, at manifest load. |
| Asset extra fields | `font`, `fontSize`, `penWidth`, `color`, `lineHeight` pass through unchecked. `bold` *is* checked. |
| Whether `src` exists on disk | Fails at compile, not at validate. |

`mcp/capabilities.js` closes all of these for the agent-facing host. The Inspector closes them
for the app by construction. A new host needs its own answer.

---

## The three hosts

The engine is DOM-free and canvas-free; each host injects a surface factory and feeds it a
document. Keeping them in agreement is the single thing the architecture is built around — a
preview that disagrees with the export is the failure mode everything here is arranged to
prevent.

| Host | Entry | Surfaces | Compiles where |
|---|---|---|---|
| **Electron app** | `electron/main.js` → `src/ui/` | `OffscreenCanvas` | main process reads files, renderer compiles |
| **CLI** | `scripts/render-project.js` | `@napi-rs/canvas` | in process, via `buildNodeSession` |
| **MCP server** | `mcp/server.js` | `@napi-rs/canvas` | in process, via `buildNodeSession` |

**The app splits the work across the IPC boundary.** The renderer cannot read files, so
`electron/prepare.js` turns a document into a JSON-safe "prepared" payload — laid-out text,
parsed SVG geometry, images as data URLs — and `src/ui/engineHost.js` compiles plans from that.
Artwork analysis happens renderer-side, so no coverage mask ever crosses the wire.
`prepare.js` and `nodeSession.js` contain the **same three-kind branch**, including the same
sub-branch on `animId !== 'draw.handwrite'`, and comments in both flag them as deliberately
twinned. Changing one without the other is how preview and export drift.

**The app's export is the CLI.** `ipcMain.handle('export:start')` writes the project to a
tmpdir and spawns `scripts/render-project.js` as a child process with `ELECTRON_RUN_AS_NODE=1`,
scraping `encoding n/total` from its stdout for the progress bar. That is deliberate — one
frame pump, so preview and export cannot diverge — and it means **anything that changes
`render-project.js`'s argv or stdout contract breaks export in the app**.

**The CLI and the MCP server share `buildNodeSession`** (`src/engine/host/nodeSession.js`), so
a frame an agent inspects is built by exactly the code that encodes the MP4.

There is a fourth function also named `buildSession` in `src/ui/engineHost.js`. The two cannot
be merged — different inputs, different surface factory — but they return the same shape
(`{ session, project, frames, bboxes }`), which is what lets callers treat them alike.

### Document transforms

Every editing action is a pure `doc -> doc` function in `src/engine/model/edits.js`: `addClipTo`,
`patchClip`, `patchAsset`, `addPageBreak`, `removePage`, `withCameraAt`, `placeInFrame` and the
rest. That is what makes undo a one-liner and keeps a host from accumulating a second,
divergent model of the scene.

`src/ui/state/editor.js` re-exports them and keeps only what is genuinely React: the reducer,
history, and the **structural-vs-timing** split. An edit is *structural* when it changes
compiled geometry — new assets, new text, a different font, a different animation. Timing and
placement edits are pure `renderFrame` inputs and repaint immediately, which is why dragging a
clip on the timeline is smooth. `isStructural(patch)` is the shared classifier; `TIMING_FIELDS`
is the list.

**A refusal throws.** `removePage` on a page that still has clips raises `EditError` with the
reason rather than returning the document unchanged. The UI catches and no-ops — the button was
disabled anyway, and an exception out of a click handler would take the renderer down — but a
headless caller needs to be told, because a document returned unchanged is indistinguishable
from success.

---

## The MCP server — an agent as author

`mcp/server.js` exposes the authoring loop over stdio: build a document, look at rendered
frames, refine, export. `.mcp.json` at the repo root points at it, so Claude Code picks it up
with no install step. `whiteboard://guide/authoring` is the guide written for the model, and
`mcp/guide.js` is where to edit it.

### Tools

| Tool | Notes |
|---|---|
| `list_capabilities` | The whole vocabulary in one call — animations with `paramSchema` and the kinds each suits, the nine fonts, hand styles, transitions, defaults, **and whether ffmpeg and the sidecar are actually installed** |
| `create_project`, `list_projects`, `get_project`, `undo` | Lifecycle |
| `storyboard` | Script → complete draft in one call. The intended starting point |
| `add_clip`, `update_clip`, `remove_clip` | Clips |
| `update_asset` | The words of a caption, its face, size, colour. The only route to rewording |
| `write_svg`, `import_asset` | Artwork in |
| `add_page`, `set_camera`, `set_meta`, `add_audio`, `remove_audio` | Structure |
| `render_frame`, `render_contact_sheet` | Seeing |
| `export_video`, `export_status` | Background encode, polled |

### Four decisions that make it usable rather than merely working

**A clip has to be placed, not dropped at the origin.** A drawable's origin is its bounding-box
*corner* and its natural size is often larger than the frame, so a clip at the default
transform sits mostly off screen. The app fixes this with a second pass once the trace returns
over IPC; headless the compile is in-process, so `add_clip` compiles the clip, measures it and
places it before the edit is ever committed. `placeInFrame` lives in `model/edits.js` for this,
and takes a `grow` flag: **vector artwork is the one kind that may be scaled up**, because an
SVG's viewBox units are arbitrary — `0 0 240 140` and `0 0 2400 1400` are the same picture —
while a raster has real pixels and text has an authored `fontSize`.

**An agent needs numbers, not only pixels.** `get_project` returns each clip's world-space rect
and flags anything running off the canvas or overlapping another clip while both are on screen.
The two mistakes that actually happen are exactly measurable, so they are reported as
measurements rather than left to be spotted in an image.

**Images cost context.** A 1920×1080 PNG is over a megabyte of base64, and an agent that spends
its context on four of those has none left to reason with. Frames go out at 720px and contact
sheets at 1200px total. `render_contact_sheet` — the whole video as one labelled grid — is the
intended way to look at a draft, and is far cheaper than N separate frames.

**Edits are transactional.** Apply the transform, run `normalizeProject`, keep the result only
if it passes. A rejected edit changes nothing and the validator's message goes back verbatim —
those messages already name the field and explain the conflict in a sentence, which is better
feedback than this layer could synthesise.

### The sandbox

Everything the server writes stays under `mcp-workspace/`. The guard is the same shape as
`bundledFontPath` (`electron/fonts.js`): `join` first so `..` normalises away, then require the
prefix — testing the raw string would let `mcp-workspace/../../etc/passwd` through. Reads are
additionally allowed from the repo's own `assets/` and `examples/`, which the engine needs.

`import_asset` is the one sanctioned door inward, copying an external file in. Without it,
strict sandboxing would mean no user image could ever enter a project.

`write_svg` matters more than its size suggests: vector artwork skips the tracer entirely, so
an agent can author exact diagrams with **no image files and no Python at all**.

### The staleness trap in the session cache

Read this before touching `Studio.built()`.

`renderFrame(session, project, …)` takes the document as a *separate argument* from the
session, so a session cached alongside an older document goes on rendering that older
document — silently, and with no error anywhere. Every non-structural edit hit this: a camera
move, a retime, a page break, a clip nudged across a page were all saved to disk and then
simply did not appear, until some later structural edit happened to force a rebuild. An export
could encode the stale version too.

The fix is **not** to rebuild on every edit — that re-traces artwork for a change which cannot
affect it, which is the whole point of the structural split. Each open document carries a
`rev`; a stale session has its document swapped in while keeping its compiled plans. The
surfaces stay valid because `surfacesFor` keys only off `plan.bbox`, and the artwork already
painted into them is untouched. A clip appearing or vanishing falls back to a full rebuild.

This was found by *using* the server, not by testing it — the unit suite passed throughout.

### Note for anyone editing the server

The server is a long-lived process spawned by the MCP client. **Code changes do not take
effect until it restarts**, so a fix verified only through the live tools will appear not to
work. `npm run mcp:smoke` spawns a fresh server per run and is the real end-to-end check.

---

## Hand assets — measured facts

Derived by reading alpha channels, not assumed. Regenerate with `npm run calibrate:hands`.
Figures below are for the 1080p source of each style.

| Asset | Label | Geometry | Tip | Arm | Variants |
|---|---|---|---|---|---|
| `hand1` | Right hand, ballpoint | forearm + hand | (542.9, 0) | exits bottom, len 1921.7 | 3 |
| `hand2` | Right hand, felt-tip | forearm + hand | (414.3, 0) | exits bottom, len 1923.4 | 3 |
| `hand3` | Right hand, marker | forearm + hand, **diagonal** | (801.5, 21) | exits **left**, len 1858.7 | 1 |
| `hand4` | Floating pen (no hand) | **pen only** | (233.6, 1510) | touches no edge | 3 |
| `eraser` | Right hand, eraser | forearm + hand, block eraser | (457.5, 68.0) | exits bottom, len 1972.0 | 1 |

`hand1`–`hand4` are **drawing hands**, offered in the picker; `hand3` is the default.
`eraser` is a **tool style**: loaded alongside whichever hand is chosen, and selected
automatically while an erase sweep runs. The two lists live in `src/engine/hand/styles.js`.

Five things that shape the design:

1. **Tip x drifts between resolution variants** (hand1: .5299 @720p / .5028 @1080p / .5198
   @1440p). They are not clean rescales, so tips are stored **per source file**.
2. **Auto-detection is unreliable** — topmost-opaque finds the right nib on hand1/hand2 but the
   pen *cap* on hand4. `tip_hint` in `scripts/calibrate_hands.py` pins it.
3. **The eraser's tip is not an alpha extremity at all.** Its index fingertip touches the top
   frame edge *above* the block, so every alpha-based hint rigs the hand by its finger and drags
   the eraser off the stroke. The block is found by colour instead (`is_tool_px`: skin is always
   R > G > B, the pink is the only saturated thing with more blue than green), and the tip is
   the midpoint of the first row wide enough to be the working face rather than its antialiased
   corner.
4. **`hand3` exits the left edge at 64° off its normal**, not the bottom. That single fact broke
   the old `minScale` closed form — see [Known limitations](#the-hand-rig).
5. **`hands/*vertical-*.png` are damaged** — pre-rotated with smearing artifacts. Not used; the
   clean assets are rotated at render time instead.

### The never-detached rule

```
s_min = (H_frame + margin) / (|V| · cos(θ_max + |assetTilt|))
```

`|V|` is the tip→elbow distance. For hand1 at 1080p this is **0.647**, giving a hand 22% of
frame width — where reference products sit.

The `assetTilt` term is **not optional**: the applied rotation is clamped to ±θ_max but
compounds with the asset's own lean (hand1's arm is 2.4° off vertical), so the worst case is
27.4°, not 25°. Omitting it leaves the arm 22px short of the edge with the nib at the top of
frame — a visibly floating hand, in exactly the case the constraint exists to prevent. A 9×9
grid × 4 tangents test covers this.

**`hand4` is a "floating pen" style** (`constraint: "none"`), *not* no-hand mode. No-hand mode
(`showHand: false`) draws no sprite at all.

---

## Subsystem status

### Done and verified

| Subsystem | Notes |
|---|---|
| Drawable compilation | Wang's-formula flattening, arc-length pacing (constant pen speed) |
| Stroke ordering | Containment grouping, reading-order score, nearest-endpoint chaining with anti-gravity, closed-ring seam selection, pen-up travel arcs |
| Zig-zag fill | Boustrophedon with cell decomposition, seeded wobble/overshoot |
| True-colour reveal | Scribble mask ∩ artwork — reveals real pixels, not flat colour |
| Hand rig | Placement, rotation clamp, edge constraint, portrait arm-stretch |
| Raster decomposition | Median-cut palette, every pixel labelled, boundary rings on the pixel lattice, rectangle coverage masks — pure JS, no Python, and **nothing is dropped** |
| Text write (default) | `draw.textReveal` — real filled letterforms revealed left to right under an oscillating hand, word by word. `outlineText()` keeps the glyph outline opentype already has, so text is instant |
| Bold text | `asset.bold`. A face with a sound `wght` axis is set to a real 700; the rest have their own outline stroked wider. Which one a face gets is *probed*, not assumed — see Known limitations |
| Text handwriting | `draw.handwrite` — semantic character guides reveal the selected OpenType glyph outlines. Still selectable, and what every pre-existing project uses |
| Image and SVG drawing | **`draw.inkPaint`, the default.** For pictures drawn with a black outline and flat colour fills, which is what this tool is pointed at. Colours are anchored on the artwork's own flat fills rather than cut to a count, so slight variation is one colour and the group count is discovered. The dark neutral groups are inked first: the pen runs down the linework's **centreline** while the reveal is assigned per pixel, so the outline appears at its real thickness and nothing is rounded or fattened by the nib. Then each **connected shape** is coloured in turn, largest first. An SVG is rasterised and takes the identical path |
| The fallback | `draw.stencilPaint` — for pictures the default's assumption does not fit: a photograph, or a soft-gradient illustration with no linework and no flat areas. The pen paints across the artwork and `composite()` shows the real picture through the mask. Two styles: `zigzag` (one sweep, with `sweepAngle`/`sweepFrom`) and `colorGroups` (one colour at a time, in `groupOrder`). **It no longer sketches a pencil stencil first** — that sketch spent a third of the clip drawing something guaranteed to be erased, and on artwork whose group boundaries are its linework it laid a second, greyer outline just inside the real one. Drawing the outline first is what `inkPaint` is for |
| Both, equally | Every pixel is owned by a group and each group closes with its exact mask, so **the last frame is the source image, byte for byte**. Neither lays pen ink, so `composite()` has nothing to knock out; `settles: false` on both, because the artwork is already on screen and compositing an image over itself raises every partial alpha |
| Entrances | `appear.instant` / `fade` / `pop` / `slide` for every asset kind. They take an asset in **either** shape — a text layout with an explicit `bbox`, or artwork as `{id, image}` — because that is what the hosts pass for the two kinds. Getting that wrong is not cosmetic: surfaces are allocated from `plan.bbox`, so a zero box means a zero-sized canvas and the clip renders as nothing at all. The mask is filled whole and the entrance is an opacity/offset/scale applied at **blit** time (`AnimationType.present`), because the surfaces only extend 32px past the drawable and a pop would clip itself |
| Clip params | The Inspector renders the selected animation's `paramSchema` generically, so an animation declares what it needs instead of growing bespoke controls. The MCP layer validates against the same schema |
| SVG import | Shapes, groups, nested transforms, style/presentation attrs, fill→region, holes |
| App shell | Electron + React; library, stage, inspector, timeline. Commands live in the **real application menu** (`buildMenu` in `electron/main.js`) and reach the renderer over `menu:command` |
| Project name | `meta.name`, independent of the filename so it survives Save As; falls back to the filename, then "Untitled", and mirrors into the window title |
| Asset placement | Click-added assets are centred on the **camera's** framing and shrunk to fit if oversized (`placeInFrame`, `model/edits.js`); a stage drop still lands under the cursor |
| Asset import | File dialog and drag-and-drop (with a byte-copy fallback when a dropped file has no path); ffprobe duration, waveform peaks, thumbnails |
| Font picker | Nine faces **bundled in `assets/fonts/`** (manifest `fonts.json`), handwriting first, each row set in its own type via the FontFace API over `fonts:read`. `FontPicker.jsx` serves both the Library and the Inspector |
| Timeline | Named tracks with clips auto-packed into shared lanes, drag to move (horizontally to retime, vertically to re-lane), edge-resize, snapping, ruler scrub, audio waveforms |
| Audio preview | WebAudio mixes the tracks live and is the master clock, so the drawing cannot drift from narration; per-lane and master mute are monitoring-only and never reach the document |
| Inspector | Clip timing/transform/erase, text and asset params, composition settings |
| Undo/redo | Pure document transforms; drags coalesce into one history entry |
| Settle to original | Nothing ships that needs it any more: every drawing animation shows the real artwork from the first stroke and sets `settles: false`. The crossfade machinery (`settleAt`, `SETTLE_SECONDS`) is still in `renderFrame` for a future animation that draws a surrogate |
| Direct manipulation | Click to select, drag to move, corner handles to resize with the opposite corner anchored |
| Erase | Top-down sweep, `destination-out` on the clip layer only; runs on the settled artwork, with the eraser hand |
| Export | 1080p MP4, `ffprobe`-verified h264/yuv420p/exact duration; ffmpeg audio graph. Encode throughput is content-dependent — measured 42fps on the simple demo, 23.7fps on `examples/pages`, 14fps on a four-page project with a camera move |
| Determinism | Backward-seek == forward playback, byte-identical across sessions |
| Pages | Multiple sheets with swipe up/down/left/right and cut between them; a page may be revisited and drawn on again, and each visit is its own segment on the timeline's page lane |
| Camera | Per-page keyframed `{x, y, zoom}`; authored with the stage's Camera tool (`C`), a timeline camera lane, and "Zoom to selection". **Zoom interpolates geometrically, x/y linearly**, both under the same smoothstep, so the apparent zoom rate is constant |
| Headless authoring | `buildNodeSession` + `model/edits.js`; the CLI and the MCP server ride on both |
| MCP server | 21 tools, resources and prompts over stdio; sandboxed workspace; background export |

### Not started

| Piece | Notes |
|---|---|
| **Page curl** | The four swipes and cut ship; the strip-based paper curl does not. `renderPage()` is the seam it would consume — it already hands back a whole page as a bitmap |
| **Backward-scrub snapshots** | Backward seeks still replay from zero — see Known limitations |
| **Editor viewport pan/zoom** | The stage fits or zooms to fixed steps; no free navigation of the *editor view*. Distinct from the document camera, which ships — that one is exported, this one would not be |
| **Packaging** | No electron-builder config yet |

---

## Known limitations — read before "fixing" these

### Tracing and artwork

- **The picture keeps its background.** There is no paper knockout any more: an image renders
  its own pixels, white rectangle and all. That is the price of the exactness guarantee, and it
  was chosen deliberately. A drawing on white therefore sits on a visible panel rather than
  blending into the paper — import it with transparency if you want it cut out.
- **A big flat area costs clip time that looks idle.** `colorGroups` paints one colour at a
  time, and a white background is a colour: on artwork that is mostly background the visible
  content can be finished well before the clip is. The brush widens with the square root of a
  group's area, which turns time-proportional-to-area into time-proportional-to-diameter and
  mostly hides it; beyond that, use fewer `colors`, or `zigzag`, which crosses colours freely.
- **The pen's path is allowed to skip things; the coverage is not.** Rings under
  `MIN_RING_AREA`, connected pieces under `MIN_PIECE_AREA`, and centreline spurs are all dropped
  from where the nib *travels* — an antialiased edge quantises into thousands of one-pixel
  islands (the bundled scribble icon makes 27557) and drawing them costs a great deal and shows
  nothing. Their pixels are still painted, by the coverage mask, like every other pixel. Prune
  the path, never the coverage: that distinction is the whole reason "no pruning" holds.
- **An SVG rasterises at one pixel per user unit.** Object space is user units — that is what
  every saved `transform.scale` was authored against — and a clip's artwork surface is allocated
  from its object-space bbox, so there is nowhere to put a supersampled copy. Blown up far past
  its own viewBox an SVG softens. Give it a larger viewBox if you need it sharper.
- **The scribble reads as a clean diagonal wipe** at default brush sizes, because passes overlap
  35%. That matches reference products, but `fillBrushWidth` and `overlap` are tunable if you
  want strokes more legible.
- **SVG scope is the drawing subset.** Shapes, groups, transforms, `style`/presentation
  attributes and fill→region all work. Gradients degrade to flat grey rather than vanishing.
  Not supported: `<use>`/`<defs>` references, clip paths, masks, filters, embedded raster — each
  would change the animation model, not just the parser.

### Text

- **A `wght` axis is not enough to trust a face's bold.** Four bundled faces carry one, but
  opentype.js 2.0.0 mis-interpolates the odd glyph: Montserrat's `o` at wght 700 comes back with
  its counter nearly as large as the letter, so a bold caption renders a thin notched ring where
  an `o` should be. Every *other* glyph in the face doubles its ink correctly, which is why the
  check is per glyph and the verdict per face — mixing real and synthetic bold inside one word is
  more obviously wrong than a uniformly blunter bold. `hasSoundWeightAxis()` flattens five round
  letters at both weights and compares the ink; a face that fails drops to synthetic bold, which
  is the letterform's own outline stroked wider (`region.dilate`). Pure geometry, so it needs no
  canvas and gives the same answer in every host. There is no newer opentype.js to upgrade to.
- **Regular is pinned to wght 400, not left at the face's default.** Montserrat's axis defaults
  to 100, so before this every caption set in it rendered Thin.
- **Glyph outlines must not go through `path.toPathData()`.** opentype.js rounds coordinates with
  `+(Math.round(decimalPart + 'e+' + places) + 'e-' + places)` — string concatenation — so a
  fractional part small enough to stringify in exponential notation builds `"2.84e-14e+3"` and the
  coordinate serialises as the literal `NaN`. The contour is then lost and the glyph silently
  disappears. It depends on where the glyph happens to land, which is what made it read as a
  rendering glitch: at 64px it ate Caveat's `Y` and Playfair Display's `L`. `flattenCommands()`
  reads the command objects instead, which are always fine. A test sweeps every face at six sizes
  in both weights and asserts nothing is dropped.
- **Skeletonisation quality varies by font.** It extracts the medial axis of a *printed*
  letterform, so modulated serifs read as traced type. Text drawing no longer uses that route:
  both text animations preserve the selected glyph outlines.
- **The writing hand loops; it does not zigzag.** A pure vertical sine only ever moves the nib
  forward, so every stroke is a straight diagonal and the motion reads as a machine.
  `textReveal` adds a horizontal sine in quadrature, making the path an ellipse dragged forward
  — a prolate trochoid — which closes into cursive `eee` loops only while `LOOP_GAIN > 1`, i.e.
  the ellipse is wider than the forward drift. Drop it to 1 and the loops open back out into the
  old zigzag. The nib therefore moves *backwards* about a third of the time; the reveal
  **frontier** is the thing that must stay monotonic, and they are deliberately separate
  quantities. A test pins both.
- **The writing hand must not follow the sweep's tangent.** The oscillation is near-vertical and
  reverses twice per letter, so the raw tangent slams between roughly ±78°, which the rig scales
  into a ±12° rock about the nib — the hand visibly wags as it writes. `textReveal` therefore
  returns a fixed `tangent: 0` and moves only in translation. This is the same trap the
  serpentine scribble fill hit; a test pins the angle.
- **Settling needs an original to settle to.** Raster clips use their source pixels and vectors
  are repainted from geometry. **Handwritten text does not settle** — there is no separate
  original, the traced ink *is* the artwork. Revealed text is the opposite case: it is *only*
  artwork, masked, so it needs `sf.art` populated (`paintVectorArt` over the glyph regions) in
  every host or it renders as nothing at all.
- **`opentype.js` quirks**: `loadSync` is deprecated and silently returns `undefined` — use
  `parse(arrayBuffer)`. `stringToGlyphs` runs a shaping engine that throws on DejaVu's GSUB
  lookups — we use `charToGlyph` per character, which is what handwriting wants anyway and still
  applies kerning.

### The hand rig

- **The hand is large** (22% of frame width). That is forced by the never-detached constraint and
  matches reference products. The only lever is the procedural arm stretch.
- **`minScale` sweeps the rotation clamp; it is not a per-edge closed form.** It asks how far the
  nib can ever be from the boundary along the limb's direction — `min(W/|ux|, H/|uy|)`, the same
  geometry `elbowOutside` verifies against. The earlier form assumed the limb left through its
  anchor edge along that edge's normal and used the frame *height* whichever edge it was, so it
  was only right for a top/bottom anchor. hand3's forearm exits the **left** edge at 64° off its
  normal, which drove `cos(θmax + assetTilt)` toward zero and demanded a scale of ~34 — a sprite
  twenty times wider than the frame. For a near-vertical limb the two agree to within 0.001, so
  hand1/hand2/eraser are unchanged.
- **Judge hand size by the fist, not the manifest's `opaqueBBox`.** hand3's arm crosses the asset
  diagonally, so its ink bbox is 52% of frame width while the fist renders at ~21% — about the
  same as hand1. A bbox-fraction assertion would fail it for no real reason.
- **`naturalAngleDeg` is measured but not applied.** `drawHand` multiplies it by `0`, so the
  sprite draws at its asset pose. The calibrator still records it, and its shaft walk mismeasures
  hand3 as 68.8° — harmless while that `* 0` stands, but a trap for anyone who re-enables it.
- **The hand follows the pen's shaft angle, not its travel direction**, folded into (-90, 90].
  With `alignFactor` 0.16 the sprite moves within about ±14°, well inside the ±25° the scale
  solve assumes. Turning either up brings back the frantic scan-line swing.
- **Erase shows the eraser hand only because every host loads the tool style.**
  `pickStyleForTool()` selects on the manifest's `tool` field, but it scans `session.hands` — so
  a tool style is only reachable if the host actually loaded it. `styleIdsFor()` is the single
  list they share. **Adding another tool is a manifest plus one entry in that list.**

### Editing and the app

- **On-canvas handles ignore `rotation`.** The selection box is the axis-aligned bounds of a
  rotated drawable, which is a correct if loose target; rotation is edited numerically in the
  Inspector. Scaling is uniform because `transform` carries one `scale` and the compiled brush
  widths are chosen from it — non-uniform scaling would distort strokes.
- **Placing a clip in the app takes two steps and is one undo.** A drawable's size is unknown
  until the sidecar traces it, so a click-added clip lands on the camera centre and is centred
  exactly when `rebuild` produces its bbox. The second step is a `replace` edit, which amends the
  document without a history entry — otherwise Ctrl+Z after adding an asset would merely nudge it
  rather than remove it. The MCP server does not have this problem: it compiles in-process and
  places before committing.
- **Framing a shot plants *two* keyframes, and that is the point.** `withCameraAt()` inserts a
  hold one second earlier carrying the previous framing, so the move *arrives* at the playhead
  instead of creeping there from the last keyframe — otherwise framing a detail at 20s has the
  camera drifting for the whole preceding video. The function is idempotent at a given `t`, which
  is what makes it safe to call on every pointermove of a pan drag; do not "optimise" that into
  an insert-once path.
- **A camera move cannot cross a page break.** Keyframes belong to a page, and mid-swipe there are
  two sheets on screen with no single one to attach a framing to — the stage's Camera tool
  disables itself there.
- **The timeline leaves camera keyframes unsorted mid-drag**, exactly as it does page breaks: a
  drag holds an index, and re-sorting under it would hand the gesture a different keyframe.
  `normalizeProject` sorts on the way to the renderer.
- **The Library is session state with no persistence.** Removing an item forgets it for the
  session; it never touches the file on disk, and clips already placed carry the path themselves,
  so they keep rendering.
- **OS file drops depend on `webUtils.getPathForFile`**, which returns `""` for anything without a
  real filesystem path. That case reports an error and points at Library → Import rather than
  silently discarding the files.
- **Never register a single-key menu accelerator.** A registered accelerator is global and fires
  ahead of the web page even while a text field has focus, so `H` would make it impossible to type
  the letter h and `Delete` would remove the selected clip instead of a character. `buildMenu`
  shows those keys via `registerAccelerator: false` and leaves the handling to the renderer's own
  key listener, which text inputs can stop with `e.stopPropagation()`. Ctrl-chords **are**
  registered and were therefore removed from the renderer handler — keeping both would run every
  one of them twice. (Undo is one of them, so a synthetic Ctrl+Z keydown in a smoke script does
  nothing.)
- **Backward scrubbing is O(everything)** until snapshots land.

### Times are floats

- **Seconds in a document are binary floats, and the validator compares them exactly.** A clip
  "ending at 3.8s" ends at 3.8000000000000003, so any time computed from it and then snapped to a
  tenth can land *before* it. `snapUp` in `model/edits.js` keeps the tidy value when it is safe
  and the exact one when it is not. Anything new that positions one element relative to another's
  end needs the same care.

---

## Bugs already found and fixed — do not reintroduce

Each of these was caught by looking at rendered output, not by tests, and each now has a
regression test. Grouped by area; the grouping is the useful index, not the numbering.

### Compositing and surfaces

1. **Artwork offset by its bbox origin.** Animations emit object-local coordinates but surfaces
   cover only the padded bbox. Drawing contexts carry a standing `-origin` translate — and
   `clearRect` must bypass it (`clearAll()`), or it clears the wrong rect.
2. **`destination-in` keeps the *destination's* colour**, masked by the source's alpha. The
   artwork must be the destination and the mask the source. Reversed, the reveal shows a flat
   white scribble instead of the artwork.
3. **Applying `destination-in` per mask half intersects the halves with each other**, leaving
   only their overlap. The committed and active masks must be unioned into a separate `maskUnion`
   surface first.
4. **`Layer.reset()` didn't clear `active`.** An animation only calls `clearActive()` on the layer
   it is currently drawing into, so a stale fill mask kept compositing through the entire outline
   phase — a region appeared pre-coloured before its outline was drawn, then blanked, then
   coloured properly. Also affects any backward scrub from fill to outline.
5. **`putImageData` is not portable about the CTM.** The spec says it ignores the transform and
   browsers do; node canvases apply it. The artwork surface carries a standing `-origin`
   translate, so knocking the paper out slid the whole image 32px and the reveal mask then lined
   up with nothing: a fifth of the picture never appeared, in a way that looked exactly like a
   coverage bug. Neutralise the transform around any get/putImageData pair rather than trusting
   either behaviour.
6. **Asking for a settle with no ink is not a no-op.** `composite(settle)` rebuilds the same
   `art ∩ mask` it already blitted and draws it again at `globalAlpha = settle`, and source-over
   of an image onto itself gives `a·(1 + s - a·s) > a` for any partial alpha — so every antialiased
   edge and soft grey would have thickened over the settle window. `settles: false` on the
   animation, honoured in `renderFrame`, is the fix.
7. **`paintVectorArt` painted the largest region on top.** Both producers emit regions
   largest-first, so the `[...regions].reverse()` iterated smallest-first and canvas painted the
   biggest one last — the opposite of the comment beside it. An SVG with a background shape came
   out as a flat rectangle of background, and only *after* the clip settled, because until then
   the pen's own ink covered it.
8. **The finished image kept white cuts through solid black.** `art` is never blitted unmasked:
   `composite()` shows `art ∩ fillMask` while drawing and `art ∩ (fill ∪ ink)` once settled, so a
   pixel no brush touched was gone for good. Three coverage holes were real: `MIN_SCRIBBLE_AREA`
   dropped small regions entirely, the scan-line loop produced **no** pass at all for a region
   thinner than half a step (a linear slash), and the last pass could stop a full step short of the
   far edge. The whole class is now closed by construction: `draw.stencilPaint` gives every pixel
   to a colour group and blits that group's exact mask, so coverage no longer depends on where the
   brush went. The scan-line distribution fix in `scribble.js` still stands and still matters —
   `scribbleRegion` is what the paint pass and the eraser both sweep with.
9. **Settling blitted the whole source image**, background included, painting an opaque white
   rectangle over the paper — the drawable's bounding box, visible as a panel behind the artwork.
   The settled artwork is now intersected with ink + fill, which is exactly the marks that were
   actually made.
10. **The drawn outline is not the artwork.** The pen traces contours at an ink width chosen to
    read as *drawing*, deliberately heavier than the source asset's own lines — so a finished clip
    looked coarser than the file the user imported. Clips now settle to the original. This must be
    a crossfade of the ink and the artwork *over* the revealed fill, not of the whole composite:
    fading `drawn` out and `art` in independently gives 0.75 alpha at the halfway point and the
    clip visibly dips translucent.
11. **Vectors have no raster to settle to**, so the artwork surface is painted from the geometry.
    Fills alone are not enough: a shape with `fill="none"` contributes no region at all and would
    *vanish* the moment its clip settled. `svgDoc` carries each subpath's own stroke paint and
    width, and `vectorArt.js` strokes them.

### Stroke ordering, plans and erase

12. **Stroke indices are global across the plan.** A layer's `commitRange` must be told the first
    index its phase owns, or the fill layer stamps the outline strokes into its mask.
13. **Erase composited on a stroke counter that never advances.** The sweep is one long stroke, so
    `committedUpTo` stays at its phase start throughout — erase was invisible until its final
    frame. Layers now carry a `used` flag.
14. **Erase reads `plan.inkBbox` before `plan.strokes`.** A reveal plan has no strokes, so the old
    stroke scan concluded there was nothing to erase and silently did nothing on a clip plainly
    covered in ink. Any future animation that lays ink without strokes must carry `inkBbox` too.
15. **The hand vanished during pen-lifts.** Visibility follows `pen.active`, not `pen.down`;
    `down` governs ink, not existence. The eraser also needs `handLive` re-opened, since by then
    the draw's own progress is already 1.
16. **Demo warm-up ran at frame 0**, where clips that start later are skipped entirely and never
    get surfaces. Warm up on the **last** frame — or better, call `ensureSurfaces` directly, which
    is what every host does now.

### Tracing and text geometry

17. **Contouring a drawn line traces it twice.** *(Historical — the vectorizer is gone. Kept
    because the failure mode is a property of contouring colour regions, and anything that goes
    back to tracing regions will hit it again.)* The vectorizer worked on colour *regions*, and a
    thin region's boundary is a loop running down one side of the line and back up the other — so
    every stroke got a visible double outline, and on thicker ink the two passes merged into a line
    far heavier than the source. Line-art clusters that are stroke-like (`elongation >= 6` and mean
    width under 2% of the image diagonal) now go through `centrelines_from_mask()`, the same
    medial-axis pipeline glyphs use, and carry their own measured width. Stroke-like clusters emit
    **no fillable region** — scribbling inside a line-width region is meaningless.
18. **Modulation measured over the wrong pixels.** Sampling the whole glyph interior includes the
    taper to zero at every boundary, so *every* font scored ~0.57. Sample the medial axis only,
    where the distance transform *is* the stroke half-width.
19. **Junction endpoints weren't canonicalised**, so edges meeting at a merged junction never
    compared equal and never chained — `t` came out as 8 strokes instead of 2.
20. **Pruning ran before chaining.** A crossbar arrives as two short free-ended edges; pruned
    individually they both vanish, turning "coffee" into "coliee". Chain first, then prune —
    genuine serif barbs are near-perpendicular and still get pruned.
21. **Endpoint extension applied at junctions.** Stroke tips are extended by the local radius to
    undo skeletonisation erosion, but only *free* ends (`degree == 1`) may be extended. At a
    junction the stroke doesn't end, and `dist` peaks there, so it shot hooks into empty space —
    spurs on `m`'s arches, `r`'s arm, `e`'s join.
22. **The last letter of a text clip stayed chewed.** `textReveal` gives the word being written a
    ragged right edge and everything behind the frontier a square one — but the frontier never
    rolls past the final segment, so at `u = 1` the last word was still the "in progress" one and
    kept a permanent bite out of its rightmost stem. `locateFrontier` now reports `frac`, and only
    `frac < 1` is ragged. The wobble was also a function of `x`, which slid the comb along as the
    frontier advanced and un-revealed ink; it is now a function of `y` alone and only ever lags the
    frontier, never leads it.

### Hand sprite selection and stretch

23. **The hand followed the raw travel direction, not the pen's shaft angle.** A pen does not flip
    end-for-end when a stroke reverses, but serpentine fill reverses on *every* scan line — so the
    sprite alternated between roughly −11° and the +25° clamp several times a second.
    `shaftAngle()` folds the tangent into (−90, 90] so both passes of a −45° scribble map to the
    same pose. Measured: a 36.3° swing per scan line became 0.0°.
24. **`stretchBand` was measured in absolute 1080p rows** but one manifest serves every resolution
    variant. With the 720p sprite selected, rows 1381–1919 are outside a 1280-tall image, so
    `drawImage` clipped the band away, the forearm stretch drew *nothing*, and the arm simply ended
    896px below the nib — a floating stump whenever the artwork sat high on the canvas. The band is
    now a **fraction of source height**.
25. **`pickSource` ranked variants by "closest to 1", which picks the smallest one.** Its required
    scale then exceeds `COMFORT_SCALE`, forcing the arm stretch — lower resolution *and* synthetic
    geometry when a larger source needed neither. Ranking by "largest that still fits inside
    COMFORT_SCALE" picks the 1080p sprite for 1080p output with **zero stretch**.

### Documents and editing

26. **Opening a project immediately re-prepared it.** `ed.load()` bumped the structural revision,
    which triggers a rebuild — but `open()` had *just* built the session from that exact document.
    Every trace and skeletonisation ran twice, and the progress overlay covered the stage. The
    reducer tracks `preparedRev` alongside `structuralRev` and only rebuilds when they disagree.
27. **`undefined` does not survive JSON.** Emitting `stroke: undefined` for unstroked subpaths
    broke the prepared payload's round-trip test, which exists precisely because the payload has to
    be writable to disk and loggable, not merely structured-cloneable. Spread the keys in
    conditionally.
28. **A clip appended straight after a page break started inside its own transition.**
    `addPageBreak` puts the break at the end of everything authored, and `addClipTo` then began at
    that same instant; `afterTransition` used a strict `>` and so did not push it clear. Two
    ordinary button presses produced a document the validator refuses. The bound is now inclusive.
29. **Snapping to a tenth could round a time back below the thing it was clearing.** See [Times are
    floats](#times-are-floats). `snapUp` is the fix.
30. **A session cached beside an older document keeps rendering the older document.** Every
    non-structural edit — camera, retime, page break — was saved and then invisible until some
    later structural edit forced a rebuild. See [the staleness
    trap](#the-staleness-trap-in-the-session-cache).

### The app shell

31. **`setPointerCapture` throws for a pointer id the browser is not tracking.** It sat at the top
    of the timeline's drag handler, so the exception aborted drag setup and clips would not move at
    all. Capture is only an optimisation — the move/up listeners are on `window` regardless — so it
    is wrapped in try/catch.
32. **A resize gesture fed back into itself.** Changing the scale re-lays-out the handle under the
    cursor, and Chromium answers a layout change with a synthetic `pointermove` at the *real*
    cursor position — which the handler treated as continued dragging, and which resized again.
    Runaway. Drags record `e.pointerId` and ignore moves from any other pointer.
33. **`max-height: 100%` cannot fit a canvas to a flex panel.** The percentage resolves against a
    parent whose height is content-derived, so it is ignored — the canvas overflowed the stage and
    slid under the transport bar. The fit scale is measured with a `ResizeObserver` and applied as
    explicit pixels.
34. **System font enumeration cannot promise a handwriting face.** A stock Linux box lists a couple
    of hundred families (223 here) and not one script face among them, which is the only category
    that matters for a whiteboard tool — and a project authored against `/usr/share/fonts/...`
    writes in something else, or fails, on the next machine. The picker offers nine bundled faces
    and nothing else.
35. **Some installed fonts cannot be parsed by opentype.js** (2 of 154 on this box: broken GSUB
    coverage, colour-emoji with no outlines). The font list was sorted alphabetically and the first
    entry happened to be one of them, so the default text face was broken out of the box and failed
    with `Coverage format must be 1 or 2`, naming neither the font nor the fix. `listFonts()` parses
    each face and drops the unusable ones; `prepare.js` reports the filename when a parse fails
    anyway. Note opentype.js also rejects Roboto and Lora, so anything added to the manifest must
    clear `isUsable()`.
36. **`webUtils.getPathForFile` returns `""`** for a dropped file the browser holds without a
    filesystem path, and drag-and-drop failed outright. There is a fallback: the renderer ships the
    bytes and `asset:ingest` writes them into the app's import folder, named by content hash. The
    path route is still preferred, because a saved project then points at the user's own file.

### Headless testing

37. **A headless X server advertises its own DPI** (1.728 here), so the smoke screenshot was laid
    out at a scale no real display uses. `runSmoke` converges an inverse zoom factor onto an
    effective ratio of 1 — note zoom feeds back into `devicePixelRatio` non-linearly, so a single
    `1/dpr` correction overshoots.
38. **A headless compositor can go idle**, after which `requestAnimationFrame` never fires and
    `capturePage` returns whatever it last drew. That hung the smoke test on an rAF that never
    resolved, and — once raced against a timeout — produced screenshots of the app as it looked
    *before* anything loaded, which reads as a pass. Trust the script's DOM assertions; the
    screenshot is best-effort.

---

## Subtle invariants worth preserving

- **Half-open scanline rule** in `spansAt`: `if ((y0 <= y) === (y1 <= y)) continue;`. This rejects
  horizontal edges and counts a vertex exactly on a scan line exactly once, so the crossing count is
  always even. The naive `y0 < y < y1` form yields odd counts and spans leak across the frame. The
  scan grid is offset by a half step for the same reason.
- **Cell decomposition** in the scribble: disjoint spans on one scan line (a U-shape) must not be
  connected across the gap, or the pen teleports between the arms.
- **Committed/active raster split**: completed strokes are drawn once in full; the single
  in-progress stroke is redrawn from its first vertex each frame. Appending per-frame deltas instead
  produces different antialiasing at the joins — visible seams and dark overlap dots.
- **Tangent smoothing is windowed over arc length, not frames.** Any IIR filter carries state
  between frames and breaks seeking.
- **The mask is the only thing standing between the artwork and the paper.** Nothing ever blits
  `art` unmasked, so a hole in the mask is a hole in the finished picture, not a patchy fill. Any
  change to the scribble's coverage maths is therefore a correctness change, and
  `(1 - overlap)(1 + 2·wobble) < 1` is the invariant that keeps adjacent passes touching —
  `clampWobble` enforces it.
- **The reveal mask may never retreat, per scanline.** A monotonic frontier is not enough: any
  ragged edge must be a function of `y` alone and must lag, or ink un-draws itself.
- **The region `clip()` belongs on the mask canvas**, not on `reveal` and not on the page — clipping
  downstream applies AA twice and leaves a thin dark rim at 1080p.
- **Outline draws above fill**, so scribble overshoot can't nibble the outline.
- **Erase is `destination-out` on the clip's own layer**, never on the page, or it punches through
  the background and every clip beneath. It composites *after* the settle crossfade, so it wipes the
  original artwork rather than the pen's version of it.
- **A drawn line is followed down its middle, never contoured.** This is the difference between one
  pen stroke and two parallel ones a hair apart.
- **`stretchBand` is a fraction of source height, never absolute rows** — the manifest is shared
  across resolution variants.
- **A drag must be bound to the pointer that started it.** Any handler that changes layout under the
  cursor will otherwise be re-entered by Chromium's synthetic `pointermove`.
- **Selection UI is DOM, not canvas.** `renderFrame` owns every exported pixel, so a handle drawn
  into the canvas could leak into an export. `StageOverlay` cannot.
- **`amix` must set `normalize=0`** — measured on this ffmpeg, the default is exactly 6.0 dB quieter
  (half amplitude) with two inputs.
- **A cache key is required for the sidecar's disk cache to do anything.** *(Historical — nothing
  is traced any more.)* `_cached(key, fn)` no-ops when `key` is falsy, and for a long time every
  caller passed two arguments — so the cache was configured, enabled, and never used. Worth knowing
  before adding a third sidecar op.

---

## Testing

`npm test` — 279 tests, `node:test`, no framework.

| File | Covers |
|---|---|
| `engine.test.js` | Geometry, arc-length pacing, scanline/even-odd, cell decomposition, hand rig against real manifests |
| `determinism.test.js` | The purity contract: cross-session identity, backward seek, no-randomness, frame-index timing |
| `project.test.js` | Schema defaults, validation paths, duration maths, the bundled example |
| `editor.test.js` | The shared document transforms (`model/edits.js`, imported through the UI's re-export), structural-vs-timing classification, undo/redo, drag coalescing |
| `mcp.test.js` | The MCP layer's pure half: the sandbox, param/transform/animation validation, the append-after-a-break rule, refusals that report why, placement and banding, session-cache freshness |
| `nodeSession.test.js` | The headless build: no-sidecar builds, per-clip bboxes, two builds render identical pixels, trace-key stability |
| `stage.test.js` | local/world/screen round trips, hit-testing, anchored resize, shaft-angle folding, settle timing, **arm reach over a 9×9 nib grid × 5 orientations × 3 aspect ratios** |
| `text.test.js` | Glyph key stability, role classification, stroke orientation and ordering, the reveal's frontier and mask |
| `svg.test.js` | Shapes, transforms, fill inheritance, viewBox, rings/holes, `.svg` routing |
| `camera.test.js` | `cameraAt` + rendered-frame hashes |
| `pages.test.js` | `pageStateAt`, `pageWindows`, multi-page `renderFrame` |
| `surfaces.test.js` | Layer reset semantics, origin-aware clearing, empty-mask compositing |
| `erase.test.js` | Ink extent, sweep direction, the `used` flag, degenerate plans |
| `stencilPaint.test.js` | **The finished frame is the source image, exactly** — over every bundled raster, in both modes. Plus: every pixel owned by exactly one group, a lone pixel is not merged away, there is no stencil pass and nothing is ever laid in the ink layer, sweep direction moves the start, ordering is total, compiling twice is byte-identical, no randomness, and a backward seek replays exactly |
| `inkPaint.test.js` | The same exactness guarantee over every bundled raster and a rasterised vector, plus the two things specific to this animation: **every ink pixel belongs to exactly one stroke** (no pixel claimed twice, none left over) and **the outline reveals at full thickness** while the hand walks a one-pixel centreline. Also: slight colour variation merges to one group, tolerance monotonically merges more, one colour in three places is three shapes, specks keep their pixels without becoming shapes, `encodeRectsMulti` agrees with `encodeRects`, and the degenerate cases — no outline, outline only, one-pixel line, fully transparent |
| `appear.test.js` | Entrances reveal everything at once, never ask for a hand, ramp opacity monotonically to exactly 1, land on true size/position, freeze after the clip, and still erase |
| `bold.test.js` | Which faces get a real weight and which a stroked one, the unsound-axis probe, HVAR advances, grown ink bounds, and **no glyph silently dropped at any size** |
| `export.test.js` | ffmpeg args and audio filter graph |
| `prepare.test.js` | The IPC boundary: payload is JSON-safe and sufficient to rebuild plans |

**One known failure**: `project.test.js` expects `examples/demo.project.json` to have 2 clips and
it has 3. The example is a saved editor artifact that drifted from the assertion; it also points at
an absolute path outside the repo, so it does not resolve on a clean checkout. Either fix the
example or the assertion — it is not a code regression.

### Beyond unit tests

- **`npm run mcp:smoke`** spawns the real MCP server over real stdio and drives a session: create →
  `write_svg` → `storyboard` → `render_contact_sheet` → reword → a refused edit → a camera move → a
  refused path. Nothing is mocked. Needs no display, no ffmpeg and no Python.
- **`WB_SMOKE_SCRIPT`** checks UI behaviour headlessly — the pointer-capture, unparseable-font,
  resize-feedback and double-prepare bugs were all caught this way and none is reachable from a unit
  test.
- **Visual checks matter as much as the tests.** Use `--frames-only` and actually look at
  `.preview/`; nearly every entry in the bug list above was found that way.
  `ffmpeg -ss <t> -i out.mp4 -frames:v 1 f.png` pulls a frame at a timestamp. From the MCP server,
  `render_contact_sheet` is the same idea in one image.

**A note on what tests do not catch.** The three most recent bugs — the page-break append, the
float snap, and the session-cache staleness — all passed the entire unit suite. Two were found by
authoring a video through the MCP server and looking at the result; one was found by reading a tool
response that disagreed with what had just been asked for. Build something with it after changing
it.

---

## Next steps

1. **Keyframe snapshots.** Backward seeks replay from zero, and the timeline makes scrubbing the
   first thing anyone tries. Cache the composited page as an `ImageBitmap` every ~2s in an LRU and
   replay forward from the nearest one.
2. **Retire the Python sidecar.** Nothing on a shipping path calls it: `vectorize.py` is gone and
   `skeleton.py` only serves `layoutText`, the legacy centreline route no host uses. Deleting it
   would remove the venv, five CV dependencies and the process lifecycle in `electron/main.js`.
3. **Packaging** with electron-builder.
4. **Page curl**, if the swipes ever stop being enough. The "render page to bitmap" path it needs
   exists: `renderPage()` returns a whole page as pixels, and the transition compositor is where a
   curl would slot in beside the push.
5. **Audio for the MCP server.** `add_audio` works, but nothing generates narration; a
   text-to-speech step would make `storyboard` produce a finished video rather than a silent one.
