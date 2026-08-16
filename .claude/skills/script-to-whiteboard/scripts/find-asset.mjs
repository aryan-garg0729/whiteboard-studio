#!/usr/bin/env node
/**
 * Rank the art library against a beat's concept.
 *
 * Plain token overlap is not good enough here. The bulk files carry twenty
 * keywords each, so they match almost any query on sheer surface area, and the
 * words they all share (`man`, `woman`, `hand`, `happy`) are the ones that
 * distinguish nothing. So scoring is IDF-weighted -- a rare word like `elevator`
 * or `champagne` is worth many times a common one -- and normalised by the
 * length of the filename, which stops the soup from winning by volume.
 *
 * The ranking is a shortlist, not an answer. Filenames lie often enough that
 * the skill is required to render the top candidates and look at them before
 * committing; see SKILL.md, phase 2.
 *
 * Usage:
 *   node find-asset.mjs "worried man money debt"
 *   node find-asset.mjs --json --limit 12 "elevator mirror"
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { INDEX_PATH, build, stale, tokenize } from './build-asset-index.mjs';

/**
 * Query words the library spells differently.
 *
 * Deliberately tiny: it covers the mismatches that actually bit during
 * development, not an invented thesaurus. A wrong synonym is worse than a
 * missing one, because it quietly promotes the wrong picture.
 */
const ALIAS = {
  car: ['car', 'vehicle', 'auto'],
  money: ['money', 'cash', 'dollar', 'finance', 'coins'],
  phone: ['phone', 'mobile', 'smartphone'],
  worried: ['worried', 'worry', 'anxious', 'unsure'],
  happy: ['happy', 'smile', 'smiling', 'laugh'],
  angry: ['angry', 'annoyed', 'grumpy', 'cross'],
  sad: ['sad', 'unhappy', 'glum', 'miserable'],
  thinking: ['thinking', 'think', 'ponder', 'consider', 'hmm'],
  talk: ['talk', 'speech', 'conversation', 'speak'],
  doctor: ['doctor', 'medicine', 'medical', 'nurse'],
  boss: ['boss', 'manager', 'ceo', 'chairman'],
  meeting: ['meeting', 'boardroom', 'presentation'],
  chart: ['chart', 'graph', 'data', 'statistics'],
};

export function loadIndex() {
  if (stale()) {
    const index = build();
    mkdirSync(dirname(INDEX_PATH), { recursive: true });
    writeFileSync(INDEX_PATH, JSON.stringify(index));
    return index;
  }
  return JSON.parse(readFileSync(INDEX_PATH, 'utf8'));
}

/** How surprising each token is, over the whole library. */
function idf(entries) {
  const df = new Map();
  for (const e of entries) for (const t of e.tokens) df.set(t, (df.get(t) ?? 0) + 1);
  const n = entries.length;
  const out = new Map();
  for (const [t, c] of df) out.set(t, Math.log(n / c));
  return out;
}

export function search(query, { index = loadIndex(), limit = 9 } = {}) {
  // One group per query word. A group scores at most once however many of its
  // synonyms hit -- otherwise `thinking`, which expands to five variants, would
  // outweigh `brain`, which expands to one, and the thought-bubble crowd would
  // bury the picture of a brain.
  const groups = [...new Set(tokenize(query.replace(/\s+/g, '-')))]
    .map((t) => ALIAS[t] ?? [t]);
  const weights = idf(index.entries);
  // An unseen query word is as rare as it gets; scoring it zero would make a
  // precise query ("champagne") behave like an empty one.
  const maxIdf = Math.log(index.entries.length);
  const weight = (t) => weights.get(t) ?? maxIdf;

  const scored = [];
  for (const e of index.entries) {
    const have = new Set(e.tokens);
    const stem = e.stem.toLowerCase();
    let hits = 0;
    let raw = 0;
    for (const group of groups) {
      let best = 0;
      for (const t of group) {
        if (have.has(t)) best = Math.max(best, weight(t));
        // Lowercase-only filenames never split into tokens, and plurals/tenses
        // ("bills" vs "bill") miss an exact match; a substring hit is real but
        // weaker than a word-boundary one.
        else if (stem.includes(t)) best = Math.max(best, weight(t) * 0.5);
      }
      // The first variant is the word the caller actually typed; a synonym hit
      // is a guess on our part and should not rank above the literal term.
      if (best) { raw += have.has(group[0]) ? best : best * 0.85; hits++; }
    }
    if (!hits) continue;
    // Divide by the square root rather than the count: a long name that hits
    // three query words is genuinely better than a short one that hits one,
    // but not proportionally so.
    //
    // The curated bonus only applies from two hits up. The thirty short names
    // are short, so a single generic token ("person") is most of their filename
    // and the bonus would float `PersonComputer` to the top of every query
    // mentioning a person.
    const score = raw / Math.sqrt(e.tokens.length) * (e.curated && hits > 1 ? 1.35 : 1);
    scored.push({ ...e, hits, score });
  }

  return scored
    .sort((a, b) => b.score - a.score || b.hits - a.hits)
    .slice(0, limit)
    .map((e) => ({
      stem: e.stem, path: e.path, kind: e.kind, svgPath: e.svgPath,
      curated: e.curated, hits: e.hits, score: Math.round(e.score * 100) / 100,
      // Judge by weighted score, not hit count: one hit on a rare word
      // ("champagne", "elevator") identifies a picture, while three hits on
      // common ones ("man", "happy", "hand") identify nothing. The threshold is
      // where hand-checking against the alchemy concepts put the boundary.
      weak: e.score < 2.5,
    }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const li = args.indexOf('--limit');
  const limit = li >= 0 ? Number(args[li + 1]) : 9;
  const query = args.filter((a, i) =>
    !a.startsWith('--') && !(li >= 0 && i === li + 1)).join(' ');

  if (!query) {
    console.error('usage: find-asset.mjs [--json] [--limit N] "<concept words>"');
    process.exit(1);
  }
  const hits = search(query, { limit });
  if (json) {
    console.log(JSON.stringify(hits, null, 2));
  } else if (!hits.length) {
    console.log(`no candidates for "${query}" — this one needs new artwork`);
  } else {
    for (const [i, h] of hits.entries()) {
      const flags = `${h.curated ? '*' : ' '}${h.weak ? '?' : ' '}`;
      console.log(`${String(i + 1).padStart(2)}. ${String(h.score).padStart(6)} ${flags} ${h.stem}`);
      console.log(`      ${h.path}`);
    }
    if (hits.every((h) => h.weak)) {
      console.log('\n  every candidate is weak (?) — likely needs new artwork');
    }
    console.log('\n  * curated short name   ? weak match — render it before trusting it');
  }
}
