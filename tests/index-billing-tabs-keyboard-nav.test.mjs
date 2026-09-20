// Incident: options-lab.html's own #tabs/#subtabs and assets/curriculum.js's
// shared bars both gained arrow-key/Home/End keyboard navigation with a
// roving tabindex in prior runs, but index.html's own `.period-tabs` bar
// (the Monthly/6-Month/Yearly/Lifetime billing-period switcher above the
// pricing tiers) was never covered -- it's driven by this page's own inline
// <script>, not curriculum.js or options-lab.html's copy. It already carries
// role="tablist"/role="tab"/aria-selected (tests/regressions.test.mjs) but,
// like every tab widget before those fixes, only ever handled clicks: no
// keydown listener, no tabIndex management.
//
// This drives the real wireTabKeyboardNav/setBundlePeriod functions
// (extracted verbatim from the shipped inline script, not reimplemented)
// against a DOM stub shaped like the actual markup, and fires real keydown
// events -- proving the arrow-key path actually moves focus and re-renders
// pricing for the target period, not just that the markup carries the
// right attributes statically.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

function extractInlineScript() {
  const html = read('index.html');
  const start = html.indexOf('// ─── BUNDLE PERIOD SELECTOR ───');
  assert.ok(start > -1, 'could not find the index.html bundle-period-selector script block');
  const end = html.indexOf('// ─── INTRO VIDEO FACADE ───', start);
  assert.ok(end > start, 'could not find the end marker (// ─── INTRO VIDEO FACADE ───) after the bundle-period script');
  return html.slice(start, end);
}

// A DOM double covering exactly what this script touches: classList,
// dataset, tabIndex, focus()/activeElement, addEventListener,
// getElementById (returns null for ids not present in this narrow fixture,
// which setBundlePeriod/applyPlanCtas already guard against), and
// querySelectorAll/querySelector with the bare-class selector shape used here.
function makeNode(tag, { id, classes = [], dataset = {} } = {}) {
  const set = new Set(classes);
  const self = {
    tag, id, dataset, attrs: {}, tabIndex: 0,
    children: [], parent: null, listeners: {},
    classList: {
      add: (c) => set.add(c),
      remove: (c) => set.delete(c),
      contains: (c) => set.has(c),
      toggle(c, force) {
        const on = force === undefined ? !set.has(c) : !!force;
        if (on) set.add(c); else set.delete(c);
        return on;
      },
    },
    setAttribute(k, v) { self.attrs[k] = String(v); },
    getAttribute(k) { return k in self.attrs ? self.attrs[k] : null; },
    addEventListener(type, fn) { (self.listeners[type] ||= []).push(fn); },
    focus() { activeElement = self; },
    append(child) { child.parent = self; self.children.push(child); return child; },
    querySelectorAll(sel) { return queryFrom(self, sel); },
  };
  return self;
}

let activeElement = null;

function collectAll(root, pred, out = []) {
  root.children.forEach((c) => { if (pred(c)) out.push(c); collectAll(c, pred, out); });
  return out;
}
function findById(root, id) {
  if (root.id === id) return root;
  for (const c of root.children) { const f = findById(c, id); if (f) return f; }
  return null;
}
function queryFrom(root, sel) {
  sel = sel.trim();
  const bare = /^\.([\w-]+)$/.exec(sel);
  if (bare) return collectAll(root, (c) => c.classList.contains(bare[1]));
  throw new Error(`unsupported selector in test stub: ${sel}`);
}

function makeFixture() {
  activeElement = null;
  const root = makeNode('div');
  const tabsBar = root.append(makeNode('div', { classes: ['period-tabs'] }));
  const periods = ['monthly', 'sixmo', 'yearly', 'lifetime'];
  const tabs = periods.map((p, i) =>
    tabsBar.append(makeNode('button', { classes: ['period-tab', ...(i === 0 ? ['active'] : [])], dataset: { period: p } })));

  const document = {
    get activeElement() { return activeElement; },
    getElementById: () => null,
    querySelector: (sel) => queryFrom(root, sel)[0] || null,
    querySelectorAll: (sel) => queryFrom(root, sel),
  };
  return {
    document, tabs, tabsBar,
    focus: (n) => { activeElement = n; },
  };
}

function run(fixture) {
  const sandbox = { document: fixture.document, console, Array, JSON };
  vm.createContext(sandbox);
  vm.runInContext(extractInlineScript(), sandbox);
  return sandbox;
}

test('index.html .period-tabs wires real arrow-key/Home/End keyboard navigation with a roving tabindex', () => {
  const fx = makeFixture();
  run(fx);

  assert.equal(fx.tabs[0].tabIndex, 0, 'the initially-active tab must start at tabIndex 0');
  for (const t of fx.tabs.slice(1)) assert.equal(t.tabIndex, -1, 'inactive tabs must start at tabIndex -1');

  fx.focus(fx.tabs[0]);
  fx.tabsBar.listeners.keydown[0]({ key: 'ArrowRight', preventDefault() {} });
  assert.equal(fx.document.activeElement, fx.tabs[1], 'ArrowRight must move focus to the next tab');
  assert.equal(fx.tabs[1].getAttribute('aria-selected'), 'true');
  assert.equal(fx.tabs[0].getAttribute('aria-selected'), 'false');
  assert.equal(fx.tabs[1].tabIndex, 0, 'the newly-focused tab must become the roving tabIndex 0');
  assert.equal(fx.tabs[0].tabIndex, -1, 'the tab that lost focus must drop back to tabIndex -1');

  fx.focus(fx.tabs[0]);
  fx.tabsBar.listeners.keydown[0]({ key: 'ArrowLeft', preventDefault() {} });
  assert.equal(fx.document.activeElement, fx.tabs[fx.tabs.length - 1], 'ArrowLeft from the first tab must wrap to the last tab');

  fx.focus(fx.tabs[0]);
  fx.tabsBar.listeners.keydown[0]({ key: 'End', preventDefault() {} });
  assert.equal(fx.document.activeElement, fx.tabs[fx.tabs.length - 1], 'End must jump to the last tab');
  fx.tabsBar.listeners.keydown[0]({ key: 'Home', preventDefault() {} });
  assert.equal(fx.document.activeElement, fx.tabs[0], 'Home must jump to the first tab');

  let prevented = false;
  fx.focus(fx.tabs[0]);
  fx.tabsBar.listeners.keydown[0]({ key: 'a', preventDefault() { prevented = true; } });
  assert.equal(fx.document.activeElement, fx.tabs[0], 'an unrelated key must not move focus');
  assert.equal(prevented, false, 'an unrelated key must not be preventDefault-ed');
});
