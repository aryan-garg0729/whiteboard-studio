# Burned-in subtitles for Whiteboard Studio

## Context

The tool renders whiteboard animations over a narration track (`project.audio`), but nothing puts
the narration's words on screen. The raw material already exists as an unwired experiment:
`plans/transcribe.py` runs faster-whisper with `word_timestamps=True` and emits
`plans/timestamps.json` (`[{word, start, end}, …]`); `faster_whisper 1.2.1` is confirmed installed
in the repo's `.venv`. There is currently **no** subtitle/caption/SRT code anywhere in the repo.

This adds a project-level subtitle track: transcribe the project's narration in-tool, store
word-level timings on the document, and burn word-synced subtitles into every rendered frame
(preview and export alike), plus an `.srt` sidecar on export.

**Decisions made with the user:**
- Timing comes from **in-tool transcription** (spawn faster-whisper), not an imported file.
- Three styles ship: **`bar`** (plain subtitle bar), **`karaoke`** (word highlight), **`pop`** (word-by-word).
- Lives in a **new project-level track**, not as clips on a page.
- **Minimal editor UI**: a settings panel + a "Transcribe narration" action. No new Timeline lane.
- Export also writes a **`.srt` sidecar** next to the `.mp4`.
- Named **`subtitles`**, not `captions` — "caption" already means *a text clip the hand writes*
  throughout this codebase (`CAPTION_BAND` in `mcp/storyboard.js:39`, "Reword a caption" in
  `mcp/studio.js:259`, and the authoring guide). Reusing it would make every tool description
  ambiguous to an MCP agent.

### Two constraints found during exploration that shape the design

1. **`normalizeProject()` is an explicit whitelist.** It ends `return { meta, assets, pages,
   pageBreaks, tracks, clips, audio };` (`src/engine/model/project.js:449`) and silently drops every
   other top-level key. Because `mcp/studio.js:82-88` is `normalizeProject(fn(doc))` then
   `saveProject(...)`, any unrelated MCP edit would **erase subtitles from disk**; `electron/main.js:175`
   would drop them on open. Adding `subtitles` to that return is step one and is non-negotiable.
2. **Fonts are not reachable at render time.** `outlineText()` is called only inside
   `buildTextClip()` in the main process (`electron/prepare.js:92-130`, `src/engine/host/nodeSession.js:121-148`);
   the parsed font is local and never stored on the session, and the Electron renderer receives only
   pre-flattened `regions` over IPC (it imports no opentype at all). So subtitle text cannot be laid
   out from render code as-is. **Resolution:** `project:prepare` ships the subtitle font's *bytes*;
   each host parses them once and hangs the font on the session; layout happens host-side and is
   cached. This keeps every subtitle edit except a font change non-structural, so dragging a size
   slider repaints instantly instead of recompiling every clip.

---

## Design

### Document shape

```js
subtitles: {
  enabled: true,
  style: 'bar' | 'karaoke' | 'pop',
  words: [{ w: 'Picture', start: 0.0, end: 0.24 }],   // ascending, from whisper
  source: '/abs/path/voiceover.mp3',                   // provenance of `words`
  font: 'assets/fonts/Montserrat.ttf', fontSize: 56, bold: true,
  color: '#ffffff', highlight: '#ffd54a', background: '#000000cc',
  marginBottom: 0.08,      // fraction of composition height
  maxChars: 42, maxWords: 7, gapSplit: 0.6, holdTail: 0.25,
}
```
Optional and absent by default; an old file simply lacks it. **Do not bump `SCHEMA_VERSION`** —
it is written but never read anywhere, and there is no migration machinery keyed on it.

### Rendering

Screen space, drawn last so it sits above the hand and survives camera moves and page transitions.

---

## Implementation

### Phase 1 — Document model

**`src/engine/model/project.js`**
- Add `export const SUBTITLE_STYLES = new Set(['bar', 'karaoke', 'pop'])` and a
  `DEFAULTS.subtitles` block next to `DEFAULTS.meta` (`:15-22`).
