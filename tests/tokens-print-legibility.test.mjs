// Incident: assets/tokens.css (shared by the three .vjm-page pages --
// premarket.html, prop-firms.html, unsubscribe.html) had no @media print
// rule at all, the same gap tests/curriculum-print-legibility.test.mjs
// already found and fixed in assets/curriculum.css. Dark mode is an
// explicit, remembered opt-in (assets/theme.js: "stored 'dark' -> dark
// (explicit opt-in, honoured)"), not a hypothetical, and a visitor who
// toggled it and then printed one of these pages got an unreadable page:
// browsers default to NOT printing element background colors ("background
// graphics" is off by default) but DO print the author's specified text
// color, so dark mode's near-black --vjm-bg silently became the paper's own
// white while its near-white --vjm-text printed exactly as specified --
// near-white ink on a white page. Fixed by forcing the light-mode ink/paper
// values at print time regardless of which theme is active on screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const css = readFileSync(join(ROOT, 'assets', 'tokens.css'), 'utf8');

function extractPrintBlock(source) {
  const start = source.indexOf('@media print');
  assert.ok(start > -1, 'assets/tokens.css has no @media print rule');
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

test('@media print forces readable ink/paper colors unconditionally, not only under body.light-mode', () => {
  // Must apply via :root (matches regardless of the light-mode class) so the
  // override wins even while dark mode is the active, on-screen theme -- a
  // rule scoped to "body.light-mode" alone would do nothing for a dark-mode
  // reader, which is exactly the visitor this regression is about.
  assert.match(printBlock, /:root\s*,/, 'print override must include a bare :root selector to cover dark mode');
});

test('@media print sets --vjm-text to a dark literal and --vjm-bg to a light literal', () => {
  const textMatch = printBlock.match(/--vjm-text\s*:\s*(#[0-9a-fA-F]{3,6})/);
  const bgMatch = printBlock.match(/--vjm-bg\s*:\s*(#[0-9a-fA-F]{3,6})/);
  assert.ok(textMatch, '--vjm-text not set inside the print block');
  assert.ok(bgMatch, '--vjm-bg not set inside the print block');

  const luminance = (hex) => {
    let h = hex.slice(1);
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    return (r + g + b) / 3;
  };

  assert.ok(luminance(textMatch[1]) < 64, `--vjm-text (${textMatch[1]}) must be dark ink, not near-white`);
  assert.ok(luminance(bgMatch[1]) > 191, `--vjm-bg (${bgMatch[1]}) must be light paper, not near-black`);
});

test('every .vjm-page that loads tokens.css actually loads it, so the print fix reaches all three', () => {
  for (const page of ['premarket.html', 'prop-firms.html', 'unsubscribe.html']) {
    const html = readFileSync(join(ROOT, page), 'utf8');
    assert.match(html, /href="assets\/tokens\.css/, `${page} does not link assets/tokens.css`);
    assert.match(html, /<body class="vjm-page">/, `${page} does not use the vjm-page body class tokens.css targets`);
  }
});
