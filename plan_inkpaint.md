# `draw.inkPaint` — outline first, then colour, for whiteboard-optimised artwork

## Context

`draw.stencilPaint` is the only way pictures are drawn today. It is *exact* — every pixel
belongs to a colour group, each group closes with its own RLE coverage mask, so `u = 1` is the
source image byte for byte — but it is *generic*. It assumes nothing about the artwork:

- the palette is a **median cut to a fixed `colors` count** (`pixels.js:143`). On flat clipart
  this both splits one flat fill into two groups and merges two genuinely different ones, and
  the antialiased fringe around every outline becomes its own spurious groups.
- phase one is a **grey pencil stencil** (`PENCIL_COLOR = '#9a9a9a'`, `paintPasses.js:25`) of the
  group boundaries, drawn into `sf.ink` and rubbed out later by `composite()`. It is a sketch of
  the outline, not the outline.
- the fill unit is a **whole colour at once** (`colorGroupStrokes`, `paintPasses.js:142`), so the
  pen scribbles across three disjoint red shapes as one region.

For the artwork this tool is actually pointed at — whiteboard-style illustrations with a solid
black outline and flat colour fills — the right animation is the one a person would do: **ink the
black linework first, following the lines, then fill each shape with its colour.** That is what
this adds, as a second animation. `draw.stencilPaint` is untouched.

The exactness guarantee is inherited unchanged: coverage still comes from per-group pixel
rectangles, never from where the brush happened to go.

## Decisions

- **A new animation id, `draw.inkPaint`**, alongside `draw.stencilPaint` — confirmed with the
  user. Its own `paramSchema`, so no inert controls on either animation, and zero regression
  risk to existing documents.
- **Nothing goes into `sf.ink`.** Both phases lay a white mask into `sf.fill`; the artwork's own
  black shows through. So no `clearInkUnderFill`, and the outline appears in its real colour
  rather than as a grey surrogate that has to be erased.
- **The outline is traced along its centreline, never scribbled** — confirmed with the user.
- **The centreline is the hand's *path*, not the reveal.** What appears is the outline at its
  real thickness, however thick that is. These are two separate things and the design keeps them
  separate: the skeleton decides where the hand goes; a per-pixel ownership map decides what has
  been revealed. A 9px-thick outline reveals as 9px wide even though the hand walked a 1px
  centreline through the middle of it.
- **The fill unit is one connected shape**, not a whole colour — the shirt, then the left shoe,
  then the right, with a pen-up travel arc between them.
- **Colours merge by perceptual tolerance and the group count is discovered from the artwork**,
  not fixed. `colorTolerance` replaces `colors` on this animation. An internal upper bound on
  distinct groups stays in the code as a robustness guard so a photograph dropped into this mode
  degrades rather than compiling thousands of groups; it is not exposed as a control.

---

## Design

### Analysis: flat-colour quantisation (`src/engine/compile/pixels.js`)

Add a second quantiser beside `buildPalette`, selected by an option so `analyzeArtwork` serves
both animations:

- `flatPalette(img, { tolerance, maxColors = 48 })` — histogram the 5-bit bins exactly as
  `buildPalette` already does (lines 147–167, same deterministic sort by bin index), then walk
  bins in descending population and either accept a bin as a new flat colour or absorb it into
  the nearest accepted colour within `tolerance` (same 0.30/0.59/0.11 weighted metric as
  `labelPixels`). A 5-colour clipart yields 5 groups; antialiased fringes and JPEG ringing snap
  onto their parent. No seeding, no iteration to a tolerance — deterministic like everything else
  in this file. `maxColors` is an internal guard, not a user control: it exists so a photograph
  dropped into this mode degrades to a coarse result instead of compiling thousands of groups.
- `analyzeArtwork(img, { palette: 'flat', tolerance, ... })` picks the quantiser. Everything
  downstream — `labelPixels`, `encodeRects`, `traceLabel`, the `groups[]` shape — is unchanged,
  which is the point: exactness is a property of the decomposition and the decomposition is the
  same.

**Ink detection.** Add `pickInkLabel(groups, { inkLuma, inkChroma })`: the darkest group whose
`luma` is below `inkLuma` (default ~0.30) and whose channels are near-neutral. If several dark
groups qualify (a black outline plus a near-black shadow) they merge into one ink group by union
of their `rects` and re-tracing. Returns `null` on artwork with no outline, in which case the
animation degrades to "colour pass only" rather than failing.

