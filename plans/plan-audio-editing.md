# Audio editing: cut, speed, trim, and gapless lanes

## Status

**Shipped.** All of the below is implemented and verified — 367 unit tests pass,
both renderer smoke scripts pass headlessly, and a real MCP-driven ffmpeg export
produces the expected filter graph and stream length.

| Piece | State |
|---|---|
| `id` + `speed` on audio items | done |
| Split at the playhead (`S`, toolbar razor, Inspector button) | done |
| Speed, pitch-preserving in export **and preview** | done — see [Round two](#round-two-speed-bugs) |
| Speed resizes the block and ripples the lane | done — round two |
| Continuous speed slider | done — round two |
| Trim handles on the waveform block | done |
| Gapless lanes: append on add, no-overlap on drag | done |
| Click a gap to close it | done |
| `update_audio` / `split_audio` MCP tools | done |
| Subtitle re-timing | **not done** — see Out of scope |

## Context

Audio was place-and-forget. An item in `doc.audio` had five fields — `src`,
`trackId`, `start`, `trimIn`, `duration?`, `gain` — and the only interactions
were "drop it on a lane", "drag it sideways", and four number fields in the
Inspector. There was no way to cut a recording, no way to retime it, no way to
trim it by dragging, and two items dropped on the same lane silently overlapped
and mixed.

Fine for a single narration file; useless for editing one. This adds the four
operations that turn an audio lane into something you can work in:

1. **Split at the playhead** (`S`), so a take can be cut and a bad half deleted.
2. **Speed**, pitch-preserving, per item.
3. **Trim handles** on the waveform block, matching how clips already resize.
4. **Gapless lanes** — new audio lands after the last item on the lane, dragging
   cannot overlap a neighbour, and a gap shows a click-target that closes it.

Two invariants held throughout:

- **`audioClock.js` and `buildAudioGraph()` read the same fields.** What you
  hear while scrubbing is what ffmpeg renders; every new field is implemented in
  both.
- **The document is never transiently invalid.** `App.jsx` runs
  `normalizeProject(ed.doc)` on every edit, and a mid-drag document that throws
  blanks the stage.

### A divergence that was tried and withdrawn

The first round shipped speed as pitch-preserving on export (`atempo`) but
pitch-shifting in preview (`playbackRate`), on the argument that timing is what
sync depends on and timbre is cosmetic. That was wrong, and round two removed it
— see below. The only divergence left is the original one: export `apad`s the mix
to the video length, preview simply stops.

---

## 1. Schema — `src/engine/model/project.js`

The audio normaliser gained two fields:

- **`id`** — assigned deterministically by position (`aud1`, `aud2`, …) when a
  file does not carry one, so every project written before this loads with
  stable handles. Duplicates in a hand-edited file are disambiguated rather than
  accepted. Position was the only handle audio had, and a split inserts an item
  and renumbers everything after it, so identity had to become intrinsic.
- **`speed`** — 0.25–4, default 1.

**`duration` stays timeline seconds.** This is the load-bearing decision: a
block is `duration` seconds wide whatever its speed, and the source it consumes
is `duration * speed`. Everything that already read `duration` —
`projectDuration()`, `packTrack`, the Timeline's block width — kept working
untouched, and `speed: 1` normalises byte-identically to before.

`SCHEMA_VERSION` stays at 1; both fields default cleanly.

## 2. Transforms — `src/engine/model/edits.js`

All of it lives here rather than in the React layer, so the MCP `Studio` gets
the same rules. New and changed exports:

- **`MIN_AUDIO`** (0.05s) — the shortest item worth having.
- **`audioIndex(doc, ref)`** — resolves an id *or* an index, so the existing
  index-based MCP calls keep working while the UI addresses items by id.
- **`audioEnd(a, srcLen)`** — now takes an optional known file length, closing
  the hole where an unprobed item counted as zero-length and two of them stacked
  on one lane. Divides by `speed`.
- **`laneEnd(doc, trackId, skipId)`**.
- **`audioSlot(doc, trackId, wantStart, length, skipId)`** — the placement rule
  behind *all three* no-overlap behaviours. On a collision it picks whichever
  side of the obstruction is nearer, flush-after or flush-before, which is what
  makes a drag feel like it is butting up against its neighbour rather than
  teleporting past it.
- **`addAudio`** now appends: the item lands at `laneEnd` of the first audio lane
  and never invents a second lane the way `packTrack` did. An explicit `start`
  is honoured but routed through `audioSlot`.
- **`patchAudio`** re-places through `audioSlot` whenever a patch touches
  `start`, `duration` or `trackId`, so no code path can author an overlap.
- **`splitAudio(doc, ref, t)`** — the halves abut exactly, so neither needs
  re-placing. `trimIn` advances by `(t - start) * speed`, which is the one place
  the timeline/source distinction actually bites. An unmeasured item splits fine:
  the right half inherits `undefined` and plays to EOF.
- **`closeAudioGap(doc, trackId, t)`** — lane-local. Rippling every lane would
  drag the music along with the narration it was placed against.

`packTrack` is untouched; clips still use it.

## 3. Export — `src/engine/export/ffmpeg.js`

Per-clip chain is now `atrim → asetpts → atempo* → volume → adelay`. `atrim`
runs first, so both its arguments are on the source's clock — `duration` is
multiplied back up by `speed` — and `atempo` only processes audio that survives
the trim.

**`atempoChain(speed)`** (exported, unit-tested) handles the filter's 0.5–2.0
limit: 3× becomes `atempo=2,atempo=1.5`, 0.25× becomes two `atempo=0.5`. The
three callers already spread `{...a, file}`, so nothing else needed changing.

## 4. Preview — `src/ui/audioClock.js`

`node.playbackRate = speed`, and both `offset` and the third argument to
`start()` scale by it — per spec they are in *buffer* time, so each timeline
second seeked or played is `speed` seconds of file. `when` is wall-clock and is
not scaled. `trackEnd()` divides by speed for the unknown-duration case.

## 5. Timeline — `src/ui/components/Timeline.jsx`, `src/ui/app.css`

- `AudioClip` gained the same `.grip.l` / `.grip.r` spans clips have, and shows
  `2×` in its label and tooltip when the rate is not 1.
- The audio drag branch handles `move`, `start` and `end`. `move` lets
  `audioSlot` do the clamping; the **trim edges clamp against the neighbours
  directly** (`audioNeighbours`), because `audioSlot` would relocate the block to
  make room — correct for a move, wrong for a trim, where `start` and `trimIn`
  must move together or the waveform slides under the window. The right edge
  also stops at the end of the recording, using the probed length.
- New **`Gap`** component per run of silence wider than `MIN_GAP`, including the
  lead-in before the first item. Hatched and near-invisible until hovered: a gap
  is the absence of content and should not read as content.
- `snapPoints` now pushes audio *ends* as well as starts — with lanes kept
  gapless, that is exactly where the overlap clamp would land anyway.
- Toolbar gained a razor button; the trash button now deletes audio too.

`App.jsx` widened `peaksBySrc` into **`mediaBySrc`** (`{peaks, duration}`). The
file's full length is a property of the file, not of the edit, so it stays out
of the document.

## 6. Inspector, selection, shortcut

- Selection is **`{type:'audio', id}`**, not an index.
- `AudioInspector` gained a **Length** field (the out point, previously not
  editable at all), a **Speed** field with a row of preset chips, and a **Split
  at playhead** button disabled unless the playhead is strictly inside the item.
  It warns when the project has a transcript — see below.
- **`S`** splits, registered in the renderer's `keydown` listener rather than the
  Electron menu, for the reason `buildMenu` already documents: a registered
  accelerator would swallow the letter in every text field.

## 7. MCP — `mcp/server.js`, `mcp/guide.js`

- `add_audio`: `start` is optional (omitted = append), plus `speed` and
  `trackId`.
- **`update_audio {name, ref, …}`** — new. There was no patch tool at all, so an
  agent could only add and remove.
- **`split_audio {name, ref, t}`** — new.
- `remove_audio` accepts an id as well as an index.
- The guide gained an "Audio lanes are sequences, not stacks" section covering
  appending, the two clocks, and the split-twice-then-remove idiom.

---

## Verification

**Unit** — `npm test`: 367 pass, 0 fail.

- `test/audio.test.js` (new, 23 tests): appending, explicit-start sliding,
  nearest-side nudging, id-or-index addressing, id backfill for old files, the
  source-vs-timeline `trimIn` arithmetic on a split at 2×, unmeasured-item
  splits, and lane-local gap closing.
- `test/export.test.js`: `speed: 1` produces a graph byte-identical to before
  (the regression that matters); `atempo` chains multiply back out to the
  requested rate for every rate tried.
- `test/project.test.js`: `speed` bounds and default.

**Renderer, headless** — `scripts/smoke/audio-editing.js` (new), run under
`xvfb-run`. Drives real pointer events and keystrokes: clicks a gap closed,
selects a block by id, scrubs and presses `S`, deletes a half, closes the
resulting gap, trims by the right grip, sets 2× from a preset chip, and drags one
block into another to confirm it stops flush. Passes.

```
WB_SMOKE=/tmp/audio.png \
WB_SMOKE_PROJECT=<project with two audio items and a gap> \
WB_SMOKE_SCRIPT=scripts/smoke/audio-editing.js \
xvfb-run -a npx electron .
```

**MCP + ffmpeg, end to end** — `create_project` → `add_audio` twice with no
`start` (second lands at the first's end, same lane) → `split_audio` →
`remove_audio` the middle piece → `update_audio {speed: 1.5}` → an overlapping
`update_audio {start}` slides flush → `export_video`. The emitted graph for a
4s block at 1.5× was `atrim=start=0:duration=6,…,atempo=1.5,adelay=2000:all=1`,
and `ffprobe` reported matching 6.58s video and 6.59s audio streams.

### Incidental fix

`scripts/smoke/timeline-tracks.js` was already failing on `main` before this
work: the camera lane, added later, is a `.tl-lane` and its selector counted it
as a track lane. Selector narrowed to `:not(.page):not(.camera)`; the script
passes again.

---

## Round two: speed bugs

Three faults in `speed` were reported after the first round and are now fixed.

**Pitch shifted in preview.** The first round used WebAudio `playbackRate` and
documented the resulting pitch shift as an accepted divergence from export's
`atempo`. That was the wrong call — preview is where a take is judged, and a
chipmunk voice makes the judgement worthless.

`src/ui/timeStretch.js` (new) is a WSOLA time-stretch: overlapping Hann windows
laid down at a different spacing, each allowed to slide within ±10ms to wherever
it best continues the one before it. That search is the whole trick, and it is
done once per hop on a 4×-decimated mono mixdown — full-rate would cost seconds
per file, and a per-channel search would smear the stereo image. 65–163ms for 20
seconds of stereo, measured.

`audioClock.js` now keeps two caches: `rawRef` (`src`, decoded, kept forever,
because decoding is slow I/O) and `buffersRef` (`` `src@speed` ``, stretched,
swept when no track references the key). Playback runs at rate 1 over an
already-stretched buffer, so all the rate arithmetic in `schedule()` disappeared
rather than moving; only `trimIn` still converts, being source seconds. Stretching
happens on a 180ms idle timer after edits settle, and synchronously on a cache
miss at play time — tens of milliseconds before the first sample is invisible,
hearing the wrong pitch is not.

**Speeding up left silence.** `patchAudio` never rescaled `duration` when `speed`
changed, so a 4s block at 2× went on claiming 4s of timeline while holding 2s of
sound, and the next item stayed where it was. New `setAudioSpeed(doc, ref, speed)`
in `edits.js` scales `duration` by `oldSpeed / newSpeed` and slides every later
item on the same lane by the delta. `patchAudio` delegates to it whenever a patch
names `speed` without naming `duration` — an explicit pair from a caller that
knows what it wants still wins. The shift is uniform, so no overlap can appear
and downstream spacing is preserved.

The ripple is the one place something moves that the user did not select. It is
deliberate: the alternative is a lane that grows a hole every time a take is
sped up, which is the bug wearing a different hat.

**Only preset speeds were reachable.** The Inspector gained a logarithmic slider
over 0.25×–4× — `pos = (log2(s) + 2) / 4`, so 1× sits at the centre rather than a
fifth of the way along — with a detent snapping the middle 2% to exactly 1. It is
coalesced into a single undo step via the same `coalesce`/`endGesture` mechanism
the timeline drags use, which matters more than usual because each intermediate
edit also ripples the lane. The number field and chips stay.

### Round-two verification

- `test/timeStretch.test.js` (new, 10 tests). The one that matters: synthesise a
  440Hz sine, stretch by 0.5/0.75/1.5/2/3, and assert the measured zero-crossing
  rate stays within 2% of 440 while the length scales — a resampler lands on
  `440 × speed` and fails loudly. Plus identity at speed 1, exact output lengths,
  no NaNs or clipping, stereo channels staying sample-identical, a rate other
  than 48k, and the AudioBuffer wrapper against a fake context.
- `test/audio.test.js` gained 10 tests for rescale-and-ripple: 2× halves and
  pulls the lane back, 0.5× doubles and pushes it out, spacing downstream is
  preserved, other lanes never move, an explicit `{speed, duration}` wins,
  unmeasured items keep `undefined`, and two successive changes land where one
  jump would.
- `scripts/smoke/audio-editing.js` now drives the slider: asserts the block
  halves and the neighbour follows on the 2× chip, that position 0.8 gives ~2.3×
  (a rate no preset offers), and that the midpoint detents to exactly 1×. Three
  consecutive headless runs produced byte-identical results.
- MCP + ffmpeg: an 8s block set to 2× becomes a 4s block whose neighbour ripples
  from 8s to 4s, emitting `atrim=start=0:duration=8,…,atempo=2` — eight source
  seconds compressed into four on the timeline. `silencedetect` finds no padded
  silence anywhere in the MP4.

387 unit tests pass; both renderer smoke scripts pass.

## Out of scope, worth a follow-up

- **Subtitle re-timing.** `subtitles.words[]` are absolute composition seconds
  produced by whisper over the whole file, and nothing re-times them when audio
  moves. Splitting, trimming, retiming or closing a gap will drift an existing
  transcript. The Inspector now warns when a transcript exists; the honest fix is
  to anchor words to an audio item id plus source-relative times, which is a
  schema change to `subtitles` and a rewrite of `buildCues`.
- **Fades.** Cutting without one clicks audibly. `afade` in the graph plus
  GainNode ramps in preview is perhaps 30 lines.
- **Pitch-preserved preview** (offline phase vocoder), per the divergence above.
- **Multi-select / range selection**, and split for clips as well as audio.
