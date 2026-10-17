// /api/verify-premium's GET returns the signed tier claim specifically so
// the under-tier upgrade gate can state what plan a member holds as fact
// instead of guessing (see that handler's own comment). assets/curriculum.js
// never read it: checkPremium() discarded data.tier, and
// renderUnderTierGate() reconstructed "held" by looking at which course was
// LOCKED, not which tier the session actually carries — `course.plan ===
// 'complete' ? PLANS.futures_core : null`. That guess happens to match the
// common case (futures_core is the only paid tier below complete today),
// but once a signed-in session carries no tier at all (e.g. a pre-tier
// legacy session after the owner flips STRICT_LEGACY_SESSIONS=true, a
// documented rollout step in docs/ENTITLEMENTS.md), the member is told a
// specific held plan/price they were never shown to hold — an invented fact
// about a member, which AGENTS.md's non-negotiables forbid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const curriculum = readFileSync(join(ROOT, 'assets/curriculum.js'), 'utf8');

// A selector matcher general enough for the handful of forms curriculum.js
// actually queries during init() and inside the lock-gate renderers: a bare
// tag name, one or more dot classes, and/or a trailing [attr="value"] (the
// only kind lockedByServer()'s '.gated-content[data-locked="1"]' needs).
// Anything curriculum.js's OTHER init helpers query that this page's fixture
// has no elements for (`.quiz`, `.group-tabs`, `.nav-item`, ...) safely
// matches nothing rather than throwing, so init() runs to completion.
function matches(el, sel) {
  const m = /^([a-zA-Z0-9_-]*)((?:\.[a-zA-Z0-9_-]+)*)((?:\[[^\]]+\])*)$/.exec(sel);
  if (!m) return false;
  const [, tag, classesStr, attrsStr] = m;
  if (tag && el.tagName.toLowerCase() !== tag.toLowerCase()) return false;
  const classes = classesStr ? classesStr.slice(1).split('.') : [];
  if (!classes.every((c) => el.classList.contains(c))) return false;
  for (const [, key, val] of attrsStr.matchAll(/\[([a-zA-Z0-9_-]+)(?:="([^"]*)")?\]/g)) {
    if (val === undefined) { if (!el.hasAttribute(key)) return false; }
    else if (el.getAttribute(key) !== val) return false;
  }
  return true;
}

function stubElement(tag, cls, attrs = {}) {
  const set = new Set(String(cls).split(' ').filter(Boolean));
  const el = {
    tagName: tag.toUpperCase(),
    children: [],
    attrs: { ...attrs },
    parent: null,
    textContent: '',
    style: {},
    _html: '',
    get innerHTML() { return el._html; },
    set innerHTML(v) { el._html = v; el.children = []; },
    classList: {
      add: (c) => set.add(c),
      remove: (...c) => c.forEach((x) => set.delete(x)),
      contains: (c) => set.has(c),
      toggle: () => {},
    },
    getAttribute: (k) => (k in el.attrs ? el.attrs[k] : null),
    setAttribute: (k, v) => { el.attrs[k] = String(v); },
    hasAttribute: (k) => k in el.attrs,
    append(child) { child.parent = el; el.children.push(child); return child; },
    appendChild(child) { return el.append(child); },
    get parentElement() { return el.parent; },
    descendants() { return el.children.flatMap((c) => [c, ...c.descendants()]); },
    matches(sel) { return matches(el, sel); },
    querySelectorAll(sel) { return el.descendants().filter((d) => d.matches(sel)); },
    querySelector(sel) { return el.descendants().filter((d) => d.matches(sel))[0] || null; },
    closest(sel) {
      let node = el;
      while (node) { if (node.matches && node.matches(sel)) return node; node = node.parent; }
      return null;
    },
    addEventListener() {},
  };
  return el;
}

// One course page (options-lab, a 'complete'-tier course) whose middleware
// already stripped .gated-content (the real server-side signal a signed-in
// session is under-tier, not merely slow to load) and one bare .lock-gate
// for the gate renderer to fill in, mirroring the real markup closely enough
// for renderUnderTierGate()'s own qs('h3'/'p', gate) lookups to find a target.
function buildPage() {
  const root = stubElement('body', '');
  const gated = stubElement('div', 'gated-content', { 'data-locked': '1' });
  root.append(gated);
  const gate = stubElement('div', 'lock-gate');
  gate.append(stubElement('h3', ''));
  gate.append(stubElement('p', ''));
  root.append(gate);
  return { root, gate };
}

function run({ tier, pathname = '/options-lab' } = {}) {
  const { root, gate } = buildPage();
  const sandbox = {
    console,
    fetch: async () => ({ json: async () => ({ ok: true, active: true, tier }) }),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { pathname },
    document: {
      readyState: 'complete',
      addEventListener() {},
      createElement: (tag) => stubElement(tag, ''),
      querySelectorAll: (sel) => root.querySelectorAll(sel),
      querySelector: (sel) => root.querySelector(sel),
      getElementById: () => null,
      body: root,
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(curriculum, sandbox);
  return { gate };
}

test('a futures_core session under-tier on a Complete course is told the real held plan', async () => {
  const { gate } = run({ tier: 'futures_core' });
  await new Promise((r) => setTimeout(r, 0));
  const lead = gate.querySelector('p');
  assert.match(lead.textContent, /Futures Core \(\$100\/mo\)/,
    'a session the backend confirms is Futures Core must be named as such');
});

// This is the case the bug fabricated: no real tier at all (a pre-tier
// legacy session once STRICT_LEGACY_SESSIONS=true, per docs/ENTITLEMENTS.md's
// rollout order) — before the fix, renderUnderTierGate() never looked at this
// value and would still have named "Futures Core" purely because the locked
// course happened to require 'complete'.
test('a session with no confirmed tier is never told it holds a specific plan', async () => {
  const { gate } = run({ tier: null });
  await new Promise((r) => setTimeout(r, 0));
  const lead = gate.querySelector('p');
  assert.doesNotMatch(lead.textContent, /signed in on/,
    'with no backend-confirmed tier, the copy must not claim a specific held plan the member was never shown to hold');
  assert.match(lead.textContent, /does not carry access/,
    'it must fall back to the honest, plan-agnostic sentence');
});

// Same guard against an unrecognized tier string (a future plan this page's
// PLANS table does not know about yet) — must degrade the same honest way,
// never crash and never echo an unknown string as if it were a plan name.
test('an unrecognized tier value falls back to the same honest copy, not a crash', async () => {
  const { gate } = run({ tier: 'some_future_tier' });
  await new Promise((r) => setTimeout(r, 0));
  const lead = gate.querySelector('p');
  assert.match(lead.textContent, /does not carry access/);
});
