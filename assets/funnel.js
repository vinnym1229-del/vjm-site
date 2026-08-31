/* Funnel event layer — the site's own conversion instrumentation.
 *
 * WHY THIS EXISTS
 * The site shipped with no on-site analytics of any kind: no gtag, no
 * dataLayer, no event calls anywhere. UTM parameters on the outbound Whop
 * links are an attribution tag, not a conversion model — they say where a
 * visitor came from, never where a visitor stopped. So nobody could answer
 * "how many people who saw a locked course ever reached checkout?", and any
 * copy or pricing test was unmeasurable by construction.
 *
 * WHAT THIS IS
 * A sink-agnostic event bus. It records the funnel stages the site cares
 * about into an in-memory buffer and hands them to whatever provider the
 * owner eventually picks. It makes NO network request and loads NO
 * third-party script — that is deliberate:
 *   - no vendor has been chosen, and choosing one is the owner's call
 *     (it is a privacy/GDPR decision, not a code decision), and
 *   - the CSP in `_headers` allows script-src/connect-src from 'self' plus a
 *     named allowlist only, so a vendor tag would be blocked until the owner
 *     deliberately widens it.
 * Until a sink is registered, every call is a silent, harmless no-op that
 * still fills the buffer, so the owner can open the console on the live site
 * and see the real funnel with `vjmFunnel.events()`.
 *
 * PUBLIC CONTRACT (other pages are instrumented against exactly this)
 *   window.vjmTrack(eventName, props = {})
 *     - safe to call before this file loads: the caller pushes onto
 *       window.vjmTrackQueue and this file drains it on load
 *     - never throws, whatever it is handed
 *     - no-ops silently when no sink is configured
 *
 * DECLARATIVE INSTRUMENTATION (no inline JS needed on the pages)
 *   data-vjm-event="plan_cta"   fire on click
 *   data-vjm-view="lock_view"   fire once when the element first scrolls into view
 *   data-vjm-props='{"a":1}'    extra props as JSON
 *   data-vjm-plan / -course / -location / -tier   convenience props
 * Any anchor pointing at whop.com also fires `whop_checkout` automatically,
 * so a CTA rendered later by the CMS is still counted.
 *
 * DEBUGGING: add ?vjmdebug=1 to any URL to console.log every event.
 */
