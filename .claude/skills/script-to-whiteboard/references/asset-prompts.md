# Requesting new artwork

When no library asset fits a beat, the skill emits a generation request rather than settling for a bad
match. The user generates the image, drops it into the library, and the next run picks it up by filename.

## The house style template

Taken from `/home/aryan/Personal/yt/v3/asset_json.py`, which is the existing convention for this library.
Substitute the subject and change nothing else — consistency across 800 assets is the whole point.

```
black ink hand-drawn whiteboard doodle of {subject}, single centered subject, simple flat line art,
thick uniform strokes, bold clean outlines, minimal detail, no text, no background, light peach skin,
muted flat clothing/object colors, VideoScribe whiteboard animation style, clean closed paths suitable
for SVG tracing
```

`{subject}` is a short noun phrase in the voice of the existing catalogue: "a simple straight arrow pointing
right", "a check mark inside a hand-drawn circle", "an elevator with mirrored interior walls".

Two properties matter downstream and both come from the template: **flat colour with black linework** is
what `draw.inkPaint` assumes (a soft-gradient image has to fall back to `draw.stencilPaint`), and **no
background** keeps the paper showing through.

## Filenames

Follow the 30 curated short names (`GreenSackDollar.png`, `DashedBox.png`, `ClockAttention.png`), not the
761 bulk `_out.png` keyword-soup names: CamelCase, 2–4 words, most distinctive word first. The index
tokenises on capitals, so `CurlyBrace.png` is findable and `curlybrace.png` is not.

Target directory: `/home/aryan/Personal/yt/vid/assets/whiteboard_assets/`

## The report table

```markdown
| beat | subject | filename | prompt |
| --- | --- | --- | --- |
| 3.2 "a curly brace grouping three items" | a large hand-drawn curly brace bracket | `CurlyBrace.png` | black ink hand-drawn whiteboard doodle of a large hand-drawn curly brace bracket, single centered subject, … |
```

Order the table by how many beats need each asset — one file often serves several.

## Where the library is thin

Worth knowing before storyboarding, because it predicts what the missing list will contain.

The library is **overwhelmingly people and scenes**: 311 filenames contain "man", 181 "hand", 102 "woman",
83 "computer", 57 "desk". Emotional states are covered in depth (angry, worried, stressed, happy, confused),
as are workplace, money, vehicles, buildings, medical and crime scenes. A beat about a person feeling
something almost always has a match.

**Abstract primitives are nearly absent** — about a dozen files total: `DashedBox`, `RedRectangle`,
`RedArrow`, `CheckBox`, `HandDrawnLine`, `YellowStickyCutout` and a handful of icons. There are no braces,
no dividers, no arrows other than `RedArrow`, no chart frames, no comparison brackets. Expect these to
dominate every missing list.

`asset_json.py` already contains hand-written prompts for ~22 categories of exactly these primitives
(`utility/arrows`, `utility/marks`, `utility/containers`, `utility/charts`, plus finance, people,
psychology). It has never been run and the assets were never generated, but its rows are the best source of
`{subject}` phrasings — read it before inventing one.

## Two ways to avoid asking at all

Try both before adding to the missing list:

- **Mirror an existing asset.** `scaleX: -1` turns `RedArrow` into a left-pointing arrow with no new file.
  `scaleX`/`scaleY` also stretch containers to any aspect ratio, which is how one `RedRectangle` serves as
  both a one-line banner and a four-line box.
- **Draw it with `write_svg`.** The server takes SVG markup and returns a path usable as a `vector` asset,
  with no tracing step. Simple geometry — arrows, braces, boxes, dividers, axes, brackets — is better
  authored this way than generated. Keep paths simple: every subpath becomes one pen stroke, so a
  thousand-node trace looks frantic rather than drawn.

Reserve the missing list for what genuinely needs illustration: people, objects, scenes, brand-specific
things.
