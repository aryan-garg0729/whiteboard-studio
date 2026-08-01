# Whiteboard Animation Studio — status & handoff

A VideoScribe/Doodly-class tool: drop in images, text and audio; arrange them on a
timeline; export a hand-drawn-on-whiteboard video at 1080p. Requirements are in
[`req.md`](req.md).

**State: the rendering engine is complete, and the editor is usable end to end.**
Import artwork or audio, add text in any installed font, arrange clips on a drag-and-drop
timeline, position and resize clips directly on the canvas, and export MP4 — all from the
app. Multiple pages with swipe transitions work, including returning to a filled page and
drawing on it again. Camera keyframes are still document-only. 168 tests pass.

> Earlier attempts live in `../v1` and `../v2`. They are **out of scope** — do not read
> or reuse them. This is a clean rewrite.

---

## Quick start

```bash
npm install                  # node deps
npm run sidecar:install      # python venv for the CV sidecar (numpy/scipy/skimage/cv2)
npm test                     # 168 tests
npm run app                  # build + launch the Electron app
npm run demo                 # renders demo.mp4 — draw + colour + handwrite + erase
```

Verified toolchain on this machine: Node 20.20.2, npm 10.8.2, system **ffmpeg 4.4.2**
(libx264, h264_nvenc, h264_vaapi), Python 3.10.12. `potrace` and `inkscape` are **not**
installed and the system Python has **neither `skimage` nor `cv2`** — hence the venv.

### Scripts

| Command | What it does |
|---|---|
| `npm run app` | **Launch the app** (vite build + electron) |
| `npm run dev` + `npm run app:dev` | Vite dev server, then Electron against it (hot reload) |
| `WB_SMOKE=out.png xvfb-run -a npx electron .` | Headless smoke test: boots, loads a project, screenshots |
| `WB_SMOKE_PROJECT=demo.project.json` | Which project the smoke test opens — a bare name is an example, anything with a `/` is a path |
| `WB_SMOKE_SCRIPT=path.js` | Runs an interaction script in the renderer before the screenshot — how UI behaviour is checked headlessly |
| `npm run render:project -- examples/demo.project.json` | **Render a project file** — the generic, data-driven path |
| `npm run demo` | Full reel from a hardcoded script (same output, kept for reference) |
| `npm run demo:frames` | Same, as a PNG sequence in `.preview/` (fast to inspect) |
| `npm run animate:image -- pic.png --seconds 6 --erase 2` | One image, traced and animated |
| `npm run animate:text -- "Hello" --size 200` | Handwriting only |
| `npm run calibrate:hands` | Regenerates `assets/hands/*.json` from `hands/*.png` |
| `node scripts/export-sample.js` | Minimal hard-coded export, useful for isolating export bugs |
| `node scripts/render-preview.js` | Minimal hard-coded engine preview, no sidecar needed |

Common flags: `--frames-only` (PNGs instead of MP4), `--no-hand`, `--hand hand1|hand2|hand4`,
`--audio track.mp3`, `--out path.mp4`.

---

## Architecture