- Add a `// --- subtitles ---` normalisation section following the style of the `audio` block
  (`:436-447`): validate `style` against `SUBTITLE_STYLES`, each `words[i]` as
  `{w: string, start, end}` with `end >= start`, and every numeric via the existing `num(...)`
  helper with min/max. Sort `words` ascending by `start` (same rationale as the camera-keyframe
  sort at `:272-274`: a hand-edited file should still behave). Throw `ProjectError` with paths like
  `subtitles.words[3].end`. Return `undefined` when `raw.subtitles` is absent — do not
  materialise a default block, so files that never use the feature stay byte-identical.
- **Add `subtitles` to the return at `:449`.**
- `projectDuration()` (`:456-475`) — fold in `max(w.end)` over `subtitles.words`. This matters:
  `audio` only counts toward duration `if (a.duration)` (`:463`) and `add_audio`'s `duration` is
  optional, so a narration-plus-subtitles project with no clips currently computes 0 frames and
  `export_video` refuses it outright (`mcp/server.js:491`).

**`src/engine/model/edits.js`** — three pure transforms in the shape of the audio trio (`:277-289`),
shallow-spread only, throwing `EditError` (`:36-41`) on refusal:
- `setSubtitles(doc, patch)` → `{ ...doc, subtitles: { ...DEFAULTS.subtitles, ...doc.subtitles, ...patch } }`
- `setSubtitleWords(doc, words, { source })` — replaces `words` wholesale.
- `removeSubtitles(doc)` — destructure the key out (`const { subtitles, ...rest } = doc; return rest;`).
  Safe now that the normaliser passes `undefined` through rather than re-defaulting.

**`src/engine/model/subtitles.js`** (new, pure and dependency-free — the renderer, the SRT writer
and the UI all need it): `buildCues(subtitles)` groups `words` into
`[{ text, start, end, lines, words: [{w, start, end, line, from, to}] }]`. Break a cue on a gap
`> gapSplit`, on sentence-ending punctuation (`.?!` — whisper keeps punctuation attached, see
`"this,"` in `plans/timestamps.json`), on `maxWords`, and on `maxChars`. Wrap within a cue by
inserting `\n` at `maxChars` — **`outlineText` has no word-wrap; `placeGlyphs` splits on `\n`
and nothing else** (`src/engine/compile/text.js:165`). `from`/`to` are character offsets into
`text`, used to map words onto glyph regions.

### Phase 2 — Rendering

**Font onto the session.** Add `subtitleFont` to what `createSession()` carries
(`src/engine/render/renderFrame.js:30-32`):
- `src/engine/host/nodeSession.js` — parse the subtitle font from disk with the same
  `opentype.parse(buf.buffer.slice(...))` idiom as `buildTextClip` (`:121-148`). Parse a
  **dedicated instance**: `outlineText` mutates the font (`applyWeight` calls `font.variation.set`,
  and `boldModeFor` memoises onto `font.__wbBoldMode`, `src/engine/compile/text.js:119-149`), so a
  shared instance at two bold settings makes layout order-dependent.
- `electron/prepare.js` — read the same bytes and put them in the prepared payload (base64 or a
  transferable), alongside the per-clip entries at `:117-130`.
- `src/ui/engineHost.js` — `opentype.parse` those bytes in `buildSession()` (`:41-56`). opentype.js
  declares a `"browser"` build and is a plain dependency, so Vite bundles it fine.

**`src/engine/render/subtitles.js`** (new):
- `subtitlePlan(session, project)` — returns `{ cues }`, rebuilding only when
  `cache.src !== project.subtitles` (reference identity; pure transforms always produce a new
  object). Per cue it runs `outlineText(font, cue.text, {fontSize, bold, color})` once and records,
  for each word, the `regionIndex` range covering it — walk the returned `glyphs` array
  (`{ch, lineIndex, ink, regionIndex, …}`, `text.js:283-284`), which is in text order and includes
  non-ink glyphs, against the cue's `from`/`to` offsets. This is a **semantically transparent
  cache**, exactly what `pageSurfaces` (`renderFrame.js:251-269`) already establishes as permitted.
