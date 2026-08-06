# Bold text + a pixel-first rewrite of image/SVG drawing

## Context

Two independent changes to the whiteboard studio.

**Bold text.** Text assets carry `font`, `fontSize`, `penWidth`, `color` and nothing else — there
is no weight concept anywhere (`electron/fonts.js:58` hardcodes `style: 'Regular'`). Authors
cannot emphasise a word.

**Image/SVG drawing.** Today a raster image is sent to a Python CV sidecar
(`src/sidecar/vectorize.py`), which downscales it, k-means quantises it, drops the background
cluster, morphologically opens it, drops contours under a minimum area, and Douglas–Peucker
simplifies what is left. The animation then draws *that geometry*, and the finished picture is
only ever the artwork intersected with the marks the pen happened to make. Six independent
thresholds decide what survives:

| Where | Threshold |
|---|---|
| `vectorize.py:167` | `maxDim` 1600 — everything is traced at ≤1600px |
| `vectorize.py:185,192` | `colors` 6 / 12 — k-means merge |
| `vectorize.py:206` | `backgroundTolerance` 26 — background cluster discarded outright |
| `vectorize.py:201`, `_rings_from_mask:93,103` | `minAreaFrac` 0.0004 / 0.0015 — contours dropped |
| `vectorize.py:202` | `smoothing` → `approxPolyDP` epsilon 1.4 / 3.0 |
| `skeleton.py:233` | `prune_spurs(factor=1.4)` — centreline branches dropped |

`doc.md:574` states the consequence plainly: *"The reveal can only show what the vectorizer
traced."* That is the behaviour to remove. The rewrite drives everything off the **actual
pixels**, so the finished frame is the source image, byte for byte.

Decisions taken with the user:

- **No paper knockout.** `artAlpha.js` is deleted. An image renders its own pixels, background
  included. Exactness wins over the blend-into-the-paper look.
- **SVG rasterises into the same pipeline.** `parseSvg`/`paintVectorArt` survive as a *renderer*
  only; there is no second geometry-driven compiler.
- **The stencil is a grey pencil sketch**, erased as paint covers it.
- **`draw.imageReveal` / `draw.outlineFill` alias** to the new animation so existing documents,
  examples and MCP scripts keep loading.

---

## Part 1 — Bold text

### Approach

Two mechanisms, chosen per face, because only four of the nine bundled fonts can do real bold:

| Face | `fvar` wght axis |
|---|---|
| Caveat | 400–700 |
| Montserrat | 100–900 (**default 100 — it currently renders Thin**) |
| OpenSans | 300–800 |
| PlayfairDisplay | 400–900 |
| Patrick Hand, Indie Flower, Architects Daughter, Permanent Marker, Poppins | none |

1. **Variable faces — real weight.** Verified working on this machine with opentype.js 2.0.0:
   ```js
   font.variation.set({ wght: Math.min(700, axis.maxValue) });
   glyph.getPath(x, y, size, {}, font);   // the 5th arg is required
   ```
   Both the outline *and* the HVAR advance width change. Traps:
   - `glyph.getPath(x, y, size)` **without** the `font` argument silently returns the default
     instance. `src/engine/compile/text.js:291` calls it that way today.
   - `glyph.advanceWidth` is only updated as a *side effect* of `variation.getTransform`, which
     `getPath` triggers. `placeGlyphs` reads `advanceWidth` — call `getPath` (or
     `font.variation.getTransform(glyph)`) for a glyph before reading its advance, or bold text
     lays out at regular metrics.
   - Set `wght: 400` on variable faces even when not bold. This fixes Montserrat rendering as
     Thin today.

2. **Static faces — synthetic dilation.** `outlineText` emits `regions[{rings, color}]` that
   `paintVectorArt` fills with `ctx.fill('evenodd')`. Adding `region.dilate` and *also* stroking
   the same path at `lineWidth = dilate`, `lineJoin/lineCap = 'round'`, is textbook fake bold:
   stems thicken and counters shrink symmetrically. `dilate ≈ fontSize * 0.055`.

### Files

- **`src/engine/compile/text.js`** — `placeGlyphs` (L148), `outlineText` (L261), `traceText`
  (L364) take `o.bold`. Apply the variation before laying out; pass `font` to `getPath` (L291);
  set `dilate` on emitted regions for non-variable faces; grow `inkBbox` (L334-342) by
  `dilate/2`.
- **`src/engine/render/vectorArt.js`** — `paintVectorArt` strokes a region when `region.dilate`
  is set, after its fill.