```
src/
  engine/            # pure JS, no DOM, no canvas import — the host injects a surface factory
    compile/         # asset -> ordered stroke primitives (all time-independent, cacheable)
      geometry.js    #   bezier flattening (Wang), arc-length tables, locate(), tangentAt()
      order.js       #   human-looking stroke sequencing + pen-up travel moves
      scribble.js    #   boustrophedon zig-zag infill (used by fill AND erase)
      svgPath.js     #   SVG path data -> flattened subpaths
      svgDoc.js      #   whole SVG document -> contours + fillable regions (+ stroke paint)
      text.js        #   opentype.js layout + glyph stroke ordering/orientation
    anim/
      registry.js    #   AnimationType plugin registry; PenState contract
      outlineFill.js #   images: outline pass, then zig-zag colour pass
      handwrite.js   #   text: centreline strokes
      erase.js       #   erase modifier (not an animation type — see below)
    render/
      renderFrame.js #   THE contract: pure (project, frameIndex) -> pixels;
                     #   renderPage() is the per-sheet seam page transitions composite
      surfaces.js    #   per-clip canvases + committed/active raster strategy
      drawHand.js    #   hand sprite placement
      vectorArt.js   #   a vector's own fills+strokes; reveal source AND settle target
    model/project.js # project schema, defaults, validation; the seam the UI sits on
    hand/rig.js      # nib placement, rotation clamp, never-detached scale solve
    hand/styles.js   # which manifests exist: drawing hands vs. tool styles (eraser)
    export/          # ffmpeg arg/filter-graph building + the frame pump
    sidecar/client.js# Node client for the Python process
  ui/                # renderer: React app (plain JS)
    App.jsx          #   shell, transport, command wiring
    stageGeom.js     #   local/world/screen mapping for direct manipulation
    state/editor.js  #   document transforms, undo/redo, structural-vs-timing edits
    components/      #   Menubar, Library, Stage, StageOverlay, Inspector, Timeline
    engineHost.js    #   rebuilds plans from the IPC payload; OffscreenCanvas surfaces
electron/
  main.js            # window, IPC, sidecar lifecycle, WB_SMOKE hook
  preload.cjs        # contextBridge surface (no ipcRenderer exposure)
  prepare.js         # project -> JSON-safe payload (geometry + data URLs)
  sidecar/           # Python: stdio JSON-RPC
    server.py        #   protocol + disk cache
    vectorize.py     #   raster -> outline contours + fillable colour regions
    skeleton.py      #   glyph outline -> ordered centreline strokes
assets/hands/*.json  # generated hand-style manifests (calibrated from the PNGs)
hands/*.png          # source hand art (supplied, not generated)
```

### The one contract everything hangs off

```js
renderFrame(session, project, frameIndex, ctx, { width, height, showHand, handStyleId })
```

Pure function of `(project, frameIndex)`. Preview and export call it identically; export
just supplies a bigger context. Rules enforced below this line:

- **no `Math.random`, `Date.now`, or `performance.now`** — all jitter is baked at compile
  time with a seeded PRNG (`mulberry32`)
- **`frameIndex` is the parameter, not `t`** — accumulating `t += 1/fps` drifts, deriving
  `t = n/fps` does not
- **the hand is drawn in screen space**, outside the camera transform, so it keeps a
  constant apparent size at any zoom

A test stubs `Math.random` to throw during a 20-frame render. Another asserts a backward
seek produces pixels identical to forward playback.

### Extensibility seams

- **New animation type** = one file exporting `{id, label, paramSchema, compile, advance}`
  plus a `register()` call. `advance()` returns a `PenState`, which is how the hand rig
  stays decoupled from what is being drawn — a new animation gets hand-following for free.
  `paramSchema` is intended to drive the inspector UI automatically.
- **New hand style** = PNGs, a `STYLES` entry in `scripts/calibrate_hands.py`, and its id in
  the right list in `src/engine/hand/styles.js` — a drawing hand in `HAND_STYLE_IDS`, a
  non-pen tool in `TOOL_STYLE_IDS`. `npm run calibrate:hands` derives tip, arm exit, bbox
  and shaft angle from the alpha channel. That list is not optional bookkeeping: a style no
  host loads is invisible to `pickStyleForTool()`, which is exactly how the eraser sat
  calibrated-but-unused.

---

## Hand assets — measured facts

Derived by reading alpha channels, not assumed. Regenerate with `npm run calibrate:hands`.

| Asset | Geometry | Tip (1080p) | Arm |
|---|---|---|---|
| `hand1` | forearm + hand, ballpoint | (543.0, 0) | exits bottom, len 1921.7 |
| `hand2` | forearm + hand, felt-tip | (414.3, 0) | exits bottom, len 1923.4 |
| `hand4` | **pen only, no hand** | (233.6, 1510) | touches no edge |
| `eraser` | forearm + hand, block eraser | (457.5, 68.0) | exits bottom, len 1972.0 |

`hand1`/`hand2`/`hand4` are **drawing hands**, offered in the picker. `eraser` is a **tool
style**: it is loaded alongside whichever hand is chosen and selected automatically while an
erase sweep runs. The two lists live in `src/engine/hand/styles.js`.

Four things that shape the design:

1. **Tip x drifts between resolution variants** (hand1: .5299 @720p / .5028 @1080p /
   .5198 @1440p). They are not clean rescales, so tips are stored **per source file**.
2. **Auto-detection is unreliable** — topmost-opaque finds the right nib on hand1/hand2 but
   the pen *cap* on hand4. `tip_hint` in `scripts/calibrate_hands.py` pins it.
3. **The eraser's tip is not an alpha extremity at all.** Its index fingertip touches the
   top frame edge *above* the block, so every alpha-based hint rigs the hand by its finger
   and drags the eraser off the stroke. The block is found by colour instead
   (`is_tool_px`: skin is always R > G > B, the pink is the only saturated thing with more
   blue than green), and the tip is the midpoint of the first row wide enough to be the
   working face rather than its antialiased corner.
4. **`hands/*vertical-*.png` are damaged** — pre-rotated with smearing artifacts. Not used;
   the clean assets are rotated at render time instead.

### The never-detached rule

```
s_min = (H_frame + margin) / (|V| · cos(θ_max + |assetTilt|))
```

`|V|` is the tip→elbow distance. For hand1 at 1080p this is **0.647**, giving a hand 22% of
frame width — where reference products sit.

The `assetTilt` term is **not optional**: the applied rotation is clamped to ±θ_max but
compounds with the asset's own lean (hand1's arm is 2.4° off vertical), so the worst case is
27.4°, not 25°. Omitting it leaves the arm 22px short of the edge with the nib at the top of
frame — a visibly floating hand, in exactly the case the constraint exists to prevent. A
9×9 grid × 4 tangents test covers this.

**`hand4` is a "floating pen" style** (`constraint: "none"`), *not* no-hand mode. No-hand
mode (`showHand: false`) draws no sprite at all.

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
| Raster vectorization | Line-art/photo classification, k-means in Lab, `RETR_CCOMP` even-odd rings; **thin clusters become centrelines, not contours** |
| Text handwriting | opentype.js layout + skeletonized centrelines, role-based stroke order |
| SVG import | Shapes, groups, nested transforms, style/presentation attrs, fill→region, holes |
| App shell | Electron + React; menubar, library, stage, inspector, timeline |
| Asset import | File dialog and drag-and-drop (with a byte-copy fallback when a dropped file has no path); ffprobe duration, waveform peaks, thumbnails |
| Font picker | System enumeration via fontconfig, **filtered to faces opentype.js can parse**, script-like families first |
| Timeline | Named tracks with clips auto-packed into shared lanes, drag to move (horizontally to retime, vertically to re-lane), edge-resize, snapping, ruler scrub, audio waveforms |
| Audio preview | WebAudio mixes the tracks live and is the master clock, so the drawing cannot drift from narration; per-lane and master mute are monitoring-only and never reach the document |
| Inspector | Clip timing/transform/erase, text and asset params, composition settings |
| Undo/redo | Pure document transforms; drags coalesce into one history entry |
| Export UI | Drives `render-project.js` in a child process with live frame progress |
| Settle to original | Once a clip finishes drawing it crossfades from the pen's heavier ink to the source asset over 0.35s — pure function of `t`, so seeking is exact |
| Direct manipulation | Click to select, drag to move, corner handles to resize with the opposite corner anchored |
| Erase | Top-down sweep, `destination-out` on the clip layer only; runs on the settled artwork |
| Export | 1080p MP4 at ~42fps; `ffprobe`-verified h264/yuv420p/exact duration; ffmpeg audio graph |
| Determinism | Backward-seek == forward playback, byte-identical across sessions |
| Pages | Multiple sheets with swipe up/down/left/right and cut between them; a page may be revisited and drawn on again, and each visit is its own segment on the timeline's page lane |

### Not started

| Piece | Notes |
|---|---|
| **Page curl** | The four swipes and cut ship; the strip-based paper curl does not. `renderPage()` is the seam it would consume — it already hands back a whole page as a bitmap |
| **Camera keyframes** | `cameraAt()` interpolates them per page; the inspector shows a disabled control |
| **Backward-scrub snapshots** | Backward seeks still replay from zero — see Known limitations |
| **Canvas pan/zoom** | The stage fits or zooms to fixed steps; no free navigation |
| **Tracer tuning panel** | `vectorize.py` accepts colour count / min area; the inspector shows them disabled |

