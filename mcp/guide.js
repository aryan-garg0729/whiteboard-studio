/**
 * The authoring guide, served as an MCP resource.
 *
 * Written for a model rather than a person: it states the rules that are
 * errors, the conventions that make output look hand-made rather than
 * generated, and the two coordinate facts that otherwise have to be discovered
 * by rendering something and finding it missing.
 */

export const AUTHORING_GUIDE = `# Authoring whiteboard videos

A project is plain JSON. A hand draws artwork and writes captions onto sheets of
paper, one sheet at a time, and a camera can move over the sheet.

## The shape of a document

- **meta** — fps, width, height, background, handStyleId, showHand.
- **assets** — the material: an \`image\` (a file, drawn from its pixels), a
  \`vector\` (an SVG, used exactly as drawn), or \`text\` (a string plus a font).
  Text, font, fontSize, penWidth, colour and \`bold\` live on the *asset*, not the
  clip; use \`update_asset\` to reword a caption or set it in bold.
- **pages** — the sheets of paper, each with its own camera keyframes.
- **pageBreaks** — the *itinerary* over those sheets: when the composition
  leaves one for another. A sheet may be revisited, which is what makes "go back
  to page 1 and keep writing" expressible.
- **clips** — an asset drawn on a page, on a lane, from \`start\` for
  \`duration\` seconds, at a \`transform\`, with an optional \`erase\` sweep.
- **tracks** — timeline lanes. Pure layout; nothing in the renderer reads them.

## Coordinates — the two facts that catch everyone

1. **A clip's origin is its bounding-box corner, not its centre.** Setting
   \`transform: {x: 0, y: 0}\` does not centre a drawable; it puts the top-left
   of its ink at the middle of the frame.
2. **World (0,0) is the centre of the frame only while the camera is at the
   identity.** After a zoom or a pan, a clip placed at (0,0) is off screen.

\`add_clip\` and \`storyboard\` place clips for you when you do not pass a
transform — they compile the clip, measure it, and fit it to the frame. Prefer
that to guessing coordinates. When you do need numbers, \`get_project\` returns
every clip's world-space rect, plus warnings for anything off screen or
overlapping.

## Timing conventions

These are what the app does when a person clicks the same buttons. Matching them
is most of what makes a generated video feel authored:

- **A caption takes 0.16s per non-space character**, clamped to 1.6–12s. Short
  labels get a beat; a sentence gets time to be read as it is written.
- **Artwork takes about 4 seconds.**
- **A page transition is a 0.6s swipe.** A \`cut\` is instantaneous by
  definition and its duration is forced to 0.
- **Times snap to a tenth of a second.**
- An erase sweep runs about 1.5s and should start a beat after the ink lands.

## The rules that are errors, not warnings

An edit breaking any of these is rejected and the document is left untouched.
The message names the field and the conflict; read it rather than guessing.

1. **A clip may only draw while its own page is on screen** — checked per
   *visit*, not against the union of visits. A clip cannot draw across a gap
   where its page left and came back.
2. **The swiping interval belongs to neither page.** Nothing can be drawn while
   the paper is moving.
3. **Page breaks may not overlap.** A break cannot begin before the previous
   transition has landed.
4. **An erase may not begin before its clip has finished drawing.**
5. **A clip's lane must match its kind** — clips on clip tracks, audio on audio.

Two more the schema does not check but this server does: an animation must suit
the asset kind it is drawing (\`draw.handwrite\` is for text, \`draw.inkPaint\`
and \`draw.stencilPaint\` for pictures), and \`params\` must be keys the animation
actually has.

## Choosing an animation

- **\`draw.inkPaint\`** — **the default for pictures.** For artwork drawn the way
  a whiteboard illustration is drawn: shapes outlined in black, filled with flat
  colour. The pen inks the outline first by running down the middle of it, and
  the line appears at its real thickness; then each shape is coloured in turn.
  The finished frame is the source image exactly. Colours within
  \`colorTolerance\` count as one; \`inkLuma\` sets how dark a group must be to
  be treated as linework.
- **\`draw.stencilPaint\`** — the fallback, for pictures the default's assumption
  does not fit: a photograph, or a soft-gradient illustration with no linework
  and no flat areas. The pen paints across the artwork and the real picture
  appears underneath; nothing is assumed about it, and the finished frame is
  exact too. Two styles, via \`params.mode\`: \`zigzag\` (one diagonal sweep
  across the whole picture, with \`sweepAngle\` and \`sweepFrom\`) and
  \`colorGroups\` (one colour at a time, in \`groupOrder\`).
- **\`draw.handwrite\`** — the default for text. Traces real letterforms.
- **\`draw.textReveal\`** — writes text with a left-to-right reveal.
- **\`appear.instant\` / \`fade\` / \`pop\` / \`slide\`** — no pen at all. Use
  sparingly: a whiteboard video is a drawing, and something that simply appears
  breaks the illusion that a hand made it.

Handwriting fonts (Caveat, Patrick Hand, Indie Flower, Architects Daughter,
Permanent Marker) suit captions. The others read as a slide.

## Making artwork

You do not need image files. **\`write_svg\`** takes SVG markup and gives back a
path usable as a \`vector\` asset — the geometry is used exactly as written, with
no tracing step, so simple diagrams, arrows, boxes and icons are best authored
this way. Keep paths reasonably simple; every subpath becomes a pen stroke, and
a thousand-node trace looks frantic rather than drawn.

To use an image from elsewhere on disk, call \`import_asset\` first — the server
only reads from its own workspace.

## The workflow that works

1. \`list_capabilities\` once, to see what exists and whether ffmpeg is
   installed.
2. \`create_project\`.
3. \`storyboard\` with the whole script as beats. One call, a complete draft.
4. \`render_contact_sheet\` — the entire video as one image. Look at pacing and
   composition here, not frame by frame.
5. \`get_project\` — read the warnings; overlapping or off-screen clips are
   reported as measurements, not left for you to spot.
6. Refine with \`update_clip\`, \`update_asset\`, \`set_camera\`. Re-render single
   frames with \`render_frame\` to check a specific moment.
7. \`export_video\` (add \`scale: 0.5\` for a fast draft), then \`export_status\`.
`;
