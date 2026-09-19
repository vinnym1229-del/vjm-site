// Coverage for tools/quiz-audit.mjs's own CLI entry point (the
// `import.meta.url === file://...` block), which every other quiz-audit test
// leaves untouched.
//
// tests/quiz-integrity.test.mjs exhaustively tests the exported pure
// functions (auditQuestions/verdict/shuffleDefenceActive) against synthetic
// fixtures, and regressions.test.mjs runs this same CLI as a subprocess -- but
// only against the real course pages, which have no length leak today. That
// means the CLI's own FAIL branch (v.lengthLeak) and its exit-code ternary
// have never actually fired in any test run: c8 flags them as zero-coverage,
// and a regression that broke `process.exitCode = ... ? 1 : 0` into always 0
// would pass the whole suite silently, defeating the one guard this repo
// relies on to catch a leaking quiz in CI. This pins that the FAIL path is
// real by driving it with a fixture the audit must reject.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TOOL = join(ROOT, 'tools', 'quiz-audit.mjs');

// A four-option quiz where the correct answer is always the far longer
// option -- the exact shape the tool's own header comment describes as
// "passable without reading the lesson."
function lengthLeakFixture(count) {
  const blocks = Array.from({ length: count }, (_, i) => `
    <div class="quiz-q" data-qi="${i}">
      <p class="qtext">Question ${i}?</p>
      <label class="quiz-choice"><span>No.</span></label>
      <label class="quiz-choice"><span>Not quite.</span></label>
      <label class="quiz-choice"><span>This is the much longer correct answer, spelled out in full detail.</span></label>
      <label class="quiz-choice"><span>Nope.</span></label>
    </div>`).join('\n');
  const key = JSON.stringify(Array.from({ length: count }, () => ({ correct: 2 })));
  return `<div class="quiz">${blocks}\n<script type="application/json">${key}</script></div>`;
}

function run(args, env = {}) {
  try {
    return {
      stdout: execFileSync(process.execPath, [TOOL, ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } }),
      status: 0,
    };
  } catch (err) {
    return { stdout: err.stdout, status: err.status };
  }
}

test("the CLI fails and exits 1 when a page's correct answers leak through length", () => {
  const dir = mkdtempSync(join(tmpdir(), 'quiz-audit-cli-'));
  const fixture = join(dir, 'leaky.html');
  writeFileSync(fixture, lengthLeakFixture(12));
  try {
    const { stdout, status } = run([fixture]);
    assert.match(stdout, /longest-is-correct 100%/, `expected the leak to be measured:\n${stdout}`);
    assert.match(
      stdout,
      /FAIL: the correct answer is too often the longest option\./,
      `expected the length-leak FAIL line:\n${stdout}`,
    );
    assert.equal(status, 1, 'a length leak must set a non-zero exit status so CI fails');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The position-leak FAIL branch (quiz-audit.mjs lines 181-185) only fires
// when the source distribution is lopsided AND the shipped curriculum.js has
// lost its render-time shuffle -- a combination the real, currently-shuffled
// curriculum.js can never produce. QUIZ_AUDIT_CURRICULUM_PATH lets this test
// swap in a synthetic "shuffle removed" source instead of mutating the real
// file on disk.
test('the CLI fails and exits 1 when answer positions are lopsided and the shuffle defence is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quiz-audit-cli-'));
  const fixture = join(dir, 'lopsided.html');
  // Same shape as the balanced fixture below (no length tell either way),
  // but every correct answer sits at position 0 -- "always click slot 0"
  // would score 100%, well past POSITION_LIMIT.
  const blocks = Array.from({ length: 12 }, (_, i) => `
    <div class="quiz-q" data-qi="${i}">
      <p class="qtext">Question ${i}?</p>
      <label class="quiz-choice"><span>Ab.</span></label>
      <label class="quiz-choice"><span>This is a longer wrong answer with extra words.</span></label>
      <label class="quiz-choice"><span>Another longer wrong answer here too.</span></label>
      <label class="quiz-choice"><span>Yet one more padded wrong answer choice.</span></label>
    </div>`).join('\n');
  const key = JSON.stringify(Array.from({ length: 12 }, () => ({ correct: 0 })));
  writeFileSync(fixture, `<div class="quiz">${blocks}\n<script type="application/json">${key}</script></div>`);
  const fakeCurriculum = join(dir, 'curriculum.js');
  writeFileSync(fakeCurriculum, '// no shuffleQuestionChoices/orderChoices here -- shuffle defence removed\n');
  try {
    const { stdout, status } = run([fixture], { QUIZ_AUDIT_CURRICULUM_PATH: fakeCurriculum });
    assert.match(
      stdout,
      /FAIL: answer positions are lopsided AND the render-time shuffle[\s\S]*is missing or bypassed/,
      `expected the position-leak FAIL line:\n${stdout}`,
    );
    assert.equal(status, 1, 'a position leak with no shuffle defence must set a non-zero exit status');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the CLI exits 0 and prints no FAIL line for a balanced fixture', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quiz-audit-cli-'));
  const fixture = join(dir, 'balanced.html');
  // Same shape, but the correct choice is the shortest text this time --
  // no length tell either way.
  const blocks = Array.from({ length: 12 }, (_, i) => `
    <div class="quiz-q" data-qi="${i}">
      <p class="qtext">Question ${i}?</p>
      <label class="quiz-choice"><span>Ab.</span></label>
      <label class="quiz-choice"><span>This is a longer wrong answer with extra words.</span></label>
      <label class="quiz-choice"><span>Another longer wrong answer here too.</span></label>
      <label class="quiz-choice"><span>Yet one more padded wrong answer choice.</span></label>
    </div>`).join('\n');
  const key = JSON.stringify(Array.from({ length: 12 }, () => ({ correct: 0 })));
  writeFileSync(fixture, `<div class="quiz">${blocks}\n<script type="application/json">${key}</script></div>`);
  try {
    const { stdout, status } = run([fixture]);
    assert.doesNotMatch(stdout, /FAIL: the correct answer is too often the longest option\./, stdout);
    assert.equal(status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