- **`src/engine/anim/textReveal.js`** — `BAND_PAD` must absorb `dilate/2` so the reveal band does
  not clip bold ascenders/descenders.
- **`src/engine/anim/handwrite.js`** — glyph bboxes used by `paintWipe` (L25-40) and the closure
  rings grow by `dilate/2` for the same reason.
- **Font metadata** — `electron/fonts.js` `listFonts()` (L53-63) reports whether a face has a
  `wght` axis (`boldMode: 'variable' | 'synthetic'`) instead of the hardcoded `style: 'Regular'`.
  Do **not** add new manifest entries — `mcp/smoke.js:61` asserts exactly nine fonts.
- **Threading `asset.bold`** through the four identical `opts` blocks:
  `electron/prepare.js:121-125`, `src/engine/host/nodeSession.js:124-128`,
  `scripts/animate-text.js:69,75`, and optional validation in
  `src/engine/model/project.js:198-205`.
- **UI** — a Bold toggle in `src/ui/components/Inspector.jsx` beside Size/Pen (L190-193) and in
  the insert panel `src/ui/components/Library.jsx` `TextTab` (L106); draft state in
  `src/ui/App.jsx:29-32` and `addText()` (L388-399).
- **MCP** — `bold: z.boolean().optional()` on `add_clip` (server.js L208-224), `update_asset`
  (L276-286) and the `storyboard` beat schema (L404-413); **add `'bold'` to the hard allowlist in
  `mcp/studio.js:286`** or the field is silently dropped; mention it in `mcp/guide.js:81-87` and
  `mcp/capabilities.js`.

---

## Part 2 — Pixel-first image & SVG drawing

### The model

```
host decodes asset -> ImageData at full source resolution
      |                       |
      |                       +-> painted verbatim into sf.art   (no knockout, no resample)
      |
      +-> analysis grid (long edge capped ~1400px)
              |
              +-- quantise into colour groups (every pixel belongs to exactly one)
              +-- group boundary rings  -> STENCIL strokes (pencil, sf.ink)
              +-- group boundary rings  -> PAINT strokes   (white mask, sf.fill)
              +-- per-group RLE mask    -> exact closure blit into sf.fill
```

`ClipSurfaces.composite()` already does `art ∩ fill.mask` via `destination-in`
(`src/engine/render/surfaces.js:192-223`). That machinery is correct and stays. What changes is
**where the mask comes from**: pixel coverage instead of traced geometry.

**Why this is exact.** The colour groups partition every pixel of the analysis grid — nothing is
dropped for being small, thin, pale or background. Each group's mask is blitted as a run-length
bitmap the moment its scribble finishes, so the union of the masks at `u = 1` is the whole image
rectangle, and `art ∩ everything = art`. Exactness is structural, not a matter of brush tuning.
Analysis cells dilate outward by one cell, which only ever overshoots.

The **stencil is cosmetic and may drop tiny contours** — the paint pass covers those pixels
regardless. That distinction is the whole reason the "no pruning" guarantee holds.

### Two paint modes

`mode: 'zigzag' | 'colorGroups'`

- **`zigzag`** — one boustrophedon sweep across the whole image. Reuse
  `scribbleRegion(rings, opts)` (`src/engine/compile/scribble.js:187`) with the image rectangle
  as its single ring. Params: `sweepAngle` (−90..90, default −45) and `sweepFrom`
  (`topLeft | topRight | bottomLeft | bottomRight`) — that pair is the "direction setting".
  Exactness needs no RLE here: overlapping passes are guaranteed by `MAX_COVERAGE_RATIO`
  (`scribble.js:162`), and a final full-rect mask fill at `u = 1` is the backstop.
- **`colorGroups`** — groups painted one at a time, each scribbled inside its own boundary rings
  (`scribbleRegion` again), each closed by its exact RLE mask. `groupOrder`:
  `darkFirst` (default) | `largestFirst` | `readingOrder`.

### The stencil pass

Group boundaries *are* the outlines — no gradient threshold to tune, and they match the regions
the paint pass fills. Trace them with marching squares over the label grid, chain them into
polylines, then order them with the existing `orderStrokes()` (`src/engine/compile/order.js`) so
the pencil moves in reading order with pen-up travel arcs, exactly as today.

The pencil draws into `sf.ink` at `#9a9a9a`. Because the artwork is now opaque, ink composited
over the reveal would sit on top of the finished picture — so **`composite()` gains a
`destination-out` of the fill mask against the ink layer** before the ink is drawn. The sketch
disappears precisely where paint has landed. Gate it on a plan flag so `handwrite` (whose ink
*is* its artwork) is untouched.

