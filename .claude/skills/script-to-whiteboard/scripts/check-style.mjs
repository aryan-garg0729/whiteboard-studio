#!/usr/bin/env node
/**
 * Measure a built project against the house style.
 *
 * The rules in references/style.md were derived by running these exact
 * measurements over examples/alchemy.json, so this script is both the output
 * check and the regression test for the rules themselves: run it on alchemy and
 * every number should land inside its own target band. If it ever does not, the
 * reference is wrong and should be re-measured rather than argued with.
 *
 * Usage: node check-style.mjs <project.json> [script.md]
 */

import { readFileSync } from 'node:fs';

/** Targets from references/style.md. */
const TARGET = {
  clipsPerMin: [15, 22],
  idleFraction: [0.12, 0.25],
  artTextRatio: [1.5, 3.0],
};

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

export function measure(project, script) {
  const clips = [...project.clips].sort((a, b) => a.start - b.start);
  if (!clips.length) throw new Error('project has no clips');

  const total = Math.max(...clips.map((c) => c.start + c.duration));

  // Idle = wall time with no clip drawing. Walk in start order tracking the
  // furthest end seen; a gap only counts when the next clip starts after it.
  let idle = 0;
  let end = 0;
  const gaps = [];
  for (const c of clips) {
    if (c.start > end) { idle += c.start - end; gaps.push({ at: end, len: +(c.start - end).toFixed(1) }); }
    end = Math.max(end, c.start + c.duration);
  }

  const kindOf = (c) => project.assets[c.assetId]?.kind;
  const text = clips.filter((c) => kindOf(c) === 'text');
  const art = clips.filter((c) => kindOf(c) !== 'text');

  const anims = {};
  for (const c of clips) anims[c.animId] = (anims[c.animId] ?? 0) + 1;

  // `appear.*` belongs on furniture -- the box that holds a caption, a marker
  // dropped onto a map -- and never on a beat's subject, because a picture that
  // simply appears breaks the illusion that a hand drew it. Containers and
  // small accent marks are the sanctioned exceptions; alchemy uses appear.pop
  // for a location pin and appear.slide for a checkbox, both correctly.
  const FURNITURE =
    /RedRectangle|DashedBox|YellowSticky|CloudBubble|HandDrawnLine|Icon|CheckBox|Arrow|Tick|Cross|Star/i;
  const appearMisuse = clips.filter((c) => c.animId.startsWith('appear.')
    && kindOf(c) !== 'text'
    && !FURNITURE.test(project.assets[c.assetId]?.src ?? ''));

  const out = {
    duration: +total.toFixed(1),
    clips: clips.length,
    pages: project.pages.length,
    clipsPerMin: +(clips.length / (total / 60)).toFixed(1),
    idleFraction: +(idle / total).toFixed(3),
    longestGap: gaps.length ? Math.max(...gaps.map((g) => g.len)) : 0,
    avgClipDuration: +(clips.reduce((s, c) => s + c.duration, 0) / clips.length).toFixed(2),
    art: art.length,
    text: text.length,
    artTextRatio: +(art.length / Math.max(1, text.length)).toFixed(2),
    anims,
    appearMisuse: appearMisuse.map((c) => project.assets[c.assetId].src.split('/').pop()),
  };

  if (script) {
    // How much of each caption is a contiguous run of script words. The style
    // is quotation, not paraphrase, so a low score here means captions were
    // invented rather than selected.
    const S = norm(script);
    const scores = text.map((c) => {
      const toks = norm(project.assets[c.assetId].text).split(' ');
      let best = 0;
      for (let i = 0; i < toks.length; i++) {
        for (let j = toks.length; j > i + best; j--) {
          if (S.includes(toks.slice(i, j).join(' '))) { best = j - i; break; }
        }
      }
      return { text: project.assets[c.assetId].text.replace(/\n/g, ' '), pct: best / toks.length };
    });
    out.captionsVerbatim = scores.filter((s) => s.pct === 1).length;
    out.captionsQuotedHalf = scores.filter((s) => s.pct >= 0.5).length;
    out.captionsInvented = scores.filter((s) => s.pct < 0.25).map((s) => s.text.slice(0, 40));

    const words = script.split(/\s+/).filter(Boolean).length;
    out.scriptWords = words;
    out.impliedWpm = +(words / (total / 60)).toFixed(1);
  }

  return out;
}

function verdict(m) {
  const rows = [];
  const check = (label, value, [lo, hi]) =>
    rows.push([value >= lo && value <= hi ? 'ok  ' : 'MISS', label, value, `${lo}–${hi}`]);
  check('clips per minute', m.clipsPerMin, TARGET.clipsPerMin);
  check('idle fraction', m.idleFraction, TARGET.idleFraction);
  check('art:text ratio', m.artTextRatio, TARGET.artTextRatio);
  return rows;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [projectPath, scriptPath] = process.argv.slice(2);
  if (!projectPath) {
    console.error('usage: check-style.mjs <project.json> [script.md]');
    process.exit(1);
  }
  const project = JSON.parse(readFileSync(projectPath, 'utf8'));
  const script = scriptPath ? readFileSync(scriptPath, 'utf8') : null;
  const m = measure(project, script);

  console.log(`${m.duration}s · ${m.clips} clips · ${m.pages} pages\n`);
  for (const [flag, label, value, band] of verdict(m)) {
    console.log(`  ${flag} ${label.padEnd(20)} ${String(value).padStart(6)}   target ${band}`);
  }
  console.log(`\n  art ${m.art} / text ${m.text} · avg clip ${m.avgClipDuration}s · longest gap ${m.longestGap}s`);
  console.log(`  animations: ${Object.entries(m.anims).map(([k, v]) => `${k} ${v}`).join(', ')}`);

  if (m.appearMisuse.length) {
    console.log(`\n  MISS appear.* on a beat's subject (${m.appearMisuse.length}):`);
    for (const s of m.appearMisuse) console.log(`       ${s}`);
  }
  if (script) {
    console.log(`\n  script ${m.scriptWords} words -> ${m.impliedWpm} wpm implied`);
    console.log(`  captions: ${m.captionsVerbatim} verbatim, ${m.captionsQuotedHalf}/${m.text} at least half quoted`);
    if (m.captionsInvented.length) {
      console.log(`  loosely derived (check these are deliberate):`);
      for (const t of m.captionsInvented) console.log(`       "${t}"`);
    }
  }
}