(function () {
  'use strict';

  if (typeof window === 'undefined') return;
  if (window.vjmFunnel && window.vjmFunnel.__installed) return;

  var VERSION = 1;
  var BUFFER_LIMIT = 200;

  /* The funnel stages this site measures. Names are the contract other pages
   * and the course-page instrumentation are written against — renaming one
   * silently breaks a report, so add rather than rename. */
  var STAGES = {
    FREE_COURSE_START: 'free_course_start', // clicked into the free starter course
    LESSON_COMPLETE: 'lesson_complete',     // finished a free lesson (course pages)
    LOCK_VIEW: 'lock_view',                 // saw a members-only lock
    PLAN_CTA: 'plan_cta',                   // clicked a specific plan's CTA
    WHOP_CHECKOUT: 'whop_checkout',         // left the site for Whop checkout
    GOOGLE_LINK: 'google_link',             // headed for Google account sign-in
    QUIZ_START: 'quiz_start',
    QUIZ_COMPLETE: 'quiz_complete',         // carries the recommended track
    LEAD_SUBMIT: 'lead_submit'
  };

  var buffer = [];
  var sink = null;
  var debug = false;

  try {
    debug = /[?&]vjmdebug=1\b/.test(window.location.search || '');
  } catch (e) { /* location unavailable (sandbox) — stay quiet */ }

  /* A random, non-identifying id so the stages of one visit can be joined
   * together in a later report. It is per browser tab (sessionStorage), holds
   * no personal data, and never leaves the browser while no sink exists. */
  var SESSION_KEY = 'vjm_funnel_visit';
  var visitId = null;
  function sessionId() {
    if (visitId) return visitId;
    var id = '';
    try {
      id = window.sessionStorage.getItem(SESSION_KEY) || '';
    } catch (e) { /* storage blocked — fall through to a memory-only id */ }
    if (!id) {
      id = 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      try { window.sessionStorage.setItem(SESSION_KEY, id); } catch (e) { /* memory only */ }
    }
    visitId = id;
    return id;
  }

  /** Props are copied and flattened to primitives: an event must never carry a
   *  live DOM node, a function, or something that cannot be serialised later. */
  function cleanProps(props) {
    var out = {};
    if (!props || typeof props !== 'object') return out;
    var keys;
    try { keys = Object.keys(props); } catch (e) { return out; }
    for (var i = 0; i < keys.length && i < 40; i++) {
      var k = keys[i];
      var v = props[k];
      var t = typeof v;
      if (v === null || t === 'string' || t === 'number' || t === 'boolean') {
        out[k] = t === 'string' && v.length > 300 ? v.slice(0, 300) : v;
      }
    }
    return out;
  }

  function emit(event) {
    if (debug) {
      try { window.console && window.console.log('[vjm-funnel]', event.name, event.props); } catch (e) { /* noop */ }
    }
    if (typeof sink !== 'function') return; // no provider wired: silent no-op
    try {
      sink(event.name, event.props, event);
    } catch (e) {
      /* A broken provider must never break the page it measures. */
      if (debug) {
        try { window.console && window.console.warn('[vjm-funnel] sink threw', e); } catch (e2) { /* noop */ }
      }
    }
  }

  /**
   * window.vjmTrack — the one call every page uses. Never throws.
   */
  function track(name, props) {
    try {
      if (typeof name !== 'string' || !name) return;
      var event = {
        name: name,
        props: cleanProps(props),
        at: new Date().toISOString(),
        visit: sessionId(),
        page: (function () {
          try { return window.location.pathname || ''; } catch (e) { return ''; }
        })()
      };
      buffer.push(event);
      if (buffer.length > BUFFER_LIMIT) buffer.splice(0, buffer.length - BUFFER_LIMIT);
      emit(event);
    } catch (e) { /* instrumentation must never break a page */ }
  }

  /* Drain anything queued before this file parsed. Accepted shapes:
   *   ['plan_cta', {plan:'complete'}]      (the documented shape)
   *   {name:'plan_cta', props:{...}}  /  {event:'plan_cta', props:{...}}
   *   'plan_cta'
   */
  function drainQueue() {
    var q = window.vjmTrackQueue;
    if (!q) return;
    var items = [];
    try { items = Array.prototype.slice.call(q); } catch (e) { items = []; }
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      try {
        if (typeof item === 'string') track(item, {});
        else if (Object.prototype.toString.call(item) === '[object Array]') track(item[0], item[1]);
        else if (item && typeof item === 'object') track(item.name || item.event, item.props || item.properties);
      } catch (e) { /* one malformed entry must not stop the drain */ }
    }
    try { q.length = 0; } catch (e) { /* frozen queue — nothing to do */ }
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * THE ONE PLACE A PROVIDER GETS WIRED IN
   *
   * TODO: owner to choose an analytics provider.
   *
   * Nothing here talks to a network. When you have picked a provider, do
   * BOTH of these and nothing else changes anywhere on the site:
   *   1. add its origin to script-src / connect-src in `_headers` (the CSP
   *      blocks it otherwise, silently), and
   *   2. register the sink, e.g.
   *
   *        vjmFunnel.setSink(function (name, props) {
   *          // plausible:  window.plausible(name, { props: props });
   *          // ga4:        window.gtag('event', name, props);
   *          // own worker: navigator.sendBeacon('<your endpoint>', ...);
   *        });
   *
   * setSink replays everything already buffered, so stages that happened
   * before the provider finished loading are not lost.
   * ───────────────────────────────────────────────────────────────────────── */
  function setSink(fn) {
    if (typeof fn !== 'function') { sink = null; return false; }
    sink = fn;
    for (var i = 0; i < buffer.length; i++) emit(buffer[i]);
    return true;
  }

  /* ── declarative binding ────────────────────────────────────────────────── */

  function propsFrom(el) {
    var props = {};
    if (!el || !el.getAttribute) return props;
    var raw = el.getAttribute('data-vjm-props');
    if (raw) {
      try {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') props = parsed;
      } catch (e) { /* malformed JSON on a CTA must not break the click */ }
    }
    var map = { plan: 'data-vjm-plan', course: 'data-vjm-course', location: 'data-vjm-location', tier: 'data-vjm-tier' };
    for (var k in map) {
      if (!Object.prototype.hasOwnProperty.call(map, k)) continue;
      var v = el.getAttribute(map[k]);
      if (v) props[k] = v;
    }
    return props;
  }

  function closestWith(el, attr) {
    var node = el;
    while (node && node.nodeType === 1) {
      if (node.getAttribute && node.getAttribute(attr)) return node;
      node = node.parentNode;
    }
    return null;
  }

  function isWhopLink(el) {
    if (!el || !el.getAttribute) return false;
    var href = el.getAttribute('href') || '';
    return /^https?:\/\/(www\.)?whop\.com\//i.test(href);
  }

  function handleClick(ev) {
    try {
      var target = ev && (ev.target || ev.srcElement);
      if (!target) return;

      var tagged = closestWith(target, 'data-vjm-event');
      if (tagged) track(tagged.getAttribute('data-vjm-event'), propsFrom(tagged));

      // Outbound checkout is measured from the link itself, so a CTA the CMS
      // renders later (assets are re-rendered from /content) still counts.
      var node = target;
      while (node && node.nodeType === 1 && node.tagName !== 'A') node = node.parentNode;
      if (node && node.nodeType === 1 && isWhopLink(node)) {
        if (!tagged || tagged.getAttribute('data-vjm-event') !== STAGES.WHOP_CHECKOUT) {
          var p = propsFrom(node);
          p.href = node.getAttribute('href');
          track(STAGES.WHOP_CHECKOUT, p);
        }
      }
    } catch (e) { /* never break a click */ }
  }

  function bindViews(root) {
    var scope = root || window.document;
    var nodes;
    try { nodes = scope.querySelectorAll('[data-vjm-view]'); } catch (e) { return; }
    if (!nodes || !nodes.length) return;
    if (!('IntersectionObserver' in window)) {
      // No observer: count it as seen rather than losing the stage entirely.
      for (var i = 0; i < nodes.length; i++) {
        if (nodes[i].getAttribute('data-vjm-seen')) continue;
        nodes[i].setAttribute('data-vjm-seen', '1');
        track(nodes[i].getAttribute('data-vjm-view'), propsFrom(nodes[i]));
      }
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      for (var j = 0; j < entries.length; j++) {
        var e = entries[j];
        if (!e.isIntersecting) continue;
        var el = e.target;
        if (el.getAttribute('data-vjm-seen')) { io.unobserve(el); continue; }
        el.setAttribute('data-vjm-seen', '1');
        track(el.getAttribute('data-vjm-view'), propsFrom(el));
        io.unobserve(el);
      }
    }, { threshold: 0.4 });
    for (var k = 0; k < nodes.length; k++) io.observe(nodes[k]);
  }

  function bindAuto(root) {
    try {
      var doc = window.document;
      if (!doc) return;
      if (!bindAuto.__clickBound) {
        doc.addEventListener('click', handleClick, true);
        bindAuto.__clickBound = true;
      }
      bindViews(root || doc);
    } catch (e) { /* noop */ }
  }

  /* ── owned lead capture ─────────────────────────────────────────────────────
   * The free tier collects no owned lead: every visitor who is not ready to
   * buy today leaves without the site keeping any way to reach them.
   *
   * TODO: owner to connect. LEAD_ENDPOINT is intentionally empty — no mailing
   * backend exists in this repository and inventing one (or embedding a
   * third-party form) is not this file's call. Set it to your own
   * same-origin collector path (and add the route under functions/) and the
   * capture form on the homepage turns itself on.
   *
   * While it is empty, `configured()` is false and the homepage shows an
   * honest next step instead of a form that cannot store anything. `submit()`
   * NEVER reports success it did not get: with no endpoint it resolves
   * { ok:false, reason:'not_configured' }, and on a failed request it resolves
   * { ok:false, reason:'error' }. The UI is written against those.
   */
  var LEAD_ENDPOINT = '';

  function leadConfigured() {
    return typeof LEAD_ENDPOINT === 'string' && LEAD_ENDPOINT.length > 0;
  }

  /** Deliberately loose: catching typos, not policing addresses. */
  function looksLikeEmail(value) {
    return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim());
  }

  function submitLead(email, props) {
    var payload = { email: String(email || '').trim(), props: cleanProps(props) };
    if (!looksLikeEmail(payload.email)) {
      return Promise.resolve({ ok: false, reason: 'invalid_email' });
    }
    if (!leadConfigured()) {
      // No backend. Say so; do not pretend anything was stored.
      return Promise.resolve({ ok: false, reason: 'not_configured' });
    }
    return fetch(LEAD_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload)
    })
      .then(function (r) { return r.ok ? { ok: true } : { ok: false, reason: 'error' }; })
      .catch(function () { return { ok: false, reason: 'error' }; });
  }

  /* ── publish ────────────────────────────────────────────────────────────── */

  window.vjmTrack = track;
  window.vjmTrackQueue = window.vjmTrackQueue || [];

  window.vjmFunnel = {
    __installed: true,
    version: VERSION,
    STAGES: STAGES,
    track: track,
    setSink: setSink,
    hasSink: function () { return typeof sink === 'function'; },
    events: function () { return buffer.slice(); },
    clear: function () { buffer.length = 0; },
    visitId: sessionId,
    bind: bindAuto,
    debug: function (on) { debug = !!on; return debug; }
  };

  window.vjmLead = {
    configured: leadConfigured,
    looksLikeEmail: looksLikeEmail,
    submit: submitLead
  };

  drainQueue();

  try {
    if (window.document) {
      if (window.document.readyState === 'loading') {
        window.document.addEventListener('DOMContentLoaded', function () { bindAuto(); });
      } else {
        bindAuto();
      }
    }
  } catch (e) { /* noop */ }
})();