- `drawSubtitles(ctx, plan, t, opts)` — find the active cue (binary search), then:
  - Scale by `opts.height / project.meta.height`: `renderFrame` receives the *render* size, which is
    not the composition size for a draft `render_frame` (`mcp/render.js:12-16`). All geometry is a
    fraction of `opts.height`.
  - Centre horizontally on `inkBbox` (`text.js:296-304`); place so ink bottom sits at
    `height * (1 - marginBottom)`. Note `outlineText`'s origin is **the baseline of line 0**, y down.
  - Paint the backing rounded rect from `background` when its alpha is non-zero.
  - Per style: `bar` → all regions `color`. `karaoke` → regions of words with `start <= t` get
    `highlight`, the rest `color`. `pop` → only words with `start <= t`, each with a short
    ease-out scale about its own centre.
  - Fill with the existing `paintVectorArt(ctx, regions, [])`
    (`src/engine/render/vectorArt.js:19-44`) — its `fill('evenodd')` is load-bearing for glyph
    counters. Recolour per region rather than re-laying out: `outlineText` gives every region one
    uniform `color`, but `paintVectorArt` reads `region.color` per region.

**`src/engine/render/renderFrame.js`** — insert after the hand block (`:328`, before the closing
brace): reset with `ctx.setTransform(1,0,0,1,0,0)`, `globalAlpha = 1`,
`globalCompositeOperation = 'source-over'` (the hand branch may not have run), then
`drawSubtitles(...)` guarded on `project.subtitles?.enabled && session.subtitleFont`. `t` is already
in scope at `:284`. **No `Math.random`/`Date.now`** — `test/determinism.test.js:90` stubs
`Math.random` and asserts it is never called; any jitter must be hashed from content the way
`textReveal.js:280` does.

**`src/ui/App.jsx`** — `rebuild()` early-returns when `!doc.clips.length` and nulls the session
(`:197-206`), and `draw()` then paints only the background (`:247-251`). A subtitles-only project
would render blank in the app. Widen that guard to
`if (!doc.clips.length && !doc.subtitles?.enabled)`.

### Phase 3 — Transcription

- **`scripts/transcribe.py`** — argv-driven adaptation of `plans/transcribe.py`:
  `--audio --out --model small.en --device cpu --compute-type int8`. Same
  `word_timestamps=True, beam_size=5`. Emit `{"progress": <0..1>}` JSON lines on **stderr**
  (segment end ÷ `info.duration`) and write the word array to `--out`. Keep `plans/transcribe.py`
  as-is; it is the untouched original.
- **`requirements.txt`** (new) — `faster-whisper>=1.2`. `.venv/` is gitignored and there is no
  requirements file today, so a fresh clone currently has no way to know what to install. Note the
  setup line (`python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`) in the README
  if one covers setup.
- **`src/engine/transcribe/whisper.js`** (new, node-only — the same shape as
  `src/engine/export/driver.js` spawning ffmpeg): `transcribe(audioPath, {model, onProgress})`
  spawning the interpreter resolved as repo `.venv/bin/python` → `$WHITEBOARD_PYTHON` → `python3`,
  plus a memoised `hasWhisper()` probing `-c "import faster_whisper"`. Resolve the interpreter
  explicitly rather than trusting PATH, mirroring how `electron/media.js:92` `hasFfmpeg()` treats
  ffmpeg. A missing dependency must fail with the actionable message, not a bare spawn ENOENT.

### Phase 4 — MCP

- **`mcp/transcribe.js`** (new) — a `Transcriptions` job registry copied structurally from
  `Exports` in `mcp/export.js:26-113`: `{id, name, state, progress, words, error, startedAt,
  finishedAt}`, `get`/`list`, and the same deliberately-unawaited `.then/.catch` at `:87-101`.
  Transcribing a 5-minute voiceover with `small.en` on CPU takes over a minute, so a blocking tool
  call would time the client out. On completion, commit the words via
  `studio.commit(name, d => edits.setSubtitleWords(d, words, {source}))` and persist the raw JSON to
  `join(EXPORT_DIR, `${name}.words.json`)` — `EXPORT_DIR` is already gitignored by `ensureWorkspace()`
  (`mcp/workspace.js:44-51`) and conventionally holds generated artefacts.
