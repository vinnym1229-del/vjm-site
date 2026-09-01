#!/usr/bin/env node
/* Find text that is nearly invisible against what is actually behind it.
 *
 * The Buffett quote was white text on a card whose light-mode override
 * repainted the surface and forgot the text. That class of bug is invisible in
 * code review — the override looks complete — and invisible in a test that
 * checks CSS as text, because nothing is missing, something is merely absent.
 * It only shows up once a browser has resolved the cascade.
 *
 * So this renders each page in a real browser, in both themes, walks every
 * element that paints text, resolves the first opaque background BEHIND it
 * (walking up ancestors, compositing alpha as it goes), and reports anything
 * under the WCAG 1.4.3 contrast minimum for its size.
 *
 * Usage:  node tools/contrast-audit.mjs [--min=4.5] [page...]
 * Exits non-zero if anything fails, so it can gate a commit.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const MIN = Number((process.argv.find((a) => a.startsWith('--min=')) || '--min=4.5').slice(6));
const PAGES = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const DEFAULT_PAGES = [
  'index.html', 'prop-firms.html', 'premarket.html', 'unsubscribe.html',
  'privacy.html', 'terms.html', 'risk-disclosure.html', 'forex-calendar.html',
  'premium-guidance.html', 'stock-lab.html', 'options-lab.html',
  'futures-dissection.html', 'psychology-enhancer.html', 'stock-breakdown.html',
  'research-engine.html', '404.html',
];
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.mp4': 'video/mp4', '.ico': 'image/x-icon' };

const server = createServer(async (req, res) => {
  const path = join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  try {
    if (!path.startsWith(ROOT)) throw new Error('escape');
    await stat(path);
    res.writeHead(200, { 'Content-Type': TYPES[extname(path)] || 'application/octet-stream' });
    res.end(await readFile(path));
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// Runs in the page: resolve each text node's real colours and contrast.
const AUDIT = (minRatio) => {
  const lum = ([r, g, b]) => {
    const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const parse = (s) => {
    const m = String(s).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return { rgb: p.slice(0, 3), a: p.length > 3 ? p[3] : 1 };
  };
  const over = (fg, bg, a) => fg.map((c, i) => Math.round(c * a + bg[i] * (1 - a)));

  // The first opaque thing painted behind this element, compositing any
  // translucent layers on the way up. Without this, text on a translucent card
  // is compared against transparent and every result is meaningless.
  // A gradient has no single colour. Pull its stops out and let the caller test
  // against the lightest AND darkest of them: text only fails if it fails
  // against both, which is what stops every button with a gradient fill from
  // being reported as white-on-white.
  const stopsOf = (image) => {
    if (!image || image === 'none') return [];
    return [...image.matchAll(/rgba?\([^)]+\)/g)]
      .map((m) => parse(m[0])).filter((c) => c && c.a > 0.5).map((c) => c.rgb);
  };

  const backdrop = (el) => {
    const stack = [];
    let grad = [];
    for (let n = el; n && n !== document.documentElement.parentNode; n = n.parentElement) {
      const cs = getComputedStyle(n);
      const g = stopsOf(cs.backgroundImage);
      if (g.length && !grad.length) grad = g;
      const c = parse(cs.backgroundColor);
      if (!c || c.a === 0) { if (g.length) break; else continue; }
      stack.push(c);
      if (c.a === 1) break;
    }
    let out = [255, 255, 255];
    for (let i = stack.length - 1; i >= 0; i--) out = over(stack[i].rgb, out, stack[i].a);
    return { base: out, candidates: grad.length ? grad.concat([out]) : [out] };
  };

  const out = [];
  const skipped = [];
  for (const el of document.querySelectorAll('body *')) {
    // Only elements that paint their own visible text.
    const text = [...el.childNodes]
      .filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(' ').trim();
    if (!text) continue;
    // An explicit, reasoned opt-out. Two things this tool genuinely cannot
    // judge: a decorative watermark that is meant to be nearly invisible, and
    // text over an <img> or gradient the computed-style walk cannot see. The
    // reason lives in the markup so an exclusion is reviewable, and the count
    // is reported so exclusions cannot quietly grow.
    if (el.hasAttribute('data-contrast-ignore')) { skipped.push(el.tagName.toLowerCase()); continue; }
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.15) continue;
    const box = el.getBoundingClientRect();
    if (!box.width || !box.height) continue;
    const fg = parse(cs.color);
    if (!fg || fg.a === 0) continue;

    const { base, candidates } = backdrop(el);
    // The best case across every colour that could actually be behind it.
    const r = Math.round(Math.max(...candidates.map(
      (bg) => ratio(over(fg.rgb, bg, fg.a), bg))) * 100) / 100;
    const bg = base;
    const size = parseFloat(cs.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
    const need = large ? Math.max(3, minRatio - 1.5) : minRatio;
    if (r < need) {
      out.push({
        ratio: r, need,
        tag: el.tagName.toLowerCase(),
        cls: (el.getAttribute('class') || '').slice(0, 40),
        color: cs.color, bg: `rgb(${bg.join(',')})`,
        text: text.slice(0, 58),
      });
    }
  }
  return { out, skipped };
};

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
let failures = 0;
let ignored = 0;
for (const page of (PAGES.length ? PAGES : DEFAULT_PAGES)) {
  for (const theme of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    await ctx.addInitScript((t) => localStorage.setItem('st-theme', t), theme);
    // Block every off-origin request. Google Fonts, TradingView and the Google
    // sign-in iframe are not what is being measured, and waiting on them (or
    // on a proxy refusing them) is the difference between a 6-second run and a
    // hang. Fonts falling back changes metrics slightly, never colour.
    await ctx.route('**/*', (route) => {
      route.request().url().startsWith(base) ? route.continue() : route.abort();
    });
    const p = await ctx.newPage();
    let res;
    try {
      res = await p.goto(`${base}/${page}`, { waitUntil: 'load', timeout: 20000 });
    } catch { await ctx.close(); continue; }
    if (!res || !res.ok()) { await ctx.close(); continue; }
    // Let reveal animations settle; hidden-then-shown content must be measured shown.
    await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await p.waitForTimeout(900);
    await p.evaluate(() => window.scrollTo(0, 0));
    await p.waitForTimeout(300);
    const { out: hits, skipped } = await p.evaluate(AUDIT, MIN);
    if (skipped.length) ignored += skipped.length;
    if (hits.length) {
      failures += hits.length;
      console.log(`\n${page}  [${theme}]  ${hits.length} low-contrast`);
      for (const h of hits.sort((a, b) => a.ratio - b.ratio)) {
        console.log(`  ${String(h.ratio).padStart(5)} (need ${h.need})  <${h.tag}${h.cls ? ' .' + h.cls : ''}>  ${h.color} on ${h.bg}`);
        console.log(`         "${h.text}"`);
      }
    }
    await ctx.close();
  }
}
await browser.close();
server.close();
console.log(failures
  ? `\n${failures} low-contrast element(s).`
  : `\nNo text below ${MIN}:1 (3:1 for large text).`);
if (ignored) console.log(`${ignored} element(s) carried data-contrast-ignore and were not measured.`);
process.exitCode = failures ? 1 : 0;