`plan.outlineShare` keeps its meaning: the fraction of the clip spent on the stencil.

### New files

| File | Contents |
|---|---|
| `src/engine/compile/pixels.js` | `quantize(imageData, opts)` — deterministic histogram bucketing in Lab plus nearest-neighbour merge of undersized buckets (**not** k-means: no randomness, no `Math.random`, and every pixel keeps a label). `colorGroups()` → `{label, color, area, bbox, rle}`. `traceLabelBoundaries()` — marching squares → rings. |
| `src/engine/compile/paintPasses.js` | groups → ordered `Stroke[]` for both modes, plus each stroke's `closure` (an RLE blit descriptor instead of today's polygon). |
| `src/engine/anim/stencilPaint.js` | `draw.stencilPaint` — `compile`/`advance`, `settles: false`. |
| `src/engine/anim/penStrokes.js` | `easeEnds`, `applyBrush`, `strokeWhole`, `strokePartial`, `paintClosure` moved out of `outlineFill.js`, which is being deleted. `erase.js:19`, `handwrite.js:11`, `textReveal.js:22` and `test/text.test.js:18` import them from here instead. |

`paramSchema` for `draw.stencilPaint`: `mode`, `outlineShare`, `sweepAngle`, `sweepFrom`,
`groupOrder`, `colors`, `pencilWidth`, `fillBrushWidth`. The Inspector renders it generically
and the MCP layer validates against it — no bespoke UI code either side.

### Deletions

- `src/engine/anim/outlineFill.js`, `src/engine/anim/imageReveal.js`
- `src/engine/render/artAlpha.js` and `test/artAlpha.test.js`
- `src/sidecar/vectorize.py`; `op_vectorize` in `src/sidecar/server.py:63,96`;
  `Sidecar.vectorize` and `toAsset()` in `src/engine/sidecar/client.js:88,111`
- `traceKey()` (`nodeSession.js:90`) and the `asset.trace` field everywhere it is threaded
- `test/imageReveal.test.js` (replaced by `test/stencilPaint.test.js`)

`src/sidecar/skeleton.py` stays — it still serves the legacy `layoutText` centreline path. With
`vectorize.py` gone the sidecar is no longer needed to render **any** project; the "tracing an
image needs the Python sidecar" error (`nodeSession.js:111`) disappears with it.

### Host changes — the twinned branch

`electron/prepare.js:85-115` and `src/engine/host/nodeSession.js:102-116` contain the same
three-kind branch and comments in both flag them as deliberately twinned. Both become:

- **image** — read the file, decode, hand `{width, height, data}` to `compile`. No sidecar call,
  no `dataUrl` round-trip needed beyond what `prepare.js` already sends.
- **vector** — `parseSvg` as today, but instead of feeding geometry to the animation, rasterise
  it with `paintVectorArt` into an offscreen canvas at ~2–3× the clip's on-screen size, and feed
  *that* ImageData to the same `compile`. One pipeline.

`src/ui/engineHost.js:104-142` mirrors it on the renderer side. Because both hosts analyse
pixels locally from the image they already decode, no mask data crosses IPC.

Artwork install (`nodeSession.js:210-224`, `engineHost.js:126-142`) simplifies to a plain
`drawImage` at source resolution — the `knockOutPaper` call and the `traced.width/height`
resample both go away.

### Migration

`normalizeProject()` (`src/engine/model/project.js`) maps `draw.imageReveal` and
`draw.outlineFill` → `draw.stencilPaint`, translating `scribbleAngle` → `sweepAngle` and
`brushWidth` → `pencilWidth`, and defaulting `mode: 'zigzag'`. `KNOWN_ANIMATIONS` (L28-31) and
`ANIMATIONS_FOR_KIND` (L43-48) list only the new id. Also update `edits.js:217`,
`mcp/storyboard.js:118`, `mcp/guide.js:73-81`, `src/ui/components/Inspector.jsx:16-17,106`, and
the driver scripts `scripts/animate-image.js`, `scripts/demo-reel.js`,
`scripts/render-preview.js`, `scripts/export-sample.js`, `scripts/smoke/image-reveal.js`.
`examples/*.json` keep their old ids and exercise the alias.

---

## Verification

Bold:

1. `npm test` — `test/text.test.js` invariants must still hold, especially "outline and centreline
   layouts agree on where a glyph sits" (L182) and "a span is a word, not a letter" (L201).
