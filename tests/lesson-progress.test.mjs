// Lesson-progress tests.
//
// assets/curriculum.js's initLessonProgress()/refreshProgressNote() track
// which FREE lessons a visitor has opened — localStorage only, never an
// account, and never a paid level (see docs/PAYWALL.md) — and render the
// "N of M lessons opened" meter plus the Resume/Start and Clear buttons on
// all four course pages. The sibling half of the same local record,
// rec.quizzes, is exhaustively covered by tests/quiz-integrity.test.mjs;
// rec.lessons had zero behavioral coverage anywhere in the suite (only a
// string match on one sentence of the rendered copy in
// tests/regressions.test.mjs), so a renamed `lessons` key, a broken
// `cards.length` guard, or a dropped gated-level check could silently break
// the meter and both buttons on every course page with nothing in CI to
// catch it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const curriculum = readFileSync(join(ROOT, 'assets/curriculum.js'), 'utf8');

// Minimal DOM stub, deliberately kept parallel to tests/quiz-integrity.test
// .mjs's stubElement so the two files are easy to compare. The one addition
// is a className getter/setter that stays in sync with the class Set:
// curriculum.js's makeEl() sets className (not classList) on every element
// it creates, and without this the stub's own class-selector matching would
// never find a note or button curriculum.js itself just built.
function stubElement(tag, cls, attrs = {}) {
  const set = new Set(String(cls).split(' ').filter(Boolean));
  const el = {
    tagName: tag.toUpperCase(),
    children: [],
    attrs: { ...attrs },
    parent: null,
    open: false,
    _html: '',
    // Real DOM destroys existing child nodes when .innerHTML is reassigned —
    // refreshProgressNote() relies on exactly that to replace its old
    // Resume/Start/Clear buttons rather than accumulate new ones beside them.
    get innerHTML() { return el._html; },
    set innerHTML(v) { el._html = v; el.children = []; },
    classList: {
      add: (c) => set.add(c),
      remove: (...c) => c.forEach((x) => set.delete(x)),
      contains: (c) => set.has(c),
      toggle: () => {},
    },
    get classes() { return [...set]; },
    get className() { return [...set].join(' '); },
    set className(v) { set.clear(); String(v).split(' ').filter(Boolean).forEach((c) => set.add(c)); },
    getAttribute: (k) => (k in el.attrs ? el.attrs[k] : null),
    setAttribute: (k, v) => { el.attrs[k] = String(v); },
    hasAttribute: (k) => k in el.attrs,
    append(child) { child.parent = el; el.children.push(child); return child; },
    get parentNode() { return el.parent; },
    get firstChild() { return el.children[0] || null; },
    insertBefore(node, anchor) {
      const at = el.children.indexOf(node);
      if (at > -1) el.children.splice(at, 1);
      const i = anchor ? el.children.indexOf(anchor) : -1;
      if (i > -1) el.children.splice(i, 0, node); else el.children.push(node);
      node.parent = el;
      return node;
    },
    descendants() { return el.children.flatMap((c) => [c, ...c.descendants()]); },
    matches(sel) {
      if (sel === 'summary') return el.tagName === 'SUMMARY';
      if (sel.startsWith('.') && !sel.includes('[')) {
        return sel.slice(1).split('.').every((c) => set.has(c));
      }
      return false;
    },
    querySelectorAll: (sel) => el.descendants().filter((d) => d.matches(sel)),
    querySelector: (sel) => el.descendants().filter((d) => d.matches(sel))[0] || null,
    closest(sel) {
      let node = el;
      while (node) { if (node.matches && node.matches(sel)) return node; node = node.parent; }
      return null;
    },
    addEventListener: (_ev, fn) => el.listeners.push(fn),
    listeners: [],
  };
  return el;
}

function lessonCard(title) {
  const card = stubElement('details', 'lesson-card');
  const summary = stubElement('summary', '');
  summary.textContent = title;
  card.append(summary);
  return card;
}

// One free level (data-pair/data-level the way the real pages author them)
// with two lessons, plus a second, gated level — exactly the shape a real
// course page has once any level beyond the free one is reached.
function buildCourse() {
  const root = stubElement('body', '');

  const freePanel = stubElement('section', 'level-panel', { 'data-level': '1', 'data-pair': 'futures' });
  const card1 = lessonCard('What a futures contract actually is');
  const card2 = lessonCard('Margin vs. notional size');
  freePanel.append(card1);
  freePanel.append(card2);
  root.append(freePanel);

  const gatedPanel = stubElement('section', 'level-panel', { 'data-level': '2', 'data-pair': 'futures' });
  gatedPanel.append(stubElement('div', 'lock-gate'));
  const gatedCard = lessonCard('A paid-only lesson');
  gatedPanel.append(gatedCard);
  root.append(gatedPanel);

  return { root, freePanel, card1, card2, gatedPanel, gatedCard };
}