**Connected components.** `components(labels, w, h, label)` — 4-connected union-find over the
mask grid, returning per-component `{rects, area, bbox}` plus rings traced on the shape grid.
Components below a small area fold into the `pending` closure list that `colorGroupStrokes`
already uses (`paintPasses.js:163,175`) — coverage is preserved, only the pen path is pruned,
exactly the `MIN_RING_AREA` distinction the file already documents at lines 56–70.

### The ink pass: centreline tracing (new `src/engine/compile/centerline.js`)

Pure JS, no Python — `src/sidecar/skeleton.py` stays only for the legacy `layoutText` route and
must not be reintroduced as a dependency.

**Path — where the hand goes:**

1. **Thin** the ink mask on the mask grid with Zhang–Suen (two subiterations to a fixed point).
   Deterministic, no parameters.
2. **Chain** skeleton pixels into polylines: mark junction pixels (>2 neighbours) and endpoints,
   walk each branch, emit a polyline. Prune spurs shorter than the local line thickness.
3. **Simplify** each polyline (exact collinear merge, then a small-tolerance Douglas–Peucker) —
   cosmetic only; it moves the hand, never the reveal.
4. **Order** with the existing `orderStrokes(subpaths, {style, travelMinGap})`
   (`src/engine/compile/order.js:198`), so the ink pass inherits containment grouping, reading
   order, seam choice and bulged pen-up travel arcs for free.

**Reveal — what appears, at the outline's real thickness.** This is deliberately *not* derived
from the stroke geometry, because a nib as wide as the line would round every corner and spill at
every junction, and the outline would come out fatter than the source. Instead:

5. **Distance transform** of the ink mask (two-pass chamfer). Its value at each skeleton pixel is
   the local half-thickness, used only to size the *nib the hand appears to hold* (`inkWidthGain`)
   so the pen looks proportionate to the line it is drawing. Cosmetic.
6. **Per-stroke pixel ownership.** Multi-source BFS over the ink mask seeded from every skeleton
   pixel, each carrying its stroke index; every ink pixel takes the index of its nearest skeleton
   pixel. So the *entire cross-section* of the outline — all nine pixels of a 9px line, right out
   to both edges — belongs to the stroke running down its middle, including the flare where two
   lines meet at a junction.
7. `encodeRects` per stroke index (a small generalisation of `pixels.js:274` to read a per-pixel
   owner array instead of a label). Each ink stroke gets an exact `closure`, so the full-thickness
   outline closes progressively right behind the nib rather than popping at the end of the phase.

Because ownership partitions the ink mask exactly, the union of the ink strokes' closures is the
ink group's rects — nothing double-owned, nothing left over. That is the assertion in
verification step 3.

### The colour pass (new `src/engine/compile/inkPasses.js`)

Structurally `colorGroupStrokes` with the ink group removed and components as the unit:

- Order the non-ink components with the existing `orderGroups` (`pixels.js:521`) —
  `darkFirst` | `largestFirst` | `readingOrder`, all already label-tiebroken and total.
- Per component: `scribbleRegion(component.rings, { brushWidth, angleDeg, seed: hashSeed(...) })`
  → `chunkPolyline` → `makeStroke({kind:'FILL', color:'#ffffff'})`, `travelStroke` between
  components when the gap exceeds the brush, `closure` = the component's own rects plus anything
  pending. Keep the `sqrt(area/mean)` brush widening (`paintPasses.js:152-158`) — it is what
  stops a big flat background eating half the clip.
- The final stroke carries the whole-image backstop closure, as today
  (`paintPasses.js:192-197`). This is what makes exactness structural.

`buildInkPasses(analysis, params) => { ink, paint }`, mirroring `buildPasses`.

### The animation (new `src/engine/anim/inkPaint.js`)

Modelled directly on `stencilPaint.js` — same two-phase `advance`, same `locate`/`makePhase`
arc-length pacing, same `easeEnds`. Differences:

- `phases.outline` = ink strokes, `phases.fill` = colour strokes, **both drawn into `sf.fill`**.
  So `advance` has one layer, and the "commit the whole stencil when crossing phases" special
  case (`stencilPaint.js:187-190`) disappears — a single `commitRange(0, at.strokeIndex, …)` over
  the whole stroke list covers it.
- No `clearInkUnderFill`, no `PENCIL_COLOR`, no `STENCIL` stroke kind.
- `settles: false` and `paintGain` 1.12, for the same reasons as `stencilPaint`.
- Plan shape unchanged so erase and the render loop work untouched: `strokes`, `phases`,
  `outlineShare`, `penWidth`, `bbox`, `inkBbox`, `width`, `height`.
