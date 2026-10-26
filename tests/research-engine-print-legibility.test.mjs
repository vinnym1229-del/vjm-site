// Incident: assets/research-engine.css was the last of the site's four
// shared stylesheets still missing an @media print override -- the same gap
// already fixed in assets/curriculum.css, assets/tokens.css, assets/site.css
// (board Queued row 9), and the six inline-<style> pages (privacy/terms/
// risk-disclosure.html, premium-guidance/stock-lab/forex-calendar.html).
// Dark mode is an explicit, remembered opt-in (assets/theme.js: light is the
// default), not hypothetical, and browsers default to NOT printing element
// background colors ("background graphics" is off by default in the print
// dialog) but DO print the author's specified text color, so a dark-mode
// visitor printing research-engine.html got --text's near-white (#ededee)
// ink landing on the un-printed white paper -- and --amber/--green (caution
// KPIs, positive stats, good-outcome cells), --soft/--muted (body/label
// text) and --red/--red-ink (brand, links, bad-outcome cells) were all just
// as illegible.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const css = readFileSync(join(ROOT, 'assets', 'research-engine.css'), 'utf8');

const DARK_INK_VARS = ['text', 'muted', 'soft', 'amber', 'green', 'red', 'red-ink'];
const LIGHT_PAPER_VARS = ['bg', 'bg2', 'line', 'line2'];

function extractPrintBlock(source) {
  const start = source.indexOf('@media print');
  assert.ok(start > -1, 'assets/research-engine.css has no @media print rule');
  // One level of nested rule inside it, so track brace depth rather than
  // assuming the first "}" after the opener is the end of the whole block.
  let depth = 0, i = source.indexOf('{', start);
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) break; }
  }
  assert.ok(depth === 0, '@media print block never closes');
  return source.slice(start, i + 1);
}

const printBlock = extractPrintBlock(css);

const luminance = (hex) => {
  let h = hex.slice(1);
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return (r + g + b) / 3;
};

test('assets/research-engine.css: @media print forces readable colors unconditionally, not only under body.light-mode', () => {
  // Must apply via :root (matches regardless of the light-mode class) so the
  // override wins even while dark mode is the active, on-screen theme -- a
  // rule scoped to "body.light-mode" alone would do nothing for a dark-mode
  // reader, which is exactly the visitor this regression is about.
  assert.match(printBlock, /:root\s*,/, 'print override must include a bare :root selector to cover dark mode');
});

test('assets/research-engine.css: @media print sets every text-color var this file actually uses to a dark literal, and bg/line to a light one', () => {
  for (const v of DARK_INK_VARS) {
    const m = printBlock.match(new RegExp(`--${v}\\s*:\\s*(#[0-9a-fA-F]{3,6})`));
    assert.ok(m, `--${v} not set inside the print block -- this file's own rules use color:var(--${v}) somewhere`);
    assert.ok(luminance(m[1]) < 64, `--${v} (${m[1]}) must be dark ink, not near-white/low-contrast`);
  }
  for (const v of LIGHT_PAPER_VARS) {
    const m = printBlock.match(new RegExp(`--${v}\\s*:\\s*(#[0-9a-fA-F]{3,6})(?!\\d)`));
    assert.ok(m, `--${v} not set inside the print block`);
    assert.ok(luminance(m[1]) > 191, `--${v} (${m[1]}) must be light paper, not near-black`);
  }
});

test('research-engine.html loads assets/research-engine.css and assets/theme.js so the dark-mode-opt-in case the print fix covers is actually reachable', () => {
  const html = readFileSync(join(ROOT, 'research-engine.html'), 'utf8');
  assert.match(html, /href="assets\/research-engine\.css/, 'research-engine.html does not link assets/research-engine.css');
  assert.match(html, /<script src="assets\/theme\.js">/, 'research-engine.html does not load assets/theme.js');
});

test('assets/research-engine.css: every color:var(...) its own rules use is covered by this test\'s DARK_INK_VARS list', () => {
  const used = new Set(
    [...css.matchAll(/(?:^|[;{])color:var\(--([a-zA-Z0-9-]+)\)/g)].map((m) => m[1])
  );
  for (const v of used) {
    assert.ok(DARK_INK_VARS.includes(v), `research-engine.css uses color:var(--${v}) but this test doesn't cover --${v} -- add it so a future palette change can't reintroduce this bug silently`);
  }
});
