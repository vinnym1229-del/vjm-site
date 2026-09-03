import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(resolve(root, 'research-engine.html'), 'utf8');
const javascript = readFileSync(resolve(root, 'assets/research-engine.js'), 'utf8');

const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
assert.deepEqual([...new Set(duplicates)], [], 'research page must not contain duplicate IDs');

const referencedIds = [...javascript.matchAll(/\$\('([^']+)'\)/g)].map((match) => match[1]);
const missingIds = [...new Set(referencedIds)].filter((id) => !ids.includes(id));
assert.deepEqual(missingIds, [], 'every JavaScript element reference must exist in the page');

for (const match of html.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
  const path = match[1];
  if (!path || /^(?:https?:|#|mailto:|data:)/.test(path)) continue;
  const clean = path.split('#')[0].split('?')[0];
  assert.ok(existsSync(resolve(root, clean)), `linked local asset must exist: ${clean}`);
}

for (const page of ['index.html', 'stock-lab.html', 'options-lab.html']) {
  const source = readFileSync(resolve(root, page), 'utf8');
  assert.ok(source.includes('research-engine.html'), `${page} must link to the research engine`);
}

for (const page of ['index.html', 'stock-lab.html', 'premium-guidance.html', 'research-engine.html']) {
  const source = readFileSync(resolve(root, page), 'utf8');
  assert.doesNotMatch(source, /verify-premium\?token/i, `${page} must send session tokens in an authorization header, not the URL`);
}

for (const file of ['research-engine.html', 'assets/research-engine.js', 'functions/api/research-engine.js']) {
  const source = readFileSync(resolve(root, file), 'utf8');
  assert.doesNotMatch(source, /ALPACA_API_KEY\s*=\s*["'][^"']+/i, `${file} must not contain an Alpaca key value`);
  assert.doesNotMatch(source, /ALPACA_SECRET_KEY\s*=\s*["'][^"']+/i, `${file} must not contain an Alpaca secret value`);
}

// prop-firms.html has a single h1 and no static h2 — its firm cards are the
// only content section, so they must render as h2, not h3 (a screen reader
// heading-level skip from h1 straight to h3).
const propFirms = readFileSync(resolve(root, 'prop-firms.html'), 'utf8');
assert.doesNotMatch(propFirms, /<h3>/, 'prop-firms firm cards must not skip a heading level from h1 to h3');
assert.match(propFirms, /'<h2>' \+ esc\(f\.name\) \+ '<\/h2>'/, 'prop-firms firm cards must render as h2');

// Every course page carries the same 19-link, four-dropdown nav. Without a
// skip link, a keyboard or screen-reader visitor has to tab through all of
// it on every visit before reaching the lesson content. options-lab.html
// was missing one — its wrapper is a <div class="curr"> rather than
// <body class="curr"> like its siblings, which is likely why it slipped
// past review as "structurally different" instead of "incomplete".
for (const [page, targetId] of [
  ['futures-dissection.html', 'curriculum'],
  ['stock-breakdown.html', 'curriculum'],
  ['psychology-enhancer.html', 'curriculum'],
  ['options-lab.html', 'tabs'],
]) {
  const source = readFileSync(resolve(root, page), 'utf8');
  assert.match(source, new RegExp(`<a class="skip" href="#${targetId}">`),
    `${page} must offer a skip link past its full nav`);
  assert.match(source, new RegExp(`id="${targetId}"`),
    `${page}'s skip link target #${targetId} must exist`);
}

// The same gap turned up again outside the curriculum pages: prop-firms.html
// and forex-calendar.html carry the identical six-dropdown Markets/Tools nav
// as premarket.html and stock-lab.html, but had no way to skip past it.
// Their siblings use two different skip-link markups (premarket.html's is an
// inline-styled class="skip-link"; stock-lab.html's is a CSS class="skip"),
// so each page is checked against the pattern its own sibling uses.
for (const [page, className, targetId] of [
  ['prop-firms.html', 'skip-link', 'main'],
  ['forex-calendar.html', 'skip', 'main'],
]) {
  const source = readFileSync(resolve(root, page), 'utf8');
  assert.match(source, new RegExp(`<a class="${className}" href="#${targetId}"`),
    `${page} must offer a skip link past its full nav`);
  assert.match(source, new RegExp(`id="${targetId}"`),
    `${page}'s skip link target #${targetId} must exist`);
}

assert.match(html, /meta name="robots" content="noindex,nofollow"/);
assert.match(html, /Educational research only—not financial advice/);
// Sessions travel via HttpOnly cookies; no Bearer tokens in client code.
assert.doesNotMatch(javascript, /Authorization\s*=\s*'Bearer '/, 'client code must not attach Bearer tokens');
assert.doesNotMatch(javascript, /localStorage\.getItem\(/, 'client code must not read tokens from storage');
// CNAME is a GitHub Pages convention. This site deploys via Cloudflare
// Pages, which takes its custom domains from the dashboard and ignores
// this file entirely -- so the stale `not-financial-advice.com` in it was
// pure misdirection, contradicting every canonical on the site while
// having no effect on anything. Removed; this pins it staying removed.
assert.ok(!existsSync(resolve(root, 'CNAME')),
  'CNAME does nothing on Cloudflare Pages and only contradicts the canonical origin');

console.log('VJM site structure and secret-leak tests passed.');