- `paintRects` (`stencilPaint.js:59`) is needed by both — move it to
  `src/engine/anim/penStrokes.js` next to `paintClosure`, and have `stencilPaint` import it. Keep
  the outward pixel snapping and its docblock; that snapping is load-bearing for exactness.

`paramSchema`: `colorTolerance`, `inkLuma`, `outlineShare` (default ~0.45 — the linework is the
show here), `groupOrder`, `sweepAngle`, `inkWidthGain`, `fillBrushWidth`. Rendered generically by
the Inspector and validated generically by MCP; no bespoke UI either side.

### Registration

Registration is an import side effect, so a module nobody imports is invisible to
`getAnimation()`. Required, or it does not work:

1. `register({...})` in the new anim file.
2. Side-effect import in **both** hosts, whose compile branches are deliberately twinned:
   `src/engine/host/nodeSession.js:42-45` and `src/ui/engineHost.js:18-21`. Both already decode
   assets to pixels via `render/rasterize.js` (`imagePixels` / `vectorPixels`), so an SVG
   rasterises and takes the identical path — **no other host change is needed**, and in
   particular `electron/prepare.js` needs nothing, because an image is already prepared as a
   plain `{kind:'image', art: dataUrl}` with no animation-specific payload.
3. `KNOWN_ANIMATIONS` (`src/engine/model/project.js:28-31`) — `normalizeProject` throws without it.
4. `ANIMATIONS_FOR_KIND.image` and `.vector` (`project.js:81-86`) — without it the Inspector never
   offers it *and* `checkAnimForKind` (`mcp/capabilities.js:102`) refuses it.

Required for a usable UX:

5. `ANIMATION_LABELS` (`src/ui/components/Inspector.jsx:15-23`) — a hard-coded id→label map that
   duplicates each animation's own `label`; an unlisted id renders a blank `<option>`. Optionally
   a hint line at `:105-117`.
6. `mcp/guide.js:76-88` — the "Choosing an animation" list is hand-written and nothing generates
   it. Say plainly: `inkPaint` for whiteboard-style artwork with a black outline and flat fills,
   `stencilPaint` for everything else.

Needs nothing: `mcp/capabilities.js` (derives from the registry), `mcp/server.js` (`animId` is
`z.string()` throughout), the Inspector's `AnimParams` (schema-driven), `renderFrame.js`,
`erase.js`. `mcp/storyboard.js:117-119` passes any `draw.*` id through unchanged.

Deliberately not changed: `src/engine/model/edits.js:217` and `mcp/storyboard.js:119` keep
`draw.stencilPaint` as the default for new image clips. `inkPaint` is opt-in — it makes an
assumption about the artwork that a default cannot.

**One existing test asserts the animation count**: `test/mcp.test.js:108` (its comment reads
"one fewer than before"). It has to be bumped.

## Files

| File | Change |
|---|---|
| `src/engine/compile/pixels.js` | `flatPalette`, `pickInkLabel`, `components`, `palette` option on `analyzeArtwork`; generalise `encodeRects` to an owner array |
| `src/engine/compile/centerline.js` | **new** — thinning, distance transform, chaining, spur pruning, per-stroke pixel ownership |
| `src/engine/compile/inkPasses.js` | **new** — `buildInkPasses(analysis, params)` |
| `src/engine/anim/inkPaint.js` | **new** — `draw.inkPaint` |
| `src/engine/anim/penStrokes.js` | receives `paintRects`, moved out of `stencilPaint.js` |
| `src/engine/anim/stencilPaint.js` | imports `paintRects` instead of defining it — no behaviour change |
| `src/engine/model/project.js`, `src/ui/components/Inspector.jsx`, `src/engine/host/nodeSession.js`, `src/ui/engineHost.js`, `mcp/guide.js` | register the id |
| `test/inkPaint.test.js` | **new** |
| `test/mcp.test.js:108` | bump the animation-count assertion |
| `scripts/animate-image.js` | accept `--anim inkPaint` (it already has an `ANIM_ARG` at `:62`) |
| `doc.md` | the subsystem table row (L541) and the architecture tree (L123) |
| `plan_inkpaint.md` | this plan, copied to the repo root alongside `plan_draw.md`, with its Status section kept current |

## Verification

1. **Exactness, the non-negotiable one.** Mirroring `test/stencilPaint.test.js`: render `u = 1`
   and assert the frame is pixel-identical to the decoded source, over the bundled rasters, a
   transparent PNG, a rasterised SVG, and a synthetic flat-colour-plus-black-outline image.
