// Incident: premium-guidance.html, stock-lab.html, and forex-calendar.html
// were the last three inline-<style> pages still carrying the missing-
// @media-print-override gap already fixed in assets/curriculum.css,
// assets/tokens.css, assets/site.css, and privacy/terms/risk-disclosure.html
// (flagged by name on the board after each of those cycles). Dark mode is an
// explicit, remembered opt-in (assets/theme.js: light is the default), not
// hypothetical, and browsers default to NOT printing element background
// colors ("background graphics" is off by default in the print dialog) but
// DO print the author's specified text color, so a dark-mode visitor
// printing any of these three got --text's near-white (#ededee) ink landing
// on the un-printed white paper -- and each page's own accent vars
// (--gold-ink/--em/--green, near-white #d9d9dd/#cfcfd4 in dark mode, plus
// --soft and the light-coral #e26060 --red used for risk/impact labels)
// made brand marks, stats, headings and classification labels just as
// illegible. Confirmed with Playwright print-media emulation before fixing
// and after on all three pages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const PAGES = [
  {
    file: 'premium-guidance.html',
    darkInkVars: ['text', 'muted', 'm2', 'gold-ink', 'em', 'red'],
    lightPaperVars: ['bg', 'bg2', 'card'],
  },
  {
    file: 'stock-lab.html',
    darkInkVars: ['text', 'muted', 'soft', 'gold-ink', 'green', 'orange', 'red'],
    lightPaperVars: ['bg', 'bg2', 'card'],
  },
  {
    file: 'forex-calendar.html',
    darkInkVars: ['text', 'muted', 'soft', 'gold-ink', 'orange', 'red'],
    lightPaperVars: ['bg', 'bg2', 'card'],
  },
];

function extractInlineStyle(html, page) {
  const match = html.match(/<style>([\s\S]*?)<\/style>/);
  assert.ok(match, `${page} has no inline <style> block`);
  return match[1];
}

function extractPrintBlock(css, page) {
  const start = css.indexOf('@media print');
  assert.ok(start > -1, `${page} has no @media print rule in its inline <style>`);
  // One level of nested rule inside it, so track brace depth rather than
  // assuming the first "}" after the opener is the end of the whole block.
  let depth = 0, i = css.indexOf('{', start);
  for (; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') { depth--; if (depth === 0) break; }
  }
  assert.ok(depth === 0, `${page}'s @media print block never closes`);
  return css.slice(start, i + 1);
}

const luminance = (hex) => {
  let h = hex.slice(1);
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return (r + g + b) / 3;
};

for (const { file, darkInkVars, lightPaperVars } of PAGES) {
  const html = readFileSync(join(ROOT, file), 'utf8');
  const css = extractInlineStyle(html, file);
  const printBlock = extractPrintBlock(css, file);

  test(`${file}: @media print forces readable colors unconditionally, not only under body.light-mode`, () => {
    // Must apply via :root (matches regardless of the light-mode class) so
    // the override wins even while dark mode is the active, on-screen theme
    // -- a rule scoped to "body.light-mode" alone would do nothing for a
    // dark-mode reader, which is exactly the visitor this regression is about.
    assert.match(printBlock, /:root\s*,/, `${file}'s print override must include a bare :root selector to cover dark mode`);
  });

  test(`${file}: @media print sets every text-color var this page actually uses to a dark literal, and bg/card to a light one`, () => {
    for (const v of darkInkVars) {
      const m = printBlock.match(new RegExp(`--${v}\\s*:\\s*(#[0-9a-fA-F]{3,6})`));
      assert.ok(m, `${file}: --${v} not set inside the print block -- this page's own markup uses color:var(--${v}) somewhere`);
      assert.ok(luminance(m[1]) < 64, `${file}: --${v} (${m[1]}) must be dark ink, not near-white/low-contrast`);
    }
    for (const v of lightPaperVars) {
      const m = printBlock.match(new RegExp(`--${v}\\s*:\\s*(#[0-9a-fA-F]{3,6})(?!\\d)`));
      assert.ok(m, `${file}: --${v} not set inside the print block`);
      assert.ok(luminance(m[1]) > 191, `${file}: --${v} (${m[1]}) must be light paper, not near-black`);
    }
  });

  test(`${file}: loads assets/theme.js so the dark-mode-opt-in case the print fix covers is actually reachable`, () => {
    assert.match(html, /<script src="assets\/theme\.js">/, `${file} does not load assets/theme.js`);
  });

  test(`${file}: every color:var(...) its own markup uses is covered by this test's darkInkVars list`, () => {
    const used = new Set(
      [...css.matchAll(/(?:^|[;{])color:var\(--([a-zA-Z0-9-]+)\)/g)].map((m) => m[1])
    );
    for (const v of used) {
      assert.ok(darkInkVars.includes(v), `${file} uses color:var(--${v}) but the print-legibility test doesn't cover --${v} -- add it so a future palette change can't reintroduce this bug silently`);
    }
  });
}
