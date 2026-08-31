#!/usr/bin/env node
/* Paywall exposure audit — measures how much paid course prose is readable
 * in this repository's public source.
 *
 * functions/_middleware.js strips every `.gated-content` region from the HTML
 * before it leaves the edge for a visitor who is not authorized for that page
 * (see authorizeResource()). That gate works. It does nothing at all about the
 * fact that the same lesson bodies sit verbatim in four .html files that
 * anyone can read on GitHub, clone, or pull out of git history.
 *
 * This tool quantifies that: per page and site-wide it reports how many
 * lessons are gated, how many words and bytes of paid prose are in public
 * source, how many of the twelve worked cases are exposed, and — separately —
 * any paid lesson markup sitting OUTSIDE a gated region, which would be
 * readable even by a correctly-served anonymous visitor over HTTPS.
 *
 * The two failures are different in kind:
 *   - paid prose inside a gated region  -> exposed by the repo (a hosting /
 *     distribution decision; see docs/PAYWALL.md). Reported, not a failure.
 *   - paid prose outside a gated region -> exposed by the site itself. This
 *     is a live paywall hole and exits non-zero.
 *
 * Usage: node tools/paywall-audit.mjs [--json] [--root <dir>]
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// ---------------------------------------------------------------------------
// Tokenizer / depth tracker
//
// Same shape the middleware's HTMLRewriter selector match has to have: find an
// opening tag, then walk forward counting opens and closes of that tag name
// until the depth returns to zero. Deliberately not a full parser — the course
// pages are machine-uniform, well-formed markup with no unclosed <details> or
// <section>, which is what these regions are built from.
// ---------------------------------------------------------------------------
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);
const TOKEN_RE = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s+[^<>]*?)?\/?>/gi;

export function tagName(tag) {
  const m = tag.match(/^<\/?\s*([a-zA-Z0-9-]+)/);
  return m ? m[1].toLowerCase() : null;
}
export function classesOf(tag) {
  const m = tag.match(/\sclass\s*=\s*("([^"]*)"|'([^']*)')/i);
  return (m ? (m[2] ?? m[3] ?? '') : '').split(/\s+/).filter(Boolean);
}
function isOpen(tag) { return !tag.startsWith('</') && !tag.startsWith('<!'); }
function isSelfClosing(tag) { return /\/>\s*$/.test(tag) || VOID_ELEMENTS.has(tagName(tag)); }

/**
 * Every region whose opening tag satisfies `match(tag)`, as byte-index spans.
 * Nested matches inside an already-open region are folded into the outer one,
 * which is what the middleware effectively does (the outer strip removes them).
 * @returns {{start:number,end:number,innerStart:number,innerEnd:number,tag:string}[]}
 */
export function findRegions(html, match) {
  const regions = [];
  let open = null; // { name, depth, start, innerStart, tag }
  TOKEN_RE.lastIndex = 0;
  for (const m of html.matchAll(TOKEN_RE)) {
    const tag = m[0];
    if (tag.startsWith('<!')) continue;
    const name = tagName(tag);
    if (!name) continue;
    if (open) {
      if (name !== open.name) continue;
      if (isOpen(tag)) { if (!isSelfClosing(tag)) open.depth += 1; continue; }
      open.depth -= 1;
      if (open.depth === 0) {
        regions.push({
          start: open.start,
          end: m.index + tag.length,
          innerStart: open.innerStart,
          innerEnd: m.index,
          tag: open.tag,
        });
        open = null;
      }
      continue;
    }
    if (!isOpen(tag) || isSelfClosing(tag) || !match(tag)) continue;
    open = { name, depth: 1, start: m.index, innerStart: m.index + tag.length, tag };
  }
  return regions;
}

export const hasClass = (cls) => (tag) => classesOf(tag).includes(cls);
const inAny = (regions, i) => regions.some((r) => i >= r.start && i < r.end);

// ---------------------------------------------------------------------------
// What counts as paid
// ---------------------------------------------------------------------------

