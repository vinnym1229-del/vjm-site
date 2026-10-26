// Incident: privacy.html, terms.html, and risk-disclosure.html had no
// @media print rule at all -- the same gap tests/curriculum-print-legibility,
// tests/tokens-print-legibility, and tests/site-print-legibility.test.mjs
// already found and fixed in their respective stylesheets. Dark mode is an
// explicit, remembered opt-in (assets/theme.js: light is the default), not
// hypothetical, and these three are exactly the pages a visitor is likely to
// print or save as a PDF (legal/policy content). Browsers default to NOT
// printing element background colors ("background graphics" is off by
// default in the print dialog) but DO print the author's specified text
// color, so a dark-mode visitor printing any of them got --text's near-white
// (#ededee) ink landing on the un-printed white paper -- and, specific to
// these three pages' own inline palette, --gold-ink's near-white (#d9d9dd)
// made every heading (h1 span, h2) and every body/footer link (main a, p a,
// li a, .footer a) just as invisible, since they're colored with it too.
// Confirmed with Playwright print-media emulation before fixing (computed
// h2/link color rgb(217,217,221) against an un-printed rgb(12,12,13) page
// background, unchanged under print emulation) and after (rgb(0,0,0) on
// rgb(255,255,255)).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PAGES = ['privacy.html', 'terms.html', 'risk-disclosure.html'];

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

for (const page of PAGES) {
  const html = readFileSync(join(ROOT, page), 'utf8');
  const css = extractInlineStyle(html, page);
  const printBlock = extractPrintBlock(css, page);

  test(`${page}: @media print forces readable colors unconditionally, not only under body.light-mode`, () => {
    // Must apply via :root (matches regardless of the light-mode class) so
    // the override wins even while dark mode is the active, on-screen theme
    // -- a rule scoped to "body.light-mode" alone would do nothing for a
    // dark-mode reader, which is exactly the visitor this regression is about.
    assert.match(printBlock, /:root\s*,/, `${page}'s print override must include a bare :root selector to cover dark mode`);
  });

  test(`${page}: @media print sets --text, --gold-ink, and --muted to dark literals, --bg to a light literal`, () => {
    const textMatch = printBlock.match(/--text\s*:\s*(#[0-9a-fA-F]{3,6})/);
    const goldInkMatch = printBlock.match(/--gold-ink\s*:\s*(#[0-9a-fA-F]{3,6})/);
    const mutedMatch = printBlock.match(/--muted\s*:\s*(#[0-9a-fA-F]{3,6})/);
    const bgMatch = printBlock.match(/--bg\s*:\s*(#[0-9a-fA-F]{3,6})(?!\d)/);
    assert.ok(textMatch, `${page}: --text not set inside the print block`);
    assert.ok(goldInkMatch, `${page}: --gold-ink not set inside the print block -- this page's headings (h1 span, h2) and every body/footer link are colored with it, and in dark mode it is a near-white ink that would print invisibly on white paper`);
    assert.ok(mutedMatch, `${page}: --muted not set inside the print block`);
    assert.ok(bgMatch, `${page}: --bg not set inside the print block`);

    assert.ok(luminance(textMatch[1]) < 64, `${page}: --text (${textMatch[1]}) must be dark ink, not near-white`);
    assert.ok(luminance(goldInkMatch[1]) < 64, `${page}: --gold-ink (${goldInkMatch[1]}) must be dark ink, not near-white`);
    assert.ok(luminance(mutedMatch[1]) < 64, `${page}: --muted (${mutedMatch[1]}) must be dark ink, not near-white`);
    assert.ok(luminance(bgMatch[1]) > 191, `${page}: --bg (${bgMatch[1]}) must be light paper, not near-black`);
  });

  test(`${page}: loads assets/theme.js so the dark-mode-opt-in case the print fix covers is actually reachable`, () => {
    assert.match(html, /<script src="assets\/theme\.js">/, `${page} does not load assets/theme.js`);
  });
}
