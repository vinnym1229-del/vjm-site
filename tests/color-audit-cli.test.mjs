// Coverage for tools/color-audit.mjs's own CLI entry point (the
// `if (import.meta.url === ...)` block: --root, --json, the text summary,
// and critically the RETIRED LITERALS STILL PRESENT fail branch that sets
// process.exitCode = 1), which no test had ever exercised.
//
// tests/palette.test.mjs only imports the exported pure functions
// (auditTree, shippedFiles, extractColors, isRed, contrast, hexToRgb) and
// asserts against the real shipped tree, which has no retired literal today
// -- so the CLI's own fail-exit-code path has zero coverage. A regression
// that silently broke it (inverting the `bad.length` check, dropping
// `process.exitCode = 1`, or a typo in the RETIRED/RETIRED_RGBA scan) would
// leave `node tools/color-audit.mjs` printing a clean report and exiting 0
// even with a retired red-palette literal back in shipped source, with
// nothing else in this repo watching for that regression: this tool isn't
// wired into `npm test` or `check:syntax`, only tests/palette.test.mjs's
// own reimplementation of the retired-literal scan would still catch it,
// and only for the real tree, not the CLI itself. This is the same defect
// class already fixed for tools/quiz-audit.mjs and tools/check-syntax.mjs's
// CLI entry points (see decisions.md, 2026-09-19 and 2026-09-20).
//
// The tool already accepts --root, so these drive the real subprocess
// against synthetic fixtures in a temp dir instead of mutating a real
// shipped file on disk mid-suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TOOL = join(ROOT, 'tools', 'color-audit.mjs');

function makeFixture(html) {
  const dir = mkdtempSync(join(tmpdir(), 'color-audit-cli-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), html);
  return dir;
}

function run(args) {
  try {
    return { stdout: execFileSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' }), status: 0 };
  } catch (err) {
    return { stdout: String(err.stdout || ''), stderr: String(err.stderr || ''), status: err.status };
  }
}

test('the CLI exits 0 and prints a clean summary when no retired literal is present', () => {
  const dir = makeFixture('<html><body style="color:#ff0000;background:#ffffff"></body></html>');
  try {
    const { stdout, status } = run(['--root', dir]);
    assert.equal(status, 0);
    assert.match(stdout, /site-wide: 1 of 2 color literals are red/, `expected a clean summary:\n${stdout}`);
    assert.doesNotMatch(stdout, /RETIRED LITERALS/, `unexpected retired-literal warning:\n${stdout}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the CLI exits 1 and names the file when a retired red literal is present', () => {
  const dir = makeFixture('<html><body style="color:#dc2626;background:#ffffff"></body></html>');
  try {
    const { stdout, status } = run(['--root', dir]);
    assert.equal(status, 1, 'a retired literal must set a non-zero exit status so CI fails');
    assert.match(stdout, /RETIRED LITERALS STILL PRESENT in 1 file\(s\):/, `expected the fail banner:\n${stdout}`);
    assert.match(stdout, /index\.html: #dc2626 x1/, `expected the offending file/literal named:\n${stdout}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--json emits the same rows auditTree() would, for the given --root', () => {
  const dir = makeFixture('<html><body style="color:#ff0000;background:#ffffff"></body></html>');
  try {
    const { stdout, status } = run(['--root', dir, '--json']);
    assert.equal(status, 0);
    const rows = JSON.parse(stdout);
    assert.deepEqual(rows, [
      { path: 'index.html', total: 2, chromatic: 1, red: 1, redShare: 1, retired: [] },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