---

## Suggested next steps

1. ~~Electron shell~~, ~~SVG import~~, ~~timeline / library / inspector~~,
   ~~playback clock~~ — **done**. The clock now anchors to `AudioContext.currentTime`
   (`src/ui/audioClock.js`); only *scrub* audio is still missing, and deliberately so.
2. **Keyframe snapshots.** Backward seeks replay from zero, and the timeline now makes
   scrubbing the first thing anyone tries. Cache the composited page as an `ImageBitmap`
   every ~2s in an LRU and replay forward from the nearest one.
3. **Page curl**, if the swipes ever stop being enough. The "render page to bitmap" path
   it needs exists now: `renderPage()` returns a whole page as pixels, and the transition
   compositor is where a curl would slot in beside the push.
4. **Camera keyframe editing** on its own timeline track, then tracer tuning.
5. **Packaging** with electron-builder.

---

## Known limitations — read before "fixing" these

- **"Any image format" oversells what's achievable.** Whiteboard animation assumes *line
  art*. Photos quantise into many noisy regions; the classifier picks different parameters
  but the result is still weaker than for line art. An import-time tuning panel (colour
  count, min region area, smoothing) is the intended mitigation — `vectorize.py` already
  accepts all of these.
- **Skeletonisation quality varies by font.** It extracts the medial axis of a *printed*
  letterform. Near-monoline faces are excellent; modulated serifs read as traced type. The
  sidecar returns a `modulation` figure and `monoline` flag — measured DejaVu Sans 0.07–0.21
  vs DejaVu Serif 0.23–0.27 — and the scripts warn. Ship curated handwriting fonts as
  defaults. A single-line/Hershey stroke-font fast path is the clean escape hatch.
- **Erase now shows the eraser hand.** `pickStyleForTool()` selects on the manifest's `tool`
  field, but it scans `session.hands` — so a tool style is only reachable if the host
  actually loaded it. All three hosts built that map from the chosen drawing hand alone,
  which is why the eraser manifest existed and still drew nothing. `styleIdsFor()` in
  `src/engine/hand/styles.js` is the single list they now share; a test asserts an erase
  frame requests an eraser sprite. **Adding another tool is a manifest plus one entry in
  that list.**
- **The scribble reads as a clean diagonal wipe** at default brush sizes, because passes
  overlap 35%. That matches reference products, but `fillBrushWidth` and `overlap` are
  tunable if you want strokes more legible.
- **The hand is large** (22% of frame width). That is forced by the never-detached
  constraint and matches reference products. The only lever is the procedural arm stretch.
- **The hand follows the pen's shaft angle, not its travel direction**, folded into
  (-90, 90]. With `alignFactor` 0.16 the sprite moves within about +/-14deg, well inside
  the +/-25deg the scale solve assumes. Turning either up brings back the frantic
  scan-line swing.
- **Centrelining depends on the classifier calling the image line art.** A photo keeps the
  region-contour path, where a double outline is not meaningful anyway. A thick elongated
  shape (a banner) stays filled by design -- see `STROKE_MAX_WIDTH_FRAC`.
- **Settling needs an original to settle to.** Raster clips use their source pixels and
  vectors are repainted from geometry, but **text does not settle** — there is no separate
  original, the handwriting ink *is* the artwork. That is deliberate, not an omission.
- **On-canvas handles ignore `rotation`.** The selection box is the axis-aligned bounds of
  a rotated drawable, which is a correct if loose target; rotation is edited numerically in
  the inspector. Scaling is uniform because `transform` carries one `scale` and the
  compiled brush widths are chosen from it — non-uniform scaling would distort strokes.
- **OS file drops depend on `webUtils.getPathForFile`**, which returns `""` for anything
  without a real filesystem path. That case now reports an error and points at Library →
  Import rather than silently discarding the files.
- **Backward scrubbing is O(everything)** until snapshots land.
- **SVG scope is the drawing subset.** Shapes, groups, transforms, `style`/presentation
  attributes and fill→region all work. Gradients degrade to flat grey rather than vanishing.
  Not supported: `<use>`/`<defs>` references, clip paths, masks, filters, embedded raster —
  each would change the animation model, not just the parser.
