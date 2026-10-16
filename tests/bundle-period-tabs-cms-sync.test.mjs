// Incident: the same "content-sync replaces a container's innerHTML out from
// under code that binds to it" bug class already fixed once for assets/tilt.js
// (tests/tilt-delegation.test.mjs), but this time it broke pricing display
// instead of a cosmetic hover. index.html's Monthly/6-Month/Yearly/Lifetime
// .period-tabs write into #price-futures/#price-allmarkets/#price-ifvg via
// setBundlePeriod()'s getElementById lookups. When an owner curates bundles
// through the Sheet CMS, loadCmsSections' "4) Bundles" fetch replaces
// #tier-grid's entire innerHTML with cards that carry no price-*/sub-*/cta-*
// ids at all -- the tabs kept toggling their own active/aria-selected state
// (still visibly "working") while every price on screen silently stopped
// responding to them. Fixed by hiding .period-tabs the moment the CMS grid
// replaces the static one, since a single flat-priced CMS bundle has no
// period variant for the tabs to switch between in the first place.
//
// This drives the real loadCmsSections IIFE (extracted verbatim from the
// shipped inline script, not reimplemented) against a fetch stub that only
// answers the bundles endpoint, proving the hide actually happens as a
// consequence of the real bundles-fetch code path, not just asserted statically.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

function extractLoadCmsSections() {
  const html = read('index.html');
  const start = html.indexOf('(function loadCmsSections() {');
  assert.ok(start > -1, 'could not find the loadCmsSections IIFE in index.html');
  const closeMarker = '\n})();';
  const end = html.indexOf(closeMarker, start);
  assert.ok(end > start, 'could not find the loadCmsSections IIFE close');
  return html.slice(start, end + closeMarker.length);
}

// A document stub that only serves #tier-grid and .period-tabs; every other
// CMS section (schedule/team/faq/stats/results) gets a { ok: false } fetch
// response below and returns before touching the DOM at all, so no other id
// or selector needs a stub here.
function makeStub(items) {
  const tierGrid = { id: 'tier-grid', innerHTML: '' };
  const periodTabs = { style: {} };
  const document = {
    getElementById(id) { return id === 'tier-grid' ? tierGrid : null; },
    querySelector(sel) { return sel === '.period-tabs' ? periodTabs : null; },
  };
  function fetchStub(url) {
    const isBundles = String(url).includes('type=bundles');
    return Promise.resolve({
      json: () => Promise.resolve(isBundles ? { ok: true, items } : { ok: false }),
    });
  }
  return { tierGrid, periodTabs, document, fetchStub };
}

async function run(items) {
  const { tierGrid, periodTabs, document, fetchStub } = makeStub(items);
  const context = { document, fetch: fetchStub, console, SocialStats: () => {} };
  vm.createContext(context);
  vm.runInContext(extractLoadCmsSections(), context);
  // Each of the six CMS fetches chains two .then() hops (fetch -> json ->
  // handler); flush enough microtask turns for all of them to settle.
  for (let i = 0; i < 8; i++) await Promise.resolve();
  return { tierGrid, periodTabs };
}

test('CMS bundle cards replacing #tier-grid hides the now-inert billing-period tabs', async () => {
  const { tierGrid, periodTabs } = await run([
    { name: 'Solo Plan', price: '$50', period: 'mo', features: ['One feature'] },
  ]);
  assert.match(tierGrid.innerHTML, /Solo Plan/, 'the bundles fetch should have replaced #tier-grid');
  assert.ok(!/id="price-/.test(tierGrid.innerHTML), 'CMS-rendered cards carry no price-* id for setBundlePeriod to target (sanity check on the bug premise)');
  assert.equal(periodTabs.style.display, 'none', 'the billing-period tabs must be hidden once the CMS cards can no longer respond to them');
});

test('an empty/failed bundles fetch leaves the static tier-grid and its tabs alone', async () => {
  const { tierGrid, periodTabs } = await run([]);
  assert.equal(tierGrid.innerHTML, '', 'no CMS items -> #tier-grid keeps its static fallback markup untouched');
  assert.notEqual(periodTabs.style.display, 'none', 'the tabs stay visible when the static, period-aware tier-grid is still in play');
});

// Same bug class, same loadCmsSections IIFE, different container: the "3) FAQ"
// section replaces #faq-list's innerHTML from the owner's curated Sheet rows,
// but the <head> FAQPage JSON-LD block (#faq-jsonld) that search engines read
// is a separate, static <script> nothing else ever touches -- so without this
// fix, publishing real FAQ rows makes the visible page and the structured data
// permanently disagree about what the FAQs are.
function makeFaqStub(items) {
  const faqList = { id: 'faq-list', innerHTML: '' };
  const faqJsonLd = { id: 'faq-jsonld', textContent: '{"@type":"FAQPage","mainEntity":[{"name":"stale static question"}]}' };
  const document = {
    getElementById(id) {
      if (id === 'faq-list') return faqList;
      if (id === 'faq-jsonld') return faqJsonLd;
      return null;
    },
    querySelector() { return null; },
  };
  function fetchStub(url) {
    const isFaqs = String(url).includes('type=faqs');
    return Promise.resolve({
      json: () => Promise.resolve(isFaqs ? { ok: true, items } : { ok: false }),
    });
  }
  return { faqList, faqJsonLd, document, fetchStub };
}

async function runFaq(items) {
  const { faqList, faqJsonLd, document, fetchStub } = makeFaqStub(items);
  const context = { document, fetch: fetchStub, console, SocialStats: () => {} };
  vm.createContext(context);
  vm.runInContext(extractLoadCmsSections(), context);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  return { faqList, faqJsonLd };
}

test('CMS FAQ rows rebuild the FAQPage JSON-LD to match the new #faq-list, not just the visible accordion', async () => {
  const { faqList, faqJsonLd } = await runFaq([
    { question: 'Do you trade futures or stocks?', answer: 'Futures only.' },
  ]);
  assert.match(faqList.innerHTML, /Do you trade futures or stocks\?/, 'the faqs fetch should have replaced #faq-list');
  const jsonLd = JSON.parse(faqJsonLd.textContent);
  assert.equal(jsonLd.mainEntity.length, 1, 'JSON-LD must carry exactly the owner-published FAQ rows');
  assert.equal(jsonLd.mainEntity[0].name, 'Do you trade futures or stocks?', 'JSON-LD question must match the new visible one');
  assert.equal(jsonLd.mainEntity[0].acceptedAnswer.text, 'Futures only.', 'JSON-LD answer must match the new visible one');
  assert.ok(!faqJsonLd.textContent.includes('stale static question'), 'the old static JSON-LD content must not survive the CMS override');
});

test('an empty/failed faqs fetch leaves the static #faq-list and its JSON-LD alone', async () => {
  const { faqList, faqJsonLd } = await runFaq([]);
  assert.equal(faqList.innerHTML, '', 'no CMS items -> #faq-list keeps its static fallback markup untouched');
  assert.match(faqJsonLd.textContent, /stale static question/, 'no CMS items -> the static JSON-LD is left untouched too');
});