2. **Quantisation.** A synthetic clipart with 4 flat colours plus ±3 per-channel noise and an
   antialiased black outline compiles to exactly 5 groups; the ink group is the outline.
3. **Ordering.** Every ink stroke precedes every colour stroke; the union of ink-stroke closures
   is the ink group's rects exactly (nothing double-owned, nothing unowned).
4. **Determinism.** Stub `Math.random` to throw across compile; compile twice and compare
   byte-for-byte; a backward seek must replay identically — the same three assertions
   `test/determinism.test.js` and `test/stencilPaint.test.js` already make.
5. **Degenerate input.** Artwork with no dark outline (ink label `null`) and a fully transparent
   image both compile and render without throwing.
6. `npm test`. Note that `test/project.test.js` currently has one pre-existing failure unrelated
   to this work — confirm the count is unchanged.
7. **Look at the output**, which `doc.md` records as how nearly every real bug here was found:
   `npm run animate:image -- <clipart>.png --seconds 8 --anim inkPaint --frames-only`, then open
   `.preview/`. Add the `inkPaint` branch to `scripts/animate-image.js:62`.
8. `npm run mcp:smoke`, and `npm run render:project -- examples/pages.project.json` to confirm
   existing documents still load and still use `draw.stencilPaint`.

## Status

**Implemented and verified. 317 tests, all passing.**

### Fixed: entrances rendered nothing on images and vectors

`appear.instant` / `fade` / `pop` / `slide` produced an empty clip for any artwork asset.

`appearPlan` reads `asset.bbox`, and surfaces are allocated from `plan.bbox` — so a missing box
is not a cosmetic default, it is a zero-sized canvas and a clip that renders as nothing
whatsoever. It also left the eraser nothing to sweep and gave a slide no distance to travel,
since travel is a fraction of the drawable's own size.

**This came in with the pixel-first rewrite, before the `inkPaint` work.** At `HEAD` the artwork
branch of both hosts compiled `{id, bbox, subpaths, regions}` and the entrances got a real box
from it; the rewrite changed artwork to `{id, image}` — no bbox anywhere in it — and nothing
noticed. Entrances on *text* kept working throughout, because that branch still passes `bbox`
explicitly, which is exactly why it stayed hidden.

The fix is at the single point that matters: `appearPlan` now derives `bbox` from
`asset.image` when there is no explicit one, and `inkBbox` from the image's alpha bounds — the
pixels that are actually there, not the whole rectangle, so the eraser does not sweep the
transparent field around a cut-out PNG.

Why no test caught it: every case in `appear.test.js` used a text-shaped asset with an explicit
`bbox`. Four tests now cover the pixel-shaped asset the hosts actually pass — bounds, that the
clip really puts pixels on the stage, that a slide has somewhere to travel, and that fully
transparent artwork still reports no ink. Three of the four were confirmed to fail against the
old code.

### Follow-up: `inkPaint` is now the default, and `stencilPaint` just paints

Three changes made after the animation landed, at the user's direction.

1. **The stale test is gone.** `the bundled example project is valid and renders a sane length`
   asserted the bundled demo had 2 clips; it has 3. The assertion had been failing since before
   this work and pinned nothing worth keeping — the neighbouring test already walks every example
   project through `normalizeProject`. Deleted rather than corrected. The suite is now fully green.
2. **`draw.stencilPaint` no longer sketches a pencil stencil.** It paints, and nothing else. The
   sketch spent a third of every clip drawing something guaranteed to be erased, and on artwork
   whose colour-group boundaries *are* its linework it laid a second, greyer outline just inside
   the real one. Drawing the outline first is exactly what `inkPaint` is for, and it inks the real
   line instead of a stand-in. Gone with it: `buildStencil`, `PENCIL_COLOR`, the `STENCIL` stroke
   kind, the `sf.ink` path and `clearInkUnderFill`, and the `pencilWidth` / `outlineShare` /
   `orderStyle` parameters. The label is now "Paint the artwork in"; **the id is unchanged**,
   because it is a key written into every project file on disk, not a description.
3. **`draw.inkPaint` is the default** for new image and vector clips (`edits.js`), for the MCP
   storyboard's art beats, and first in `ANIMATIONS_FOR_KIND`. `stencilPaint` stays as the
   fallback that assumes nothing.

