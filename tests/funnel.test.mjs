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
function load({ queue, storage = true, search = '', fetch: fetchImpl } = {}) {
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
  if (fetchImpl) sandbox.fetch = fetchImpl;
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

// Incident: docs/NEWSLETTER.md claims Turnstile is "wired end to end" for all
// four forms feeding /api/newsletter/subscribe, but the homepage quiz's lead
// box (the only one of the four built via vjmLead.submit() rather than a
// static <form class="nl-signup">) never forwarded a token at all. The
// moment an owner sets TURNSTILE_SECRET_KEY, the server requires one
// (functions/api/_lib/turnstile.js: no token is always a fail) and the quiz
// form's every submit would 403 while the other three kept working — a gap
// the docs' own claim hid rather than caught. Fixed by threading a
// turnstileToken through submitLead's payload, same field name and same
// shape the standalone forms already send.
test('lead capture forwards a turnstileToken through to the subscribe endpoint', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, json: async () => ({ ok: true }) };
  };
  const { win } = load({ fetch: fetchImpl });

  await win.vjmLead.submit('reader@example.com', { consent: true, source: 'homepage-quiz', turnstileToken: 'tok-abc' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/newsletter/subscribe');
  assert.equal(calls[0].body.turnstileToken, 'tok-abc', 'the token given to submit() must reach the request body');

  // No token supplied (Turnstile off, or the widget has not produced one
  // yet): the field must still serialise as an empty string, same as the
  // standalone forms' `form.dataset.turnstileToken || ''` -- a stray
  // `undefined` in the JSON body is the kind of thing that is easy to miss
  // in a manual test and awkward for the server to distinguish from "off".
  await win.vjmLead.submit('reader@example.com', { consent: true });
  assert.equal(calls[1].body.turnstileToken, '', 'a missing token must serialise as an empty string, not be omitted');
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
  // Owner request (2026-09-09): the price wraps onto its own line with the
  // star, so the CTA carries a manual <br> between the dash and the price.
  assert.match(indexMarkup, /Get The Trifecta —<br>\$129\/mo/);
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

test('quiz CTA tags the free psychology essay as free_course_start, not lock_view', () => {
  // Evaluate the shipped event-tagging logic rather than a copy of it. The
  // psychology essay is one of only two free things on the whole site
  // (tests/regressions.test.mjs pins that), but every "gambler" persona
  // result and the Q4 "my process needs fixing" answer route rec.track to
  // 'psychology' via mainline (not edge-case) paths, so a stale futures-only
  // check here would tag real free-content clicks as lock_view.
  const start = index.indexOf('const FREE_TRACKS = new Set');
  const end = index.indexOf(';', index.indexOf("cta.setAttribute('data-vjm-event'", start)) + 1;
  const snippet = index.slice(start, end);
  const eventFor = vm.runInNewContext(`(function(rec) {
    const cta = { setAttribute(_, v) { this.event = v; } };
    ${snippet}
    return cta.event;
  })`);
  assert.equal(eventFor({ track: 'futures' }), 'free_course_start');
  assert.equal(eventFor({ track: 'psychology' }), 'free_course_start');
  assert.equal(eventFor({ track: 'stocks' }), 'lock_view');
  assert.equal(eventFor({ track: 'options' }), 'lock_view');
});

// ─────────────────────────────────────────────────────────────────────────
// Declarative auto-binding: handleClick/bindViews/closestWith/propsFrom/
// isWhopLink. This is the mechanism that actually fires plan_cta, lock_view
// and whop_checkout on every page that carries data-vjm-* markup (and the
// only way a CMS-rendered CTA gets counted at all), but nothing above this
// point ever dispatches a click or an intersection through it — every prior
// test drives window.vjmTrack directly. A regression in the ancestor walk,
// the whop-link detector, or the anti-double-count guard on a link that is
// both tagged and outbound would ship with the whole suite green.
// ─────────────────────────────────────────────────────────────────────────

/** A DOM node stub with just enough shape for closestWith's parentNode walk. */
function fakeEl(tagName, attrs = {}, parent = null) {
  return {
    tagName,
    nodeType: 1,
    parentNode: parent,
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null; },
    setAttribute(name, value) { attrs[name] = String(value); },
  };
}

/** Same sandbox as load(), plus a delegated-click listener capture and an
 *  optional fake IntersectionObserver so bindViews can be driven directly. */
function loadWithDom({ viewEls = [], withObserver = false } = {}) {
  const listeners = {};
  const ioInstances = [];
  class FakeIntersectionObserver {
    constructor(cb) { this.cb = cb; this.observed = []; ioInstances.push(this); }
    observe(el) { this.observed.push(el); }
    unobserve(el) { this.observed = this.observed.filter((e) => e !== el); }
  }
  const sandbox = {
    console: { log() {}, warn() {} },
    document: {
      readyState: 'complete',
      addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
      querySelectorAll(sel) { return sel === '[data-vjm-view]' ? viewEls : []; },
    },
    location: { search: '', pathname: '/' },
    sessionStorage: { getItem: () => null, setItem() {} },
  };
  sandbox.window = sandbox;
  if (withObserver) sandbox.IntersectionObserver = FakeIntersectionObserver;
  vm.createContext(sandbox);
  vm.runInContext(funnelSrc, sandbox);
  return { win: sandbox, listeners, ioInstances };
}

test('bindAuto installs exactly one delegated click listener', () => {
  const { listeners } = loadWithDom();
  assert.equal(listeners.click && listeners.click.length, 1);
});

test('clicking a data-vjm-event element fires that stage with its convenience props', () => {
  const { win, listeners } = loadWithDom();
  const seen = [];
  win.vjmFunnel.setSink((name, props) => seen.push([name, props]));
  const btn = fakeEl('BUTTON', { 'data-vjm-event': 'plan_cta', 'data-vjm-plan': 'complete' });
  listeners.click[0]({ target: btn });
  assert.deepEqual(plain(seen), [['plan_cta', { plan: 'complete' }]]);
});

test('a click on a descendant of a tagged element still finds the tag via the ancestor walk', () => {
  const { win, listeners } = loadWithDom();
  const seen = [];
  win.vjmFunnel.setSink((name) => seen.push(name));
  const btn = fakeEl('BUTTON', { 'data-vjm-event': 'plan_cta' });
  const icon = fakeEl('svg', {}, btn); // e.g. an icon rendered inside the CTA
  listeners.click[0]({ target: icon });
  assert.deepEqual(plain(seen), ['plan_cta']);
});

test('malformed data-vjm-props JSON does not break the click; convenience attrs still apply', () => {
  const { win, listeners } = loadWithDom();
  const seen = [];
  win.vjmFunnel.setSink((name, props) => seen.push(props));
  const btn = fakeEl('BUTTON', { 'data-vjm-event': 'plan_cta', 'data-vjm-props': '{not json', 'data-vjm-tier': 'complete' });
  assert.doesNotThrow(() => listeners.click[0]({ target: btn }));
  assert.deepEqual(plain(seen), [{ tier: 'complete' }]);
});

test('clicking an outbound whop.com link auto-fires whop_checkout with no markup needed', () => {
  const { win, listeners } = loadWithDom();
  const seen = [];
  win.vjmFunnel.setSink((name, props) => seen.push([name, props]));
  const link = fakeEl('A', { href: 'https://whop.com/checkout/abc', 'data-vjm-plan': 'complete' });
  listeners.click[0]({ target: link });
  assert.deepEqual(plain(seen), [['whop_checkout', { plan: 'complete', href: 'https://whop.com/checkout/abc' }]]);
});

// This guard (funnel.js: `if (!tagged || tagged.getAttribute('data-vjm-event')
// !== STAGES.WHOP_CHECKOUT)`) exists specifically so a link that is BOTH
// explicitly tagged whop_checkout AND caught by the outbound-host detector
// only ever reports once. Without it, the sitewide checkout conversion count
// would be inflated by exactly one for every anchor that carries the tag.
test('a link explicitly tagged whop_checkout is not double-counted by the outbound-link detector', () => {
  const { win, listeners } = loadWithDom();
  const seen = [];
  win.vjmFunnel.setSink((name) => seen.push(name));
  const link = fakeEl('A', {
    href: 'https://whop.com/checkout/abc',
    'data-vjm-event': 'whop_checkout',
    'data-vjm-plan': 'complete',
  });
  listeners.click[0]({ target: link });
  assert.deepEqual(plain(seen), ['whop_checkout'], 'exactly one event, not two, for a tagged outbound link');
});

test('data-vjm-view elements fire once on intersection, then unobserve themselves', () => {
  const target = fakeEl('DIV', { 'data-vjm-view': 'lock_view', 'data-vjm-course': 'options-lab' });
  const { win, ioInstances } = loadWithDom({ viewEls: [target], withObserver: true });
  assert.equal(ioInstances.length, 1, 'bindViews must construct one observer');
  assert.deepEqual(ioInstances[0].observed, [target]);

  const seen = [];
  win.vjmFunnel.setSink((name, props) => seen.push([name, props]));
  ioInstances[0].cb([{ target, isIntersecting: true }]);
  assert.deepEqual(plain(seen), [['lock_view', { course: 'options-lab' }]]);
  assert.deepEqual(ioInstances[0].observed, [], 'must unobserve once counted, so it stops watching');

  // Scrolling the same element back into view (re-triggering the observer)
  // must not count it a second time.
  ioInstances[0].cb([{ target, isIntersecting: true }]);
  assert.equal(seen.length, 1, 'an already-seen element must not track twice');
});

test('an intersection entry that is not yet intersecting is ignored', () => {
  const target = fakeEl('DIV', { 'data-vjm-view': 'lock_view' });
  const { win, ioInstances } = loadWithDom({ viewEls: [target], withObserver: true });
  win.vjmFunnel.setSink(() => assert.fail('must not track before the element actually intersects'));
  ioInstances[0].cb([{ target, isIntersecting: false }]);
});

test('without IntersectionObserver support, data-vjm-view elements count as seen immediately rather than losing the stage', () => {
  const target = fakeEl('DIV', { 'data-vjm-view': 'quiz_start' });
  const { win } = loadWithDom({ viewEls: [target], withObserver: false });
  const names = win.vjmFunnel.events().map((e) => e.name);
  assert.deepEqual(plain(names), ['quiz_start']);
  assert.equal(target.getAttribute('data-vjm-seen'), '1');
});

test('the homepage lead capture cannot claim a signup that did not happen', () => {
  assert.match(index, /function renderQuizLead/);
  // With no collector configured no form is rendered at all.
  assert.match(index, /window\.vjmLead && window\.vjmLead\.configured\(\)/);
  // The copy for that branch changed with the endpoint: a list exists now, so
  // "there is no email list to join yet" would be false on a live page. What
  // it must still do is decline honestly rather than render a dead form.
  assert.match(index, /Email signup is switched off at the moment/);
  assert.doesNotMatch(index, /There is no email list to join yet/);
  // And every failure path says the address was not saved.
  assert.match(index, /Email signup is not connected yet — your address was not saved\./);
  assert.match(index, /your address was not saved\. Please try again\./);
  // Honest about use, and no third-party form embed.
  assert.match(index, /Used only to send you PJ Trades course and membership emails/);
  assert.doesNotMatch(index, /mailchimp|convertkit|substack|beehiiv|klaviyo/i);
});
