/**
 * WB_SMOKE_SCRIPT: the Text tab offers the bundled faces, each set in its own.
 *
 * The picker is worth checking headlessly because its whole value is visual and
 * two failures are silent: a face whose bytes never load falls back to the UI
 * font and still looks like a perfectly good row, and a manifest entry the
 * parser rejects simply disappears from the list.
 *
 *   WB_SMOKE=/tmp/fonts.png \
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
