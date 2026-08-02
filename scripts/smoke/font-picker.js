/**
 * WB_SMOKE_SCRIPT: the Text tab offers the bundled faces, each set in its own.
 *
 * The picker is worth checking headlessly because its whole value is visual and
 * two failures are silent: a face whose bytes never load falls back to the UI
 * font and still looks like a perfectly good row, and a manifest entry the
 * parser rejects simply disappears from the list.
 *
 *   WB_SMOKE=/tmp/fonts.png \
 *   WB_SMOKE_PROJECT=demo.project.json \
 *   WB_SMOKE_SCRIPT=scripts/smoke/font-picker.js \
 *   xvfb-run -a npx electron .
 */

const fail = (msg) => { throw new Error(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const textTab = [...document.querySelectorAll('.tabs button')]
  .find((b) => b.textContent.trim() === 'Text');
if (!textTab) fail('no Text tab');
textTab.click();
await sleep(400);                      // the faces load over IPC, one file each

const rows = [...document.querySelectorAll('.font-list button')];
if (rows.length < 5 || rows.length > 12) {
  fail(`the picker should offer a short curated set, got ${rows.length}`);
}

const manifest = await window.studio.listFonts();
const names = rows.map((r) => r.firstChild.textContent.trim());
if (names.join('|') !== manifest.map((f) => f.family).join('|')) {
  fail(`rows ${names.join(', ')} do not match the manifest`);
}

// Each row must be drawn in the face it offers, not in the UI font.
for (const row of rows) {
  const fam = getComputedStyle(row).fontFamily;
  if (!fam.startsWith('sf-') && !fam.startsWith('"sf-')) {
    fail(`"${row.textContent.trim()}" is set in ${fam}, so its bytes never loaded`);
  }
  if (!document.fonts.check(`16px ${fam}`)) fail(`${fam} is registered but not loaded`);
}

// Handwriting first: it is what the tool is for, and what the tag marks.
if (!rows[0].querySelector('.hand-tag')) fail('the default face is not a script face');

// Picking one arms the draft, which is what "Add text clip" then uses.
rows[1].click();
await sleep(60);
if (document.querySelector('.font-list button[aria-selected="true"]') !== rows[1]) {
  fail('clicking a face did not select it');
}

// ── the Inspector's picker re-faces a clip that already exists ──
// The Library's copy only arms the *next* clip. Changing the face of a line
// already on the timeline is the more common want, and it goes through
// patchAsset, which is structural -- the clip is laid out and traced again.
const state = () => window.__studioState();
const textAsset = Object.entries(state().assets).find(([, a]) => a.kind === 'text');
if (!textAsset) fail('the smoke project has no text clip to re-face');
const [assetId] = textAsset;

const block = document.querySelector('.tl-clip.text');
if (!block) fail('no text clip in the timeline');
block.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
block.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
await sleep(80);

const head = document.querySelector('.font-pick-head');
if (!head) fail('selecting a text clip did not show the face picker');
if (document.querySelector('.font-pick-menu')) fail('the picker starts open');

const before = state().assets[assetId].font;
head.click();
await sleep(60);
const menu = [...document.querySelectorAll('.font-pick-menu .font-list button')];
if (menu.length !== rows.length) fail('the Inspector offers a different set of faces');

// Not merely "different from `before`": a clip with no font of its own is
// already written in the first face, so picking that one would assert nothing.
const wanted = manifest.find((f) => f.path !== (before ?? manifest[0].path));
menu[manifest.findIndex((f) => f.path === wanted.path)].click();
await sleep(150);
if (state().assets[assetId].font !== wanted.path) {
  fail(`the clip still writes in ${state().assets[assetId].font}`);
}
if (document.querySelector('.font-pick-menu')) fail('the list stayed open after a pick');
const closed = document.querySelector('.font-pick-head');
if (!closed.textContent.includes(wanted.family)) {
  fail('the closed picker does not read back the face it just set');
}
if (closed.querySelector('.hand-tag')?.textContent === 'default') {
  fail('the clip has its own face now, so it must not claim to be the default');
}

// Reported by the runner as `[script] ...`, so a silent no-op is visible: an
// `undefined` here means the script returned before it asserted anything.
// The runner wraps this in an async IIFE, so it is `return`, not a trailing
// expression, that reaches the log.
return `${rows.length} faces offered; re-faced ${assetId} as ${wanted.family}`;
