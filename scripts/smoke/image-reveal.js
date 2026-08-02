/**
 * WB_SMOKE_SCRIPT: an image clip can be switched to the reveal, in the app.
 *
 * The engine tests pin what the reveal draws; this pins that the editor can
 * actually reach it -- the animation has to be registered, offered for an image
 * asset, and survive the rebuild that a structural edit triggers. The demo
 * project is deliberately still authored against `draw.outlineFill`, so this
 * also covers the legacy id continuing to load.
 *
 *   WB_SMOKE=/tmp/reveal.png \
 *   WB_SMOKE_PROJECT=demo.project.json \
 *   WB_SMOKE_SCRIPT=scripts/smoke/image-reveal.js \
 *   xvfb-run -a npx electron .
 */

const fail = (msg) => { throw new Error(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const state = () => window.__studioState();

const imageClip = state().clips.find((c) => {
  const asset = state().assets[c.assetId];
  return asset && asset.kind === 'image';
});
if (!imageClip) fail('the smoke project has no image clip');

// Select it, so the Inspector is showing this clip's animation picker.
const block = document.querySelector('.tl-clip.image');
if (!block) fail('no image clip in the timeline');
block.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
block.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
await sleep(80);

const select = document.querySelector('.insp select');
if (!select) fail('no animation picker for the selected clip');
const ids = [...select.options].map((o) => o.value);
if (!ids.includes('draw.imageReveal')) {
  fail(`the reveal is not offered for an image: ${ids.join(', ')}`);
}
if (select.value !== 'draw.outlineFill') {
  fail(`expected the demo project's own animation, got ${select.value}`);
}

// Switching is a structural edit: the clip is recompiled and re-traced.
select.value = 'draw.imageReveal';
select.dispatchEvent(new Event('change', { bubbles: true }));
await sleep(300);
if (state().clips.find((c) => c.id === imageClip.id) === undefined) fail('the clip vanished');

// The rebuild runs through the sidecar, so give it room, then check the stage
// actually painted something rather than blanking.
for (let i = 0; i < 100; i++) {
  if (!document.querySelector('.stage .busy, .overlay.busy')) break;
  await sleep(100);
}
await sleep(600);

const canvas = document.querySelector('.stage canvas');
if (!canvas) fail('no stage canvas');
const probe = document.createElement('canvas');
probe.width = canvas.width;
probe.height = canvas.height;
probe.getContext('2d').drawImage(canvas, 0, 0);
const d = probe.getContext('2d').getImageData(0, 0, probe.width, probe.height).data;
let painted = 0;
for (let i = 0; i < d.length; i += 4) {
  // Anything that is not the paper. The stage is 1080p, so sample sparsely.
  if (d[i] < 230 || d[i + 1] < 230 || d[i + 2] < 230) painted++;
  i += 4 * 16;
}
if (painted === 0) fail('the stage is blank after switching to the reveal');

return `switched ${imageClip.id} to draw.imageReveal; ${painted} non-paper samples on the stage`;
