# Close the last cuts, add "appear" animations, fix the hand test

## Context

Three things, from using the tool after the reveal landed.

1. **Cuts still happen sometimes.** The reveal mask can only ever contain geometry the
   vectorizer emitted, and the vectorizer's job — produce a plausible *pen path* — is not the
   same job as *cover every inked pixel*. There are at least ten places where ink is dropped
   before the engine ever sees it, several of them unbounded in area: a k-means cluster whose
   *centre* is near-white is skipped whole while its darker pixels survive `artAlpha`'s ramp
   (`vectorize.py:206-227` vs `artAlpha.js:30`); a stroke-like cluster emits centrelines and
   **no region** (`vectorize.py:246-259`), so any compact blob sharing that colour is lost;
   `centrelines_from_mask` collapses per-vertex radii into one mean `width`
   (`skeleton.py:503-510`) although `max_width` is right there (`skeleton.py:449`);
   `approxPolyDP` cuts up to `epsilon` inside the true contour and does it from *both* sides of
   a shared boundary; `MORPH_OPEN` deletes anything thinner than 3px; `min_area` drops small
   blobs; and the anti-alias halo exists at a device resolution the tracer never saw.
   Chasing these one at a time will keep leaking. **Fix it structurally instead: stop letting
   the traced geometry decide *what* is covered, and let it decide only *when*.**
2. **Images should be able to just appear**, not always be drawn. Shipping `appear.instant`,
   `appear.fade`, `appear.pop` and `appear.slide`, for images, SVGs **and** text.
3. **`the hand oscillates rather than tracking the baseline` fails** against the committed
   quarter-amplitude hand sweep (`textReveal.js:296-297`). The test asserts a magic
   `span > band * 0.5`; it should derive its expectation from the animation's own constants.

---

## 1. Coverage backstop — `src/engine/render/coverage.js` (new)

The artwork's alpha is the ground truth for what must end up revealed. Compute the shortfall
once, at build time, and hand it to the strokes that will paint it.

```js
export function closeCoverageGaps(sf, plan, opts = {})   // → number of stamps attached
```

1. Rasterise the plan's **finished** mask into a scratch canvas: every non-lift stroke at
   `width * gain`, plus every `closure` polygon. This is the same drawing `imageReveal`'s
   `drawWhole` does — factor that into a shared `paintStroke(ctx, st, plan)` so the two cannot
   drift apart.
2. Read `sf.art`'s alpha and the mask's alpha (one `getImageData` each; **reset the CTM
   first** — the artwork surface carries a standing `-origin` translate and `putImageData`
   honours it in node canvases, which is bug 35).
3. `remainder = artAlpha > INK_FLOOR && maskAlpha < MASK_FLOOR`. Label its connected
   components (4-connected flood fill over a `Uint32Array`); discard components under
   `MIN_STAMP_PX` (a couple of stray antialias pixels are not worth a stamp).
4. For each remaining component, render just those pixels into a bbox-sized canvas and attach
   it to the plan stroke whose vertices are **nearest its centroid**, as
   `plan.stamps: Map<strokeIndex, {canvas, x, y}[]>`. Nearest-stroke, not "the last stroke",
   so a dropped blob appears while the pen is next to it rather than popping at the end.
5. `imageReveal`'s `drawWhole` draws a stroke's stamps right after its closure, so they commit
   once, replay correctly on a backward seek, and cost nothing per frame.

Constants: `INK_FLOOR = 8`, `MASK_FLOOR = 128`, `MIN_STAMP_PX = 6`.

**Only run it where the artwork has a real silhouette** — i.e. when `knockOutPaper` ran, or the
art came from `paintVectorArt`. On a photo the art is an opaque rectangle and "everything not
covered" is the whole background; guard on the same `wantsPaperKnockout(traceMode)` the hosts
already consult, and pass a flag through.

Called by all three hosts immediately after the art is installed
(`src/ui/engineHost.js:113-129`, `scripts/render-project.js:179-194`,
`scripts/animate-image.js:~120`), guarded by `plan.reveal`.

Cost: two full-surface reads plus one labelling pass per clip at build time — the same order as
`knockOutPaper`, against a trace that takes seconds. Nothing changes per frame.

### Also fix the cheapest upstream cause, because it shrinks every stamp

`src/sidecar/skeleton.py:503-510`: emit `"maxWidth": round(2.0 * max(radii), 2)` beside
`width`. Plumb it through `vectorize.py:246-259` → `client.js` `toAsset` →
`prepare.js` `serializeDrawable` → `compileDrawPlan`, and have **`imageReveal` only** use
`maxWidth` for its mask (`outlineFill` keeps `width`, since its stroke is visible ink and must
stay the traced weight). The reveal mask is invisible, so being as wide as the widest point of
the stroke is free — it is exactly the tapered-brush case users hit.

---

## 2. Appear animations — DONE (`src/engine/anim/appear.js`)

Four registrations sharing one implementation, all `settles: false`:

| id | behaviour |
|---|---|
| `appear.instant` | fully visible from the clip's first frame |
| `appear.fade` | opacity 0→1, `easeInOut` |
| `appear.pop` | fade plus scale 0.92→1 about the clip's centre |
| `appear.slide` | fade plus a slide from `direction` (`up`/`down`/`left`/`right`), `distance` as a fraction of the bbox |