function renderCourse() {
  const { root, freePanel, card1, card2, gatedPanel, gatedCard } = buildCourse();
  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
  const sandbox = {
    console,
    fetch: async () => ({ json: async () => ({}) }),
    localStorage,
    location: { pathname: '/futures-dissection' },
    vjmTrack: () => {},
    document: {
      readyState: 'complete',
      addEventListener() {},
      createElement: (tag) => stubElement(tag, ''),
      querySelectorAll: (sel) => root.querySelectorAll(sel),
      querySelector: (sel) => root.querySelector(sel),
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(curriculum, sandbox);

  const saved = () => {
    const raw = store.get('vjm-progress-v1');
    return raw ? JSON.parse(raw) : null;
  };
  // insertBefore(note, panel.firstChild) makes the progress note the first
  // child of its panel, every time it is (re)built.
  const noteOf = (panel) => panel.children[0];
  const buttonOf = (panel, label) => noteOf(panel).querySelectorAll('.vjm-btn-sm').find((b) => b.innerHTML === label);
  const open = (card) => { card.open = true; card.listeners.forEach((fn) => fn()); };
  return { root, freePanel, card1, card2, gatedPanel, gatedCard, saved, noteOf, buttonOf, open };
}

test('opening a free lesson marks it seen and persists the record on this device', () => {
  const q = renderCourse();
  assert.equal(q.card1.classes.includes('vjm-seen'), false, 'unopened lesson must not start marked seen');

  q.open(q.card1);
  assert.equal(q.card1.classes.includes('vjm-seen'), true);

  const rec = q.saved()['futures-dissection'];
  assert.ok(rec.lessons['futures:1:0'], 'opening the first lesson must persist its id');
  assert.equal(rec.lessons['futures:1:1'], undefined, 'the still-closed second lesson must not be recorded');
});

test('the progress note reports done/total and the meter width as a percentage', () => {
  const q = renderCourse();
  assert.match(q.noteOf(q.freePanel).innerHTML, /0 of 2 lessons opened/);
  assert.match(q.noteOf(q.freePanel).innerHTML, /width:0%/);

  q.open(q.card1);
  assert.match(q.noteOf(q.freePanel).innerHTML, /1 of 2 lessons opened/);
  assert.match(q.noteOf(q.freePanel).innerHTML, /width:50%/);

  q.open(q.card2);
  assert.match(q.noteOf(q.freePanel).innerHTML, /2 of 2 lessons opened/);
  assert.match(q.noteOf(q.freePanel).innerHTML, /width:100%/);
});

test('the Start/Resume button opens the first unopened lesson, and disappears once none remain', () => {
  const q = renderCourse();
  assert.ok(q.buttonOf(q.freePanel, 'Start'), 'a fresh course must offer Start, not Resume');
  assert.equal(q.buttonOf(q.freePanel, 'Resume'), undefined);

  q.buttonOf(q.freePanel, 'Start').listeners[0]();
  assert.equal(q.card1.open, true, 'Start must open the first unopened lesson');

  q.open(q.card1);
  assert.ok(q.buttonOf(q.freePanel, 'Resume'), 'once one lesson is open, the label must switch to Resume');
  q.buttonOf(q.freePanel, 'Resume').listeners[0]();
  assert.equal(q.card2.open, true, 'Resume must jump to the next unopened lesson');

  q.open(q.card2);
  assert.equal(q.buttonOf(q.freePanel, 'Resume'), undefined, 'no unopened lesson left means no jump button at all');
});

test('the Clear button wipes the saved record and strips vjm-seen from the DOM', () => {
  const q = renderCourse();
  q.open(q.card1);
  q.open(q.card2);
  assert.ok(q.buttonOf(q.freePanel, 'Clear'), 'a Clear button must appear once any progress exists');

  q.buttonOf(q.freePanel, 'Clear').listeners[0]();

  assert.equal(q.card1.classes.includes('vjm-seen'), false);
  assert.equal(q.card2.classes.includes('vjm-seen'), false);
  assert.equal((q.saved() || {})['futures-dissection'], undefined, 'the course record itself must be deleted, not just zeroed');
  assert.match(q.noteOf(q.freePanel).innerHTML, /0 of 2 lessons opened/, 'the note must re-render immediately after clearing');
});

test('a gated level is never read, written, or given a progress note', () => {
  const q = renderCourse();
  assert.equal(q.gatedCard.listeners.length, 0, 'a paid lesson must get no toggle listener at all');
  // Only the original lock-gate div and the lesson card itself — no progress
  // note was inserted as a new first child.
  assert.equal(q.gatedPanel.children.length, 2, 'no progress note must be inserted into a gated panel');

  // Even if something did force it open, there is no listener to react.
  q.gatedCard.open = true;
  const rec = q.saved();
  assert.equal(rec, null, 'touching the gated lesson must not create any saved record');
});
