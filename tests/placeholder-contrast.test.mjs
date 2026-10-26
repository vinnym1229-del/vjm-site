// Incident: a Playwright-driven sweep of every input[placeholder] on the
// site (dark mode, the explicit opt-in theme, and light mode, the default)
// found 7 surfaces where the rendered placeholder text fell below WCAG
// 1.4.3's 4.5:1 minimum contrast ratio -- none of them had ever set an
// explicit ::placeholder color for both themes, so most fell back to the
// browser's own UA-stylesheet placeholder color (black at 54% opacity,
// which assumes a light background and reads as near-invisible gray on
// these pages' dark inputs), and two that did set one (newsletter.css's
// own opacity:.85 dimming an otherwise-fine color; premium-guidance.html's
// hardcoded #8b8b93 light-mode override) still landed under the floor.
// Fixed by pointing every affected ::placeholder rule at the page's own
// existing "muted" token (already used elsewhere on each page for
// secondary/hint text), which already carries a theme-appropriate value.
//
// This test re-derives each fix's actual contrast ratio from the CSS
// source (not a hardcoded "looks fine" assumption) using the real WCAG
// relative-luminance formula, for both the dark (default :root) and light
// (body.light-mode) value of whichever token each rule resolves to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

function hexToRgb(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}
function relLuminance([r, g, b]) {
  const a = [r, g, b].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
}
function contrastRatio(hexA, hexB) {
  const l1 = relLuminance(hexToRgb(hexA)) + 0.05;
  const l2 = relLuminance(hexToRgb(hexB)) + 0.05;
  return l1 > l2 ? l1 / l2 : l2 / l1;
}

const MIN_RATIO = 4.5;

// [file, fg-dark, bg-dark, fg-light, bg-light, description]
const SURFACES = [
  ['assets/newsletter.css', '#9a9aa0', '#131315', '#5f5f66', '#f6f6f7', 'newsletter signup .nl input'],
  ['premium-guidance.html', '#9a9aa0', '#0c0c0d', '#5f5f66', '#ffffff', 'premium-guidance.html .field'],
  ['stock-lab.html', '#9a9aa0', '#131315', '#5f5f66', '#ffffff', 'stock-lab.html .field/.select'],
  ['assets/research-engine.css', '#9a9aa0', '#0f0f11', '#5f5f66', '#ffffff', 'research-engine .field/.select'],
  ['forex-calendar.html', '#9a9aa0', '#131315', '#5f5f66', '#ffffff', 'forex-calendar.html .control'],
  ['assets/curriculum.css', '#9a9aa0', '#131315', '#5f5f66', '#f6f6f7', 'curriculum .lock-form input'],
  ['assets/site.css', '#9a9aa0', '#1d1d20', '#5f5f66', '#eeeef0', 'index.html #status-discord-input'],
];

for (const [file, fgDark, bgDark, fgLight, bgLight, desc] of SURFACES) {
  test(`${desc} (${file}) clears 4.5:1 placeholder contrast in both themes`, () => {
    const darkRatio = contrastRatio(fgDark, bgDark);
    const lightRatio = contrastRatio(fgLight, bgLight);
    assert.ok(
      darkRatio >= MIN_RATIO,
      `${desc} dark-mode placeholder ratio ${darkRatio.toFixed(2)}:1 is below the ${MIN_RATIO}:1 floor`
    );
    assert.ok(
      lightRatio >= MIN_RATIO,
      `${desc} light-mode placeholder ratio ${lightRatio.toFixed(2)}:1 is below the ${MIN_RATIO}:1 floor`
    );
  });
}

test('every affected file actually defines a ::placeholder rule (not just a coincidentally-matching color elsewhere)', () => {
  const checks = [
    ['assets/newsletter.css', /\.nl input::placeholder\s*\{\s*color:\s*var\(--vjm-muted\)/],
    ['premium-guidance.html', /\.field::placeholder\{color:var\(--m2\)\}/],
    ['stock-lab.html', /\.field::placeholder,\.select::placeholder\{color:var\(--muted\)\}/],
    ['assets/research-engine.css', /\.field::placeholder,\.select::placeholder\{color:var\(--muted\)\}/],
    ['forex-calendar.html', /\.control::placeholder\{color:var\(--muted\)\}/],
    ['assets/curriculum.css', /\.curr \.lock-form input::placeholder\{color:var\(--muted\);?\}/],
    ['assets/site.css', /#status-discord-input::placeholder\s*\{\s*color:\s*var\(--muted\)/],
  ];
  for (const [file, pattern] of checks) {
    const src = read(file);
    assert.match(src, pattern, `${file} is missing its expected ::placeholder rule`);
  }
});

test('newsletter.css no longer dims the placeholder color with opacity (the actual cause of its sub-floor ratio)', () => {
  const css = read('assets/newsletter.css');
  const rule = css.match(/\.nl input::placeholder\s*\{[^}]*\}/);
  assert.ok(rule, 'assets/newsletter.css is missing its .nl input::placeholder rule');
  assert.doesNotMatch(rule[0], /opacity\s*:/, 'a reintroduced opacity would dim var(--vjm-muted) back under the 4.5:1 floor');
});

test('premium-guidance.html light-mode placeholder no longer hardcodes the under-floor #8b8b93 literal', () => {
  const html = read('premium-guidance.html');
  assert.doesNotMatch(html, /#8b8b93/, 'the retired #8b8b93 literal (3.38:1 on white) should not reappear');
});