/** A lesson: the <details class="lesson-card"> unit the course pages are built from. */
const LESSON_RE = /<details\b[^>]*\bclass="[^"]*\blesson-card\b[^"]*"[^>]*>/gi;

/**
 * A worked case: the twelve long-form, fully-computed examples that are the
 * most expensive thing on the site to reproduce. Two markups are in use — an
 * `.extra` callout label, and a lesson whose number is "W.".
 */
const WORKED_RE = /<span class="label">\s*Worked case|<span class="lnum">W\.<\/span>\s*Worked case/gi;

/**
 * Course content the owner has decided is free, so it is paid-looking markup
 * that is legitimately outside a gated region (tests/regressions.test.mjs:
 * futures Level 1 and the psychology essay, and nothing else).
 */
export const FREE_REGIONS = {
  'futures-dissection.html': (tag) =>
    hasClass('level-panel')(tag) && /data-level="1"/.test(tag) && /data-pair="futures"/.test(tag),
  'psychology-enhancer.html': (tag) => hasClass('essay')(tag),
};

/**
 * The pages the middleware gates, read out of the middleware itself so this
 * tool cannot drift from the thing it is auditing.
 */
export function gatedPages(root = ROOT, read = (p) => readFileSync(join(root, p), 'utf8')) {
  const src = read(join('functions', '_middleware.js'));
  const block = src.match(/GATED_PAGES\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
  if (!block) throw new Error('could not read GATED_PAGES out of functions/_middleware.js');
  const files = new Set();
  for (const m of block[1].matchAll(/'([^']+)'/g)) {
    const p = m[1].replace(/^\//, '');
    files.add(p.endsWith('.html') ? p : `${p}.html`);
  }
  return [...files].filter((f) => existsSync(join(root, f))).sort();
}

// ---------------------------------------------------------------------------
// Prose measurement
// ---------------------------------------------------------------------------
const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”' };

/** Visible prose of an HTML fragment: scripts, styles and markup removed. */
export function textOf(fragment) {
  return fragment
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : ' ';
      }
      return ENTITY[e.toLowerCase()] ?? ' ';
    })
    .replace(/\s+/g, ' ')
    .trim();
}
// A word is a token containing at least one letter or digit, so a spaced em
// dash or a lone bullet does not inflate the figure quoted in docs/PAYWALL.md.
export const wordCount = (text) => (text ? text.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t)).length : 0);
const bytes = (s) => Buffer.byteLength(s, 'utf8');

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/**
 * Audit one page.
 * @param {string} path  page path, used to look up its free-content exemption
 * @param {string} html  raw source as it sits in the repository
 */
export function auditPage(path, html) {
  const gated = findRegions(html, hasClass('gated-content'));
  const freeMatch = FREE_REGIONS[path];
  const free = freeMatch ? findRegions(html, freeMatch) : [];

  const gatedText = gated.map((r) => textOf(html.slice(r.innerStart, r.innerEnd)));
  const paidWords = gatedText.reduce((a, t) => a + wordCount(t), 0);
  const paidBytes = gated.reduce((a, r) => a + bytes(html.slice(r.start, r.end)), 0);

  const lessons = { gated: 0, free: 0, exposed: [] };
  for (const m of html.matchAll(LESSON_RE)) {
    if (inAny(gated, m.index)) { lessons.gated += 1; continue; }
    if (inAny(free, m.index)) { lessons.free += 1; continue; }
    const id = m[0].match(/\bid="([^"]+)"/)?.[1] ?? `offset ${m.index}`;
    lessons.exposed.push(id);
  }

  const worked = { gated: 0, free: 0, exposed: 0 };
  for (const m of html.matchAll(WORKED_RE)) {
    if (inAny(gated, m.index)) worked.gated += 1;
    else if (inAny(free, m.index)) worked.free += 1;
    else worked.exposed += 1;
  }

  return {
    path,
    bytes: bytes(html),
    gatedRegions: gated.length,
    lessonsGated: lessons.gated,
    lessonsFree: lessons.free,
    lessonsExposed: lessons.exposed,
    workedGated: worked.gated,
    workedFree: worked.free,
    workedExposed: worked.exposed,
    paidWords,
    paidBytes,
  };
}