- **`mcp/server.js`** — four tools on the existing `registerTool(name, {title, description,
  inputSchema: <raw zod shape>}, tool(async …))` pattern:
  - `transcribe_audio { name, index?, src?, model? }` — resolve the path via `readablePath()`
    (`mcp/workspace.js:71-77`), defaulting to `doc.audio[index ?? 0].src`, exactly as
    `mcp/export.js:90` does. Returns a job id; description says "poll transcribe_status".
  - `transcribe_status { id? }` — mirrors `export_status` (`:496-521`) field for field.
  - `set_subtitles { name, enabled?, style?, font?, fontSize?, bold?, color?, highlight?,
    background?, marginBottom?, maxChars?, maxWords?, gapSplit?, words? }` — `studio.commit` with
    **no** `{structural: true}`; the `sameClips` fast path in `studio.built()` (`:141-147`) swaps the
    new doc in and keeps the clip plans. Return `after(name, { subtitles: … })` since the frame
    changes. `words` is included as an escape hatch so the feature is testable without running whisper.
  - `remove_subtitles { name }`.
  - `tool()` (`:68-81`) only converts errors named `ProjectError`/`EditError`/`InvalidInput`/
    `WorkspaceError`; the whisper wrapper's failures must be re-thrown as one of these or they
    become protocol errors.
- **`mcp/capabilities.js`** — add `subtitleStyles: [...SUBTITLE_STYLES]` and
  `environment.whisper: hasWhisper()` to `capabilities()` (`:69-83`), alongside the existing
  `ffmpeg: hasFfmpeg()`. Cache the probe — `list_capabilities` calls this every time.
- **`mcp/guide.js`** — a `## Subtitles` section in `AUTHORING_GUIDE` after `## Timing conventions`,
  stating plainly that subtitles are the burned-in narration track and are **not** the same thing as
  the text clips the guide elsewhere calls captions.
- Drive-by: `mcp/server.js:601` calls `studio.stop()`, which does not exist on `Studio` — every
  SIGINT/SIGTERM throws a `TypeError` before `process.exit(0)`. Fix it while adding job cleanup there.

### Phase 5 — SRT sidecar

**`src/engine/export/srt.js`** (new) — `toSrt(cues)`, `HH:MM:SS,mmm` timestamps, blank-line
separated, `\n` preserved as the intra-cue line break. Write `out.replace(/\.mp4$/, '.srt')` on
successful completion, when `subtitles.words.length`, from both export paths: `Exports.start`
(`mcp/export.js:87-101`) and `ipcMain.handle('export:start', …)` (`electron/main.js:342-380`).
No ffmpeg argument changes — the subtitles are already burned into the frames.

### Phase 6 — Minimal UI

- **`src/ui/components/Inspector.jsx`** — add `<SubtitlesGroup ed={ed} />` to `ProjectInspector`
  after `<PagesGroup/>` (`:483`); that is the no-selection branch (`:512-514`), which is the right
  home for a project-level overlay. Reuse the generic schema renderer: factor the enum/color/number
  JSX out of `AnimParams` (`:35-64`) into `SchemaFields({schema, value, onSet})` and have both call
  it — a small refactor rather than a copy. A "Transcribe narration" `<button className="btn wide">`
  follows the pattern at `:444-447`, disabled while a job runs, with an inline progress percentage.
- **`electron/main.js` / `preload.cjs`** — a `Transcribe narration…` item in the Insert submenu
  (`:112-119`) and an `ipcMain.handle('subtitles:transcribe', …)` that calls the Phase-3 wrapper and
  streams `subtitles:progress` to `e.sender`, mirroring `export:start` + `export:progress`
  (`main.js:342-380`, `preload.cjs:29-37`). Errors through the existing `asError` (`:185-188`).
- **`src/ui/state/editor.js`** — one `actions` method per transform
  (`setSubtitles(patch) { edit((doc) => edits.setSubtitles(doc, patch)); }`), non-structural. The
  preview updates immediately because `App.jsx:252` renders the *live* doc, not `built.project`,
  and `draw()` reruns on `ed.rev` (`:259`).
