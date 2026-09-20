// Coverage for tools/check-syntax.mjs's own CLI entry point (main()'s
// pass/fail/exit-code logic), which no test had ever exercised.
//
// tests/pj-futures.test.mjs's "check:syntax auto-discovers assets/*.js"
// test only imports and asserts the exported filesToCheck() list -- it never
// invokes main() or the CLI itself. Since every file this repo actually
// lists in check:syntax is, by definition, always valid, running the real
// CLI against them can never hit the failed-file branch (the `if (failed)`
// exit(1) path and its error-line formatting), so a regression that broke
// that branch -- inverting the condition, dropping process.exit(1), or a
// catch block that stops incrementing `failed` -- would leave
// `npm run check:syntax` printing "files OK" and exiting 0 for a genuinely
// broken file, and the whole suite (which depends on check:syntax running
// first) would stay green. This is the same defect class already fixed for
// tools/quiz-audit.mjs's CLI entry point (see decisions.md, 2026-09-19).
//
// main() now accepts an explicit file list (argv-injectable) specifically so
// this test can drive the real subprocess against synthetic fixtures instead
// of mutating a real source file on disk mid-suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TOOL = join(ROOT, 'tools', 'check-syntax.mjs');

function run(files) {
  try {
    return { stdout: execFileSync(process.execPath, [TOOL, ...files], { encoding: 'utf8' }), status: 0 };
  } catch (err) {
    return { stdout: String(err.stdout || ''), stderr: String(err.stderr || ''), status: err.status };
  }
}

test('the CLI fails and exits 1 when a file has a real syntax error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'check-syntax-cli-'));
  const good = join(dir, 'good.mjs');
  const broken = join(dir, 'broken.mjs');
  writeFileSync(good, 'export const x = 1;\n');
  writeFileSync(broken, 'export const x = ;\n');
  try {
    const { stderr, status } = run([good, broken]);
    assert.equal(status, 1, 'a syntax error must set a non-zero exit status so CI fails');
    assert.match(stderr, /broken\.mjs/, `expected the broken file to be named in stderr:\n${stderr}`);
    assert.match(stderr, /1 of 2 files failed syntax check\./, `expected the failure tally on stderr:\n${stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the CLI exits 0 and reports every file OK when nothing is broken', () => {
  const dir = mkdtempSync(join(tmpdir(), 'check-syntax-cli-'));
  const a = join(dir, 'a.mjs');
  const b = join(dir, 'b.mjs');
  writeFileSync(a, 'export const a = 1;\n');
  writeFileSync(b, 'export const b = 2;\n');
  try {
    const { stdout, status } = run([a, b]);
    assert.equal(status, 0);
    assert.match(stdout, /2 files OK/, `expected a clean success line:\n${stdout}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
