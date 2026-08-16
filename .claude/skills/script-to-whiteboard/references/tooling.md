# Driving the studio

The authoritative document is the server's own guide, MCP resource
`whiteboard://guide/authoring` (source: `/home/aryan/Personal/yt/v3/mcp/guide.js`). Read it once per
session. This file covers only what that guide does not: the layout maths this style needs, and the call
sequence for a multi-element page.

## Why not `storyboard`

`storyboard` is the server's one-call entry point and it is the wrong tool here. It lays a beat out as a
caption in the top 26% band with artwork underneath — one or two elements per frame. The house style puts
**6–15 elements in one composition** (see `references/worked-example.md`). Likewise `add_clip` without a
transform centres every drawable in the frame, so a page built that way is a single stack.

So: **`add_clip` with an explicit `transform`, one call per beat.**

`storyboard` is still useful for a throwaway scratch project when previewing candidate artwork.

## Coordinates

- World `(0,0)` is the centre of the frame **at the identity camera**. Visible extent is therefore
  x ∈ [−960, 960], y ∈ [−540, 540] for a 1920×1080 project.
- **`transform.x` / `y` place the bounding-box top-left corner, not the centre.** This is the mistake that
  costs an hour. `{x: 0, y: 0}` puts the corner of the ink at frame centre, pushing the drawable down-right.
- `scaleX` / `scaleY` multiply `scale`, one axis each. `1` keeps proportions, `0.6` squeezes, **negative
  mirrors** — a right-pointing arrow becomes left-pointing with `scaleX: -1`, no second asset needed.
- `rotation` is degrees clockwise about that same corner, so it swings the drawable away from where it was
  unless `x`/`y` compensate.

## The slot grid

Lay each page out on a **3 × 2** grid over the visible extent. Slots are 640 × 540 world units:

```
        x: -960…-320   -320…320    320…960
y: -540      TL           TC          TR
y:    0      BL           BC          BR
```

Two rows, not three. Measured across alchemy's 69 raster clips, artwork averages **29% of frame width and
45% of frame height**; a 3×3 grid caps a square drawable at 29% of frame height and produces a page of
postage stamps. A 540-tall slot at the fill below gives 43%, which is the right size.

To fit a drawable of size `bboxW × bboxH` into a slot:

```js
const FILL = 0.86;                                   // matches the server's own band fill
const scale = Math.min(slotW / bboxW, slotH / bboxH, 1) * FILL;
const x = Math.round(slotLeft + (slotW - bboxW * scale) / 2);   // corner, not centre
const y = Math.round(slotTop  + (slotH - bboxH * scale) / 2);
```

Never scale a raster or text **above 1** — it goes soft. Vectors may grow.

