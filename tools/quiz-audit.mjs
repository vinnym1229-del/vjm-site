// Quiz answer-shape auditor.
//
// A quiz whose correct answer is reliably the longest option — or reliably in
// the same position — is not an assessment: it can be passed without reading
// the lesson. This measures both leaks. Run: node tools/quiz-audit.mjs [file.html ...]
//
// Reports, per page and overall:
//   - how often the correct answer is the longest option (chance is
//     1/optionCount, i.e. ~25% for four options) and how much longer the
//     correct answer runs than the average option;
//   - the distribution of correct-answer positions and the score a member
//     would get by always clicking the single most common position.
//
// Exit status. The length leak always fails CI. The position leak is graded
// against the DEFENCE that is actually deployed: assets/curriculum.js shuffles
// each question's displayed choices once per page load and grades by each
// choice's original index, so a lopsided source distribution is no longer
// exploitable by a reader. While that shuffle is in place a lopsided source is
// reported as a WARNING; if the shuffle is removed or bypassed, the same
// distribution becomes exploitable again and the audit fails.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export const DEFAULT_PAGES = [
  'stock-breakdown.html',
  'options-lab.html',
  'futures-dissection.html',
  'psychology-enhancer.html',
];

// Above this share of answers sitting in one position, "always click slot N"
// beats genuine study. Chance for four options is 25%.
export const POSITION_LIMIT = 0.45;
// Same idea for the longest-option tell.
export const LENGTH_LIMIT = 0.45;

const strip = (s) => s.replace(/<[^>]+>/g, '').replace(/&[a-z]+;/gi, ' ').trim();

// Pull every graded question out of one page: its choice texts and the
// authored correct index.
export function parseQuestions(html) {
  const quizzes = html.match(/<div class="quiz">[\s\S]*?<script type="application\/json">[\s\S]*?<\/script>/g) || [];
  const out = [];
  for (const q of quizzes) {
    const key = JSON.parse(/<script type="application\/json">([\s\S]*?)<\/script>/.exec(q)[1]);
    const blocks = q.split(/<div class="quiz-q" data-qi="\d+">/).slice(1);
    blocks.forEach((b, bi) => {
      const choices = [...b.matchAll(/<span>([\s\S]*?)<\/span>/g)].map((m) => strip(m[1]));
      if (choices.length < 2 || bi >= key.length) return;
      const correct = key[bi].correct;
      if (!Number.isInteger(correct) || correct >= choices.length) return;
      out.push({ choices, correct });
    });
  }
  return out;
}

// Length + position statistics for a set of questions.
export function auditQuestions(questions) {
  const positions = [];
  let total = 0;
  let longest = 0;
  let correctLen = 0;
  let avgLen = 0;
  for (const { choices, correct } of questions) {
    const lens = choices.map((c) => c.length);
    total += 1;
    if (lens[correct] === Math.max(...lens)) longest += 1;
    correctLen += lens[correct];
    avgLen += lens.reduce((a, b) => a + b, 0) / lens.length;
    positions[correct] = (positions[correct] || 0) + 1;
    for (let i = 0; i < choices.length; i++) positions[i] = positions[i] || 0;
  }
  const counts = [...positions].map((n) => n || 0);
  const topCount = counts.length ? Math.max(...counts) : 0;
  return {
    total,
    longest,
    longestPct: total ? longest / total : 0,
    lengthRatio: avgLen ? correctLen / avgLen : 0,
    correctLen,
    avgLen,
    positions: counts,
    // What "always click the most common position" scores.
    topPosition: counts.indexOf(topCount),
    topPositionPct: total ? topCount / total : 0,
  };
}

export function auditPage(path, html) {
  return { page: path, ...auditQuestions(parseQuestions(html)) };
}

export function auditPages(pages = DEFAULT_PAGES, read = (p) => readFileSync(join(ROOT, p), 'utf8')) {
  return pages.map((p) => auditPage(p, read(p))).filter((r) => r.total);
}