- **`opentype.js` quirks**: `loadSync` is deprecated and silently returns `undefined` — use
  `parse(arrayBuffer)`. `stringToGlyphs` runs a shaping engine that throws on DejaVu's GSUB
  lookups — we use `charToGlyph` per character, which is what handwriting wants anyway and
  still applies kerning.

---

## Bugs already found and fixed — do not reintroduce

Each of these was caught by looking at rendered output, not by tests, and each now has a
regression test.

1. **Artwork offset by its bbox origin.** Animations emit object-local coordinates but
   surfaces cover only the padded bbox. Drawing contexts carry a standing `-origin`
   translate — and `clearRect` must bypass it (`clearAll()`), or it clears the wrong rect.
2. **`destination-in` keeps the *destination's* colour**, masked by the source's alpha. The
   artwork must be the destination and the mask the source. Reversed, the reveal shows a
   flat white scribble instead of the artwork.
3. **Applying `destination-in` per mask half intersects the halves with each other**,
   leaving only their overlap. The committed and active masks must be unioned into a
   separate `maskUnion` surface first.
4. **Stroke indices are global across the plan.** A layer's `commitRange` must be told the
   first index its phase owns, or the fill layer stamps the outline strokes into its mask.
5. **Erase composited on a stroke counter that never advances.** The sweep is one long
   stroke, so `committedUpTo` stays at its phase start throughout — erase was invisible
   until its final frame. Layers now carry a `used` flag.
6. **The hand vanished during pen-lifts.** Visibility follows `pen.active`, not `pen.down`;
   `down` governs ink, not existence. The eraser also needs `handLive` re-opened, since by
   then the draw's own progress is already 1.
7. **Modulation measured over the wrong pixels.** Sampling the whole glyph interior
   includes the taper to zero at every boundary, so *every* font scored ~0.57. Sample the
   medial axis only, where the distance transform *is* the stroke half-width.
8. **Junction endpoints weren't canonicalised**, so edges meeting at a merged junction never
   compared equal and never chained — `t` came out as 8 strokes instead of 2.
9. **Pruning ran before chaining.** A crossbar arrives as two short free-ended edges;
   pruned individually they both vanish, turning "coffee" into "coliee". Chain first, then
   prune — genuine serif barbs are near-perpendicular and still get pruned.
10. **Endpoint extension applied at junctions.** Stroke tips are extended by the local
    radius to undo skeletonisation erosion, but only *free* ends (`degree == 1`) may be
    extended. At a junction the stroke doesn't end, and `dist` peaks there, so it shot
    hooks into empty space — spurs on `m`'s arches, `r`'s arm, `e`'s join.
11. **`Layer.reset()` didn't clear `active`.** An animation only calls `clearActive()` on
    the layer it is currently drawing into, so a stale fill mask kept compositing through
    the entire outline phase — a region appeared pre-coloured before its outline was drawn,
    then blanked, then coloured properly. Also affects any backward scrub from fill to
    outline.
12. **Demo warm-up ran at frame 0**, where clips that start later are skipped entirely and
    never get surfaces. Warm up on the **last** frame.

16. **`setPointerCapture` throws for a pointer id the browser is not tracking.** It sat
    at the top of the timeline's drag handler, so the exception aborted drag setup and
    clips would not move at all. Capture is only an optimisation — the move/up listeners
    are on `window` regardless — so it is now wrapped in try/catch.
17. **Some installed fonts cannot be parsed by opentype.js** (2 of 154 on this box:
    broken GSUB coverage, colour-emoji with no outlines). The font list was sorted
    alphabetically and the first entry happened to be one of them, so the default text
    face was broken out of the box and failed with `Coverage format must be 1 or 2`,
    naming neither the font nor the fix. `listFonts()` now parses each face and drops the
    unusable ones; `prepare.js` reports the filename when a parse fails anyway.
