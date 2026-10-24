// Incident: assets/curriculum.css (shared by futures-dissection.html,
// options-lab.html, psychology-enhancer.html, stock-breakdown.html) had no
// @media print rule at all. Dark mode is an explicit, remembered opt-in
// (assets/theme.js: "stored 'dark' -> dark (explicit opt-in, honoured)"),
// not a hypothetical, and a member who toggled it and then printed a lesson
// to study offline got an unreadable page: browsers default to NOT printing
// element background colors ("background graphics" is off by default) but
// DO print the author's specified text color, so dark mode's near-black
// --bg silently became the paper's own white while its near-white --text
// printed exactly as specified -- near-white ink on a white page. Fixed by
// forcing the light-mode ink/paper values at print time regardless of which
// theme is active on screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const css = readFileSync(join(ROOT, 'assets', 'curriculum.css'), 'utf8');

function extractPrintBlock(source) {
  const start = source.indexOf('@media print');
  assert.ok(start > -1, 'assets/curriculum.css has no @media print rule');
  // Find the matching close brace for the @media block (one level of
  // nested rule inside it, so track depth rather than assuming the first
  // "}" after the opener is the end of the whole media query).
  let depth = 0, i = source.indexOf('{', start);
  const blockStart = i;
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
  const bgMatch = printBlock.match(/--bg\s*:\s*(#[0-9a-fA-F]{3,6})/);
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

test('every curriculum page actually loads assets/curriculum.css, so the print fix reaches all four', () => {
  for (const page of ['futures-dissection.html', 'options-lab.html', 'psychology-enhancer.html', 'stock-breakdown.html']) {
    const html = readFileSync(join(ROOT, page), 'utf8');
    assert.match(html, /href="assets\/curriculum\.css"/, `${page} does not link assets/curriculum.css`);
  }
});
