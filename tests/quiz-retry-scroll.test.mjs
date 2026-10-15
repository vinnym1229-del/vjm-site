// Incident: a quiz's "Retry the missed questions" button (assets/curriculum.js's
// renderCompletion(), inside result.missed.forEach()) called
// block.scrollIntoView() once per missed question, back to back, with no
// delay between calls. A browser only has one scroll target to animate
// toward, so each call overrode the previous one's -- the page always landed
// on the LAST missed question, not the first. A learner who missed an early
// question in a long quiz (psychology-enhancer.html runs 52 questions) had
// its radio silently cleared along with everything else, but was scrolled
// straight past it with no visual cue it had been reset at all.
//
// Reuses tests/quiz-integrity.test.mjs's render-time DOM-stub harness, scaled
// to multiple questions so "missed" can span more than one block, plus a
// scrollIntoView spy neither that file nor the stub needed before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const curriculum = readFileSync(join(ROOT, 'assets/curriculum.js'), 'utf8');

function stubElement(tag, cls, attrs = {}) {
  const set = new Set(String(cls).split(' ').filter(Boolean));
  const el = {
    tagName: tag.toUpperCase(),
    children: [],
    attrs: { ...attrs },
    parent: null,
    text: '',
    checked: false,
    scrollCalls: 0,
    classList: {
      add: (c) => set.add(c),
      remove: (...c) => c.forEach((x) => set.delete(x)),
      contains: (c) => set.has(c),
      toggle: () => {},
    },
    get classes() { return [...set]; },
    get value() { return el.attrs.value; },
    set value(v) { el.attrs.value = String(v); },
    getAttribute: (k) => (k in el.attrs ? el.attrs[k] : null),
    setAttribute: (k, v) => { el.attrs[k] = String(v); },
    hasAttribute: (k) => k in el.attrs,
    append(child) { child.parent = el; el.children.push(child); return child; },
    get parentNode() { return el.parent; },
    get nextSibling() {
      if (!el.parent) return null;
      return el.parent.children[el.parent.children.indexOf(el) + 1] || null;
    },
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
      const qi = /^\.quiz-q\[data-qi="(\d+)"\]$/.exec(sel);
      if (qi) return set.has('quiz-q') && el.attrs['data-qi'] === qi[1];
      if (sel === 'input[type="radio"]') return el.tagName === 'INPUT';
      if (sel === 'input[type="radio"]:checked') return el.tagName === 'INPUT' && el.checked;
      if (sel.startsWith('script')) return el.tagName === 'SCRIPT';
      if (sel.startsWith('.') && !sel.includes('[')) return set.has(sel.slice(1));
      return false;
    },
    querySelectorAll: (sel) => el.descendants().filter((d) => d.matches(sel)),
    querySelector: (sel) => el.descendants().filter((d) => d.matches(sel))[0] || null,
    closest(sel) {
      let node = el;
      while (node) { if (node.matches && node.matches(sel)) return node; node = node.parent; }
      return null;
    },
    // Real scrollIntoView takes no useful return value; the spy just counts
    // calls so the test can tell "scrolled once" from "scrolled N times".
    scrollIntoView() { el.scrollCalls++; },
    addEventListener: (_ev, fn) => el.listeners.push(fn),
    listeners: [],
  };
  return el;
}

// Three questions, same four-choice shape tests/quiz-integrity.test.mjs uses,
// so a wrong answer can land at the first, middle, or last position.
function renderQuiz() {
  const quiz = stubElement('div', 'quiz');
  const blocks = [0, 1, 2].map((qi) => {
    const block = stubElement('div', 'quiz-q', { 'data-qi': String(qi) });
    quiz.append(block);
    ['alpha', 'bravo', 'charlie', 'delta'].forEach((t, i) => {
      const label = stubElement('label', 'quiz-choice');
      const input = stubElement('input', '', { type: 'radio', name: `q${qi}`, value: String(i) });
      label.append(input);
      label.text = t;
      block.append(label);
    });
    const explain = block.append(stubElement('div', 'quiz-explain'));
    explain.textContent = `Explanation for question ${qi}.`;
    const qtext = block.append(stubElement('p', 'qtext'));
    qtext.textContent = `Question ${qi} text`;
    return block;
  });
  const submit = quiz.append(stubElement('button', 'quiz-submit'));
  const score = quiz.append(stubElement('span', 'quiz-score'));
  const data = quiz.append(stubElement('script', '', { type: 'application/json' }));
  data.textContent = JSON.stringify([{ correct: 1 }, { correct: 1 }, { correct: 1 }]);

  const panel = stubElement('section', 'level-panel', { 'data-level': '1', 'data-pair': 'futures' });
  panel.append(quiz);

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
      querySelectorAll: (sel) => (sel === '.quiz' ? [quiz] : []),
      querySelector: () => null,
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(curriculum, sandbox);

  const submitQuiz = () => submit.listeners.forEach((fn) => fn());
  const pick = (qi, oi) => blocks[qi].querySelectorAll('.quiz-choice').forEach((el) => {
    el.querySelector('input[type="radio"]').checked = el.getAttribute('data-oi') === String(oi);
  });
  const retryButton = () => {
    const box = quiz.children[quiz.children.length - 1];
    return box.descendants().find((n) => n.tagName === 'BUTTON' && n.innerHTML === 'Retry the missed questions');
  };
  return { blocks, score, submitQuiz, pick, retryButton };
}

test('retrying missed questions scrolls to the first missed question, not the last', () => {
  const q = renderQuiz();
  q.pick(0, 1); // right
  q.pick(1, 2); // wrong: original index 2 (correct is 1)
  q.pick(2, 0); // wrong: original index 0 (correct is 1)
  q.submitQuiz();
  assert.equal(q.score.textContent, 'Score: 1 / 3');

  const retry = q.retryButton();
  assert.ok(retry, 'a Retry button must be rendered when questions were missed');
  retry.listeners[0]();

  assert.equal(q.blocks[0].scrollCalls, 0, 'the correct question must never be scrolled to');
  assert.equal(q.blocks[1].scrollCalls, 1, 'the FIRST missed question (qi 1) must receive the scroll');
  assert.equal(q.blocks[2].scrollCalls, 0, 'the LAST missed question must not steal the scroll target');

  // Every missed question's state is still cleared, not just the one scrolled to.
  [1, 2].forEach((qi) => {
    q.blocks[qi].querySelectorAll('input[type="radio"]').forEach((r) => assert.equal(r.checked, false));
    q.blocks[qi].querySelectorAll('.quiz-choice').forEach((c) => {
      assert.equal(c.classes.includes('correct'), false);
      assert.equal(c.classes.includes('incorrect'), false);
    });
    assert.equal(q.blocks[qi].querySelector('.quiz-explain').classes.includes('show'), false);
  });
});
