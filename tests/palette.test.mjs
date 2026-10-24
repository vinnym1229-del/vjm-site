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
import { auditTree, shippedFiles, extractColors, isRed, contrast, composite, hexToRgb, RETIRED } from '../tools/color-audit.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const rows = auditTree(ROOT);

test('no retired red literal survives anywhere in shipped source', () => {
  const offenders = rows.filter((r) => r.retired.length)
    .map((r) => `${r.path}: ${r.retired.join(', ')}`);
  assert.deepEqual(offenders, [], `retired palette literals came back:\n${offenders.join('\n')}`);
});

// shippedFiles() only walks root *.html and assets/*.{css,js} -- it never
// looks inside .svg files, so manifest.json's PWA icon is invisible to the
// test above the same way functions/api/_lib/discord.js's embed color was
// invisible to it before that was fixed directly. Checked by hand instead.
test('assets/icon.svg (the PWA install icon) carries no retired red literal', () => {
  const svg = read('assets/icon.svg');
  const offenders = RETIRED.filter((lit) => svg.toLowerCase().includes(lit.toLowerCase()));
  assert.deepEqual(offenders, [], `assets/icon.svg still has a retired literal: ${offenders.join(', ')}`);
});

test('red stays a minority of the palette', () => {
  const tot = rows.reduce((a, r) => ({ t: a.t + r.total, r: a.r + r.red }), { t: 0, r: 0 });
  const share = tot.r / tot.t;
  // Was 40.9% before the rebrand. The budget leaves room to add accents but
  // not to drift back toward a red-on-red site.
  assert.ok(share < 0.25, `red is ${(share * 100).toFixed(1)}% of all color literals (budget: 25%)`);
});

