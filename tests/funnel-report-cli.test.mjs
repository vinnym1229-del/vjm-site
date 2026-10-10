// Coverage for tools/funnel-report.mjs's headline conversion figure.
//
// lock_view and plan_cta were each an independent COUNT(DISTINCT visit_id)
// aggregate from the same GROUP BY name query, with nothing tying a plan_cta
// visit back to a lock_view visit. plan_cta fires from several places that
// have nothing to do with the course-lock paywall (the homepage hero CTA,
// the bundles pricing cards, the final-page CTA, the Core->Complete upgrade
// link on premium-guidance.html), so dividing the two raw totals was not
// "paywall hit -> purchase intent" -- it was two unrelated counts divided
// into each other, able to print over 100% or look strong while the paywall
// converted nobody. Fixed by computing the real lock_view/plan_cta
// intersection via conversionSql's EXISTS join, and feeding that (not
// plan_cta's own total) into headlineLine. These pin both halves of the fix:
// the query actually joins on visit_id across both event names, and the
// formatter's math/wording given that joined count.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { conversionSql, headlineLine } from '../tools/funnel-report.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TOOL = join(ROOT, 'tools', 'funnel-report.mjs');

test('conversionSql joins plan_cta to lock_view by visit_id, not two independent totals', () => {
  const sql = conversionSql("datetime('now', '-30 days')");
  assert.match(sql, /plan_cta/);
  assert.match(sql, /lock_view/);
  // The defining property of the fix: an EXISTS correlated on visit_id, not
  // a second independent COUNT(DISTINCT visit_id) grouped by name.
  assert.match(sql, /EXISTS/);
  assert.match(sql, /b\.visit_id\s*=\s*a\.visit_id/);
  // Both halves of the join must respect the same reporting window.
  assert.equal(sql.match(/-30 days/g).length, 2);
});

test('headlineLine reports the joined conversion count and percentage', () => {
  assert.equal(
    headlineLine(10, 4),
    '\n  Of the 10 visits that hit a paywall, 4 went on to click a pricing button (40%).'
  );
});

test('headlineLine never claims more conversions than paywall hits (the bug this replaces)', () => {
  // Before the fix, plan_cta's own independent total could exceed lock_view's
  // -- e.g. a quiet week for the course-lock cards alongside a busy one for
  // the homepage hero CTA -- printing a nonsensical >100%. The joined count
  // this function is now fed is a subset of locks by construction, so a
  // caller passing converted > locks here would itself be the regression;
  // this pins the percentage math stays correct right up to that boundary.
  assert.equal(
    headlineLine(5, 5),
    '\n  Of the 5 visits that hit a paywall, 5 went on to click a pricing button (100%).'
  );
});

test('headlineLine singularizes "visit" for exactly one paywall hit', () => {
  assert.equal(
    headlineLine(1, 1),
    '\n  Of the 1 visit that hit a paywall, 1 went on to click a pricing button (100%).'
  );
});

test('headlineLine reports 0% rather than dividing by a truthy-but-zero case', () => {
  assert.equal(
    headlineLine(8, 0),
    '\n  Of the 8 visits that hit a paywall, 0 went on to click a pricing button (0%).'
  );
});

test('headlineLine returns null when no one has hit a paywall yet', () => {
  assert.equal(headlineLine(0, 0), null);
});

// Coverage for funnel-report.mjs's own CLI entry point (the
// `import.meta.url === file://...` block) and its query() wrapper around
// wrangler -- both previously untested (a coverage run flagged lines 51-59
// and 92-161 as zero-coverage), since every test above only drives the two
// pure exports. This tool's only way to get data is shelling out to `npx
// wrangler d1 execute --remote`, which needs a real Cloudflare login and has
// no place in this suite, so FUNNEL_REPORT_NPX (a test-only seam added
// alongside these tests, a no-op in production since it's unset there)
// points the tool at a fake wrangler stand-in that returns canned rows
// instead of a real one.
const FAKE_NPX_SRC = `#!/usr/bin/env node
const sql = process.argv[process.argv.length - 1];
if (process.env.FAKE_NPX_FAIL) {
  process.stderr.write(\`wrangler: authenticating...
Error: D1 is unreachable
\`);
  process.exit(1);
}
let results;
if (sql.includes('GROUP BY name')) {
  results = JSON.parse(process.env.FAKE_ROWS || '[]');
} else if (sql.includes('COUNT(DISTINCT a.visit_id) AS n')) {
  results = [{ n: Number(process.env.FAKE_CONVERTED || '0') }];
} else {
  results = [{ v: Number(process.env.FAKE_VISITS_TOTAL || '0') }];
}
process.stdout.write(\`wrangler banner noise that precedes the real JSON
\`);
if (process.env.FAKE_NPX_NO_JSON) process.exit(0);
process.stdout.write(JSON.stringify([{ results }]));
`;

