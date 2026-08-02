# Close the last cuts
## Context

One issue, from using the tool after the reveal landed.

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

## 2. Verification

- `node --test test/` — plus new pins:
  - `test/coverage.test.js`: an asset whose plan deliberately misses part of its artwork (a
    region the plan has no geometry for) ends up **fully** revealed after
    `closeCoverageGaps`; stamps land on the nearest stroke; running it twice is idempotent;
    it is skipped for photo-mode art.
- **New `scripts/check-coverage.js <image> [--anim …]`** — traces an image, runs the plan to
  `u=1`, and prints the percentage of inked pixels never revealed plus a `missing.png` map.
  This is the tool for the repro image: run it before and after and quote the number.

---


## Open item for next session

You said you'd add an image that reproduces the remaining cuts. Drop it in (e.g.
`assets/demo/`) and point me at it — `scripts/check-coverage.js` will then give a
before/after number on the real failure rather than a synthetic one.