export function auditSite(root = ROOT, read = (p) => readFileSync(join(root, p), 'utf8')) {
  const pages = gatedPages(root, read);
  const rows = pages.map((p) => auditPage(p, read(p)));
  const totals = rows.reduce((a, r) => ({
    bytes: a.bytes + r.bytes,
    gatedRegions: a.gatedRegions + r.gatedRegions,
    lessonsGated: a.lessonsGated + r.lessonsGated,
    lessonsFree: a.lessonsFree + r.lessonsFree,
    lessonsExposed: a.lessonsExposed + r.lessonsExposed.length,
    workedGated: a.workedGated + r.workedGated,
    workedFree: a.workedFree + r.workedFree,
    workedExposed: a.workedExposed + r.workedExposed,
    paidWords: a.paidWords + r.paidWords,
    paidBytes: a.paidBytes + r.paidBytes,
  }), {
    bytes: 0, gatedRegions: 0, lessonsGated: 0, lessonsFree: 0, lessonsExposed: 0,
    workedGated: 0, workedFree: 0, workedExposed: 0, paidWords: 0, paidBytes: 0,
  });
  return { rows, totals };
}

/** Course markup that has escaped the four gated pages entirely. */
export function strayCoursePages(root = ROOT, read = (p) => readFileSync(join(root, p), 'utf8'), list) {
  const known = new Set(gatedPages(root, read));
  const files = list ?? readdirSync(root).filter((f) => f.endsWith('.html'));
  const stray = [];
  for (const f of files) {
    if (known.has(f)) continue;
    const html = read(f);
    const n = [...html.matchAll(LESSON_RE)].length;
    if (n) stray.push({ path: f, lessons: n });
  }
  return stray;
}

const kb = (n) => `${(n / 1024).toFixed(0)}KB`;

if (import.meta.url === `file://${process.argv[1]}`) {
  const rootArg = process.argv.indexOf('--root');
  const root = rootArg > -1 ? process.argv[rootArg + 1] : ROOT;
  const read = (p) => readFileSync(join(root, p), 'utf8');
  const { rows, totals } = auditSite(root, read);
  const stray = strayCoursePages(root, read);

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ rows, totals, stray }, null, 2));
  } else {
    console.log('page                          gates  lessons  free  worked   paid words   paid bytes  exposed');
    for (const r of rows) {
      console.log(
        `${r.path.padEnd(29)} ${String(r.gatedRegions).padStart(5)} ` +
        `${String(r.lessonsGated).padStart(8)} ${String(r.lessonsFree).padStart(5)} ` +
        `${String(r.workedGated).padStart(7)} ${String(r.paidWords).padStart(12)} ` +
        `${kb(r.paidBytes).padStart(12)}  ${r.lessonsExposed.length + r.workedExposed || ''}`,
      );
    }
    console.log(
      `\n${totals.lessonsGated} paid lessons and ${totals.workedGated} of the twelve worked cases are gated at the edge` +
      ` — and all of them are readable in this repository's source.`,
    );
    console.log(`paid prose in public source: ${totals.paidWords.toLocaleString('en-US')} words, ${kb(totals.paidBytes)} of markup across ${rows.length} files (${kb(totals.bytes)} of page source in total).`);
    console.log(`free by design (ungated, intended): ${totals.lessonsFree} lessons, ${totals.workedFree} worked cases.`);
    console.log('\nThe edge gate hides this from an anonymous HTTP request. It does not');
    console.log('hide it from `git clone`. See docs/PAYWALL.md for the options.');

    const holes = rows.filter((r) => r.lessonsExposed.length || r.workedExposed);
    if (holes.length || stray.length) {
      console.log('\nPAID CONTENT OUTSIDE ANY GATED REGION (served to anonymous visitors):');
      for (const r of holes) {
        if (r.lessonsExposed.length) console.log(`  ${r.path}: ${r.lessonsExposed.length} ungated lesson(s): ${r.lessonsExposed.join(', ')}`);
        if (r.workedExposed) console.log(`  ${r.path}: ${r.workedExposed} ungated worked case(s)`);
      }
      for (const s of stray) console.log(`  ${s.path}: ${s.lessons} lesson card(s) on a page the middleware does not gate`);
      process.exitCode = 1;
    }
  }
}