Migration: `brushWidth`, `pencilWidth`, `outlineShare` and `orderStyle` all now land in
`DROPPED_PARAMS` rather than being mapped onto a survivor, because the thing each of them
controlled no longer exists. Dropping is the honest migration; carrying them across would
silently change what an old document does. `scribbleAngle` → `sweepAngle` still renames, since
that is genuinely the same quantity. These apply only to documents naming a *retired* animation
id, so none of it can reach `inkPaint`, which has an `outlineShare` of its own.

One test needed rethinking rather than retargeting: `prepare.test.js`'s "the payload is sufficient
to rebuild a plan and render a frame" was passing because the grey stencil was visible *without
any artwork installed*. With the stencil gone the pen lays only a mask, so the test now installs
the artwork it had been getting away with omitting — which is what the two hosts actually do, and
what the test claimed to be mirroring.

Verified: pixel-exactness at `u = 1` over all 14 bundled rasters and a rasterised vector;
determinism, no `Math.random`, byte-identical recompiles and backward-seek equality;
`npm run mcp:smoke` end to end; all three example projects still render and still use
`draw.stencilPaint`; and the rendered frames from `animate-image` actually looked at.

### What differed from the plan

Five things, all found by running the code rather than by reading it.

1. **`encodeRects` needed no generalising.** It compares ids, not labels, so it already worked on
   an owner array. What it *did* need was the opposite: an `encodeRectsMulti` that does every id
   in one pass. Calling it per stroke is a full grid scan each time, and a detailed drawing
   compiles to thousands of strokes — the scribble icon took **62 seconds**. One pass took it to
   0.6s. The same fix applied to per-piece coverage.
2. **The ink is not one colour group.** The plan assumed `flatPalette` would make one black group
   and picking the darkest would be right. The bundled lightbulb inks its outline in two shades
   measuring 15.3 apart — just past the merge tolerance — so taking only the darkest inked a thin
   broken core and left the rest to be coloured in as a fill. `pickInkLabels` now returns *all*
   dark neutral groups. The guard against swallowing a dark fill is the chroma test, which had to
   be tightened to 0.14 after a dark purple in the plane-trail icon passed as linework.
3. **Right-angle corners shattered the skeleton.** Under 8-connectivity a corner pixel and its two
   arms are mutually adjacent, so all three read as degree-3 junctions with a two-pixel cycle
   between them: a plain rectangle chained into 17 stubs. Suppressing redundant diagonals makes it
   one loop. Spur pruning then leaves junctions with only two branches still cut, so a `stitchPaths`
   pass rejoins them and carries strokes straight through real crossings — the scribble icon went
   from 1192 fragments averaging 7px to 716, and the star from 5 pieces to one 3955px gesture.
4. **Not every ink pixel gets a stroke.** The centreline is thinned on a coarser grid, so specks
   vanish there and their pixels have no stroke anywhere near them. `assignOwners` now sweeps
   those into an explicit remainder the pass closes at its end, which is what makes the partition
   total rather than merely usually-total.
5. **`darkFirst` was the wrong default here.** It exists so dark linework goes down first and
   gives the picture structure — but this animation has already inked the linework in its own
   pass, so the argument is spent. What was left put the bulb icon's one big yellow body *last*
   and filled the largest shape in the picture in the closing second. The default is
   `largestFirst`, and pieces within one colour are indexed largest-first too.

### Also worth knowing

- `mcp/smoke.js:60` had a **second** animation-count assertion the plan did not find, beside the
  one in `test/mcp.test.js`. Both bumped to 8.
- `MIN_PIECE_AREA` and `MAX_DRAWN_PIECES` were added to `pixels.js` as internal guards. An
  antialiased edge fragments into thousands of one-pixel islands — the scribble icon made 27557 —
  and none is a shape a hand fills. They keep every pixel; they just do not get their own trip of
  the pen.
- `paintRects` moved from `stencilPaint.js` to `penStrokes.js`, and `chunkPolyline` gained a size
  argument. `stencilPaint`'s behaviour is unchanged.

### Known limitations

- Artwork that is not outline-plus-flat-fills degrades rather than failing. The plane-trail icon
  (a gradient illustration, 16 groups) leaves 33% of its "ink" to the end-of-pass remainder, and
  the scribble icon — a *blue* scribble whose black group is sparse antialiasing speckle — still
  compiles 716 short fragments. Both still finish exactly; they just do not look like drawing.
  `draw.stencilPaint` is the right choice for those, which is why this one is opt-in.
- A genuinely dark grey *fill* is taken for linework. That is inherent to the assumption the
  animation is built on; `inkLuma` is the way out.
