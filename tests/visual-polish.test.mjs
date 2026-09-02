// Visual polish + assistant wiring contract tests (pj branch).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// Homepage CSS now lives in assets/site.css (extracted for caching);
// concatenate so pattern assertions keep covering markup + styles.
const siteCss = read('assets/site.css');
const index = read('index.html') + siteCss;
const guidance = read('premium-guidance.html');
const propFirms = read('prop-firms.html');

test('liquid system extends across the page sections', () => {
  const instances = [...index.matchAll(/class="liquid-bg[^"]*"/g)].length;
  assert.equal(instances, 5, `expected liquid-bg in hero, features, premium, faq, about — found ${instances}`);
  assert.ok(/<section id="premium"[^>]*>\s*<div class="liquid-bg soft"/.test(index), '#premium must open with its own scoped liquid-bg');
  assert.ok(/<section id="about"[^>]*>\s*<div class="liquid-bg soft"/.test(index), '#about must open with its own scoped liquid-bg');
});

test('blob budget respected and sections scope their blobs', () => {
  const blobs = [...index.matchAll(/class="liquid-blob /g)].length;
  assert.ok(blobs <= 9, `perf budget: max 3+2+2+1+1 blobs, found ${blobs}`);
  // New sections must clip their blobs so nothing bleeds into neighbors.
  assert.match(index, /#premium, #about, #features, #faq \{ position:relative; overflow:hidden; \}/);
});

test('reduced-motion guard covers every blob instance', () => {
  const css = siteCss;
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\{\.liquid-blob\{animation:none!important;\}\}/);
});

test('scroll-reveal is progressive enhancement (no-JS keeps content visible)', () => {
  // Content must NOT be hidden by default CSS; hiding is JS-only.
  assert.doesNotMatch(index, /\[data-reveal\][^}]*opacity:\s*0/);
  // Hidden state is added by JS only…
  assert.match(index, /el\.classList\.add\('reveal-init'\)/);
  // …and never when IntersectionObserver or motion safety is missing.
  assert.match(index, /!reduced && !\('IntersectionObserver' in window\)|if \(reduced \|\| !\('IntersectionObserver' in window\)\) return/);
  assert.match(index, /prefers-reduced-motion: reduce/, 'reveal JS/CSS must reference reduced-motion guard');
});

test('scroll-reveal animation stays subtle', () => {
  assert.match(index, /\.reveal-init\{opacity:0;transform:translateY\(12px\);\}/);
  assert.match(index, /transition:opacity \.4s ease-out, transform \.4s ease-out/);
});

test('floating market assistant is wired into member-facing pages', () => {
  for (const page of ['index.html', 'stock-lab.html', 'options-lab.html', 'forex-calendar.html', 'premarket.html', 'prop-firms.html']) {
    assert.match(read(page), /<script src="assets\/chatbot\.js" defer><\/script>/, `${page} should load the chatbot widget`);
  }
});

test('lesson companion is bound to a server-held lesson, not browser text', () => {
  const assistant = read('functions/api/assistant.js');
  assert.match(guidance, /id="lesson-companion"/);
  assert.match(guidance, /hidden>/, 'lesson companion must be hidden until premium is verified');
  // The page names a lesson; it never ships lesson prose to the endpoint.
  assert.match(guidance, /lessonId:\s*lesson\.id/, 'must send a lesson id so the server does the lookup');
  assert.match(guidance, /lessonVersion:\s*lesson\.version/, 'must pin the immutable lesson version');
  assert.doesNotMatch(guidance, /lessonText\s*[:(]/, 'browser must never send lesson text — that is the LLM-proxy hole');
  assert.match(assistant, /Answer ONLY using the LESSON TEXT/);
  // Entitlement is enforced server-side with the shared tier table.
  assert.match(assistant, /authorizeResource\(session, lesson\.resource, env\)/);
  // Coverage is stated rather than implied: the picker lists what is wired.
  assert.match(guidance, /id="lesson-select"/);
  assert.match(guidance, /id="lesson-coverage"/);
  assert.match(assistant, /coverage:/);
  // Companion must stay hidden until a verified session exists.
  assert.match(guidance, /function showVerifiedCard\(\)[\s\S]*?showLessonCompanion\(\)/);
});

test('prop-firms page states no unverified specifics in code', () => {
  // Directory is owner-data driven; the HTML must not hardcode firms/prices.
  assert.doesNotMatch(propFirms, /(topstep|apex trader|myfundedfutures|mffx|bulenox|takeprofit trader|ftmo|echelon)/i);
  assert.doesNotMatch(propFirms, /\$\d{2,4}\s*\/\s*(mo|month)/i);
  assert.match(propFirms, /rel="noopener noreferrer sponsored"/, 'outbound firm links must be marked sponsored');
  assert.match(propFirms, /TODO: owner to confirm/);
});

test('mobile polish: the three defects reported from a phone stay fixed', () => {
  const html = read('index.html');

  // 1. The play button was the "▶" character, which iOS and Android render as
  //    a colour emoji — it looked like an emoji pasted onto the poster.
  assert.doesNotMatch(html, /class="video-play"[^>]*>\s*<span>[▶►]/u, 'play button must not be a glyph');
  assert.match(html, /class="video-play">[\s\S]{0,400}?<svg[^>]*viewBox="0 0 24 24"/, 'play button must be an inline SVG triangle');
  // …and it was centred, which put it squarely on PJ's face at every width.
  assert.match(siteCss, /\.video-poster\{[^}]*justify-content:flex-end/, 'poster controls sit in the lower third, off the subject');

  // 2. The poster title used var(--text): dark text on the dark end of the
  //    poster gradient, so it was invisible in light mode.
  assert.doesNotMatch(siteCss, /\.video-poster-title\{[^}]*color:var\(--text\)/, 'title must not inherit the theme text colour');
  assert.match(siteCss, /\.video-poster-title\{[^}]*color:#fff/, 'title is white over the poster in both themes');
  assert.match(siteCss, /body\.light-mode \.video-poster-title\{color:#fff;\}/, 'light mode must not repaint it dark');

  // 3. The hero badge was an inline-flex row, so each phrase wrapped on its own
  //    and "5.0", "★ on Whop", the review count and the join count landed on
  //    different lines at different baselines.
  assert.doesNotMatch(siteCss, /\.hero-badge\{[^}]*display:inline-flex/, 'badge must not be a flex row');
  assert.match(siteCss, /\.hero-badge\{[^}]*display:inline-block/);
  assert.match(siteCss, /\.hero-badge \.hb-item\{white-space:nowrap;\}/, 'each figure stays glued to its label');
  // A break may only happen at a separator, so every figure keeps its label.
  for (const [id, label] of [['hb-rating', '★ on Whop'], ['hb-reviews', 'reviews'], ['hb-joined', 'joined']]) {
    assert.match(html, new RegExp(`<span class="hb-item">(?:<span class="pulse-dot"></span>)?<span id="${id}">[^<]+</span>\\s*${label}</span>`),
      `${id} must sit inside a nowrap .hb-item with its own label`);
  }
  // The pulsing dot lives inside the first item so it cannot be orphaned onto
  // a line of its own, which is exactly what it did at 360px.
  assert.match(html, /<span class="hb-item"><span class="pulse-dot"><\/span>/);
});

test('light mode: text that was painted for a dark surface stays repainted', () => {
  // Every item here was measured invisible or near-invisible on the white page
  // by tools/contrast-audit.mjs — colours chosen against a near-black card that
  // were never revisited when light mode became the default. The worst,
  // .course-badge.free, was #ffffff on #ffffff.
  //
  // This test pins the repaints. The audit tool is the real check (it resolves
  // the cascade in a browser, which no string match can), but it needs
  // Playwright, so these assertions keep the fixes from silently reverting in
  // a run that only has node.
  for (const sel of [
    'body\\.light-mode \\.course-badge\\.free',
    'body\\.light-mode \\.course-badge',
    'body\\.light-mode \\.course-cta',
    'body\\.light-mode \\.tier-was',
    'body\\.light-mode #stream-countdown-bar \\.cd-live',
  ]) {
    assert.match(siteCss, new RegExp(sel), `${sel.replace(/\\\\/g, '')} needs a light-mode colour`);
  }
  // The Buffett card's surface was repainted for light mode and its text was
  // not, which is the bug that started this sweep.
  assert.match(siteCss, /body\.light-mode \.buffett-card blockquote\{color:var\(--text\);?\}/);
  assert.match(siteCss, /body\.light-mode \.buffett-card figcaption\{color:var\(--muted\);?\}/);

  // Body-copy links had no colour rule on the legal pages, so they fell back to
  // the browser's #0000EE — unreadable on the dark page.
  for (const page of ['privacy.html', 'terms.html', 'risk-disclosure.html']) {
    assert.match(read(page), /main a,p a,li a\{color:var\(--gold-ink\)/, `${page} must colour body-copy links`);
    assert.doesNotMatch(read(page), /#0000EE/i, 'do not write the default blue as a literal — the palette test reads hex codes');
  }

  // Exclusions from the audit must carry their reason in the markup, so that
  // "the tool passes" can never mean "the tool was told not to look".
  const index = read('index.html');
  for (const m of index.matchAll(/data-contrast-ignore="([^"]*)"/g)) {
    assert.ok(m[1].length > 20, 'every data-contrast-ignore needs a stated reason');
  }
});

test('light mode: the featured card and the page bolts are actually visible', () => {
  // The ring around the Complete card was still the DARK art — a white-hot
  // filament fading to red — which on a white page loses its brightest half.
  assert.match(siteCss, /body\.light-mode \.tier-card\.hot::before\{[\s\S]{0,200}?background-image:/,
    'the featured card needs all-red bolt art in light mode');
  const lightRing = siteCss.slice(siteCss.indexOf('body.light-mode .tier-card.hot::before{'));
  const ringRule = lightRing.slice(0, lightRing.indexOf('\n}'));
  for (const neutral of ['%23ffffff', '%23ededee', '%23c8c8ce']) {
    assert.ok(!ringRule.includes(neutral), `${neutral} must not survive into the light-mode ring`);
  }
  // …and it must not be dimmer than the dark one it replaced.
  assert.match(siteCss, /@keyframes cardBoltFlashLight\{0%\{opacity:\.78;\}/);

  // The page background bolts were tuned against the dark layer and undershot.
  assert.match(read('assets/lightning-bg.js'), /body\.light-mode #site-bolt-layer\{opacity:\.62;\}/);
});

test('the billing tabs clear the featured card\'s bolt ring', () => {
  // The ring bleeds outside the Complete card on purpose, and it reaches
  // upwards by (the card's lift + the bleed). If the gap below the billing
  // tabs is smaller than that reach, the bolts are drawn on top of the tabs —
  // which is exactly what happened at a 36px gap.
  //
  // Derived from the real values rather than pinned to a magic number, so
  // changing the bleed or the lift fails here instead of on the page.
  const lift = Number(/\.tier-card\.hot\{[^}]*transform:translateY\((-?\d+)px\)/.exec(siteCss)[1]);
  const bleed = Number(/\.tier-card\.hot::before\{[^}]{0,120}?inset:var\(--bolt-bleed,(-?\d+)px\)/.exec(siteCss)[1]);
  const gap = Number(/\.period-tabs\{[^}]*margin:0 auto (\d+)px/.exec(siteCss)[1]);
  const reach = -lift + -bleed;
  assert.ok(gap - reach >= 16,
    `the ring reaches ${reach}px above the grid but only ${gap}px of gap sits below the tabs`);

  // That gap must be the WHOLE gap. Adjacent siblings collapse their vertical
  // margins to the larger of the two rather than summing them, so splitting it
  // with .tier-grid's margin-top silently gives back whichever is smaller.
  assert.match(siteCss, /\.tier-grid\{[^}]*margin:0 auto;/,
    'the tier grid must not add a top margin — it would collapse, not add');
});

test('ferrari showcase collapses to a static card under reduced motion and on phones', () => {
  // The pinned 220vh scroll band + 3D rotateY only make sense with a working
  // scrollbar and a visitor who tolerates motion. Both bail-out paths must
  // hold, in CSS (so nothing pins/rotates even if the script fails to load)
  // and in JS (so no rAF loop runs computing a transform nobody sees).
  assert.match(siteCss, /@media \(max-width: 760px\) \{[\s\S]*?\.fs-track \{ height: auto; \}[\s\S]*?\.fs-card \{ transform: none !important;/,
    'phone breakpoint must flatten the track and freeze the card transform');
  assert.match(siteCss, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.fs-track \{ height: auto; \}[\s\S]*?\.fs-card \{ transform: none !important; \}/,
    'reduced-motion must flatten the track and freeze the card transform, same as the phone breakpoint');
  // backface-visibility is the belt-and-suspenders guard against the one
  // photo ever rendering mirrored/backwards if the JS clamp is ever loosened.
  assert.match(siteCss, /\.fs-card \{[\s\S]*?backface-visibility: hidden;/);

  assert.match(index, /var reduced = window\.matchMedia && window\.matchMedia\('\(prefers-reduced-motion: reduce\)'\)\.matches;/);
  assert.match(index, /if \(reduced \|\| !track \|\| !card \|\| window\.innerWidth <= 760\) return;/,
    'the spin script must bail out before touching the DOM under any of these conditions');
});

test('ferrari showcase image ships correct intrinsic dimensions and a real alt text', () => {
  // Same class of bug as the testimonials collage CLS incident: declared
  // width/height must match the actual file, or the browser reserves the
  // wrong box and the page jumps once the real image decodes.
  const declared = /<img src="assets\/pj-ferrari\.jpg" width="(\d+)" height="(\d+)"/.exec(index);
  assert.ok(declared, 'ferrari showcase image must declare width/height');
  const path = join(ROOT, 'assets/pj-ferrari.jpg');
  assert.ok(existsSync(path), 'assets/pj-ferrari.jpg must exist');
  const buf = readFileSync(path);
  let real = null;
  for (let i = 2; i < buf.length; ) {
    if (buf[i] !== 0xFF) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xD8 || marker === 0xD9) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
      real = { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      break;
    }
    i += 2 + len;
  }
  assert.ok(real, 'could not read a JPEG SOF0 frame from assets/pj-ferrari.jpg');
  assert.equal(Number(declared[1]), real.width, 'declared width must match the real file');
  assert.equal(Number(declared[2]), real.height, 'declared height must match the real file');

  // A filename or "photo" is not alt text — a screen reader gets nothing
  // useful from either, and this is a real photo of the owner, not decoration.
  const alt = /<img src="assets\/pj-ferrari\.jpg"[\s\S]{0,120}?alt="([^"]+)"/.exec(index);
  assert.ok(alt, 'ferrari showcase image must have an alt attribute');
  assert.ok(alt[1].length > 15 && !/pj-ferrari|\.jpg/i.test(alt[1]), 'alt text must describe the photo, not name the file');
});

test('the intro video points at the file that actually exists', () => {
  // The facade pointed at /video/pj-intro.mp4 while the file sat committed at
  // assets/pj-intro.mp4. The HEAD check 404'd, so the most prominent element
  // on the homepage told every visitor the video was "dropping here soon"
  // while it was one directory away. A path typo with no error anywhere.
  const html = read('index.html');
  const src = /data-video-mp4="([^"]*)"/.exec(html);
  assert.ok(src, 'the facade must declare a video source');
  const path = src[1].replace(/^\//, '');
  assert.ok(existsSync(join(ROOT, path)), `data-video-mp4 points at ${src[1]}, which does not exist in the repo`);
  // Cloudflare Pages refuses any single file over 25MB, and a video that fails
  // to deploy fails exactly like a wrong path: silently, as "coming soon".
  const mb = statSync(join(ROOT, path)).size / 1e6;
  assert.ok(mb < 25, `${path} is ${mb.toFixed(1)}MB — over Cloudflare Pages' 25MB per-file limit`);
});
