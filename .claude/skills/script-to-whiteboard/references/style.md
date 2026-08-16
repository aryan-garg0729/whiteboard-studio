# The house style

Every number here was measured from `examples/alchemy.json` (356s, 13 pages, 108 clips) and its script
`examples/alchemy.md` (1062 words). They are targets to hit, not trivia.

## Density and pacing

| Quantity | Value |
| --- | --- |
| Clips per minute | **18.2** — aim for 15–22 |
| Clip duration | avg 2.6s, median 2.2s, range 0.2–9s |
| Idle time (nothing drawing) | **20.1%** — aim 15–20% |
| Idle distribution | 56 gaps, only 17 over 1.5s, longest 4.4s |
| Page length | 8–46s, typically ~30s ≈ 9 clips |

Idle time is many short breaths, not dead air. It accumulates on connective sentences and just before a
page turn, where the finished drawing sits on screen while the narrator moves the argument along.

## Narration pace

**176 wpm = 0.34 seconds per word.** Timestamp every word in the script at this rate and any phrase can be
located on the timeline.

A caption's clip starts **0.5–1s before its phrase is spoken**; the handwrite then runs across the phrase so
the ink finishes as the sentence lands. Art behaves the same way — the picture is being drawn while it is
being described, never after.

A uniform-pace estimate drifts against a real recording: it tracked within ~3s over the first half of
alchemy and ~7–11s by the end. Say so in the handoff. These timings are a scaffold for the user to drag,
not a finished edit.

## Pages follow paragraphs

All 11 of alchemy's page breaks land on a script paragraph boundary. 19 paragraphs became 12 page segments:

- One page per paragraph.
- A one-line section-header paragraph ("Two. Small interventions beat big ones.") **merges forward** into
  the paragraph it introduces.
- Split anything over ~45s.

Transitions are always 0.6s. `swipeLeft` for a continuation — that is the default and the majority.
`swipeUp` / `swipeDown` to mark a bigger shift, typically into a new numbered section.

## Art versus text

**74 art clips to 34 text clips — roughly 2:1.** Text is a co-equal visual element, not a label. Art carries
the anecdote; text carries the thesis.

Choose text when the beat is a **proposition** — a statistic, a lesson, a comparison of two abstractions
(`Psychology` vs `Logic`, `MATH` vs `Psychology`). Choose art when the beat has a **concrete noun** to draw
— a train, an elevator, a doctor, a person feeling something. When both are available, art wins and the text
becomes a short callout beside it.

Roughly one script sentence in three produces no clip at all.

## Animations

| animId | Count | When |
| --- | --- | --- |
| `draw.inkPaint` | 55 | **The default for artwork.** Flat-colour line art. |
| `draw.handwrite` | 33 | **The default for text.** Always. |
| `draw.stencilPaint` | 11 | Photographs, book covers, logos — anything not flat line art. |
| `appear.fade` / `instant` / `pop` / `slide` | 9 | Containers, and almost nothing else. |

Never use `appear.*` for the subject of a beat. A whiteboard video is a drawing; something that simply
appears breaks the illusion. Its legitimate use is the box that holds a caption, where the pen drawing a
rectangle would waste a second.

Useful `params`, all optional:
- `draw.inkPaint`: `groupOrder` (`largestFirst` default, `darkFirst`, `readingOrder`), `inkWidthGain`,
  `outlineShare`, `colorTolerance`, `sweepAngle`. `readingOrder` suits a picture with a natural left-to-right
  story; `darkFirst` suits a portrait where the linework should land before the colour.
- `draw.stencilPaint`: `mode` (`zigzag` default, `colorGroups`), `sweepAngle`, `groupOrder`.
- `draw.handwrite`: none.

## Text styling

- **Always `fontSize: 120, penWidth: 5`.** Apparent size comes from `transform.scale`, 0.26–0.57. A long
  paragraph gets a small scale; a single shouted word gets a large one.
- 1–6 lines, average 6.4 words. Break lines with `\n` **by meaning, not by width** — "People wouldn't have\n
  wanted the train to go faster\nThey'd have wanted it to\ngo slower".
- **Print faces for the narrator's voice**: Poppins (13 uses), Open Sans (10). Section headers and thesis
  statements.
- **Hand faces for in-world text**: Indie Flower (4), Architects Daughter (4), Caveat, Patrick Hand. A
  thought inside a bubble, a scrawled number, a character's line of dialogue, a sum being worked out.
- Playfair Display appears once, for `MATH` — a print face used to make a concept look institutional.

Fonts live at `/home/aryan/Personal/yt/v3/assets/fonts/<Name>.ttf`:
`Poppins`, `OpenSans`, `Montserrat`, `PlayfairDisplay`, `Caveat`, `PatrickHand-Regular`,
`IndieFlower-Regular`, `ArchitectsDaughter-Regular`, `PermanentMarker`.

### Colour

One saturated accent per callout, and never the same accent twice in a row:

`#ff2424` `#fe2a2a` `#ff0000` red · `#6524ff` purple · `#00a83b` green · `#ff5900` `#ff6a38` orange ·
`#e60063` pink · `#5b6cec` blue · `#3b076e` deep purple

`#ffffff` **only** on a red banner. `#000000` / `#1a1a1a` for in-scene labels, sums and dialogue.

## The container-then-text motif

The single most repeated device — 17 occurrences. A container is drawn **fast** (0.4–1.0s), the caption
starts within 0–2.7s of it, and the caption's corner sits roughly **+100…+350 in x and +180…+400 in y**
from the container's corner. Containers are stretched to fit the text block with `scaleX` / `scaleY`
anywhere in 0.30–3.17 — they are elastic, unlike artwork.

| Container | Meaning | Caption style |
| --- | --- | --- |
| `RedRectangle` | **Numbered section header.** Top-left of a fresh page, always the page's first clip. | white bold Poppins, e.g. `1. Perception is Reality` |
| `DashedBox` | Mid-page callout or definition | accent colour, print face |
| `YellowStickyCutout` | An aside or a punchline sticky | accent colour, print face |
| `CloudBubbleThinking` | A character's thought — place it beside the person | hand face, `#1a1a1a` |

## Repetition as quantity

Assets are reused freely and deliberately: `RedRectangle` ×7, `DashedBox` ×5, `RedArrow` /
`CloudBubbleThinking` / `GreenSackDollar` / `BankNotes…` ×3 each. Drawing the same money sack three times in
a row, at slightly different positions and scales, is how the style says "a lot of money" — reach for that
before hunting a new asset.

## Camera

Used sparingly: only 4 of 13 pages move at all. Two shapes:
- A **zoom-in on a punchline**: arrive at zoom ~2.0–2.3, hold ~2s, pull back out.
- A **pan to a second composition area** on a page wider than the frame.

`set_camera` plants a hold keyframe `moveDuration` earlier so the move *arrives* at `t` — the camera is
settled when the pen lands, rather than creeping for the whole video. Aim for 2–4 moves in a 6-minute video.

## Erase

Rare — 2 clips of 108. Its one good use is swapping a caption for its opposite in the same spot:
"How do we reduce quantity of time?" is erased and "How do we improve quality of time?" is written over it.
An erase must begin after its clip has finished drawing, and runs ~1.5s.

## Project meta

```json
{ "fps": 30, "width": 1920, "height": 1080,
  "background": "#fdfdfb", "handStyleId": "hand3", "showHand": true }
```
