#!/usr/bin/env node
/* Syntax gate for assets/*.js plus the functions/api/*.js files check:syntax
 * has always named explicitly.
 *
 * Only the assets/ half is auto-discovered. That's the half that's actually
 * broken twice: candles-bg.js was missing until an earlier run added it,
 * then curriculum.js and tilt.js were missing too (fixed 2026-09-12,
 * same day as this change) — a hand-kept list of "every file in this one
 * flat directory" has no reason to exist when readdirSync can do it and
 * never rot again.
 *
 * The functions/api/*.js list stays explicit and unchanged from before this
 * change: that same 2026-09-12 run found several functions/api/*.js and
 * _lib/*.js files check:syntax had never named, and deliberately left them
 * out — every one of those files already has direct import/execution-based
 * test coverage that would catch a syntax error just as reliably, so
 * enumerating them here would be tidiness with no coverage gain. Don't
 * relitigate that; if a *new* functions/api file ships with no test
 * importing it, that's a test-coverage gap to fix directly, not a reason to
 * grow this list.
 *
 * Usage: node tools/check-syntax.mjs
 */
import { readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const EXPLICIT_FUNCTIONS_FILES = [
  'functions/api/research-engine.js',
  'functions/api/verify-premium.js',
  'functions/api/check-member-status.js',
  'functions/api/logout-premium.js',
  'functions/api/forex-calendar.js',
  'functions/api/yahoo-news.js',
  'functions/api/stock-research.js',
  'functions/api/premium-stock-research.js',
  'functions/api/premium-market-analyst.js',
  'functions/api/content.js',
  'functions/api/ticker.js',
  'functions/api/_lib/session.js',
  'functions/api/_lib/http.js',
  'functions/api/assistant.js',
  'functions/api/whop-webhook.js',
  'functions/api/auth-google.js',
  'functions/api/_lib/entitlements.js',
  'functions/api/_lib/backtest-core.js',
  'functions/api/analytics.js',
];

function listJsFilesFlat(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.js'))
    .map((name) => join(dir, name));
}

// Exported so tests/pj-futures.test.mjs can pin specific assets files into
// this set without re-hardcoding the list check:syntax no longer carries
// for that half.
export function filesToCheck(root = ROOT) {
  return [
    ...listJsFilesFlat(join(root, 'assets')),
    ...EXPLICIT_FUNCTIONS_FILES.map((f) => join(root, f)),
  ].sort();
}

function main() {
  const files = filesToCheck();
  let failed = 0;
  for (const file of files) {
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } catch (err) {
      failed++;
      console.error(`✗ ${relative(ROOT, file)}`);
      console.error(String(err.stderr || err.message).trim());
    }
  }

  if (failed) {
    console.error(`\n${failed} of ${files.length} files failed syntax check.`);
    process.exit(1);
  }
  console.log(`check:syntax — ${files.length} files OK (assets/*.js auto-discovered + ${EXPLICIT_FUNCTIONS_FILES.length} named functions/api/*.js files).`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