// Is the render-time defence still in place? The audit only demands a balanced
// SOURCE distribution when the displayed order is no longer shuffled.
export function shuffleDefenceActive(currSrc) {
  return /function orderChoices\s*\(/.test(currSrc)
    && /function shuffleQuestionChoices\s*\(/.test(currSrc)
    && /shuffleQuestionChoices\(block/.test(currSrc)
    && /data-oi/.test(currSrc)
    && /isCorrectPick\(picked, q\)/.test(currSrc);
}

// One verdict for the whole site, given the per-page rows and the shipped
// curriculum.js source.
export function verdict(rows, currSrc) {
  const site = rows.reduce((a, r) => {
    a.total += r.total;
    a.longest += r.longest;
    a.correctLen += r.correctLen;
    a.avgLen += r.avgLen;
    r.positions.forEach((n, i) => { a.positions[i] = (a.positions[i] || 0) + n; });
    return a;
  }, { total: 0, longest: 0, correctLen: 0, avgLen: 0, positions: [] });
  const topCount = site.positions.length ? Math.max(...site.positions) : 0;
  const shuffled = shuffleDefenceActive(currSrc);
  const longestPct = site.total ? site.longest / site.total : 0;
  const topPositionPct = site.total ? topCount / site.total : 0;
  return {
    ...site,
    longestPct,
    lengthRatio: site.avgLen ? site.correctLen / site.avgLen : 0,
    topPosition: site.positions.indexOf(topCount),
    topPositionPct,
    shuffled,
    lengthLeak: longestPct > LENGTH_LIMIT,
    positionLeak: topPositionPct > POSITION_LIMIT,
    // A lopsided source only fails CI when nothing shuffles it at render time.
    positionFails: topPositionPct > POSITION_LIMIT && !shuffled,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const pages = args.length ? args : DEFAULT_PAGES;
  const resolve = (p) => (existsSync(p) ? p : join(ROOT, p));
  const rows = auditPages(pages, (p) => readFileSync(resolve(p), 'utf8'));
  const currSrc = readFileSync(join(ROOT, 'assets/curriculum.js'), 'utf8');
  const v = verdict(rows, currSrc);

  for (const r of rows) {
    console.log(
      `${r.page.padEnd(26)} ${String(r.total).padStart(3)} questions  ` +
      `longest-is-correct ${(r.longestPct * 100).toFixed(0).padStart(3)}%  ` +
      `length ratio ${r.lengthRatio.toFixed(2)}x  ` +
      `positions [${r.positions.join(', ')}]  ` +
      `always-slot-${r.topPosition} scores ${(r.topPositionPct * 100).toFixed(0).padStart(3)}%`,
    );
  }
  console.log('-'.repeat(78));
  console.log(
    `OVERALL ${String(v.total).padStart(20)} questions  ` +
    `longest-is-correct ${(v.longestPct * 100).toFixed(0).padStart(3)}%  ` +
    `length ratio ${v.lengthRatio.toFixed(2)}x`,
  );
  console.log(`answer positions site-wide: [${v.positions.join(', ')}]`);
  console.log(
    `always clicking slot ${v.topPosition} scores ${(v.topPositionPct * 100).toFixed(0)}% ` +
    `of ${v.total} questions (chance for 4 options is 25%)`,
  );
  console.log('chance level for 4 options is 25%; anything above ~45% means the quiz leaks its answers');

  if (v.lengthLeak) {
    console.log('FAIL: the correct answer is too often the longest option.');
  }
  if (v.positionLeak && v.shuffled) {
    console.log(
      'WARN: the authored answer positions are lopsided, but assets/curriculum.js ' +
      'shuffles each question at render time and grades by original index, so the ' +
      'displayed order does not leak. Removing that shuffle turns this into a failure.',
    );
  }
  if (v.positionFails) {
    console.log(
      'FAIL: answer positions are lopsided AND the render-time shuffle in ' +
      'assets/curriculum.js is missing or bypassed — the quiz is guessable again.',
    );
  }
  process.exitCode = v.lengthLeak || v.positionFails ? 1 : 0;
}