`compile()` needs only the asset's `bbox`, and returns a `textReveal`-shaped plan:
`strokes: []`, empty `phases`, `inkBbox` (the asset's ink bounds — `regions`/`inkBbox` when the
payload has them, else `bbox`), `penWidth`, so `compileErase` keeps working unchanged
(`erase.js:32-53` reads `inkBbox` first precisely for this case).

`advance()` fills the whole surface rect into `sf.fill.active` in white and calls `markUsed()`
— `composite()`'s `destination-in` then yields the untouched artwork — and returns `IDLE_PEN`,
which is already all it takes to suppress the hand (`renderFrame.js:235`).

**New blit hook.** There is no per-clip opacity or entrance transform today. Add an optional
`present(plan, u)` on `AnimationType` returning `{alpha, scale, dx, dy}`, applied in
`renderFrame.js` between the clip transform and `ctx.drawImage(out, ...)`, about the bbox
centre. It must be applied at blit time rather than drawn into the surface: surfaces are only
padded 32px (`renderFrame.js:103-112`) and a pop or slide would be clipped.

### Wiring

- `project.js`: `KNOWN_ANIMATIONS` += the four ids; `ANIMATIONS_FOR_KIND` gains them for
  `image`, `vector` **and** `text`.
- `electron/prepare.js:126` and its twin `scripts/render-project.js:105` branch on
  `clip.animId === 'draw.textReveal'` to decide filled letterforms vs a skeletonised
  handwriting payload. That test becomes "anything except `draw.handwrite`", so an appear text
  clip gets `mode:'reveal'` geometry and real artwork. `engineHost.js:63` routes on
  `p.mode === 'reveal'` and must dispatch by `clip.animId` instead.
- `engineHost.js` / `render-project.js`: `getAnimation(clip.animId)` already dispatches for
  drawables; appear needs no `brushWidth`/`fillBrushWidth`, so pass `clip.params` only.
- Optional but worth it: `prepare.js:98-100` can skip the sidecar entirely for an image clip
  whose animation is `appear.*` — it needs no geometry at all, only `bbox` and the data URL.
- `scripts/animate-image.js:59` hardcodes the `draw.` prefix and line 112 dereferences
  `plan.phases.outline.i1`; accept a full id and guard the log.
- `Inspector.jsx`: labels for the four ids.

### Params UI — the reason `appear.slide` can be one id instead of four

`paramSchema` is declared by every animation and rendered nowhere; `clip.params` is only ever
`{}`. Add a small generic block to `ClipInspector` that renders the selected animation's
`paramSchema` (`number` → the existing `Num`, `enum` → `<select>`, `color` → colour input),
writing through `ed.patchClip(clip.id, { params: {...} })`. Roughly 40 lines, and it also
unlocks the pen width / fill brush / scribble angle / draw order that `outlineFill` and
`imageReveal` have always had. Use `listAnimations()` (`registry.js:55`, currently uncalled) so
the Inspector stops needing its duplicate `ANIMATION_LABELS` table.

---

## 3. The hand oscillation test — DONE

`textReveal.js:296-297` carries two bare `0.5` factors that quarter the sweep. Fold them into
the named constant — `OSCILLATION_REACH` 0.42 → **0.105** — restore the clean expressions, and
export `OSCILLATION_REACH`/`LOOP_VARY`. Then `test/text.test.js:236` asserts against the
animation's own numbers instead of a magic `0.5`:

```js
const reach = band * OSCILLATION_REACH * 2 * (1 - LOOP_VARY);
assert.ok(span > reach * 0.9 && span < band * OSCILLATION_REACH * 2 * 1.25, ...);
```

so retuning the sweep moves the test with it, while a sweep that collapses or runs away still
fails. Keep the direction-change count check as is.

---

## 4. Verification

- `node --test test/` — plus new pins:
  - `test/coverage.test.js`: an asset whose plan deliberately misses part of its artwork (a
    region the plan has no geometry for) ends up **fully** revealed after
    `closeCoverageGaps`; stamps land on the nearest stroke; running it twice is idempotent;
    it is skipped for photo-mode art.
  - `test/appear.test.js`: `instant` is fully opaque on frame 1; `fade` is monotonic in `u`
    and reaches the artwork exactly at `u=1`; no hand is ever requested; nothing changes
    after the clip ends (`settles: false`); erase still finds the ink.
  - `test/text.test.js`: the reworked oscillation assertion above.
- **New `scripts/check-coverage.js <image> [--anim …]`** — traces an image, runs the plan to
  `u=1`, and prints the percentage of inked pixels never revealed plus a `missing.png` map.
  This is the tool for the repro image: run it before and after and quote the number.
- End to end: `node scripts/animate-image.js <repro> --frames-only --no-hand` and look at the
  last frame; then the app, `WB_SMOKE_SCRIPT=scripts/smoke/image-reveal.js`, extended to also
  switch the clip to `appear.fade` and assert the stage paints without a hand.

---

## Status

Sections 2 (appear animations, including the generic params UI) and 3 (the hand oscillation
test) are implemented and tested. Section 1, the coverage backstop for the remaining cuts,
is still to do.

## Open item for next session

You said you'd add an image that reproduces the remaining cuts. Drop it in (e.g.
`assets/demo/`) and point me at it — `scripts/check-coverage.js` will then give a
before/after number on the real failure rather than a synthetic one.