18. **`max-height: 100%` cannot fit a canvas to a flex panel.** The percentage resolves
    against a parent whose height is content-derived, so it is ignored — the canvas
    overflowed the stage and slid under the transport bar. The fit scale is now measured
    with a `ResizeObserver` and applied as explicit pixels, which also keeps the guide
    overlay aligned and lets the zoom control show the true percentage.
19. **A headless X server advertises its own DPI** (1.728 here), so the smoke screenshot
    was laid out at a scale no real display uses. `runSmoke` now converges an inverse
    zoom factor onto an effective ratio of 1 — note zoom feeds back into
    `devicePixelRatio` non-linearly, so a single `1/dpr` correction overshoots.

20. **The hand followed the raw travel direction, not the pen's shaft angle.** A pen does
    not flip end-for-end when a stroke reverses, but serpentine fill reverses on *every*
    scan line — so the sprite alternated between roughly -11deg and the +25deg clamp
    several times a second. `shaftAngle()` folds the tangent into (-90, 90] so both passes
    of a -45deg scribble map to the same pose. Measured: a 36.3deg swing per scan line
    became 0.0deg. `alignFactor` also dropped 0.25 -> 0.16, halving the overall range to
    about +/-14deg, still well inside the +/-25deg that `minScale()` assumes.
21. **The drawn outline is not the artwork.** The pen traces contours at an ink width
    chosen to read as *drawing*, which is deliberately heavier than the source asset's own
    lines — so a finished clip looked coarser than the file the user imported. Clips now
    settle to the original. Note this must be a crossfade of the ink and the artwork *over*
    the revealed fill, not of the whole composite: fading `drawn` out and `art` in
    independently gives 0.75 alpha at the halfway point and the clip visibly dips
    translucent. Keeping the reveal underneath at full alpha holds the body opaque.
22. **Vectors have no raster to settle to**, so the artwork surface is painted from the
    geometry. Fills alone are not enough: a shape with `fill="none"` contributes no region
    at all and would *vanish* the moment its clip settled. `svgDoc` now carries each
    subpath's own stroke paint and width, and `vectorArt.js` strokes them.
23. **A resize gesture fed back into itself.** Changing the scale re-lays-out the handle
    under the cursor, and Chromium answers a layout change with a synthetic `pointermove`
    at the *real* cursor position — which the handler treated as continued dragging, and
    which resized again. Runaway. Drags now record `e.pointerId` and ignore moves from any
    other pointer. (Caught headlessly: the injected pointer is id 0 and the OS mouse is
    id 1, so the loop was dramatic rather than subtle.)
24. **Opening a project immediately re-prepared it.** `ed.load()` bumped the structural
    revision, which is what triggers a rebuild — but `open()` had *just* built the session
    from that exact document. Every trace and skeletonisation ran twice, and the progress
    overlay it raised covered the stage, so the manipulation layer was unreachable for
    seconds after opening. The reducer now tracks `preparedRev` alongside `structuralRev`
    and only rebuilds when they disagree.
25. **`undefined` does not survive JSON.** Emitting `stroke: undefined` for unstroked
    subpaths broke the prepared payload's round-trip test, which exists precisely because
    the payload has to be writable to disk and loggable, not merely structured-cloneable.
    Spread the keys in conditionally.

26. **Contouring a drawn line traces it twice.** The vectorizer worked on colour
    *regions*, and a thin region's boundary is a loop running down one side of the line
    and back up the other -- so every stroke got a visible double outline, and on thicker
    ink the two passes merged into a line far heavier than the source. Line-art clusters
    that are stroke-like (`elongation >= 6` and mean width under 2% of the image diagonal)
    now go through `centrelines_from_mask()`, the same medial-axis pipeline glyphs use,
    and carry their own measured width so the pen reproduces the original weight.
    Stroke-like clusters emit **no fillable region** -- scribbling inside a line-width
    region is meaningless.
27. **`stretchBand` was measured in absolute 1080p rows** but one manifest serves every
    resolution variant. With the 720p sprite selected, rows 1381-1919 are outside a
    1280-tall image, so `drawImage` clipped the band away, the forearm stretch drew
    *nothing*, and the arm simply ended 896px below the nib -- a floating stump whenever
    the artwork sat high on the canvas. The band is now a **fraction of source height**.
