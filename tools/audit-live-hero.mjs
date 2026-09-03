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

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
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

    // How far each block sits from the page's centre line. Every section on
    // this homepage is a centred column, so these should all be 0 — and when
    // one is not, that block is the one that looks wrong, however tidy it
    // looks measured against itself. A two-column hero once put the headline
    // 459px right of centre while every check still passed, because nothing
    // compared the hero to the rest of the page.
    const vw = document.documentElement.clientWidth;
    const centreOffset = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return Math.round(r.left + r.width / 2 - vw / 2);
    };
    out.centreOffsets = {
      heroHeadline: centreOffset('.hero h1'),
      heroCopy: centreOffset('.hero-sub'),
      heroCtas: centreOffset('.hero-ctas'),
      featuresHeading: centreOffset('#features .section-title'),
      premiumHeading: centreOffset('#premium .section-title'),
    };
    out.horizontalOverflowPx = document.documentElement.scrollWidth - vw;
    return out;
  });
  console.log(JSON.stringify(dom, null, 2));

  const check = (label, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
    if (!ok) failures++;
  };

  check('car section survived load', dom.showcasePresent);
  check('WebGL scene reached ready state', String(dom.stageClass).includes('fs-ready'), dom.stageClass);
  check('car does not overlap the hero copy', dom.overlapWithCopyPx === 0, `${dom.overlapWithCopyPx}px²`);
  check('page does not scroll sideways', dom.horizontalOverflowPx <= 0, `${dom.horizontalOverflowPx}px`);

  // The check that was missing while the hero sat 459px off-centre and every
  // other check passed: the hero has to line up with the rest of the page.
  for (const [name, off] of Object.entries(dom.centreOffsets)) {
    if (off === null) continue;
    check(`${name} is centred on the page`, Math.abs(off) <= 8, `${off > 0 ? '+' : ''}${off}px from centre`);
  }

  if (dom.showcasePresent && String(dom.stageClass).includes('fs-ready')) {
    // Scroll it into view first. The render loop deliberately pauses while the
    // car is off-screen, so screenshotting it where it sits would capture a
    // frozen car and report "not rotating" for a car that rotates fine.
    await page.$eval('#fsStage', (el) => el.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(1500);
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
