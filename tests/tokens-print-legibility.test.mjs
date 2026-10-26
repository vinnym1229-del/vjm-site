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
//
// Follow-up incident: that first fix only forced --vjm-bg/bg2/card/border/
// border-strong/text/muted and missed six other vars this file and its
// three consuming pages also use via color: -- --vjm-red/--vjm-red-bright
// (premarket/prop-firms/unsubscribe's .brand and back/error links) and
// --vjm-green/--vjm-gold/--vjm-amber/--vjm-blue (.pos, .gold, focus-visible
// outlines, and premarket.html's dynamic statusChip() chip text). Dark
// mode's --green/--gold/--amber/--blue are all near-white and --red/
// --red-bright are too low-contrast on white paper, so they printed just as
// illegibly. The DARK_INK_VARS/LIGHT_PAPER_VARS lists and the last test
// below (mirroring tests/tool-pages-print-legibility.test.mjs's self-check)
// exist so a future var this file starts using via color: can't silently
// reopen this bug again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const css = readFileSync(join(ROOT, 'assets', 'tokens.css'), 'utf8');
const PAGES_USING_TOKENS = ['premarket.html', 'prop-firms.html', 'unsubscribe.html'];
const DARK_INK_VARS = ['text', 'muted', 'red', 'red-bright', 'green', 'gold', 'amber', 'blue'];
const LIGHT_PAPER_VARS = ['bg', 'bg2', 'card'];

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

const luminance = (hex) => {
  let h = hex.slice(1);
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return (r + g + b) / 3;
};

test('@media print sets every text-color var tokens.css or its three consuming pages actually use to a dark literal, and bg/card to a light one', () => {
  for (const v of DARK_INK_VARS) {
    const m = printBlock.match(new RegExp(`--vjm-${v}\\s*:\\s*(#[0-9a-fA-F]{3,6})`));
    assert.ok(m, `--vjm-${v} not set inside the print block -- tokens.css or one of its consuming pages uses color:var(--vjm-${v}) somewhere`);
    assert.ok(luminance(m[1]) < 64, `--vjm-${v} (${m[1]}) must be dark ink, not near-white/low-contrast`);
  }
  for (const v of LIGHT_PAPER_VARS) {
    const m = printBlock.match(new RegExp(`--vjm-${v}\\s*:\\s*(#[0-9a-fA-F]{3,6})`));
    assert.ok(m, `--vjm-${v} not set inside the print block`);
    assert.ok(luminance(m[1]) > 191, `--vjm-${v} (${m[1]}) must be light paper, not near-black`);
  }
});

test('every .vjm-page that loads tokens.css actually loads it, so the print fix reaches all three', () => {
  for (const page of PAGES_USING_TOKENS) {
    const html = readFileSync(join(ROOT, page), 'utf8');
    assert.match(html, /href="assets\/tokens\.css/, `${page} does not link assets/tokens.css`);
    assert.match(html, /<body class="vjm-page">/, `${page} does not use the vjm-page body class tokens.css targets`);
  }
});

test('every color:var(--vjm-x) used by tokens.css itself or its three consuming pages is covered by this test\'s DARK_INK_VARS list', () => {
  const sources = [css, ...PAGES_USING_TOKENS.map((p) => readFileSync(join(ROOT, p), 'utf8'))];
  for (const source of sources) {
    const used = new Set(
      [...source.matchAll(/(?:^|[;{\s"'])color:\s*var\(--vjm-([a-zA-Z0-9-]+)\)/g)].map((m) => m[1])
    );
    for (const v of used) {
      assert.ok(DARK_INK_VARS.includes(v), `uses color:var(--vjm-${v}) but the print-legibility test doesn't cover --vjm-${v} -- add it so a future palette change can't reintroduce this bug silently`);
    }
  }
});
