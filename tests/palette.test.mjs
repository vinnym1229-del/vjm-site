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
  // Zero, not a tolerance: the system is white/black/red by design, so any
  // chromatic non-red literal is either a leftover from the old palette or a
  // new hue someone added without deciding to. Adding one deliberately means
  // editing this test on purpose.
  assert.deepEqual(strays, [], `non-red hues found:\n${strays.join('\n')}`);
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

// Updated 2026-09-01: LIGHT is now the default theme, so the browser chrome
// colour must describe the LIGHT page, not the old dark one. The light
// background is body.light-mode's --bg (#ffffff); #0c0c0d is the dark --bg and
// is now only what a visitor sees after explicitly choosing dark.
const LIGHT_BG = '#ffffff';

test('theme-color meta matches the manifest and the light default background', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.theme_color, LIGHT_BG);
  assert.equal(manifest.background_color, LIGHT_BG);
  // TRANSITIONAL (2026-09-01): index.html is being edited in a parallel lane
  // this cycle, so its meta tag is swept there rather than here. Once it ships
  //   <meta name="theme-color" content="#ffffff">
  // delete the '#0c0c0d' alternative below and pin the meta to LIGHT_BG.
  const meta = read('index.html').match(/<meta name="theme-color" content="(#[0-9a-f]{6})">/i);
  assert.ok(meta, 'theme-color meta missing from index.html');
  assert.ok([LIGHT_BG, '#0c0c0d'].includes(meta[1].toLowerCase()),
    `unexpected theme-color ${meta[1]} — it should be ${LIGHT_BG}`);
});

test('light is the default theme; only an explicit "dark" opts out', () => {
  // The bootstrap used to read `if (stored !== 'light') return;`, which made
  // dark the default and put every first-time visitor on a black page.
  const js = read('assets/theme.js');
  assert.match(js, /stored === 'dark'/, 'theme.js must opt out on stored dark, not opt in on stored light');
  assert.doesNotMatch(js, /stored !== 'light'/, 'the old dark-by-default rule is back');
  // and the page with the toggle must agree with the bootstrap.
  assert.match(read('options-lab.html'), /stored !== 'dark'/, 'options-lab toggle must default to light');
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
