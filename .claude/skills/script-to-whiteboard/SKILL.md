---
name: script-to-whiteboard
description: Turn a narration script into a whiteboard animation project in the house style of examples/alchemy.json — analyse the script into beats, match each beat against the ~800-asset art library, report which new assets must be created, and build the project with approximate timings. Use when asked to make/storyboard a video from a script, plan the visuals for a script, or work out which assets a script needs.
---

# Script → whiteboard video

Takes a narration script and produces a whiteboard project ready for the user to re-time, voice and export.

The style is not generic: it is measured from `examples/alchemy.json` and its script `examples/alchemy.md`.
**Read `references/style.md` before deciding anything, and `references/worked-example.md` before
storyboarding.** The numbers in them are targets, not background.

## Three phases, with a stop between 2 and 3

```
script.md ──▶ 1. beat sheet ──▶ 2. asset report ──▶ ⏸ user creates art ──▶ 3. build project
                                                                                    │
                                        user re-times, adds voiceover, exports ◀────┘
```

Phase 2 ends the turn. Do not build a project with placeholder artwork.

## Phase 1 — script → beat sheet

1. Read the script. Timestamp every word at **176 wpm (0.34 s/word)** so any phrase can be located on the
   timeline. Report the estimated total up front.
2. **Pages follow paragraphs.** One page per paragraph; merge a one-line section-header paragraph forward
   into the paragraph it introduces; split anything over ~45s.
3. Walk the script sentence by sentence and decide: art beat, text beat, container+text beat, or nothing.
   Roughly one sentence in three gets nothing — that is where the 20% idle time comes from.
   - **Art** when the sentence has a concrete noun to draw.
   - **Text** when it is a proposition — a statistic, a lesson, a comparison of abstractions.
   - Target **2:1 art:text** and **~18 clips/min**.
4. **Caption text is quoted from the script, never paraphrased.** Long captions (8–20 words) verbatim;
   short ones cut to the keyword or figure with spoken numbers digitised ("ninety seven percent" → `97%`).
   Record the character range each caption came from.
5. A beat's `t` is its phrase's narration time **minus ~0.7s**, so the ink lands with the words. Durations:
   `min(12, max(1.6, nonSpaceChars * 0.16))` for text, 2–4s for art (up to 9s for one anchor drawing that
   carries a whole paragraph).

Write `<name>.beats.json` beside the script:

```json
{ "page": 4, "t": 40.7, "duration": 9, "kind": "art",
  "concept": "eurostar train losing passengers",
  "scriptSpan": [412, 486], "anim": "draw.inkPaint",
  "params": { "groupOrder": "readingOrder" }, "slot": "MC", "notes": "anchor drawing for the paragraph" }
```

Text beats carry `text`, `font`, `color` instead of `concept`. Container beats carry `container` naming the
asset. This file is the handoff artefact — it survives between sessions and phase 3 reads it back.

## Phase 2 — match assets, report the gaps

The library has no catalogue; these scripts are it.

```bash
node .claude/skills/script-to-whiteboard/scripts/build-asset-index.mjs   # rebuilds only when stale
node .claude/skills/script-to-whiteboard/scripts/find-asset.mjs --limit 9 "eurostar train passengers"
```

`find-asset.mjs` scores 836 entries (791 PNG + 45 SVG-only) by IDF-weighted token overlap over their
CamelCase filenames, `--json` for machine use. Prefer the PNG over its SVG twin — `draw.inkPaint` on flat
raster is what the whole style is built on.

**Then look at the candidates.** 761 of the filenames are stock keyword soup and they lie: "worried man"
resolves happily to a warehouse worker in PPE. For any match that is not obvious from the name, build a
scratch project, `add_clip` the top candidates with `appear.instant`, `render_contact_sheet`, and read the
image before committing. Batch this — one scratch project for all the uncertain beats in a script, not one
per beat.

Before declaring an asset missing, try the two escapes in `references/asset-prompts.md`: mirroring an
existing asset with `scaleX: -1`, and drawing simple geometry yourself with `write_svg`.

Write `<name>.assets.md`:
- **Matched** — beat → absolute path → confidence.
- **Missing** — beat → subject → target filename → generation prompt in the house template.

Then **stop** and report. See `references/asset-prompts.md` for the prompt template, the filename
convention, and why abstract primitives will dominate the missing list.

## Phase 3 — build the project

Only after the user confirms the missing artwork exists. Re-run `build-asset-index.mjs --force` to pick up
the new files.

Full call sequence, coordinate maths and the slot grid are in `references/tooling.md`. In short:

1. `list_capabilities`, then `create_project` with alchemy's meta.
2. `import_asset` each matched path once — the server reads only from `mcp-workspace/`.
3. Author beats **in time order**: `add_page` per page, then per beat an `add_clip` with an **explicit
   `transform`** computed from the 3×2 slot grid, followed by an `update_clip` setting its real `start`
   (`add_clip` has no `start` — it appends). `storyboard` and transform-less `add_clip` both centre
   everything and cannot produce a 6–15 element composition.
   **Font paths must be absolute** or the clip fails and poisons the project — see `references/tooling.md`.
4. `get_project` → fix genuine collisions with `update_clip`. Ignore off-screen warnings for panned regions
   and container/caption overlaps.
5. `set_camera` for 2–4 moves.
6. `render_contact_sheet` and look at it.

Then hand back: project path, duration, per-page beat map, and an explicit note that **timings are estimated
from word counts and will drift several seconds against a real recording** — the user re-times, adds audio
and exports.

Never call `add_audio`, `transcribe_audio`, `set_subtitles` or `export_video`. Those are the user's steps.

## Checking your own output

`scripts/check-style.mjs <project.json> [script.md]` measures a built project against the style targets —
clips/min, idle fraction, art:text ratio, `appear.*` misuse, captions traceable to the script. Run it before
handing off. Running it on `examples/alchemy.json` reproduces the numbers in `references/style.md`.