28. **`pickSource` ranked variants by "closest to 1", which picks the smallest one.** Its
    required scale then exceeds `COMFORT_SCALE`, forcing the arm stretch -- lower
    resolution *and* synthetic geometry when a larger source needed neither. Ranking by
    "largest that still fits inside COMFORT_SCALE" picks the 1080p sprite for 1080p output
    with **zero stretch**, and leaves stretching as the portrait-output fallback it was
    meant to be.
29. **Settling blitted the whole source image**, background included, painting an opaque
    white rectangle over the paper -- the drawable's bounding box, visible as a panel
    behind the artwork. The settled artwork is now intersected with ink + fill, which is
    exactly the marks that were actually made.
30. **`webUtils.getPathForFile` returns `""`** for a dropped file the browser holds
    without a filesystem path, and drag-and-drop failed outright. There is now a fallback:
    the renderer ships the bytes and `asset:ingest` writes them into the app's import
    folder, named by content hash so re-dropping reuses one copy. The path route is still
    preferred, because a saved project then points at the user's own file.
31. **A headless compositor can go idle**, after which `requestAnimationFrame` never
    fires and `capturePage` returns whatever it last drew. That hung the smoke test on an
    rAF that never resolved, and — once raced against a timeout — produced screenshots of
    the app as it looked *before* anything loaded, which reads as a pass. Trust the
    script's DOM assertions; the screenshot is best-effort.

### Subtle invariants worth preserving

- **Half-open scanline rule** in `spansAt`: `if ((y0 <= y) === (y1 <= y)) continue;`. This
  rejects horizontal edges and counts a vertex exactly on a scan line exactly once, so the
  crossing count is always even. The naive `y0 < y < y1` form yields odd counts and spans
  leak across the frame. The scan grid is offset by a half step for the same reason.
- **Cell decomposition** in the scribble: disjoint spans on one scan line (a U-shape) must
  not be connected across the gap, or the pen teleports between the arms.
- **Committed/active raster split**: completed strokes are drawn once in full; the single
  in-progress stroke is redrawn from its first vertex each frame. Appending per-frame deltas
  instead produces different antialiasing at the joins — visible seams and dark overlap dots.
- **Tangent smoothing is windowed over arc length, not frames.** Any IIR filter carries
  state between frames and breaks seeking.
- **`amix` must set `normalize=0`** — measured on this ffmpeg, the default is exactly 6.0 dB
  quieter (half amplitude) with two inputs.
- **The region `clip()` belongs on the mask canvas**, not on `reveal` and not on the page —
  clipping downstream applies AA twice and leaves a thin dark rim at 1080p.
- **Outline draws above fill**, so scribble overshoot can't nibble the outline.
- **Erase is `destination-out` on the clip's own layer**, never on the page, or it punches
  through the background and every clip beneath. It composites *after* the settle
  crossfade, so it wipes the original artwork rather than the pen's version of it.
- **A drawn line is followed down its middle, never contoured.** This is the difference
  between one pen stroke and two parallel ones a hair apart.
- **`stretchBand` is a fraction of source height, never absolute rows** -- the manifest is
  shared across resolution variants.
- **A drag must be bound to the pointer that started it.** Any handler that changes layout
  under the cursor will otherwise be re-entered by Chromium's synthetic `pointermove`.
- **Selection UI is DOM, not canvas.** `renderFrame` owns every exported pixel, so a
  handle drawn into the canvas could leak into an export. `StageOverlay` cannot.

---

## Project data model

Defined and validated in `src/engine/model/project.js`; see `examples/demo.project.json`
for a working document and `scripts/render-project.js` for the renderer that consumes it.
`normalizeProject()` fills defaults and throws `ProjectError` with a path
(`clips[1].animId: unknown animation "draw.wiggle"`) rather than rendering something wrong.

```js
{
  meta:   { fps, width, height, background },
  pages:  [{ id, name, cameraKeyframes: [{ t, x, y, zoom }] }],
  pageBreaks: [{ t, pageId, transition, duration }],  // the itinerary over the sheets
  tracks: [{ id, name, kind }],  // 'clip' | 'audio'; timeline lanes, layout only
  clips: [{
    id, assetId,
    animId,                      // registry key: 'draw.outlineFill' | 'draw.handwrite'
    pageId,                      // which sheet it is drawn on
    trackId,                     // which lane it is drawn on
    start, duration,             // seconds, timeline
    erase: { start, duration },  // optional modifier
    transform: { x, y, scale, rotation },
  }],
  audio: [{ src, trackId, start, trimIn, duration, gain }],
}
```

