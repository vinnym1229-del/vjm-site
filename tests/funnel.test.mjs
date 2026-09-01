// Funnel instrumentation tests.
//
// The site shipped with no on-site conversion measurement at all — no gtag, no
// dataLayer, no event call anywhere — so nobody could say where a buyer
// dropped out, and no copy or pricing change was measurable. assets/funnel.js
// is the event layer that fixes that, and the homepage is instrumented against
// it. Other pages (the four courses) are being instrumented against the SAME
// window.vjmTrack contract, so these tests pin the contract itself, not just
// the current markup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const funnelSrc = read('assets/funnel.js');
const index = read('index.html');
const indexMarkup = index.replace(/<!--[\s\S]*?-->/g, '');

/** Values cross a vm realm boundary, so compare structure, not prototypes. */
const plain = (v) => JSON.parse(JSON.stringify(v));

/** Enough of a browser for the IIFE to install itself. */
function load({ queue, storage = true, search = '' } = {}) {
  const listeners = {};
  const store = new Map();
  const sandbox = {
    console: { log() {}, warn() {} },
    document: {
      readyState: 'complete',
      addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
      querySelectorAll: () => [],
    },
    location: { search, pathname: '/' },
    sessionStorage: storage
      ? { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) }
      : { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } },
  };
  sandbox.window = sandbox;
  if (queue) sandbox.vjmTrackQueue = queue;
  vm.createContext(sandbox);
  vm.runInContext(funnelSrc, sandbox);
  return { win: sandbox, listeners };
}

test('window.vjmTrack exists, buffers, and ships with the first-party sink live', () => {
  const { win } = load();
  assert.equal(typeof win.vjmTrack, 'function');
  // The sink is now live by default and first-party: events go to this site's
  // own /api/analytics, not to a vendor. setSink(null) turns collection off
  // without touching a single page.
  assert.equal(win.vjmFunnel.hasSink(), true, 'collection ships enabled');
  win.vjmFunnel.setSink(null);
  assert.equal(win.vjmFunnel.hasSink(), false, 'setSink(null) must disable collection entirely');
  win.vjmTrack('plan_cta', { plan: 'complete' });
  const events = win.vjmFunnel.events();
  assert.equal(events.length, 1);
  assert.equal(events[0].name, 'plan_cta');
  assert.deepEqual(plain(events[0].props), { plan: 'complete' });
});

test('vjmTrack never throws, whatever it is handed', () => {
  const { win } = load();
  const cyclic = {}; cyclic.self = cyclic;
  for (const args of [[], [null], [''], [42], [{}], ['e', null], ['e', 'str'], ['e', cyclic], ['e', { fn() {} }]]) {
    assert.doesNotThrow(() => win.vjmTrack(...args));
  }
  // Only the well-formed calls are recorded, and non-primitive props dropped.
  const names = win.vjmFunnel.events().map((e) => e.name);
  assert.deepEqual(plain(names), ['e', 'e', 'e', 'e']);
  assert.deepEqual(plain(win.vjmFunnel.events().pop().props), {});
});

test('a sink installed later still receives everything already buffered', () => {
  const { win } = load();
  win.vjmTrack('lock_view', { course: 'options-lab' });
  const seen = [];
  assert.equal(win.vjmFunnel.setSink((name, props) => seen.push([name, props])), true);
  assert.deepEqual(plain(seen), [['lock_view', { course: 'options-lab' }]]);
  win.vjmTrack('whop_checkout', { plan: 'complete' });
  assert.equal(seen.length, 2);
});

test('a provider that throws cannot break the page it measures', () => {
  const { win } = load();
  win.vjmFunnel.setSink(() => { throw new Error('vendor blew up'); });
  assert.doesNotThrow(() => win.vjmTrack('plan_cta', { plan: 'futures_core' }));
  assert.equal(win.vjmFunnel.events().length, 1, 'the event is still buffered locally');
});

test('calls made before the script loads are queued and drained', () => {
  // The three shapes the head shim and hand-written callers can produce.
  const queue = [
    ['free_course_start', { location: 'hero' }],
    { name: 'lock_view', props: { course: 'stock-breakdown' } },
    'google_link',
    null,
  ];
  const { win } = load({ queue });
  assert.deepEqual(
    plain(win.vjmFunnel.events().map((e) => e.name)),
    ['free_course_start', 'lock_view', 'google_link'],
  );
  assert.equal(win.vjmTrackQueue.length, 0, 'the queue must be emptied so nothing is counted twice');
});

