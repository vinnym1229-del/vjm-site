// Keyboard-focus regression for the site-wide nav dropdown pattern.
//
// Every page's "Membership/Curriculum/Tools/..." dropdown is CSS
// visibility:hidden when closed, which means it cannot hold focus. A member
// tabbing to a nav button, opening it with Enter, then tabbing into one of
// its links and pressing Escape used to have closeAll() strip `.open` (and
// hide the panel) with no idea where focus was — the browser silently blurs
// to <body>, and the next Tab restarts sequential navigation from the very
// top of the page. Fixed by having closeAll() notice focus is inside the
// panel it's about to close and return it to that panel's own trigger
// button first. This is the same three-line fix landed in seven places:
// assets/curriculum.js (shared by futures-dissection/options-lab/
// stock-breakdown/psychology-enhancer) and six inline copies of the pattern
// (index.html, research-engine.html, premarket.html, prop-firms.html,
// stock-lab.html, forex-calendar.html).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// Pull out a top-level `function name(){...}` (or, for name === null, the
// self-invoking `(function(){...})();` IIFE) by walking braces rather than a
// regex, since none of these bodies nest evenly enough for a bounded regex.
function extractBlock(source, startNeedle) {
  const start = source.indexOf(startNeedle);
  assert.ok(start > -1, `could not find ${JSON.stringify(startNeedle)} in source`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) {
        // Include a trailing `)();` for a `(function(){...})();` IIFE, if present
        // (the leading "(" before "function" needs its matching ")" too).
        let end = i + 1;
        const tail = /^\)?\(\);/.exec(source.slice(end, end + 4));
        if (tail) end += tail[0].length;
        return source.slice(start, end);
      }
    }
  }
  throw new Error('unbalanced braces');
}

// A DOM double covering exactly the API these scripts touch: classList,
// querySelector(All) for '.nav-top'/'.nav-drop', addEventListener/focus, and
// a real activeElement so the fix's whole point — where focus ends up — is
// actually observable.
function makeNavStub(count = 3) {
  let activeElement = null;
  function node(tag, classes) {
    const set = new Set(classes);
    const self = {
      tag,
      children: [],
      attrs: {},
      listeners: {},
      classList: {
        add: (c) => set.add(c),
        remove: (c) => set.delete(c),
        contains: (c) => set.has(c),
      },
      setAttribute(k, v) { self.attrs[k] = String(v); },
      getAttribute(k) { return k in self.attrs ? self.attrs[k] : null; },
      addEventListener(type, fn) { (self.listeners[type] ||= []).push(fn); },
      contains(other) {
        let n = other;
        while (n) { if (n === self) return true; n = n.parent; }
        return false;
      },
      focus() { activeElement = self; },
      append(child) { child.parent = self; self.children.push(child); return child; },
      querySelector(sel) { return findAll(self, sel)[0] || null; },
      querySelectorAll(sel) { return findAll(self, sel); },
    };
    return self;
  }
  function findAll(root, sel) {
    const cls = sel.trim().split(/\s+/).pop().replace(/^\./, '');
    const out = [];
    (function walk(n) {
      n.children.forEach((c) => {
        if (c.classList.contains(cls)) out.push(c);
        walk(c);
      });
    })(root);
    return out;
  }

  const items = Array.from({ length: count }, () => {
    const item = node('div', ['nav-item']);
    const btn = item.append(node('button', ['nav-top']));
    btn.setAttribute('aria-expanded', 'false');
    const drop = item.append(node('div', ['nav-drop']));
    const link = drop.append(node('a', []));
    item.btn = btn;
    item.link = link;
    return item;
  });
  const root = node('div', []);
  items.forEach((i) => root.append(i));

  const docListeners = {};
  const document = {
    get activeElement() { return activeElement; },
    querySelector: (sel) => root.querySelector(sel),
    querySelectorAll: (sel) => root.querySelectorAll(sel),
    getElementById: () => null,
    addEventListener(type, fn) { (docListeners[type] ||= []).push(fn); },
  };
  const window = {
    innerWidth: 1400,
    addEventListener() {},
  };
  return {
    document,
    window,
    items,
    fireKeydown(key) { (docListeners.keydown || []).forEach((fn) => fn({ key })); },
    focus(n) { activeElement = n; },
    get activeElement() { return activeElement; },
  };
}