// The one deliberate exception to red-only chromatic color: a financial
// ticker's "up" state reads as green everywhere else on the internet, and
// the owner asked for it explicitly (2026-09-02) rather than this being an
// old-palette leftover slipping back in. Scoped to exactly the two literals
// that make it up (dark-mode and light-mode), in exactly the one file.
const TICKER_UP_GREEN = new Set(['assets/live-ticker.js: #3ecf72', 'assets/live-ticker.js: #157a3a']);

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
      if (!isRed(c) && !TICKER_UP_GREEN.has(`${p}: ${c.raw}`)) strays.push(`${p}: ${c.raw}`);
    }
  }
  // Zero, not a tolerance: the system is white/black/red by design, so any
  // chromatic non-red literal is either a leftover from the old palette or a
  // new hue someone added without deciding to. Adding one deliberately means
  // editing this test on purpose — see TICKER_UP_GREEN above for the one
  // case where that has actually happened.
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
  const meta = read('index.html').match(/<meta name="theme-color" content="(#[0-9a-f]{6})">/i);
  assert.ok(meta, 'theme-color meta missing from index.html');
  assert.equal(meta[1].toLowerCase(), LIGHT_BG,
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

test('ticker down/closed states clear WCAG AA against the light-mode ticker background', () => {
  // The "up" green got a light-mode retune (TICKER_UP_GREEN above) but its
  // sibling "down" percentage and the CLOSED session badge did not: both kept
  // the dark-tuned #d14343, which only clears 4.23:1 against the light-mode
  // ticker background (--bg2 #f6f6f7) -- under the 4.5:1 AA floor for text
  // this size. Pin the light-mode overrides to the site's own light-mode red
  // (tokens.css --vjm-red / --vjm-red-soft) so this can't regress silently.
  const ticker = read('assets/live-ticker.js');
  const site = read('assets/site.css');
  const lightBlock = site.match(/body\.light-mode\s*\{([^}]*)\}/)[1];
  const bg2 = hexToRgb(lightBlock.match(/--bg2:\s*(#[0-9a-fA-F]{6})/)[1]);

  const pct = ticker.match(/body\.light-mode #ticker-wrap \.lt-pct\.down\{color:(#[0-9a-fA-F]{6})/);
  assert.ok(pct, 'no light-mode override for .lt-pct.down in assets/live-ticker.js');
  assert.ok(contrast(hexToRgb(pct[1]), bg2) >= 4.5,
    `light-mode .lt-pct.down (${pct[1]}) on --bg2 is ${contrast(hexToRgb(pct[1]), bg2).toFixed(2)}:1`);

  const sess = ticker.match(/body\.light-mode #ticker-wrap \.lt-sess\.sess-cl\{color:(#[0-9a-fA-F]{6})/);
  assert.ok(sess, 'no light-mode override for .lt-sess.sess-cl in assets/live-ticker.js');
  assert.ok(contrast(hexToRgb(sess[1]), bg2) >= 4.5,
    `light-mode .lt-sess.sess-cl (${sess[1]}) on --bg2 is ${contrast(hexToRgb(sess[1]), bg2).toFixed(2)}:1`);
});

test('ticker pre-market/overnight/crypto badges clear WCAG AA against their own composited background', () => {
  // sess-ah/sess-on/sess-247 (PRE-MARKET, AFTER HOURS, OVERNIGHT, 24/7 crypto)
  // paint their own translucent rgba(0,0,0,.05) chip background on top of
  // --bg2, so the text's real background isn't --bg2 itself but that overlay
  // flattened onto it -- which is darker than --bg2 alone. The prior tests
  // above check sess-cl/lt-pct.down against bare --bg2 and that happens to be
  // fine for those (their own overlays are red-tinted, not neutral-darkening
  // enough to matter), but the old #6b6b70 here cleared 4.91:1 against bare
  // --bg2 while only clearing 4.40:1 against its actual composited
  // background -- under the 4.5:1 AA floor for this .54rem/900-weight text,
  // on the only visual indicator of market session state on the homepage
  // ticker. Composite properly so this can't pass on the wrong background.
  const ticker = read('assets/live-ticker.js');
  const site = read('assets/site.css');
  const lightBlock = site.match(/body\.light-mode\s*\{([^}]*)\}/)[1];
  const bg2 = hexToRgb(lightBlock.match(/--bg2:\s*(#[0-9a-fA-F]{6})/)[1]);

  const rule = ticker.match(
    /body\.light-mode #ticker-wrap \.lt-sess\.sess-ah,\s*\n\s*body\.light-mode #ticker-wrap \.lt-sess\.sess-on,\s*\n\s*body\.light-mode #ticker-wrap \.lt-sess\.sess-247\{color:(#[0-9a-fA-F]{6});background:rgba\((\d+),(\d+),(\d+),([\d.]+)\);\}/
  );
  assert.ok(rule, 'no light-mode override for .lt-sess.sess-ah/sess-on/sess-247 in assets/live-ticker.js');
  const [, colorHex, r, g, b, alpha] = rule;
  const ownBg = composite({ r: +r, g: +g, b: +b }, +alpha, bg2);
  const ratio = contrast(hexToRgb(colorHex), ownBg);
  assert.ok(ratio >= 4.5,
    `light-mode .lt-sess.sess-ah/on/247 (${colorHex}) on its own composited background is ${ratio.toFixed(2)}:1`);
});

test('ticker up/down percentages clear WCAG AA against their own theme background, both themes', () => {
  // The prior test above covers light-mode down and the CLOSED badge, but the
  // ticker's own base (dark-mode) rules and light-mode "up" were never pinned:
  // dark #d14343 measured 4.28:1 against #ticker-wrap's own #0c0c0d (below the
  // 4.5:1 AA floor -- the same "wrong red" #d14343/#a63333 draws elsewhere,
  // here on a background dark enough that only --vjm-red-bright clears it),
  // and light-mode #1a8a45 measured 4.08:1 against --bg2 (#f6f6f7) -- both
  // slipped through because assets/live-ticker.js injects its own hardcoded
  // <style> block rather than drawing from tokens.css, so neither the site's
  // contrast audit nor the test above (scoped to the down/closed states) ever
  // covered them.
  const ticker = read('assets/live-ticker.js');
  const site = read('assets/site.css');
  const lightBlock = site.match(/body\.light-mode\s*\{([^}]*)\}/)[1];
  const bg2 = hexToRgb(lightBlock.match(/--bg2:\s*(#[0-9a-fA-F]{6})/)[1]);
  const darkBg = hexToRgb(site.match(/#ticker-wrap\s*\{\s*background:\s*(#[0-9a-fA-F]{6})/)[1]);

  const darkDown = ticker.match(/(?<!body\.light-mode )#ticker-wrap \.lt-pct\.down\{color:(#[0-9a-fA-F]{6})/);
  assert.ok(darkDown, 'no base (dark-mode) rule for .lt-pct.down in assets/live-ticker.js');
  assert.ok(contrast(hexToRgb(darkDown[1]), darkBg) >= 4.5,
    `dark-mode .lt-pct.down (${darkDown[1]}) on #ticker-wrap's background is ${contrast(hexToRgb(darkDown[1]), darkBg).toFixed(2)}:1`);

  const lightUp = ticker.match(/body\.light-mode #ticker-wrap \.lt-pct\.up\{color:(#[0-9a-fA-F]{6})/);
  assert.ok(lightUp, 'no light-mode override for .lt-pct.up in assets/live-ticker.js');
  assert.ok(contrast(hexToRgb(lightUp[1]), bg2) >= 4.5,
    `light-mode .lt-pct.up (${lightUp[1]}) on --bg2 is ${contrast(hexToRgb(lightUp[1]), bg2).toFixed(2)}:1`);
});

test('the "LIVE" badge fades into the light-mode ticker background, not the dark one', () => {
  // injectStyles() paints the pulsing "LIVE" badge with a gradient that fades
  // from an opaque swatch to transparent so it blends into #ticker-wrap
  // behind it -- but that swatch was hardcoded to the dark-mode ticker
  // background (#0c0c0d) with no `body.light-mode` restatement, unlike every
  // other selector in this same injected block (.lt-cell/.lt-label/.lt-price
  // /.lt-pct/.lt-sess all got one). site.css repaints #ticker-wrap itself to
  // --bg2 in light mode (line ~1135), so the badge sat as a solid black box
  // with light-gray text at the left edge of an otherwise white/light tape
  // on every light-mode visit -- confirmed by rendering the real markup in a
  // headless browser before this fix landed. Pin both the swatch and the dot
  // to the site's own light-mode tokens so this can't regress silently.
  const ticker = read('assets/live-ticker.js');
  const site = read('assets/site.css');
  const lightBlock = site.match(/body\.light-mode\s*\{([^}]*)\}/)[1];
  const bg2Hex = lightBlock.match(/--bg2:\s*(#[0-9a-fA-F]{6})/)[1];

  const badge = ticker.match(/body\.light-mode #ticker-wrap \.lt-live\{background:([^;]+);color:(#[0-9a-fA-F]{6})/);
  assert.ok(badge, 'no light-mode override for .lt-live in assets/live-ticker.js');
  assert.ok(badge[1].toLowerCase().includes(bg2Hex.toLowerCase()),
    `light-mode .lt-live background (${badge[1]}) does not fade from site.css's own --bg2 (${bg2Hex}) -- it is still the dark-mode swatch`);
  assert.doesNotMatch(badge[1], /#0c0c0d/i,
    'light-mode .lt-live still carries the dark-mode #0c0c0d swatch');
  assert.ok(contrast(hexToRgb(badge[2]), hexToRgb(bg2Hex)) >= 4.5,
    `light-mode .lt-live text (${badge[2]}) on --bg2 is ${contrast(hexToRgb(badge[2]), hexToRgb(bg2Hex)).toFixed(2)}:1`);

  const dot = ticker.match(/body\.light-mode #ticker-wrap \.lt-live \.dot\{background:(#[0-9a-fA-F]{6})/);
  assert.ok(dot, 'no light-mode override for .lt-live .dot in assets/live-ticker.js');
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

// The Market Assistant widget (assets/chatbot.js) loads on 15 of the site's
// 16 pages and, unlike every other themed component (site.css, curriculum.css,
// tokens.css, this file's own sibling assets/live-ticker.js), shipped with no
// `body.light-mode` restatement anywhere -- every color in its injected style
// block was tuned for dark mode only, on a site whose own default theme is
// light. Two concrete, testable results on a default, unmodified visit: the
// whole panel rendered as an opaque dark island over an otherwise white page,
// and the FAB button's own `:focus-visible` outline (#d9d9dd, a near-white
// light gray) sat at ~1.4:1 contrast against a light page -- under WCAG
// 1.4.11/2.4.7's 3:1 floor for a visible non-text focus indicator, so a
// keyboard user tabbing to the assistant button on any page got no visible
// confirmation it was focused. These tests pin the fix at both levels: every
// selector that carries a hardcoded color in the dark block must have a
// `body.light-mode` counterpart, and the specific outline/text colors chosen
// must actually clear WCAG AA/the 3:1 UI-component floor, not just exist.
test('the chatbot widget FAB focus outline is visible against a light-mode page', () => {
  const chatbot = read('assets/chatbot.js');
  const m = chatbot.match(/body\.light-mode \.vjm-chat-fab:focus-visible\{outline-color:(#[0-9a-fA-F]{6})/);
  assert.ok(m, 'no light-mode outline-color override for .vjm-chat-fab:focus-visible in assets/chatbot.js');
  const ratio = contrast(hexToRgb(m[1]), hexToRgb('#ffffff'));
  assert.ok(ratio >= 3,
    `light-mode .vjm-chat-fab:focus-visible outline (${m[1]}) on white is ${ratio.toFixed(2)}:1 -- ` +
    'under the WCAG 1.4.11/2.4.7 3:1 floor for a visible focus indicator');
});

test('every hardcoded chatbot widget selector has a light-mode restatement', () => {
  const chatbot = read('assets/chatbot.js');
  // Selectors from the dark-tuned block above the light-mode section that
  // carry a literal color (background/border/color), each of which must
  // reappear as `body.light-mode <selector>{...}` further down the file.
  const SELECTORS = [
    '.vjm-chat-panel', '.vjm-chat-head', '.vjm-chat-close', '.vjm-msg-bot',
    '.vjm-msg-bot.data', '.vjm-topic-btn', '.vjm-cite', '.vjm-support-links a',
    '.vjm-chat-form', '.vjm-chat-input', '.vjm-chat-foot',
  ];
  const missing = SELECTORS.filter((sel) => {
    const re = new RegExp(`body\\.light-mode ${sel.replace(/[.]/g, '\\.')}\\{`);
    return !re.test(chatbot);
  });
  assert.deepEqual(missing, [], `no body.light-mode restatement for: ${missing.join(', ')}`);
});

test('chatbot widget light-mode text colors clear WCAG AA against their own backgrounds', () => {
  const chatbot = read('assets/chatbot.js');
  const white = hexToRgb('#ffffff');
  // .vjm-chat-panel/.vjm-chat-head/.vjm-msg-bot/.vjm-topic-btn all resolve to
  // an (almost imperceptible) black-overlay-on-white background in light
  // mode, so white is the correct backdrop to check every text color against.
  const CASES = [
    { sel: '.vjm-chat-head', prop: 'color' },
    { sel: '.vjm-chat-close', prop: 'color' },
    { sel: '.vjm-msg-bot', prop: 'color' },
    { sel: '.vjm-msg-bot\\.data', prop: 'color' },
    { sel: '.vjm-topic-btn', prop: 'color' },
    { sel: '.vjm-cite', prop: 'color' },
    { sel: '.vjm-support-links a', prop: 'color' },
    { sel: '.vjm-chat-input', prop: 'color' },
    { sel: '.vjm-chat-foot', prop: 'color' },
  ];
  for (const { sel, prop } of CASES) {
    const block = chatbot.match(new RegExp(`body\\.light-mode ${sel}\\{([^}]*)\\}`));
    assert.ok(block, `no body.light-mode block for ${sel}`);
    const m = block[1].match(new RegExp(`(?<![-\\w])${prop}:(#[0-9a-fA-F]{6})`));
    if (!m) continue; // .vjm-chat-foot only restates its border in this block; color was already AA-clean unchanged
    const ratio = contrast(hexToRgb(m[1]), white);
    assert.ok(ratio >= 4.5, `light-mode ${sel} ${prop} (${m[1]}) on white is ${ratio.toFixed(2)}:1`);
  }
  // .vjm-chat-foot's color was left at its original dark-mode literal
  // (#6f6f76) because it already clears AA on white (4.99:1) -- pin that so a
  // future edit to either value can't silently drop it back under the floor.
  const footColor = chatbot.match(/\.vjm-chat-foot\{[^}]*color:(#[0-9a-fA-F]{6})/)[1];
  assert.ok(contrast(hexToRgb(footColor), white) >= 4.5,
    `.vjm-chat-foot's unchanged color (${footColor}) no longer clears AA on a light-mode background`);
});

// premium-guidance.html carries its own inline :root/body.light-mode palette
// instead of assets/site.css's shared tokens (same pattern as stock-lab.html
// and forex-calendar.html), so the shared-token test above never sees it.
// Its dark --muted had drifted to #6f6f76 -- the project's own "muted on a
// LIGHT background" constant (see .vjm-chat-foot above) -- instead of the
// #9a9aa0 every sibling dark-mode page uses, landing at 3.92:1 on --bg
// (#0c0c0d) against a 4.5:1 floor. Automated contrast/axe sweeps never
// caught it because the two sections using --muted (#lesson-coverage,
// the Lesson Assistant/AI Trend Analyst disclaimers) carry `hidden` in the
// markup and only unhide after a real signed-in session check passes.
test("premium-guidance.html's own inline --muted clears WCAG AA against --bg in both themes", () => {
  const html = read('premium-guidance.html');
  const darkBlock = html.match(/:root\{([^}]*)\}/)[1];
  const lightBlock = html.match(/body\.light-mode\{([^}]*)\}/)[1];
  const varOf = (src, name) => {
    const m = src.match(new RegExp(`--${name}:(#[0-9a-fA-F]{3,8})`));
    return m ? hexToRgb(m[1]) : null;
  };
  for (const [block, label] of [[darkBlock, 'dark'], [lightBlock, 'light']]) {
    const bg = varOf(block, 'bg'), muted = varOf(block, 'muted');
    assert.ok(bg && muted, `${label}: premium-guidance.html's own --bg/--muted must be declared as hex`);
    const ratio = contrast(muted, bg);
    assert.ok(ratio >= 4.5, `${label}: premium-guidance.html's own --muted on --bg is ${ratio.toFixed(2)}:1`);
  }
});

// options-lab.html's own inline :root block declares dark --gold as #e26060
// (this file's own --red literal, a copy-paste mixup -- every sibling
// curriculum page's dark --gold is #d14343). That literal is dead on arrival
// in the real page, though: assets/curriculum.css is <link>ed AFTER this
// inline <style> block closes and its own :root also declares --gold
// (#d14343), so with equal specificity the normal CSS cascade (later source
// wins on a tie) silently overrides the inline value for every element on
// the page -- confirmed by actually rendering the file in a headless browser
// and reading getComputedStyle(document.documentElement) rather than trusting
// either file's text in isolation. So .tab-btn.active's white text was never
// really sitting on #e26060 at 3.46:1; the live background was always
// #d14343 at 4.57:1, already clearing the 4.5:1 AA floor. A prior cycle's fix
// (commit 38937368929) didn't know that and swapped the button to --gold2
// instead, believing it was escaping a live failure -- that swap is harmless
// (6.68:1 dark / 9.24:1 light) and this test keeps pinning it, but treat the
// inline #e26060 as shadowed dead weight, not a bug to re-derive: a direct
// re-read of this page's own :root block alone will keep saying --gold is
// "wrong" when the cascade has already corrected every consumer of it back
// to #d14343. That correction is exactly what exposes a real failure
// elsewhere, though -- see the SVG-label test below: this page's "Zero Gamma
// Flip" chart annotation also used var(--gold), and the real, cascade-
// corrected #d14343 only clears 3.95:1 against this page's --card
// background, still under the 4.5:1 text floor. --gold was never safe to use
// as foreground text color on --card in this file; --gold-ink was already
// the token reserved for that role everywhere else on the page.
test("options-lab.html's .tab-btn.active uses --gold2, which clears WCAG AA for white text in both themes", () => {
  const html = read('options-lab.html');
  assert.match(html, /\.tab-btn\.active\s*\{\s*background:\s*var\(--gold2\)/,
    'options-lab.html .tab-btn.active must paint its background from --gold2, not --gold');

  const darkBlock = html.match(/:root\s*\{([^}]*)\}/)[1];
  const lightBlock = html.match(/body\.light-mode\s*\{([^}]*)\}/)[1];
  const varOf = (src, name) => {
    const m = src.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})`));
    return m ? hexToRgb(m[1]) : null;
  };
  const white = hexToRgb('#ffffff');
  for (const [block, label] of [[darkBlock, 'dark'], [lightBlock, 'light']]) {
    const gold2 = varOf(block, 'gold2');
    assert.ok(gold2, `${label}: options-lab.html's own --gold2 must be declared as hex`);
    const ratio = contrast(white, gold2);
    assert.ok(ratio >= 4.5, `${label}: options-lab.html's white-on-gold2 is ${ratio.toFixed(2)}:1`);
  }
});

// Resolves --gold-ink/--card the way a real browser does: assets/curriculum.css
// loads after this page's own inline <style> and wins any shared custom
// property on a specificity tie (see the comment above), so a value found
// only in this page's own :root block, like the two tests above used to do
// for --gold, can be dead on arrival. last-match-wins over the inline block
// followed by curriculum.css's block mirrors that cascade order directly
// instead of trusting either file's text in isolation.
test('options-lab.html\'s SVG "Zero Gamma Flip" label uses --gold-ink, which clears WCAG AA against --card in both themes', () => {
  const html = read('options-lab.html');
  const css = read('assets/curriculum.css');
  assert.match(html, /<text[^>]*style="fill:var\(--gold-ink\)[^"]*"[^>]*>Zero Gamma Flip<\/text>/,
    'options-lab.html\'s "Zero Gamma Flip" SVG label must paint its fill from --gold-ink, not --gold');

  const blockOf = (re, src) => { const m = src.match(re); return m ? m[1] : ''; };
  const darkBlock = `${blockOf(/:root\s*\{([^}]*)\}/, html)};${blockOf(/:root\s*\{([^}]*)\}/, css)}`;
  const lightBlock = `${blockOf(/body\.light-mode\s*\{([^}]*)\}/, html)};${blockOf(/body\.light-mode\s*\{([^}]*)\}/, css)}`;
  const varOf = (src, name) => {
    const re = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})`, 'g');
    let m, last = null;
    while ((m = re.exec(src))) last = m;
    return last ? hexToRgb(last[1]) : null;
  };
  for (const [block, label] of [[darkBlock, 'dark'], [lightBlock, 'light']]) {
    const goldInk = varOf(block, 'gold-ink'), card = varOf(block, 'card');
    assert.ok(goldInk && card, `${label}: options-lab.html's real cascade-resolved --gold-ink/--card must be declared as hex`);
    const ratio = contrast(goldInk, card);
    assert.ok(ratio >= 4.5, `${label}: options-lab.html's cascade-resolved gold-ink-on-card is ${ratio.toFixed(2)}:1`);
  }
});

// unsubscribe.html's .back/#theme-toggle hover states used the plain
// --vjm-red token (tokens.css's dark value #d14343), which only clears
// 4.28:1 against --vjm-bg (#0c0c0d) -- under the 4.5:1 AA floor, same bug
// class already fixed for live-ticker.js's .lt-pct.down. Hover-only text
// never shows up in an anonymous axe/contrast crawl, which is why this one
// survived. Fixed to --vjm-red-bright, the token the project already uses
// whenever plain --vjm-red fails this exact check (see newsletter.css's own
// comment on the same tradeoff). Pin both themes so a future tokens.css
// retune can't silently reintroduce the failure.
test("unsubscribe.html's hover states use --vjm-red-bright, which clears WCAG AA against --vjm-bg in both themes", () => {
  const html = read('unsubscribe.html');
  const tokens = read('assets/tokens.css');
  const darkBlock = tokens.match(/:root\s*\{([^}]*)\}/)[1];
  const lightBlock = tokens.match(/body\.light-mode\s*\{([^}]*)\}/)[1];
  const varOf = (src, name) => {
    const m = src.match(new RegExp(`--vjm-${name}:\\s*(#[0-9a-fA-F]{3,8})`));
    return m ? hexToRgb(m[1]) : null;
  };

  for (const selector of ['.back:hover', '#theme-toggle:hover']) {
    assert.match(html, new RegExp(`${selector.replace(/[.#]/, '\\$&')}\\{color:var\\(--vjm-red-bright\\)\\}`),
      `unsubscribe.html's ${selector} no longer uses --vjm-red-bright`);
  }

  for (const [block, label] of [[darkBlock, 'dark'], [lightBlock, 'light']]) {
    const bg = varOf(block, 'bg'), redBright = varOf(block, 'red-bright');
    assert.ok(bg && redBright, `${label}: tokens.css's --vjm-bg/--vjm-red-bright must be declared as hex`);
    const ratio = contrast(redBright, bg);
    assert.ok(ratio >= 4.5, `${label}: tokens.css's --vjm-red-bright on --vjm-bg is ${ratio.toFixed(2)}:1`);
  }
});

// site.css's own --border went from #e3e3e6 to #d4d4db (see that file's
// comment on the token) because a white .vjm-card/.card on a white page with
// a near-white border has no visible edge at all. tokens.css's light-mode
// --vjm-border is the same token under a different name for premarket.html's
// and prop-firms.html's .vjm-card instances, and never got the same fix --
// it shipped the pre-fix value, so those two pages' card borders stayed
// effectively invisible (1.28:1) while index.html's identical cards (via
// site.css) read correctly. Pin tokens.css to the same literal site.css
// already ships so a future retune can't silently drop back to the
// pre-fix value on just one of the two files. (Still short of the 3:1 AA
// floor for non-text UI boundaries, same as site.css's own fix -- a true
// pass would need a materially darker gray, an owner-level design call
// this isn't; this closes the propagation gap, not the full AA finding.)
test("tokens.css's light-mode --vjm-border matches site.css's already-fixed --border literal", () => {
  const tokens = read('assets/tokens.css');
  const site = read('assets/site.css');
  const lightBlock = tokens.match(/body\.light-mode\s*\{([^}]*)\}/)[1];
  const vjmBorder = lightBlock.match(/--vjm-border:\s*(#[0-9a-fA-F]{3,8});/);
  const siteBorderBlock = site.match(/body\.light-mode\s*\{([^}]*)\}/)[1];
  const siteBorder = siteBorderBlock.match(/--border:\s*(#[0-9a-fA-F]{3,8});/);
  assert.ok(vjmBorder && siteBorder, 'both --vjm-border (tokens.css) and --border (site.css) must be declared as hex');
  assert.equal(vjmBorder[1].toLowerCase(), siteBorder[1].toLowerCase(),
    `tokens.css's light-mode --vjm-border (${vjmBorder[1]}) no longer matches site.css's --border (${siteBorder[1]})`);

  const card = hexToRgb('#ffffff');
  const ratio = contrast(hexToRgb(vjmBorder[1]), card);
  assert.ok(ratio > contrast(hexToRgb('#e3e3e6'), card),
    'the fixed --vjm-border must be a visible improvement over the retired #e3e3e6 value, not a lateral change');
});