- No Timeline lane (per the user's "minimal UI" choice). `Timeline.jsx` already has the
  `PageLane`/`CameraLane` non-track-lane pattern (`:95-215`) if it is wanted later.

---

## Tests — `test/subtitles.test.js`

Follow the house style: `node:test` + `node:assert/strict`, a why-this-file-exists docstring, and
`useTestSurfaces()` at module top level (`test/helpers/surface.js`).

- `buildCues` — splits on a gap over `gapSplit`, on sentence punctuation, at `maxWords`/`maxChars`;
  wraps by inserting `\n`; word `from`/`to` offsets index the cue text correctly.
- Validation — `throwsAt(raw, 'subtitles.words[1].end')` in the shape of `test/project.test.js:14-29`;
  an unknown `style` is rejected; words are sorted.
- **The regression that matters most:** a doc with `subtitles` survives a `normalizeProject` round
  trip, and survives `studio.commit` of an *unrelated* edit.
- `projectDuration` covers the last word when the audio entry has no `duration`.
- Rendering — build a bare `createSession()` with a parsed font, **no clips at all**, render a frame
  with `@napi-rs/canvas`, and assert via `ctx.getImageData` that pixels in the subtitle band changed
  (the idiom in `test/pages.test.js:11-21`). Assert `karaoke` paints the highlight colour at a `t`
  inside word 2 but not before word 1, and that `pop` paints nothing before the first word.
- Determinism — extend the existing hash-two-renders check so a subtitled frame is byte-identical
  across renders (`test/determinism.test.js:47-52`).
- `toSrt` — index numbering, `,` decimal separator, trailing blank line.

## Verification

1. `npm test` — the full suite, not just the new file (Phase 1 touches `normalizeProject`, which
   `project.test.js`, `mcp.test.js` and `prepare.test.js` all lean on).
2. `.venv/bin/python scripts/transcribe.py --audio voiceover.mp3 --out /tmp/words.json` on the
   repo's real 15 MB `voiceover.mp3`, then eyeball the first few words against `plans/timestamps.json`.
3. End-to-end over MCP against `mcp-workspace/`: `create_project` → `import_asset` the voiceover →
   `add_audio` → `transcribe_audio` → poll `transcribe_status` → `set_subtitles {style:'karaoke'}` →
   `render_contact_sheet` and confirm the words appear, advance and highlight in step.
4. `export_video` on that project; confirm the `.mp4` has burned-in subtitles and a sibling `.srt`
   whose timings match, and confirm a **draft** export (`scale: 0.5`) scales the subtitles with the
   frame rather than rendering them at composition pixel size.
5. `npm run app` — open the exported project, confirm subtitles show in the preview, that changing
   style/colour/size repaints without the "Preparing artwork" overlay, and that a project with
   subtitles but zero clips still renders them.
6. `list_capabilities` reports `subtitleStyles` and `environment.whisper`.

## Status

**Done.** All six phases implemented; `npm test` is 339/339 and `node mcp/smoke.js` passes.

Verified end to end:
- `scripts/transcribe.py` on the repo's `voiceover.mp3` — 1502 words over 626s, and the first
  words match `plans/timestamps.json` exactly.
- A full MCP session: `create_project` → `import_asset` → `add_audio` → `transcribe_audio`
  (51 words in 6.8s on a 20s clip) → `set_subtitles` → `export_video` at `scale: 0.5`, producing
  a burned-in MP4 plus a matching `.srt`. The project had zero clips and still exported, which is
  what the `projectDuration` change is for.
- All three styles rendered and inspected; `karaoke` highlights exactly the words spoken by `t`,
  `pop` reveals one word at a time.
- `scripts/render-project.js` with a hand-drawn text clip and subtitles together.
- The Electron app boots with the Subtitles panel rendering and no renderer errors.

Deviations from the plan as written:
- **The plate under `pop` hugs the visible words** rather than the whole cue, which the plan did
  not anticipate. A whole-cue plate trailed a slab of empty colour where the unspoken words were
  going to be.
- **`normalizeProject` returns `undefined` for an absent track** rather than materialising a
  default block, so a project that never uses subtitles is not rewritten the first time it is saved.
- **A shared `src/engine/compile/font.js`** now owns font parsing; both hosts had their own copy of
  the same two non-obvious details (`loadSync` returns undefined; a Buffer is a view into a pool).
- **`electron/prepare.js` ships font *bytes***, and the renderer lays subtitles out itself. Only a
  change of *face* costs a re-prepare; size, colour, style and wrapping repaint locally.
- **The UI got both a menu item and a panel button**, sharing one implementation lifted into
  `App.jsx` — two entry points must not be two jobs racing to commit the same transcript.
- Drive-by: `mcp/server.js` called `studio.stop()`, which has never existed, so every SIGINT threw
  a `TypeError` instead of exiting cleanly.

Not done: no Timeline lane for subtitles (the "minimal UI" choice). `Timeline.jsx` already has the
`PageLane`/`CameraLane` non-track-lane pattern if it is wanted later.
