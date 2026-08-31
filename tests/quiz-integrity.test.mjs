// Quiz integrity tests.
//
// Every authored question on the four course pages puts the correct answer in
// the same slot: site-wide, 96 of 100 correct answers sit at index 1, so
// "always click the second option" scored 96% without reading a lesson. The
// fix is a render-time shuffle in assets/curriculum.js keyed to each choice's
// ORIGINAL index, plus an audit guard so the defence cannot quietly go away.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import {
  auditQuestions,
  parseQuestions,
  shuffleDefenceActive,
  verdict,
  POSITION_LIMIT,
} from '../tools/quiz-audit.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const curriculum = read('assets/curriculum.js');

// Load the browser IIFE in a sandbox with just enough of a DOM that it parses
// and publishes its test seam without running init().
function loadInternals() {
  const sandbox = {
    document: { readyState: 'loading', addEventListener() {}, querySelectorAll: () => [] },
    console,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(curriculum, sandbox);
  return sandbox.window.__quizInternals;
}

const { orderChoices, isCorrectPick } = loadInternals();

// A four-option quiz whose answer is always slot 1 — the shape the real pages
// have. The audit must recognise it as a position leak.
const lopsided = Array.from({ length: 12 }, () => ({
  choices: ['aaaa', 'bbbb', 'cccc', 'dddd'],
  correct: 1,
}));
const balanced = Array.from({ length: 12 }, (_, i) => ({
  choices: ['aaaa', 'bbbb', 'cccc', 'dddd'],
  correct: i % 4,
}));

test('the audit flags a positionally-imbalanced fixture', () => {
  const bad = auditQuestions(lopsided);
  // Protects the measurement itself: "always click the most common slot" must
  // be reported as a 100% score, not hidden behind an average.
  assert.equal(bad.topPosition, 1);
  assert.equal(bad.topPositionPct, 1);
  assert.ok(bad.topPositionPct > POSITION_LIMIT, 'an all-slot-1 key must exceed the position limit');

  const good = auditQuestions(balanced);
  // Protects against a guard that flags everything: an even spread must pass.
  assert.equal(good.topPositionPct, 0.25);
  assert.ok(good.topPositionPct <= POSITION_LIMIT, 'an evenly spread key must not be flagged');
});

test('a lopsided key fails CI only when the render-time shuffle is gone', () => {
  const rows = [{ page: 'fixture.html', ...auditQuestions(lopsided) }];
  // With the shuffle shipped, the source imbalance is unexploitable: warn, pass.
  const withShuffle = verdict(rows, curriculum);
  assert.equal(withShuffle.positionLeak, true, 'the imbalance must still be reported');
  assert.equal(withShuffle.positionFails, false, 'shuffled pages must not fail CI on source order');
  // Strip the shuffle and the same key becomes guessable again — CI must fail.
  const withoutShuffle = verdict(rows, curriculum.replace(/shuffleQuestionChoices\(block/g, 'noop(block'));
  assert.equal(withoutShuffle.positionFails, true, 'removing the shuffle must break the build');
});

test('the shipped curriculum.js still carries the shuffle defence', () => {
  // The guard above is only meaningful if the real file passes it today.
  assert.equal(shuffleDefenceActive(curriculum), true);
});

test('the real course pages are the imbalanced case this defends against', () => {
  // Documents the live exploit: if someone rebalances the HTML later this
  // still passes, but the shuffle must never be dropped while it holds.
  const questions = ['stock-breakdown.html', 'options-lab.html', 'futures-dissection.html', 'psychology-enhancer.html']
    .flatMap((p) => parseQuestions(read(p)));
  assert.equal(questions.length, 100, 'all 100 graded questions must be parsed');
  const stats = auditQuestions(questions);
  assert.ok(stats.topPositionPct > POSITION_LIMIT, 'the authored key is lopsided, so the shuffle is load-bearing');
});

test('curriculum.js grades by original index, not rendered position', () => {
  // The pure grading rule takes an ORIGINAL choice index, so where a choice is
  // drawn cannot change a score.
  assert.equal(isCorrectPick(1, { correct: 1 }), true);
  assert.equal(isCorrectPick(0, { correct: 1 }), false);
  assert.equal(isCorrectPick(1, {}), false, 'a question with no key must never grade as correct');

  // Source-level guard: the old code compared the loop position `ci` against
  // q.correct for the highlight, which would mis-highlight after a shuffle.
  assert.doesNotMatch(curriculum, /if \(ci === q\.correct\)/, 'highlighting must not key off rendered position');
  assert.match(curriculum, /originalIndexOf\(choiceEl, ci\)/, 'highlighting must resolve the original index');
  assert.match(curriculum, /data-oi/, 'each rendered choice must be stamped with its original index');
});

test('the shuffle happens once at render, not on every submit', () => {
  // A reshuffle on submit would move a member's selection under them.
  const submitBody = /submitBtn\.addEventListener\('click', \(\) => \{[\s\S]*?\n      \}\);/.exec(curriculum);
  assert.ok(submitBody, 'submit handler must be present');
  assert.doesNotMatch(submitBody[0], /shuffleQuestionChoices/, 'submit must not reshuffle');
  assert.match(curriculum, /if \(block\) shuffleQuestionChoices\(block, rand\);/, 'shuffle runs during init');
});

test('the shuffle preserves the set of choices exactly', () => {
  const choices = ['alpha', 'bravo', 'charlie', 'delta'];
  for (let seed = 0; seed < 200; seed++) {
    let n = seed + 1;
    const rand = () => ((n = (n * 1103515245 + 12345) % 2147483648) / 2147483648);
    const ordered = orderChoices(choices, rand);
    // Nothing dropped or duplicated…
    assert.equal(ordered.length, choices.length);
    assert.deepEqual([...ordered].map((c) => c.oi).sort(), [0, 1, 2, 3]);
    // …and nothing reworded: every text survives verbatim, paired with the
    // original index the grader will use.
    assert.deepEqual([...ordered].sort((a, b) => a.oi - b.oi).map((c) => c.choice), choices);
  }
});

test('the shuffle actually reorders (it is not a no-op)', () => {
  // A "shuffle" that always returns source order would leave the exploit intact.
  let n = 7;
  const rand = () => ((n = (n * 1103515245 + 12345) % 2147483648) / 2147483648);
  const runs = Array.from({ length: 50 }, () => orderChoices([0, 1, 2, 3], rand).map((c) => c.oi).join(''));
  assert.ok(new Set(runs).size > 1, 'repeated shuffles must produce more than one order');
  const slot0 = runs.filter((r) => r[0] === '1').length;
  // The pre-fix answer slot must not dominate the first rendered position.
  assert.ok(slot0 < runs.length * 0.6, 'original index 1 must not stay pinned to the top slot');
});

// --- render-time integration -------------------------------------------
// No browser here, so this is a deliberately tiny DOM stub: just enough of
// classList / insertBefore / querySelector for initQuizzes to render and grade
// a four-choice question end to end. It caught a real bug (Number(null) === 0
// made every choice claim original index 0), which is why it is kept.
function stubElement(tag, cls, attrs = {}) {
  const set = new Set(String(cls).split(' ').filter(Boolean));
  const el = {
    tagName: tag.toUpperCase(),
    children: [],
    attrs: { ...attrs },
    parent: null,
    text: '',
    checked: false,
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
    addEventListener: (_ev, fn) => el.listeners.push(fn),
    listeners: [],
  };
  return el;
}

// Build one .quiz with a single four-choice question whose answer is index 1 —
// exactly the shape the course pages ship — and run curriculum.js against it.
function renderQuiz() {
  const quiz = stubElement('div', 'quiz');
  const block = stubElement('div', 'quiz-q', { 'data-qi': '0' });
  quiz.append(block);
  const labels = ['alpha', 'bravo', 'charlie', 'delta'].map((t, i) => {
    const label = stubElement('label', 'quiz-choice');
    const input = stubElement('input', '', { type: 'radio', name: 'q0', value: String(i) });
    label.append(input);
    label.text = t;
    return block.append(label);
  });
  const explain = block.append(stubElement('div', 'quiz-explain'));
  const submit = quiz.append(stubElement('button', 'quiz-submit'));
  const score = quiz.append(stubElement('span', 'quiz-score'));
  const data = quiz.append(stubElement('script', '', { type: 'application/json' }));
  data.textContent = '[{"correct":1}]';

  const sandbox = {
    console,
    fetch: async () => ({ json: async () => ({}) }),
    document: {
      readyState: 'complete',
      addEventListener() {},
      querySelectorAll: (sel) => (sel === '.quiz' ? [quiz] : []),
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(curriculum, sandbox);
  const rendered = () => block.querySelectorAll('.quiz-choice');
  const submitQuiz = () => submit.listeners.forEach((fn) => fn());
  const pick = (oi) => rendered().forEach((el) => {
    el.querySelector('input[type="radio"]').checked = el.getAttribute('data-oi') === String(oi);
  });
  return { block, labels, rendered, explain, score, submitQuiz, pick };
}

test('rendering stamps every choice with its original index', () => {
  const q = renderQuiz();
  const stamped = q.rendered().map((el) => el.getAttribute('data-oi'));
  // Each choice must carry a distinct original index, and the radio value must
  // agree with it — grading reads the value, highlighting reads data-oi.
  assert.deepEqual([...stamped].sort(), ['0', '1', '2', '3']);
  q.rendered().forEach((el) => {
    assert.equal(el.querySelector('input[type="radio"]').value, el.getAttribute('data-oi'));
  });
  // Every authored choice survives the reorder, text intact.
  assert.deepEqual(q.rendered().map((el) => el.text).sort(), ['alpha', 'bravo', 'charlie', 'delta']);
  assert.equal(q.rendered().length, 4, 'no choice dropped or duplicated by the reorder');
});

test('the correct answer scores wherever it is rendered', () => {
  for (let i = 0; i < 25; i++) {
    const q = renderQuiz();
    q.pick(1); // original index 1 — the authored answer, at whatever slot it landed
    q.submitQuiz();
    // Grading must follow the original index, never the rendered position.
    assert.equal(q.score.textContent, 'Score: 1 / 1');
    const correctEl = q.rendered().find((el) => el.classes.includes('correct'));
    assert.equal(correctEl.getAttribute('data-oi'), '1', 'the highlight must mark the original answer');
    assert.equal(q.explain.classes.includes('show'), true);
  }
});

test('a wrong answer scores zero and is marked wherever it is rendered', () => {
  const q = renderQuiz();
  q.pick(2);
  q.submitQuiz();
  // Protects against an off-by-position bug crediting the wrong choice.
  assert.equal(q.score.textContent, 'Score: 0 / 1');
  assert.equal(q.rendered().find((el) => el.classes.includes('incorrect')).getAttribute('data-oi'), '2');
  assert.equal(q.rendered().find((el) => el.classes.includes('correct')).getAttribute('data-oi'), '1');
});

test('the second rendered slot is no longer a free pass', () => {
  // The whole point: across page loads the authored answer must not keep
  // landing in slot 1, otherwise the 96% guess still works.
  const slots = Array.from({ length: 120 }, () => renderQuiz().rendered()
    .findIndex((el) => el.getAttribute('data-oi') === '1'));
  const inSlot1 = slots.filter((s) => s === 1).length / slots.length;
  assert.ok(inSlot1 < 0.5, `answer stayed in slot 1 ${(inSlot1 * 100).toFixed(0)}% of loads`);
  assert.equal(new Set(slots).size, 4, 'the answer must be able to land in every slot');
});