An element may span two slots — widen `slotW` / `slotH` accordingly. An anchor drawing that carries a whole
paragraph (alchemy's 9-second train) spans both rows in one column. Captions are laid out the same way but
land smaller, ~20–30% of frame height, which is what leaves room for artwork above them.

Real pages are not grid-locked; alchemy's coordinates are hand-nudged. The grid exists to stop a generated
page collapsing into a pile, and step 5 below fixes the rest.

### Estimating `bbox` without compiling

Passing an explicit transform means knowing the drawable's size before the server measures it. Both formulas
below were checked against `get_project` rects.

**Artwork** — the PNG's pixel dimensions *are* its bbox, exactly. Read them without loading the file:

```bash
file /path/to/Asset.png     # -> PNG image data, 600 x 600, 8-bit/color RGBA
```

**Text** — from the metrics of the 120px face the style always uses:

```js
const lines  = text.split('\n');
const bboxW  = Math.max(...lines.map((l) => l.length)) * fontSize * 0.53;
const bboxH  = fontSize * (1.35 * lines.length + 1.5);
```

The height formula is **exact** for Poppins at 120px (verified at 1, 2 and 3 lines: 342, 504, 666). The
width is within ±10% — it depends on which letters, so a line of capitals runs wide and a line of `i`s runs
narrow. That is fine: `get_project` reports the true rect afterwards and only outliers need correcting.

Note the height is much larger than the visible ink — a single line occupies 2.85 × fontSize because the box
includes the font's full vertical metrics. Sizing a caption as though one line were 1.25 em makes every
caption a third too big.

## Call sequence

1. **`list_capabilities`** — once. Confirms the animation vocabulary and whether ffmpeg/whisper exist.
2. **`create_project`** — `{fps: 30, width: 1920, height: 1080, background: '#fdfdfb', handStyleId: 'hand3', showHand: true}`.
3. **`import_asset`** for every matched path, once each. The server reads only from `mcp-workspace/`, so an
   absolute path into the art library must be copied in first. Keep the original → workspace mapping for the
   report.
4. **Per page**: `add_page` (omit for the first page — the project already opens on one), then one
   `add_clip` per beat with `duration`, `animId`, `transform` and `params`.

   **`add_clip` has no `start` parameter.** It appends: the new clip begins where everything authored so far
   ends. Since ~20% idle time is part of the style, the beat sheet's start times will not match the appended
   ones, so each clip needs a following `update_clip` with its real `start`. Budget two calls per beat and
   author in time order.

5. **`get_project`** — returns every clip's world rect plus warnings: clips extending outside the frame, and
   pairs of clips on the same page whose *visible* intervals overlap. Fix real collisions with
   `update_clip`. Two warnings to read past:
   - "extends outside the frame" is computed against the **identity camera**; a clip that belongs to a
     panned region is correctly placed and correctly warned about.
   - Overlap counts ink as visible until erased, so a container and the caption inside it always overlap.
     That is the motif working, not a bug.
6. **`set_camera`** for the 2–4 moves the video wants. `moveDuration: 1` and the move *arrives* at `t`.
7. **`render_contact_sheet`** with `count: 12`–`25` and **look at it**. Pacing and collisions live here;
   `render_frame` is for one specific moment.

## Two traps found the hard way

**Font paths must be absolute.** `add_clip`'s `font` resolves relative paths against `mcp-workspace/`, not
against the repo, so `assets/fonts/Poppins.ttf` becomes `mcp-workspace/assets/fonts/Poppins.ttf` and fails.
Always pass the full path:

```
/home/aryan/Personal/yt/v3/assets/fonts/Poppins.ttf
```

**A failed `add_clip` is not rolled back.** Despite the documented transactional guarantee, an `add_clip`
that throws while compiling still leaves its asset and clip in the saved document — and because every later
call recompiles, the bad asset then poisons *everything*, including `get_project`, with the same error.

Recovery: `remove_clip` the offending clip. It deletes the orphaned asset with it and the project opens
again. Note the clip id from the error context, or read `mcp-workspace/<name>.project.json` directly to find
it. The lesson for the skill is to get the font path right the first time.

## Rules that are errors, not warnings

An edit breaking one of these is rejected and the document left untouched:

1. A clip may only draw while its own page is on screen — checked per *visit*, so a clip cannot draw across
   a gap where its page left and came back.
2. Nothing can be drawn during the 0.6s swipe. The transition belongs to neither page.
3. Page breaks may not overlap.
4. An erase may not begin before its clip has finished drawing.
5. Clips go on `clip` lanes, audio on `audio` lanes.

Two more the MCP layer enforces: an `animId` must suit the asset kind (`draw.handwrite` for text only;
`draw.inkPaint` / `draw.stencilPaint` for pictures only), and `params` keys must exist on that animation —
an unknown key is an error, not a silent no-op.

## Where the skill stops

Do **not** call `add_audio`, `transcribe_audio`, `set_subtitles` or `export_video`. Timings in the delivered
project are estimated from word counts against a recording that does not exist yet. The user re-times in the
Electron UI, then adds the voiceover, subtitles and export themselves.
