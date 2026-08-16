# Whiteboard Studio

A whiteboard-animation video studio: a hand draws artwork and writes captions onto sheets of
paper, one sheet at a time, while a camera moves over the page. Projects are plain JSON, edited
either by hand in an Electron app or by an AI agent through an MCP server, and rendered to MP4
by the same engine either way.

## How it works

- **A project is a document, not a timeline UI state.** Sheets of paper (`pages`), artwork and
  captions on them (`clips` of `assets`), an itinerary between pages (`pageBreaks`), audio lanes,
  and one optional subtitle track burned from the narration.
- **The renderer is headless.** `src/engine` compiles a project into frames with
  [`@napi-rs/canvas`](https://github.com/Brooooooklyn/canvas) — no browser, no GPU dependency —
  so the Electron preview and the CLI/MCP exporter run byte-identical code.
- **Two front doors, one engine.** The Electron app (`electron/`, `src/ui/`) is for a person
  editing by hand. The MCP server (`mcp/`) exposes the same operations as tools so an agent (e.g.
  Claude) can author a whole video from a script in a few calls.

## Requirements

- Node.js (ESM, `"type": "module"`)
- [ffmpeg](https://ffmpeg.org/) on `PATH` — required for video/audio export
- Python 3 + the packages in `requirements.txt` (`faster-whisper`, etc.) — only needed for
  audio transcription/subtitles

## Setup

```bash
npm install
python -m venv .venv && .venv/bin/activate  # optional, only for transcription
pip install -r requirements.txt
```

## Using the desktop app

```bash
npm run dev      # Vite dev server for the editor UI
npm run app:dev  # Electron pointed at the dev server, in a second terminal
npm run app      # production build: vite build, then electron .
```

## Using the MCP server

Point an MCP-capable client (e.g. Claude Code, via `.mcp.json` in this repo) at:

```bash
npm run mcp
```

Call `list_capabilities` first to see the available animations, fonts, hand/tool styles, and
whether `ffmpeg`/whisper are actually installed on this machine. Then `create_project` and
`storyboard` to lay out a whole script in one call, and `render_contact_sheet` to see the entire
video as a single image. The full authoring rules (coordinate system, timing conventions, audio
lanes, subtitles, animation choices) are in the `whiteboard://guide/authoring` MCP resource
(source: `mcp/guide.js`) — read it before the first edit.

`npm run mcp:smoke` runs a scripted end-to-end check against the server.

## CLI scripts

For working on the engine directly, without the app or MCP:

```bash
node scripts/render-project.js examples/demo.project.json [--out o.mp4] [--frames-only]
node scripts/animate-image.js <image> [--anim inkPaint|stencilPaint]
node scripts/animate-text.js
node scripts/demo-reel.js
node scripts/export-sample.js
```

## Tests

```bash
npm test
```

Runs `node --test` over `test/*.test.js`: engine correctness, determinism, the MCP tool layer,
and rendering of specific animations (erase, ink/stencil paint, text, camera, subtitles, ...).

## Project layout

```
electron/     Electron main process: window, IPC, filesystem, fonts, media probing
src/engine/   The headless rendering engine (model, compile, anim, render, hand, export, transcribe)
src/ui/       The editor's React UI (renderer process)
mcp/          MCP server exposing the engine as agent tools, plus the authoring guide resource
scripts/      Standalone CLI entry points for rendering/animating outside the app
examples/     Sample projects
test/         node:test suite
.claude/skills/script-to-whiteboard/   Skill that turns a narration script into a storyboarded project
```