Plain JSON, and the single source of truth for `renderFrame`. `session.plans` /
`session.erasePlans` hold the compiled geometry keyed by clip id; `session.surfaces` holds
the canvases.

**Erase is a clip property, not an animation type** — that way it works identically for
images and text without either knowing about it, since both produce the same
`ClipSurfaces`.

**`pages` is the set of sheets; `pageBreaks` is the itinerary over them.** Splitting the two
is what makes "go back to page 1 and keep writing" expressible at all — a break may name a
page that has already been visited, so a page gets one *window* per visit rather than a
single lifetime. `pageWindows()` derives those windows and `pageStateAt()` answers "which
sheet, and how far through a swipe" — the renderer asks nothing else.

Two rules fall out of that and are enforced by the validator:

- **A clip may only draw while its own page is on screen.** Checked per window, not against
  their union, so a draw cannot span a gap where the page left and came back. Draw and erase
  are checked separately, because drawing on one visit and wiping on a later one is a
  reasonable thing to author.
- **The swiping interval belongs to neither page.** A window opens when the transition lands
  and closes when the next one begins, so nothing can be drawn while the paper is moving —
  and the renderer draws no hand there either.

The strictness is deliberate, and the editor is what keeps it from being annoying: a clip's
`pageId` travels with it when you drag it past a break (same coalesced patch as the move, so
one undo step and every intermediate frame legal), and "Add page" places the break after
everything already authored rather than orphaning later clips.

**Tracks are layout, nothing else.** No code below `renderFrame` reads `trackId`, and
`projectDuration()` ignores tracks entirely, which is what lets a vertical drag on the
timeline be a timing-class edit rather than a re-trace. It is also why every pre-tracks
project file still loads: `normalizeProject` synthesises the default lanes and assigns
everything to them.

---

## Testing

`npm test` — 168 tests, `node:test`, no framework.

| File | Covers |
|---|---|
| `engine.test.js` | Geometry, arc-length pacing, scanline/even-odd, cell decomposition, hand rig against real manifests |
| `determinism.test.js` | The purity contract: cross-session identity, backward seek, no-randomness, frame-index timing |
| `surfaces.test.js` | Layer reset semantics, origin-aware clearing, empty-mask compositing |
| `erase.test.js` | Ink extent, sweep direction, the `used` flag, degenerate plans |
| `export.test.js` | ffmpeg args and audio filter graph |
| `text.test.js` | Glyph key stability, role classification, stroke orientation and ordering |
| `project.test.js` | Schema defaults, validation paths, duration maths, the bundled example |
| `svg.test.js` | Shapes, transforms, fill inheritance, viewBox, rings/holes, .svg routing |
| `prepare.test.js` | The IPC boundary: payload is JSON-safe and sufficient to rebuild plans |
| `editor.test.js` | Document transforms, structural-vs-timing classification, undo/redo, drag coalescing |
| `stage.test.js` | local/world/screen round trips, hit-testing, anchored resize, shaft-angle folding, settle timing, **arm reach over a 9x9 nib grid x 5 orientations x 3 aspect ratios** |

UI behaviour is checked headlessly with `WB_SMOKE_SCRIPT`, which evaluates an interaction
script in the renderer (click through tabs, add a clip, drag it, resize it, undo) and
prints what changed. Assert against `window.__studioState()` — a read-only view of the
document, selection and frame — rather than scraping input values, which lag a commit
boundary behind. The pointer-capture, unparseable-font, resize-feedback and
double-prepare bugs were all caught this way; none is reachable from a unit test.

**Visual checks matter as much as the tests here.** Use `--frames-only` and actually look at
`.preview/` — every bug in the list above was found that way. `ffmpeg -ss <t> -i demo.mp4
-frames:v 1 out.png` pulls a frame at a timestamp.
