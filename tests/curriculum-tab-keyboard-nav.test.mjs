// Incident: assets/curriculum.js's initGroupTabs()/initLevelTabs() (rendered
// on all four course pages: futures-dissection, options-lab's curriculum
// section, stock-breakdown, psychology-enhancer) declare role="tablist"/
// role="tab" on their tab bars, but until now only ever handled clicks. The
// WAI-ARIA Tabs pattern that markup implies also requires arrow-key movement
// between tabs (Left/Right, Home/End) with a roving tabindex, so a
// screen-reader user landing on a tab (announced "tab, 1 of 4") can move
// through the group without Tab stopping on every single tab first. Neither
// handler, nor any test, ever wired a keydown listener or set tabIndex.
//
// This drives the real initGroupTabs()/initLevelTabs() functions (extracted
// from the shipped source, not reimplemented) against a minimal DOM stub and
// fires real keydown events, proving the arrow-key path actually moves focus
// and activates the target tab -- not just that the markup carries the right
// attributes statically.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// Same brace-walking extractor tests/nav-dropdown-focus.test.mjs uses: these
// function bodies don't nest evenly enough for a bounded regex.
function extractBlock(source, startNeedle) {
  const start = source.indexOf(startNeedle);
  assert.ok(start > -1, `could not find ${JSON.stringify(startNeedle)} in source`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced braces');
}

// A DOM double covering exactly what these two functions touch: classList,
// dataset, tabIndex, focus()/activeElement, addEventListener, and
// querySelectorAll with the two selector shapes they use (a bare class, and
// a class plus one [data-x="y"] attribute filter).
function makeTabStub({ barClass, tabClass, panelClass, pairAttr, valueAttr, values }) {
  let activeElement = null;
  function node(tag, classes, dataset = {}) {
    const set = new Set(classes);
    const self = {
      tag,
      dataset,
      children: [],
      attrs: {},
      listeners: {},
      tabIndex: 0,
      classList: {
        add: (c) => set.add(c),
        remove: (c) => set.delete(c),
        contains: (c) => set.has(c),
        toggle: (c, force) => {
          const on = force === undefined ? !set.has(c) : !!force;
          if (on) set.add(c); else set.delete(c);
        },
      },
      setAttribute(k, v) { self.attrs[k] = String(v); },
      getAttribute(k) { return k in self.attrs ? self.attrs[k] : null; },
      addEventListener(type, fn) { (self.listeners[type] ||= []).push(fn); },
      focus() { activeElement = self; },
      append(child) { child.parent = self; self.children.push(child); return child; },
      querySelectorAll(sel) { return findAll(self, sel); },
    };
    return self;
  }
  function findAll(root, sel) {
    const m = /^\.([\w-]+)(?:\[data-([\w-]+)="([^"]*)"\])?$/.exec(sel.trim());
    assert.ok(m, `unsupported selector in test stub: ${sel}`);
    const [, cls, attr, value] = m;
    const key = attr ? attr.replace(/-([a-z])/g, (_, c) => c.toUpperCase()) : null;
    const out = [];
    (function walk(n) {
      n.children.forEach((c) => {
        if (c.classList.contains(cls) && (!key || c.dataset[key] === value)) out.push(c);
        walk(c);
      });
    })(root);
    return out;
  }

  const root = node('div', []);
  const bar = root.append(node('div', [barClass], { [pairAttr]: 'grp' }));
  const tabs = values.map((v, i) => bar.append(node('button', [tabClass, ...(i === 0 ? ['active'] : [])], { [valueAttr]: v })));
  const panels = values.map((v) => root.append(node('div', [panelClass], { [pairAttr]: 'grp', [valueAttr]: v })));
  tabs[0].classList.add('active');
  panels[0].classList.add('active');

  const document = {
    get activeElement() { return activeElement; },
    querySelectorAll: (sel) => root.querySelectorAll(sel),
  };
  return { document, bar, tabs, panels, focus: (n) => { activeElement = n; } };
}

function runArrowKeyScenario({ initFnName, barClass, tabClass, panelClass, pairAttr, valueAttr, values }) {
  const src = read('assets/curriculum.js');
  const snippet = extractBlock(src, 'function wireTabKeyboardNav(bar, tabSelector, activate)')
    + '\n' + extractBlock(src, `function ${initFnName}()`)
    + `\n${initFnName}();`;
  const stub = makeTabStub({ barClass, tabClass, panelClass, pairAttr, valueAttr, values });
  const sandbox = { document: stub.document, console };
  vm.createContext(sandbox);
  vm.runInContext(snippet, sandbox);

  // Init must roving-tabindex: only the already-active tab is reachable by Tab.
  assert.equal(stub.tabs[0].tabIndex, 0, 'the initially-active tab must start at tabIndex 0');
  for (const t of stub.tabs.slice(1)) assert.equal(t.tabIndex, -1, 'inactive tabs must start at tabIndex -1');

  // ArrowRight from the first tab moves focus to and activates the second.
  stub.focus(stub.tabs[0]);
  stub.bar.listeners.keydown[0]({ key: 'ArrowRight', preventDefault() {} });
  assert.equal(stub.document.activeElement, stub.tabs[1], 'ArrowRight must move focus to the next tab');
  assert.equal(stub.tabs[1].getAttribute('aria-selected'), 'true');
  assert.equal(stub.tabs[0].getAttribute('aria-selected'), 'false');
  assert.equal(stub.tabs[1].tabIndex, 0, 'the newly-focused tab must become the roving tabIndex 0');
  assert.equal(stub.tabs[0].tabIndex, -1, 'the tab that lost focus must drop back to tabIndex -1');
  assert.equal(stub.panels[1].classList.contains('active'), true, 'ArrowRight must switch to the target tab\'s panel');
  assert.equal(stub.panels[0].classList.contains('active'), false);

  // ArrowLeft from the first tab wraps around to the last one.
  stub.focus(stub.tabs[0]);
  stub.bar.listeners.keydown[0]({ key: 'ArrowLeft', preventDefault() {} });
  assert.equal(stub.document.activeElement, stub.tabs[stub.tabs.length - 1], 'ArrowLeft from the first tab must wrap to the last tab');

  // End jumps straight to the last tab; Home jumps straight back to the first.
  stub.focus(stub.tabs[0]);
  stub.bar.listeners.keydown[0]({ key: 'End', preventDefault() {} });
  assert.equal(stub.document.activeElement, stub.tabs[stub.tabs.length - 1], 'End must jump to the last tab');
  stub.bar.listeners.keydown[0]({ key: 'Home', preventDefault() {} });
  assert.equal(stub.document.activeElement, stub.tabs[0], 'Home must jump to the first tab');

  // A key outside the handled set is left alone: no focus change, no
  // preventDefault (so plain Tab/typing keeps working normally).
  let prevented = false;
  stub.focus(stub.tabs[0]);
  stub.bar.listeners.keydown[0]({ key: 'a', preventDefault() { prevented = true; } });
  assert.equal(stub.document.activeElement, stub.tabs[0], 'an unrelated key must not move focus');
  assert.equal(prevented, false, 'an unrelated key must not be preventDefault-ed');
}

test('initLevelTabs wires real arrow-key/Home/End keyboard navigation with a roving tabindex', () => {
  runArrowKeyScenario({
    initFnName: 'initLevelTabs',
    barClass: 'level-tabs',
    tabClass: 'level-tab',
    panelClass: 'level-panel',
    pairAttr: 'pair',
    valueAttr: 'level',
    values: ['1', '2', '3', '4'],
  });
});

test('initGroupTabs wires real arrow-key/Home/End keyboard navigation with a roving tabindex', () => {
  runArrowKeyScenario({
    initFnName: 'initGroupTabs',
    barClass: 'group-tabs',
    tabClass: 'group-tab',
    panelClass: 'group-panel',
    pairAttr: 'group',
    valueAttr: 'groupValue',
    values: ['A', 'B', 'C', 'D'],
  });
});