test('blocked sessionStorage does not break tracking', () => {
  const { win } = load({ storage: false });
  assert.doesNotThrow(() => win.vjmTrack('plan_cta', {}));
  assert.equal(win.vjmFunnel.events().length, 1);
  assert.ok(win.vjmFunnel.visitId().length > 1, 'falls back to a memory-only visit id');
});

test('the buffer is capped so a long session cannot grow without bound', () => {
  const { win } = load();
  for (let i = 0; i < 400; i++) win.vjmTrack('e' + i, {});
  const events = win.vjmFunnel.events();
  assert.ok(events.length <= 200, `buffer grew to ${events.length}`);
  assert.equal(events[events.length - 1].name, 'e399', 'the newest events are the ones kept');
});

test('collection is first-party only: no vendor, no cross-origin request', () => {
  // The funnel is measured in the owner's own D1 via /api/analytics. That is
  // what keeps the CSP unchanged, keeps visitor data on this account, and
  // means there is no processor to disclose. A vendor tag creeping in here
  // would quietly undo all three.
  for (const bad of ['googletagmanager', 'plausible.io', 'segment.com', 'mixpanel', 'google-analytics', "createElement('script')"]) {
    assert.ok(!funnelSrc.includes(bad), `funnel.js must not reference ${bad}`);
  }
  const code = funnelSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // Every request target in the executable file must be same-origin and root
  // relative -- no absolute URL, no protocol, no other host.
  const targets = [...code.matchAll(/(?:fetch|sendBeacon)\(\s*([A-Za-z_$][\w$]*|'[^']*')/g)].map((m) => m[1]);
  assert.ok(targets.length >= 2, 'expected the analytics endpoint and the lead stub');
  for (const t of targets) {
    assert.ok(!/^'https?:/.test(t) && !t.includes('//'), `request target must be same-origin, got ${t}`);
  }
  assert.match(code, /var ENDPOINT = '\/api\/analytics';/, 'the analytics endpoint is same-origin and root-relative');
  assert.equal((code.match(/XMLHttpRequest|new Image\(/g) || []).length, 0, 'no pixel or XHR smuggling');
  // The old "no provider chosen" TODO is gone precisely because one is wired.
  assert.doesNotMatch(funnelSrc, /TODO: owner to choose an analytics provider/);
});

test('lead capture points at the site\'s own endpoint and never reports a signup it did not make', async () => {
  // This used to assert the opposite — LEAD_ENDPOINT shipped empty because no
  // mailing backend existed and inventing one was not funnel.js's call. One
  // exists now (functions/api/newsletter/subscribe.js), same-origin, with the
  // list in the owner's own D1, so the helper is wired to it. What has NOT
  // changed is the part that matters: it still never claims a signup it did
  // not get.
  const { win } = load();
  assert.equal(win.vjmLead.configured(), true);
  assert.match(funnelSrc, /var LEAD_ENDPOINT = '\/api\/newsletter\/subscribe';/,
    'same-origin and root-relative — never a third-party form host');
  assert.doesNotMatch(funnelSrc, /TODO: owner to connect\. LEAD_ENDPOINT/);

  // Rejected before any request is made, so a typo or an unticked box cannot
  // reach the endpoint and cannot be reported as success.
  assert.deepEqual(plain(await win.vjmLead.submit('nope', { consent: true })), { ok: false, reason: 'invalid_email' });
  assert.deepEqual(plain(await win.vjmLead.submit('', { consent: true })), { ok: false, reason: 'invalid_email' });
  assert.deepEqual(plain(await win.vjmLead.submit('reader@example.com', {})), { ok: false, reason: 'no_consent' },
    'consent comes from the form; the helper must never supply it');
  assert.deepEqual(plain(await win.vjmLead.submit('reader@example.com', { consent: 'yes' })), { ok: false, reason: 'no_consent' });
});

test('the homepage carries the queue shim and loads the event layer', () => {
  assert.match(index, /window\.vjmTrackQueue\s*=\s*window\.vjmTrackQueue\s*\|\|\s*\[\]/, 'pre-load queue shim missing');
  assert.match(index, /<script src="assets\/funnel\.js" defer><\/script>/);
});

test('every homepage funnel stage the audit named is instrumented', () => {
  const stages = {
    free_course_start: /data-vjm-event="free_course_start"/,
    lock_view: /data-vjm-view="lock_view"/,
    plan_cta: /data-vjm-event="plan_cta"/,
    google_link: /data-vjm-event="google_link"/,
  };
  for (const [stage, re] of Object.entries(stages)) {
    assert.match(indexMarkup, re, `${stage} is not instrumented on the homepage`);
  }
  // whop_checkout is bound to the outbound link itself, so CMS-rendered CTAs
  // are counted too — it lives in funnel.js, not in the markup.
  assert.match(funnelSrc, /WHOP_CHECKOUT: 'whop_checkout'/);
  assert.match(funnelSrc, /whop\\\.com/, 'outbound checkout links must be detected by host');

  // Locked courses carry the tier the server actually enforces.
  assert.match(indexMarkup, /data-vjm-course="stock-breakdown" data-vjm-tier="complete"/);
  assert.match(indexMarkup, /data-vjm-course="options-lab" data-vjm-tier="complete"/);
  assert.match(indexMarkup, /data-vjm-course="psychology-enhancer" data-vjm-tier="futures_core"/);
});

test('each tier has its own CTA carrying its plan', () => {
  // Both CTAs pointed at one generic Whop URL, so a buyer could not choose the
  // tier the backend distinguishes (entitlements.js: futures_core vs complete).
  assert.match(indexMarkup, /id="cta-futures-core"[^>]*data-vjm-plan="futures_core"/);
  assert.match(indexMarkup, /id="cta-complete"[^>]*data-vjm-plan="complete"/);
  assert.match(indexMarkup, /Join Futures Core — \$100\/mo/);
  assert.match(indexMarkup, /Get Complete — \$129\/mo/);
  // The per-plan checkout URLs are not invented — they ship empty and TODO'd.
  assert.match(index, /const WHOP_PLAN_URLS = \{/);
  assert.match(index, /futures_core: '', \/\/ TODO: owner to confirm/);
  assert.match(index, /complete: ''\s+\/\/ TODO: owner to confirm/);
});

test('the trader quiz routes to a real course instead of dead-ending on Retake', () => {
  // The one moment the homepage knows what a visitor wants; it used to end at
  // a Retake button and throw that away.
  assert.match(index, /const quizTracks = \{/);
  for (const page of ['futures-dissection.html', 'stock-breakdown.html', 'options-lab.html', 'psychology-enhancer.html']) {
    assert.ok(index.includes(`href: '${page}'`), `quiz cannot route to ${page}`);
  }
  assert.match(index, /id="quiz-track-cta"/, 'the result needs a real link to the recommended track');
  assert.match(index, /Retake Quiz/, 'Retake stays available as the secondary action');
  // The recommendation is carried on the event, or the routing is unmeasurable.
  assert.match(index, /vjmTrack\('quiz_complete', \{ persona: type, track: rec\.track/);
  // A fourth question is what makes the market track knowable at all.
  assert.match(indexMarkup, /id="q4"/);
  assert.match(indexMarkup, /4 of 4 —/);
  assert.doesNotMatch(indexMarkup, /of 3 —/, 'the question counters must all be updated');
});

test('quiz routing maps answers to the track they imply', () => {
  // Evaluate the shipped mapping rather than a copy of it.
  const src = index.slice(index.indexOf('function recommendTrack'), index.indexOf('function quizAnswer'));
  const recommendTrack = vm.runInNewContext(`(${src.trim()})`);
  assert.equal(recommendTrack('discipline', { 4: 'futures' }).track, 'futures');
  assert.equal(recommendTrack('learning', { 4: 'stocks' }).track, 'stocks');
  assert.equal(recommendTrack('learning', { 4: 'options' }).track, 'options');
  assert.equal(recommendTrack('discipline', { 4: 'process' }).track, 'psychology');
  // Someone who just said they have no loss limit is sent to process first,
  // but their market is still recorded and still offered.
  const gambler = recommendTrack('gambler', { 4: 'options' });
  assert.equal(gambler.track, 'psychology');
  assert.equal(gambler.market, 'options');
  assert.equal(gambler.overridden, true);
});

test('the homepage lead capture cannot claim a signup that did not happen', () => {
  assert.match(index, /function renderQuizLead/);
  // With no collector configured no form is rendered at all.
  assert.match(index, /window\.vjmLead && window\.vjmLead\.configured\(\)/);
  assert.match(index, /There is no email list to join yet/);
  // And every failure path says the address was not saved.
  assert.match(index, /Email signup is not connected yet — your address was not saved\./);
  assert.match(index, /your address was not saved\. Please try again\./);
  // Honest about use, and no third-party form embed.
  assert.match(index, /Used only to send you PJ Trades course and membership emails/);
  assert.doesNotMatch(index, /mailchimp|convertkit|substack|beehiiv|klaviyo/i);
});
