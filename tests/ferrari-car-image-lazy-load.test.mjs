// The homepage's Ferrari hero (index.html, #ferrari-showcase) ships two
// photographic <img> variants (light/dark theme) instead of the WebGL
// turntable on every browser that reaches the branch at index.html's
// `stage.querySelector('.pj-car-image')` check. Both used to carry a real
// `src` attribute, so the browser's preload scanner fetched both ~145KB
// WebP files unconditionally on every visit -- even under reduced motion,
// where assets/site.css's own `@media (prefers-reduced-motion: reduce)`
// rule hides #ferrari-showcase entirely (display:none never stops an <img>
// src from being fetched), and even on wide screens where only one of the
// two theme variants is ever actually shown. The hydrate gate must NOT also
// skip phones/small tablets: unlike the dead WebGL branch, a higher-
// specificity mobile override in assets/site.css re-enables this
// photographic branch (smaller, reflowed) below 1100px rather than hiding
// it, so gating hydration on that width left most mobile visitors with a
// correctly-visible but permanently empty box (fixed 2026-10-17). This test
// drives the real hydrate script (now keyed off data-src, not src) through
// a minimal sandbox to prove it fetches the right variant for every
// visitor, including narrow ones, and skips fetching only under reduced
// motion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');

const START = '  // Both car photos above are declared with data-src';
const END = '  </script>';
const startIdx = html.indexOf(START);
assert.ok(startIdx !== -1, 'could not locate the car-image hydrate script in index.html');
const endIdx = html.indexOf(END, startIdx);
assert.ok(endIdx !== -1, 'could not locate the end of the car-image hydrate script');
const hydrateSrc = html.slice(startIdx, endIdx);

test('#ferrari-showcase is aria-hidden, not aria-label\'d (a <div> has an implicit role of "generic", which ARIA prohibits from carrying an accessible name -- browsers silently drop the name instead of erroring, so an aria-label here looks intentional but is never actually announced)', () => {
  assert.match(html, /<div id="ferrari-showcase" aria-hidden="true">/,
    'the decorative car showcase must be aria-hidden so assistive tech skips the whole subtree, matching its own .fs-loading/#fsCanvas children');
  const divTag = html.match(/<div id="ferrari-showcase"[^>]*>/)[0];
  assert.doesNotMatch(divTag, /aria-label=/,
    'aria-label on a role-less <div> is a no-op per the ARIA spec (role "generic" prohibits naming) -- it reads as intentional but assistive tech never announces it');
});

test('index.html declares both car <img> tags with data-src, not src, and toggleTheme hydrates the revealed variant', () => {
  assert.match(html, /<img class="pj-car-image pj-car-light" data-src="assets\/ferrari-reference-light\.webp"[^>]*>/);
  assert.match(html, /<img class="pj-car-image pj-car-dark" data-src="assets\/ferrari-reference-dark\.webp"[^>]*>/);
  assert.doesNotMatch(html, /<img class="pj-car-image pj-car-(light|dark)" src=/,
    'a real src on these tags means the browser fetches it unconditionally, defeating the hydrate script entirely');
  assert.match(hydrateSrc, /window\.matchMedia\('\(prefers-reduced-motion: reduce\)'\)/,
    'the hydrate gate must key off reduced-motion only -- unlike the dead WebGL branch, the photographic branch stays visible (reflowed, not hidden) below 1100px per assets/site.css\'s mobile override, so gating on width here leaves the box empty for mobile visitors');
  assert.match(html, /if \(window\.pjHydrateCarImage\) window\.pjHydrateCarImage\(\);/,
    'toggleTheme must hydrate the newly-revealed variant, or switching theme shows a blank frame until next reload');
});

function makeImg(dataSrc) {
  let srcAttr = null;
  return {
    dataset: { src: dataSrc },
    getAttribute: (name) => (name === 'src' ? srcAttr : null),
    set src(v) { srcAttr = v; },
    get src() { return srcAttr; },
  };
}

function run({ hidden, isLight }) {
  const lightImg = makeImg('assets/ferrari-reference-light.webp');
  const darkImg = makeImg('assets/ferrari-reference-dark.webp');
  const changeListeners = [];
  let matches = hidden;
  const mq = {
    get matches() { return matches; },
    addEventListener: (type, cb) => { if (type === 'change') changeListeners.push(cb); },
  };
  const sandbox = {
    document: {
      querySelector: (sel) => (sel === '.pj-car-light' ? lightImg : sel === '.pj-car-dark' ? darkImg : null),
      body: { classList: { contains: (c) => c === 'light-mode' && isLight } },
    },
  };
  sandbox.window = sandbox;
  sandbox.window.matchMedia = () => mq;
  vm.createContext(sandbox);
  vm.runInContext(hydrateSrc, sandbox, { filename: 'index.html#car-hydrate' });
  return { lightImg, darkImg, setHidden: (v) => { matches = v; changeListeners.forEach((cb) => cb()); } };
}

test('reduced-motion visitors fetch neither car image', () => {
  const { lightImg, darkImg } = run({ hidden: true, isLight: true });
  assert.equal(lightImg.src, null);
  assert.equal(darkImg.src, null);
});

test('a narrow-screen (phone/tablet) light-mode visitor still fetches the light variant -- the photographic branch stays visible, just reflowed, below 1100px', () => {
  const { lightImg, darkImg } = run({ hidden: false, isLight: true });
  assert.equal(lightImg.src, 'assets/ferrari-reference-light.webp',
    'the mobile CSS override makes #ferrari-showcase visible (smaller, below the copy) rather than hiding it, so a narrow visitor must still get the image');
  assert.equal(darkImg.src, null, 'the dark variant is never shown for this visitor and must not be fetched');
});

test('a wide-screen light-mode visitor (the site default) fetches only the light variant', () => {
  const { lightImg, darkImg } = run({ hidden: false, isLight: true });
  assert.equal(lightImg.src, 'assets/ferrari-reference-light.webp');
  assert.equal(darkImg.src, null, 'the dark variant is never shown for this visitor and must not be fetched');
});

test('a wide-screen dark-mode visitor fetches only the dark variant', () => {
  const { lightImg, darkImg } = run({ hidden: false, isLight: false });
  assert.equal(darkImg.src, 'assets/ferrari-reference-dark.webp');
  assert.equal(lightImg.src, null, 'the light variant is never shown for this visitor and must not be fetched');
});

test('turning Reduce Motion off after load (section starts hidden, then becomes visible) still hydrates the image', () => {
  const { lightImg, setHidden } = run({ hidden: true, isLight: true });
  assert.equal(lightImg.src, null, 'sanity: nothing fetched while still hidden');
  setHidden(false);
  assert.equal(lightImg.src, 'assets/ferrari-reference-light.webp',
    'the mq "change" listener must hydrate once the section actually becomes visible, or a visitor who turns Reduce Motion off mid-session sees a blank frame');
});
