// Incident: assets/site.css (index.html's own stylesheet, the single
// highest-traffic page) had no @media print rule at all -- the same gap
// tests/curriculum-print-legibility.test.mjs and
// tests/tokens-print-legibility.test.mjs already found and fixed in
// assets/curriculum.css and assets/tokens.css. Dark mode is an explicit,
// remembered opt-in (assets/theme.js: light is the default, 'dark' only
// applies when explicitly stored), not a hypothetical, and a visitor who
// toggled it and then printed the page got an unreadable result: browsers
// default to NOT printing element background colors ("background graphics"
// is off by default in the print dialog) but DO print the author's
// specified text color, so dark mode's near-black --bg silently became the
// paper's own white while its near-white --text printed exactly as
// specified -- near-white ink on a white page. Fixed by forcing the
// light-mode ink/paper values at print time regardless of which theme is
// active on screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const css = readFileSync(join(ROOT, 'assets', 'site.css'), 'utf8');

function extractPrintBlock(source) {
  const start = source.indexOf('@media print');
  assert.ok(start > -1, 'assets/site.css has no @media print rule');
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

test('@media print sets --text to a dark literal and --bg to a light literal', () => {
  const textMatch = printBlock.match(/--text\s*:\s*(#[0-9a-fA-F]{3,6})/);
  const bgMatch = printBlock.match(/--bg\s*:\s*(#[0-9a-fA-F]{3,6})(?!\d)/);
  assert.ok(textMatch, '--text not set inside the print block');
  assert.ok(bgMatch, '--bg not set inside the print block');

  const luminance = (hex) => {
    let h = hex.slice(1);
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    return (r + g + b) / 3;
  };

  assert.ok(luminance(textMatch[1]) < 64, `--text (${textMatch[1]}) must be dark ink, not near-white`);
  assert.ok(luminance(bgMatch[1]) > 191, `--bg (${bgMatch[1]}) must be light paper, not near-black`);
});

test('index.html loads assets/site.css and uses the body class the print override covers', () => {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  assert.match(html, /href="assets\/site\.css/, 'index.html does not link assets/site.css');
  assert.match(html, /<body class="pj-home">/, 'index.html does not use the pj-home body class site.css targets');
});
