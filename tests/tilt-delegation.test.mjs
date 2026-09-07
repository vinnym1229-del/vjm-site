// assets/tilt.js used to bind pointermove/pointerleave listeners directly to
// each .feature-card/.tier-card node found at load time. index.html's CMS
// content-sync replaces #tier-grid's whole innerHTML with fresh .tier-card
// nodes once /api/content?type=bundles resolves (a network round trip, so it
// lands after this deferred script runs) whenever an owner curates real
// bundles — the new cards carried no tilt listeners at all, and the effect
// silently disappeared from the pricing cards with no error anywhere. Fixed
// by delegating both listeners onto document and resolving the target card
// via closest() on each event, so a later innerHTML swap needs no re-init.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// A DOM double covering exactly what tilt.js touches: classList/closest for
// selector matching, addEventListener at document level, getBoundingClientRect,
// and a style object real enough to assert the written custom properties.
function node(tag, classes) {
  const set = new Set(classes);
  const ownListeners = {};
  const self = {
    tag,
    parent: null,
    classList: {
      add: (c) => set.add(c),
      remove: (c) => set.delete(c),
      contains: (c) => set.has(c),
    },
    style: { props: {}, setProperty(k, v) { self.style.props[k] = v; } },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    closest(sel) {
      const classes = sel.split(',').map((s) => s.trim().replace(/^\./, ''));
      let n = self;
      while (n) {
        if (classes.some((c) => n.classList.contains(c))) return n;
        n = n.parent;
      }
      return null;
    },
    // Only exercised by the pre-fix, per-card-bound version of tilt.js.
    addEventListener(type, fn) { (ownListeners[type] ||= []).push(fn); },
    fireOwn(type, e) { (ownListeners[type] || []).forEach((fn) => fn(e)); },
  };
  return self;
}

function makeStub(nodesPresentAtLoad) {
  const listeners = {};
  const document = {
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    // Only used by the pre-fix, load-time-bound version of tilt.js; the fixed
    // version never calls this, since it delegates from document instead.
    querySelectorAll(sel) {
      const classes = sel.split(',').map((s) => s.trim().replace(/^\./, ''));
      return nodesPresentAtLoad.filter((n) => classes.some((c) => n.classList.contains(c)));
    },
  };
  const rafQueue = [];
  const window = {
    document,
    // Simulates a desktop mouse user: not reduced-motion, and hover-capable
    // with a fine pointer (the two guards tilt.js checks before doing anything).
    matchMedia: (q) => ({ matches: !q.includes('prefers-reduced-motion') }),
    requestAnimationFrame: (fn) => { rafQueue.push(fn); return rafQueue.length; },
    cancelAnimationFrame() {},
  };
  return {
    document,
    window,
    fire(type, e) { (listeners[type] || []).forEach((fn) => fn(e)); },
    runRaf() { while (rafQueue.length) rafQueue.shift()(); },
  };
}

function runTiltScript(nodesPresentAtLoad = []) {
  const src = read('assets/tilt.js');
  const stub = makeStub(nodesPresentAtLoad);
  const sandbox = {
    document: stub.document,
    window: stub.window,
    console,
    matchMedia: stub.window.matchMedia,
    requestAnimationFrame: stub.window.requestAnimationFrame,
    cancelAnimationFrame: stub.window.cancelAnimationFrame,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return stub;
}

// Fires on both the card directly and (simulating real bubbling) on
// document, so this exercises whichever binding style tilt.js currently uses
// — a direct per-card listener (pre-fix) or a delegated document one (fixed).
function pointermoveOn(stub, card, x, y) {
  const e = { target: card, clientX: x, clientY: y };
  card.fireOwn('pointermove', e);
  stub.fire('pointermove', e);
  stub.runRaf();
}

test('tilt.js tilts a card that already existed at load time', () => {
  const card = node('div', ['tier-card']);
  const stub = runTiltScript([card]);
  pointermoveOn(stub, card, 75, 25);
  assert.notEqual(card.style.props['--ry'], undefined, 'pointer over an original card must set a tilt angle');
  assert.notEqual(card.style.props['--ry'], '0.00deg');
});

test('tilt.js still tilts a .tier-card added after load (CMS bundles content-sync swap)', () => {
  const stub = runTiltScript([]); // nothing present when tilt.js's own load-time scan would have run
  // Simulates index.html's `#tier-grid.innerHTML = ...` replacement once the
  // /api/content?type=bundles fetch resolves after this script already ran.
  const freshCard = node('div', ['tier-card', 'hot']);
  pointermoveOn(stub, freshCard, 80, 20);
  assert.notEqual(
    freshCard.style.props['--ry'], undefined,
    'a .tier-card created after tilt.js ran must still receive the tilt effect (event delegation, not a load-time querySelectorAll)'
  );
  assert.notEqual(freshCard.style.props['--rx'], undefined);
});

test('tilt.js resets the tilt when the pointer leaves the window from over a card', () => {
  const card = node('div', ['feature-card']);
  const stub = runTiltScript([card]);
  pointermoveOn(stub, card, 90, 10);
  assert.notEqual(card.style.props['--ry'], '0.00deg');
  stub.fire('pointerout', { relatedTarget: null }); // left the browser window
  assert.equal(card.style.props['--rx'], '0deg');
  assert.equal(card.style.props['--ry'], '0deg');
});
