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

// Build one .quiz with a single four-choice question whose answer is index 1 —
// exactly the shape the course pages ship — and run curriculum.js against it.
function renderQuiz(opts = {}) {
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
  explain.textContent = 'Margin is a performance bond, not a loss cap.';
  const qtext = block.append(stubElement('p', 'qtext'));
  qtext.textContent = 'Is a long futures position capped at the margin deposited?';
  const submit = quiz.append(stubElement('button', 'quiz-submit'));
  const score = quiz.append(stubElement('span', 'quiz-score'));
  const data = quiz.append(stubElement('script', '', { type: 'application/json' }));
  data.textContent = '[{"correct":1}]';

  // The quiz lives inside a level panel, the way it does on every course page:
  // the completion panel reads the level/pair off it.
  const panel = stubElement('section', 'level-panel', { 'data-level': '1', 'data-pair': 'futures' });
  panel.append(quiz);

  // localStorage that behaves (opts.storageThrows models private mode, where
  // the accessor itself throws — the page must still grade and render).
  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { if (opts.storageThrows) throw new Error('QuotaExceededError'); store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
  const events = [];
  const sandbox = {
    console,
    fetch: async () => ({ json: async () => ({}) }),
    localStorage: opts.noStorage ? undefined : localStorage,
    location: { pathname: opts.pathname || '/futures-dissection' },
    vjmTrack: (name, props) => events.push({ name, props }),
    document: {
      readyState: 'complete',
      addEventListener() {},
      createElement: (tag) => stubElement(tag, ''),
      querySelectorAll: (sel) => (sel === '.quiz' ? [quiz] : []),
      querySelector: (sel) => (opts.lookup && opts.lookup[sel]) || null,
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
  // Everything the completion panel rendered, flattened for assertions.
  const completion = () => {
    const box = quiz.children[quiz.children.length - 1];
    if (!box || box === score || box === data) return null;
    const html = [box, ...box.descendants()].map((n) => n.innerHTML || '').join(' ');
    const links = [box, ...box.descendants()].filter((n) => n.href).map((n) => n.href);
    return { box, html, links, nodes: [box, ...box.descendants()] };
  };
  const saved = () => {
    const raw = store.get('vjm-progress-v1');
    return raw ? JSON.parse(raw) : null;
  };
  return { block, labels, rendered, explain, score, submitQuiz, pick, panel, events, saved, completion, store };
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

// --- free progress, remediation, and the next step ------------------------
// Finishing free Futures Level 1 used to produce a score and nothing else: no
// saved progress, no remediation for what was missed, no next lesson, and no
// prompt to the plan that contains Level 2. These pin the replacement, and
// pin that none of it can reintroduce the position leak or break grading.

test('finishing a free quiz saves progress on this device and reports the stage', () => {
  const q = renderQuiz();
  q.pick(1);
  q.submitQuiz();

  const rec = q.saved();
  assert.ok(rec, 'a completed quiz must persist locally');
  const quizRec = rec['futures-dissection'].quizzes['futures:1'];
  assert.deepEqual(
    { last: quizRec.last, best: quizRec.best, total: quizRec.total, missed: quizRec.missed },
    { last: 1, best: 1, total: 1, missed: [] },
  );

  const stage = q.events.find((e) => e.name === 'free_level_complete');
  assert.ok(stage, 'free_level_complete must be reported to the funnel');
  assert.equal(stage.props.level, '1');
  assert.equal(stage.props.course, 'futures-dissection');
  assert.equal(stage.props.score, 1);
});

test('saved progress records original question indices, never the rendered order', () => {
  // The shuffle is per render by design. Persisting the drawn order — or the
  // picked slot — would hand back the "always click slot 1" leak the shuffle
  // exists to close, so the record may only ever carry authored indices.
  const q = renderQuiz();
  q.pick(2);            // wrong: original index 2
  q.submitQuiz();
  assert.equal(q.score.textContent, 'Score: 0 / 1', 'saving progress must not disturb grading');

  const raw = q.store.get('vjm-progress-v1');
  const rec = JSON.parse(raw)['futures-dissection'].quizzes['futures:1'];
  assert.deepEqual(rec.missed, [0], 'missed questions are keyed by question index');
  assert.doesNotMatch(raw, /order|slot|rendered|position|picked/i,
    `the stored record must not describe how choices were drawn: ${raw}`);
});

test('a missed question comes back with targeted remediation, not just a score', () => {
  const q = renderQuiz();
  q.pick(2);
  q.submitQuiz();
  const panel = q.completion();
  assert.ok(panel, 'a completion panel must be rendered');
  assert.match(panel.html, /Is a long futures position capped at the margin deposited\?/);
  assert.match(panel.html, /Margin is a performance bond, not a loss cap\./);
  assert.match(panel.html, /Review these/);
});

test('the end of the free level points at the plan that actually contains the next one', () => {
  // Level 2 of Futures Dissection is Futures Core ($100/mo) — not Complete.
  const lockedGate = { getAttribute: () => null };
  const lockedNext = { querySelector: (sel) => (sel === '.lock-gate' ? lockedGate : null) };
  const q = renderQuiz({
    lookup: {
      '.level-panel[data-pair="futures"][data-level="2"]': lockedNext,
      '.level-tab[data-pair="futures"][data-level="2"]': { textContent: '2. Intermediate 🔒' },
    },
  });
  q.pick(1);
  q.submitQuiz();
  const panel = q.completion();
  assert.match(panel.html, /2\. Intermediate/, 'the next level must be named');
  assert.match(panel.html, /Futures Core/);
  assert.match(panel.html, /\$100\/mo/);
  assert.doesNotMatch(panel.html, /\$129/, 'the free futures level must not upsell the wrong plan');
  assert.ok(
    panel.links.some((h) => h.includes('whop.com/pjtradespremium') && h.includes('free-level-complete-futures_core')),
    `a plan CTA must be present: ${panel.links.join(', ')}`,
  );
});

test('an entitled member finishing the free level gets a Next button, not a repeat upsell', () => {
  // unlockAll() hides an unlocked level's .lock-gate rather than removing it
  // (functions/_middleware.js already stripped the paid markup server-side
  // for anyone else, so the node has to stay for a signed-out/under-tier
  // visitor). It stamps data-vjm-lock="entitled" on the gate as the only
  // record that this member's own copy is unlocked. Before this stamp
  // existed, nextLevelInfo() treated the gate's mere presence as "still
  // locked", so a paying member who just finished Level 1 was told to buy
  // Futures Core again and to "sign in" while already signed in.
  const unlockedGate = { getAttribute: (k) => (k === 'data-vjm-lock' ? 'entitled' : null) };
  const unlockedNext = { querySelector: (sel) => (sel === '.lock-gate' ? unlockedGate : null) };
  const q = renderQuiz({
    lookup: {
      '.level-panel[data-pair="futures"][data-level="2"]': unlockedNext,
      '.level-tab[data-pair="futures"][data-level="2"]': { textContent: '2. Intermediate' },
    },
  });
  q.pick(1);
  q.submitQuiz();
  const panel = q.completion();
  assert.match(panel.html, /Next: 2\. Intermediate/, 'an unlocked next level must offer to go there');
  assert.doesNotMatch(panel.html, /Futures Core|\$100\/mo/, 'an entitled member must not be upsold the plan they already have');
  assert.doesNotMatch(panel.html, /Already a member\?/, 'a signed-in member must not be told to sign in');
});

test('a device that cannot store progress still grades, renders and reports', () => {
  // localStorage throws in private mode and in some embedded webviews; the
  // lesson must not care.
  for (const opts of [{ storageThrows: true }, { noStorage: true }]) {
    const q = renderQuiz(opts);
    q.pick(1);
    q.submitQuiz();
    assert.equal(q.score.textContent, 'Score: 1 / 1');
    assert.equal(q.saved(), null, 'nothing is persisted when storage is unavailable');
    assert.ok(q.events.some((e) => e.name === 'free_level_complete'));
  }
});