// Runs one extracted nav-dropdown snippet end to end: opens item 1, moves
// focus to the link inside its (now-visible) panel, then fires the Escape
// keydown handler the script itself registered — proving both that Escape
// actually closes the panel AND that focus lands back on its trigger button
// rather than vanishing into the panel that just went visibility:hidden.
function runEscapeScenario(snippet) {
  const stub = makeNavStub(3);
  const sandbox = { document: stub.document, window: stub.window, console };
  sandbox.window.document = stub.document;
  vm.createContext(sandbox);
  vm.runInContext(snippet, sandbox);
  const openItem = stub.items[1];
  openItem.classList.add('open');
  openItem.btn.setAttribute('aria-expanded', 'true');
  stub.focus(openItem.link); // member tabbed past the trigger into the link
  assert.equal(stub.activeElement, openItem.link, 'test setup: focus must start on the in-panel link');
  stub.fireKeydown('Escape');
  assert.equal(openItem.classList.contains('open'), false, 'Escape must still close the panel');
  assert.equal(openItem.btn.getAttribute('aria-expanded'), 'false');
  assert.equal(stub.activeElement, openItem.btn, 'focus must return to the trigger button, not be abandoned in the hidden panel');
}

test('curriculum.js: Escape returns focus to the dropdown trigger', () => {
  const src = read('assets/curriculum.js');
  const snippet = extractBlock(src, 'function initNavDropdowns()') + '\ninitNavDropdowns();';
  runEscapeScenario(snippet);
});

test('index.html: Escape returns focus to the dropdown trigger', () => {
  const src = read('index.html');
  const iifeStart = src.indexOf("(function(){\n  var items = document.querySelectorAll('.nav-item');");
  assert.ok(iifeStart > -1, 'nav-dropdown IIFE not found at its expected shape');
  const snippet = extractBlock(src, "(function(){\n  var items = document.querySelectorAll('.nav-item');");
  runEscapeScenario(snippet);
});

// research-engine.html/premarket.html/prop-firms.html share one "spaced"
// closeAll() shape and call initNavDropdowns() themselves at top level;
// stock-lab.html/forex-calendar.html share one fully-minified shape and only
// call it from a DOMContentLoaded handler. Prove the fix once per shape...
test('research-engine.html: Escape returns focus to the dropdown trigger (spaced variant)', () => {
  const src = read('research-engine.html');
  const snippet = extractBlock(src, 'function initNavDropdowns(){') + '\ninitNavDropdowns();';
  runEscapeScenario(snippet);
});

test('stock-lab.html: Escape returns focus to the dropdown trigger (minified variant)', () => {
  const src = read('stock-lab.html');
  const snippet = extractBlock(src, 'function initNavDropdowns(){') + '\ninitNavDropdowns();';
  runEscapeScenario(snippet);
});

// ...then pin the other three duplicates byte-for-byte against whichever
// proven shape they share, so this can't silently drift back out of sync.
test('premarket.html and prop-firms.html carry the exact proven research-engine.html fix', () => {
  const proven = extractBlock(read('research-engine.html'), 'function initNavDropdowns(){');
  for (const page of ['premarket.html', 'prop-firms.html']) {
    const here = extractBlock(read(page), 'function initNavDropdowns(){');
    assert.equal(here, proven, `${page}'s initNavDropdowns must match the proven research-engine.html version`);
  }
});

test('forex-calendar.html carries the exact proven stock-lab.html fix', () => {
  const proven = extractBlock(read('stock-lab.html'), 'function initNavDropdowns(){');
  const here = extractBlock(read('forex-calendar.html'), 'function initNavDropdowns(){');
  assert.equal(here, proven, "forex-calendar.html's initNavDropdowns must match the proven stock-lab.html version");
});