2. New tests: bold Caveat/Montserrat glyph paths differ from regular and advance widths grow;
   bold Patrick Hand (no axis) produces a `dilate` on its regions; Montserrat regular is no
   longer wght 100.
3. `npm run animate:text -- "Bold test" --size 200 --bold` and look at `.preview/`.

Images:

4. **The exactness test, which is the point of the whole change**: render the last frame of a
   clip at `u = 1` and assert it is pixel-identical to the decoded source image. Run it for a
   photo, a line-art PNG, a transparent PNG and a rasterised SVG, in **both** modes.
5. Determinism: `test/determinism.test.js` must still pass — stub `Math.random` to throw across
   the pixel compiler, and assert a backward seek matches forward playback.
6. `npm run animate:image -- <photo>.png --seconds 6 --mode colorGroups` and
   `--mode zigzag --sweepFrom topRight`, `--frames-only`, then **actually look at `.preview/`** —
   `doc.md` records that nearly every real bug here was found that way, not by a test.
7. `npm run render:project -- examples/pages.project.json` and `examples/svg.project.json` to
   confirm the aliases load pre-existing documents.
8. `npm run mcp:smoke` (drives the real server over stdio; needs no display, ffmpeg or Python),
   then author a short project through the MCP server and read it back with
   `render_contact_sheet`.
9. Confirm the Python sidecar is genuinely optional: render an image project with the venv
   deleted from `PATH`.

## Documentation

`doc.md` is the handoff document and several of its sections become wrong: the tracing/pruning
limitations (L567-580), the subsystem table rows for image drawing and raster vectorization
(L520-545), the architecture tree (L100-150), and "Next steps" item 2 (tracer tuning panel — the
tracer will no longer exist). Update them in the same change.

---

## Status

**Both parts implemented and verified.** 293 tests, 292 pass — the one failure is the
pre-existing stale assertion about a bundled example, confirmed identical on the commit before
this work.

### What shipped beyond the plan

Three things the plan did not anticipate, all found by looking at rendered output:

1. **A `wght` axis is not enough to trust a face's bold.** opentype.js 2.0.0 mis-interpolates
   Montserrat's `o` — at wght 700 its counter comes back nearly as large as the letter, so bold
   rendered a thin notched ring. Every other glyph in the face is fine. Faces are now *probed*
   (`hasSoundWeightAxis`, pure geometry, no canvas) and an unsound one drops to synthetic bold.
   Montserrat is therefore synthetic; Caveat, Open Sans and Playfair Display get real weight.
2. **A pre-existing bug that silently deleted letters.** `path.toPathData()` rounds by string
   concatenation, so a coordinate landing within ~1e-7 of an integer serialises as the literal
   `NaN` and its contour is lost. At 64px this ate Caveat's `Y` and Playfair Display's `L`.
   Glyphs now go through `flattenCommands()`, which reads the command objects. This is almost
   certainly the "wierd outline on characters" issue in `req.md`.
3. **Exactness needed three fixes the plan did not foresee**: the mask grid must take the
   *maximum* alpha over a box, not the mean (a lone near-transparent pixel averaged to nothing
   and was never revealed); coverage rectangles must be snapped to whole pixels, because two
   antialiased fills overlapping a pixel do not add up to full coverage; and the pencil stencil
   must be clipped to the artwork's own silhouette, or the half of each stencil line that falls
   outside the shape survives to the last frame.

### Verified

- Pixel-exactness at `u = 1` over every bundled raster in both modes, plus a 2400x1800
  photo-like image and one with varying alpha — a test in `test/stencilPaint.test.js`.
- Determinism, backward-seek equality, and no `Math.random` in the pixel compiler.
- Bold across all nine faces; no glyph dropped at any of six sizes in either weight.
- `npm run mcp:smoke` end to end; `render:project` on all three example projects via the
  retired-id alias; `animate-image`, `demo-reel`, `render-preview`, `export-sample`.
- An image renders with `.venv` moved away entirely — no host needs Python now.

### Not done

- The Electron app was not launched (the user asked to hold off on that). The renderer host was
  rewired to match `nodeSession`, and `scripts/smoke/stencil-paint.js` was updated to cover it,
  but that headless UI check has not been run.
- `colorGroups` on artwork with a large flat background still spends its tail painting
  white-on-white. The brush now widens with the square root of a group's area, which mostly
  hides it; documented under Known limitations with the mitigations.
