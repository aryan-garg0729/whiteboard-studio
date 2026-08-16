# Script → video skill

## Status

**Shipped.** The skill lives at `.claude/skills/script-to-whiteboard/`.

- [x] 1. Skill scaffold, `references/style.md`, `references/worked-example.md`
- [x] 2. Asset index + ranked search (`scripts/build-asset-index.mjs`, `scripts/find-asset.mjs`)
- [x] 3. `SKILL.md` three-phase workflow + `references/tooling.md`
- [x] 4. `references/asset-prompts.md`
- [x] 5. Permissions: `add_clip`, `add_page`, `import_asset` added to `.claude/settings.local.json`
- [x] 6. `scripts/check-style.mjs`, verified against `examples/alchemy.json`
- [ ] 7. Full 6-minute script run — only a 60s slice has been driven end to end so far

## What it does

Takes a narration script and drives the front half of the pipeline, stopping before audio:

```
script.md ─▶ beat sheet ─▶ asset report ─▶ ⏸ user creates missing art ─▶ project with draft timings
                                                                                 │
                                     user re-times, adds voiceover, exports ◀────┘
```

Timings are estimated from word count at 176 wpm because no recording exists yet; the skill says so in its
handoff rather than implying the edit is final.

## Where the style came from

Everything in `references/style.md` was measured from `examples/alchemy.json` (356s, 13 pages, 108 clips)
and its script `examples/alchemy.md` (1062 words), not guessed. The load-bearing findings:

- 18.2 clips/min, 20% idle, 2:1 art:text, `appear.*` only on containers.
- **Captions are quoted from the script, never paraphrased** — long ones verbatim, short ones cut to the
  keyword with spoken numbers digitised ("ninety seven percent" → `97%`).
- **Page breaks land on paragraph boundaries** — all 11 of them.
- Narration runs at 176 wpm; a caption starts ~0.7s before its phrase is spoken.

`scripts/check-style.mjs` measures a built project against these targets and is also the regression test for
the numbers themselves — run it on `examples/alchemy.json` and everything lands in band.

## Decisions

- **Built through the MCP server**, not by writing project JSON directly. Costs an `import_asset` copy per
  asset, buys validation, `get_project` overlap warnings and contact-sheet review.
- **Explicit transforms, not auto-placement.** `storyboard` lays out one caption over one picture and
  `add_clip` without a transform centres everything; the house style puts 6–15 elements in a composition.
  The skill computes transforms from a 3×2 slot grid (640×540 world units).
- **Keyword index over the art library**, IDF-weighted, plus a mandatory look at rendered candidates. There
  was no catalogue; 761 of the 791 filenames are stock keyword soup and they lie.
- **Missing artwork is requested, not substituted** — the skill stops with generation prompts in the house
  style from `asset_json.py` rather than building with placeholders.

## Findings worth keeping

Both hit during verification, both documented in `references/tooling.md`:

1. **`add_clip`'s `font` resolves relative paths against `mcp-workspace/`, not the repo root.** So
   `assets/fonts/Poppins.ttf` — the same form `nodeSession.DEFAULT_FONT` uses internally — resolves to
   `mcp-workspace/assets/fonts/Poppins.ttf` and throws ENOENT. Absolute paths only.
2. **A failed `add_clip` is not rolled back.** The asset and clip survive in the saved document, and since
   every later call recompiles, the bad asset poisons every subsequent call including `get_project`. This
   contradicts the guarantee in `mcp/guide.js` ("the document is left untouched"). Recovery is
   `remove_clip`. Worth fixing in `mcp/studio.js` — the commit should not persist when the compile throws.

## Calibration data

Measured against `get_project` rects, for anyone changing the layout code:

- A PNG's pixel dimensions are its bbox exactly.
- Text bbox height is **exact** at `fontSize * (1.35 * lines + 1.5)` — 342 / 504 / 666 for 1 / 2 / 3 lines
  of Poppins at 120px. A single line is 2.85 em, not 1.25; sizing it as one line-height makes every caption
  a third too large.
- Text bbox width ≈ `maxLineChars * fontSize * 0.53`, ±10% depending on the letters.
- Alchemy's artwork averages 29% of frame width and 45% of frame height. That is what sets the grid at
  3×2 rather than 3×3.