function run(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'funnel-report-'));
  const npx = join(dir, 'fake-npx.mjs');
  writeFileSync(npx, FAKE_NPX_SRC);
  chmodSync(npx, 0o755);
  try {
    return {
      stdout: execFileSync(process.execPath, [TOOL], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, FUNNEL_REPORT_NPX: npx, ...env },
      }),
      status: 0,
    };
  } catch (err) {
    return { stdout: err.stdout, stderr: err.stderr, status: err.status };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the CLI prints the funnel in stage order, marks a never-fired stage, surfaces an unordered DB row, and reports the real headline', () => {
  const rows = [
    { name: 'free_course_start', n: 50, visits: 40 },
    { name: 'lock_view', n: 10, visits: 10 },
    { name: 'plan_cta', n: 6, visits: 5 },
    { name: 'legacy_stage', n: 3, visits: 2 },
  ];
  const { stdout, status } = run({
    FAKE_ROWS: JSON.stringify(rows),
    FAKE_VISITS_TOTAL: '40',
    FAKE_CONVERTED: '5',
  });
  assert.equal(status, 0);
  assert.match(stdout, /40 visits recorded/);
  assert.match(stdout, /Started the free course\s+50\s+40\s+100%/);
  // A never-fired FUNNEL stage is shown as a dotted row, not omitted --
  // "no data for this step" and "nobody reached this step" must not look
  // the same, per this file's own header comment.
  assert.match(stdout, /Opened a lesson\s+\xb7\s+\xb7\s+—/);
  // A DB row whose name isn't in FUNNEL (schema drift, a retired stage) is
  // still surfaced, under its own heading, not silently dropped.
  assert.match(stdout, /Stages the collector accepts but this report does not order/);
  assert.match(stdout, /legacy_stage\s+3\s+2/);
  // The headline must come from the real lock_view/plan_cta intersection
  // query (10 locks, 5 converted) -- reusing headlineLine itself means this
  // assertion can't drift from the formatter it's pinning.
  assert.ok(stdout.includes(headlineLine(10, 5)));
  // 40 visits is above the noise threshold; the small-sample caveat must
  // not appear.
  assert.doesNotMatch(stdout, /Sample size is/);
});

test('the CLI reports an empty window as "nothing recorded," not a table of zero rows', () => {
  const { stdout, status } = run({
    FAKE_ROWS: '[]',
    FAKE_VISITS_TOTAL: '0',
    FAKE_CONVERTED: '0',
  });
  assert.equal(status, 0);
  assert.match(stdout, /Nothing recorded in this window/);
  assert.match(stdout, /RESEARCH_DB/);
  assert.doesNotMatch(stdout, /STAGE/);
});

test('the CLI flags a small sample as noise rather than presenting it as a real conversion rate', () => {
  const { stdout, status } = run({
    FAKE_ROWS: JSON.stringify([{ name: 'free_course_start', n: 5, visits: 5 }]),
    FAKE_VISITS_TOTAL: '5',
    FAKE_CONVERTED: '0',
  });
  assert.equal(status, 0);
  assert.match(stdout, /Sample size is 5/);
});

test('the CLI fails with an actionable message, not a stack trace, when wrangler itself fails', () => {
  const { stdout, stderr, status } = run({ FAKE_NPX_FAIL: '1' });
  assert.equal(status, 1);
  const out = `${stdout || ''}${stderr || ''}`;
  assert.match(out, /Could not read the database/);
  assert.match(out, /npx wrangler login/);
});

test('the CLI treats wrangler output with no JSON bracket as the same hard failure as a thrown error', () => {
  const { stdout, stderr, status } = run({ FAKE_NPX_NO_JSON: '1' });
  assert.equal(status, 1);
  const out = `${stdout || ''}${stderr || ''}`;
  assert.match(out, /Could not read the database/);
  assert.match(out, /no JSON in wrangler output/);
});
