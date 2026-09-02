// Audit the LIVE hero in a real browser and print hard numbers.
//
// Why this exists: every "it works on my machine" round of the hero/Ferrari
// work was verified against a local static server, and the live site kept
// disagreeing — a CSP header the local server never sent, a :has() selector
// the test browser supported and the real one didn't, a frame rate the
// headless run never reproduced. Local verification cannot see any of that.
// This loads the real deployed URL, in a real browser, and prints measured
// facts: what CSS actually applied, whether the section survived, whether it
// rotates, and where the rendered pixels actually sit inside their frame.
//
// Run it from CI (the sandbox this repo's agent sessions run in has no egress
// to the live domain):  SITE=https://… node tools/audit-live-hero.mjs
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const SITE = process.env.SITE;
if (!SITE) { console.error('SITE env var is required'); process.exit(1); }
const OUT = process.env.OUT_DIR || 'audit-out';
mkdirSync(OUT, { recursive: true });

const WIDTHS = (process.env.WIDTHS || '1920,1512,1280').split(',').map(Number);

const browser = await chromium.launch();
let failures = 0;

for (const width of WIDTHS) {
  console.log(`\n${'='.repeat(70)}\nVIEWPORT ${width}x1000\n${'='.repeat(70)}`);
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message.slice(0, 200)));
  page.on('console', (m) => {
    const t = m.text();
    // 404s for third-party embeds are noise; anything mentioning our own
    // assets, WebGL, CSP or the module graph is not.
    if (m.type() === 'error' && /wasm|webgl|three|vendor|ferrari|security policy|module/i.test(t)) {
      errors.push('CONSOLE: ' + t.slice(0, 200));
    }
  });

  const resp = await page.goto(SITE, { waitUntil: 'load', timeout: 60000 });
  console.log('HTTP status:', resp.status());
  const csp = resp.headers()['content-security-policy'] || '(none)';
  console.log('CSP allows wasm:', /wasm-unsafe-eval|unsafe-eval/.test(csp) ? 'YES' : 'NO  <-- car cannot load without this');

  // The model + decoder are a few MB; give them room on CI bandwidth.
  await page.waitForTimeout(12000);

  const dom = await page.evaluate(() => {
    const hero = document.querySelector('.hero');
    const show = document.getElementById('ferrari-showcase');
    const stage = document.getElementById('fsStage');
    const sub = document.querySelector('.hero-sub');
    const link = document.querySelector('link[href*="site.css"]');
    const out = {
      cssHref: link ? link.getAttribute('href') : 'NO STYLESHEET LINK',
      heroClass: hero ? hero.className : 'NO .hero',
      heroDisplay: hero ? getComputedStyle(hero).display : null,
      heroGridColumns: hero ? getComputedStyle(hero).gridTemplateColumns : null,
      showcasePresent: !!show,
      stageClass: stage ? stage.className : 'NO #fsStage (section was removed)',
    };
    if (show && sub) {
      const a = show.getBoundingClientRect();
      const c = sub.getBoundingClientRect();
      const ox = Math.max(0, Math.min(a.right, c.right) - Math.max(a.left, c.left));
      const oy = Math.max(0, Math.min(a.bottom, c.bottom) - Math.max(a.top, c.top));
      out.overlapWithCopyPx = Math.round(ox * oy);
      out.showcaseRect = { x: Math.round(a.x), y: Math.round(a.y), w: Math.round(a.width), h: Math.round(a.height) };
    }
    return out;
  });
  console.log(JSON.stringify(dom, null, 2));

  const check = (label, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
    if (!ok) failures++;
  };

  check('car section survived load', dom.showcasePresent);
  check('WebGL scene reached ready state', String(dom.stageClass).includes('fs-ready'), dom.stageClass);
  check('hero is a two-column grid', dom.heroDisplay === 'grid', `display:${dom.heroDisplay}`);
  check('car does not overlap the hero copy', dom.overlapWithCopyPx === 0, `${dom.overlapWithCopyPx}px²`);

  if (dom.showcasePresent && String(dom.stageClass).includes('fs-ready')) {
    const box = await page.$eval('#fsStage', (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y + window.scrollY, width: r.width, height: r.height };
    });
    await page.screenshot({ path: `${OUT}/w${width}-t0.png`, clip: box, fullPage: true });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: `${OUT}/w${width}-t1.png`, clip: box, fullPage: true });
    console.log(`(saved ${OUT}/w${width}-t0.png and -t1.png, 3s apart, for rotation + centering analysis)`);
  }

  console.log('page errors:', errors.length ? errors : 'none');
  await page.close();
}

await browser.close();
console.log(`\n${failures === 0 ? 'ALL DOM CHECKS PASSED' : failures + ' DOM CHECK(S) FAILED'}`);
process.exit(0); // pixel analysis runs next and owns the final verdict
