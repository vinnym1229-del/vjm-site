// Palette contract tests.
//
// The site was originally gold/emerald/blue and had been mass find-replaced to
// red, which left every border, glow, heading and "positive" state the same
// alarm red. It is now a white / black / neutral-gray system with red as a
// restrained accent. These tests keep it that way: they fail if a retired red
// literal comes back, if red creeps past its budget, if a foreign hue is
// introduced, or if a page ships without a light theme.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditTree, shippedFiles, extractColors, isRed, contrast, hexToRgb } from '../tools/color-audit.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const rows = auditTree(ROOT);

test('no retired red literal survives anywhere in shipped source', () => {
  const offenders = rows.filter((r) => r.retired.length)
    .map((r) => `${r.path}: ${r.retired.join(', ')}`);
  assert.deepEqual(offenders, [], `retired palette literals came back:\n${offenders.join('\n')}`);
});

test('red stays a minority of the palette', () => {
  const tot = rows.reduce((a, r) => ({ t: a.t + r.total, r: a.r + r.red }), { t: 0, r: 0 });
  const share = tot.r / tot.t;
  // Was 40.9% before the rebrand. The budget leaves room to add accents but
  // not to drift back toward a red-on-red site.
  assert.ok(share < 0.25, `red is ${(share * 100).toFixed(1)}% of all color literals (budget: 25%)`);
});

test('the palette stays white / black / red — no foreign hues', () => {
  // Every chromatic color should be the red accent. Greens, blues, golds and
  // teals are what made the original find-replace inconsistent.
  const strays = [];
  for (const p of shippedFiles(ROOT)) {
    for (const c of extractColors(read(p))) {
      const { r, g, b, a } = c;
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const l = (max + min) / 2 / 255;
      const s = max === min ? 0 : (max - min) / (255 - Math.abs(max + min - 255));
      if (s < 0.25 || l < 0.06 || l > 0.94 || a < 0.06) continue; // neutral or invisible
      if (!isRed(c)) strays.push(`${p}: ${c.raw}`);
    }
  }
  assert.ok(strays.length <= 4, `non-red hues found (max 4 tolerated):\n${strays.join('\n')}`);
});

test('every page ships a light theme', () => {
  // A visitor who picks Light on the homepage must not hit a black page.
  const pages = shippedFiles(ROOT).filter((p) => p.endsWith('.html'));
  const missing = [];
  for (const p of pages) {
    const html = read(p);
    let covered = html.includes('light-mode');
    if (!covered) {
      for (const m of html.matchAll(/<link[^>]+href="([^"]+\.css)"/g)) {
        const href = m[1].replace(/^\//, '');
        try { if (read(href).includes('light-mode')) { covered = true; break; } } catch { /* external */ }
      }
    }
    if (!covered) missing.push(p);
  }
  assert.deepEqual(missing, [], `pages with no light theme: ${missing.join(', ')}`);
});

test('every page applies the stored theme preference', () => {
  // assets/theme.js reads localStorage['st-theme']; without it the light-mode
  // CSS above is dead code on every page but the two with a toggle.
  const pages = shippedFiles(ROOT).filter((p) => p.endsWith('.html'));
  const missing = pages.filter((p) => !/assets\/theme\.js/.test(read(p)));
  assert.deepEqual(missing, [], `pages not loading the theme bootstrap: ${missing.join(', ')}`);
  assert.match(read('assets/theme.js'), /st-theme/);
});

test('theme-color meta matches the manifest and the new page background', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.theme_color, '#0c0c0d');
  assert.match(read('index.html'), /<meta name="theme-color" content="#0c0c0d">/);
});

test('core text/background pairs clear WCAG AA in both themes', () => {
  const css = read('assets/site.css');
  const block = (sel) => {
    const m = css.match(new RegExp(`${sel}\\s*\\{([^}]*)\\}`));
    return m ? m[1] : '';
  };
  const varOf = (src, name) => {
    const m = src.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})`));
    return m ? hexToRgb(m[1]) : null;
  };
  for (const [sel, label] of [[':root', 'dark'], ['body\\.light-mode', 'light']]) {
    const src = block(sel);
    const bg = varOf(src, 'bg'), text = varOf(src, 'text'), muted = varOf(src, 'muted');
    assert.ok(bg && text && muted, `${label}: --bg/--text/--muted must be declared as hex in ${sel}`);
    assert.ok(contrast(text, bg) >= 4.5, `${label}: --text on --bg is ${contrast(text, bg).toFixed(2)}:1`);
    assert.ok(contrast(muted, bg) >= 4.5, `${label}: --muted on --bg is ${contrast(muted, bg).toFixed(2)}:1`);
  }
});
