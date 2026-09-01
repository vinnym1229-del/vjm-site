#!/usr/bin/env node
/* Read the funnel that functions/api/analytics.js has been collecting.
 *
 * The collector was the easy half. Without this, the data sat in D1 and the
 * only way to look at it was to remember the table name and write SQL, which
 * in practice means nobody ever looks — and analytics nobody reads is just a
 * privacy liability with extra steps.
 *
 * Reports the stages in FUNNEL ORDER rather than by volume, because the whole
 * point is seeing where people stop, and sorting by count hides exactly that.
 * A stage that has never fired is printed as a zero row, not omitted: "we have
 * no data for this step" and "nobody reached this step" look identical in a
 * list that only shows what happened, and they mean opposite things.
 *
 * Usage:
 *   node tools/funnel-report.mjs                 # last 30 days
 *   node tools/funnel-report.mjs --days=7
 *   node tools/funnel-report.mjs --db=vjm-content --days=90
 *
 * Requires wrangler and a Cloudflare login (same as the newsletter export in
 * docs/NEWSLETTER.md). Reads only; it never writes.
 */
import { execFileSync } from 'node:child_process';
import { ALLOWED_EVENTS } from '../functions/api/analytics.js';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const DB = arg('db', 'vjm-content');
const DAYS = Number(arg('days', '30'));

// The visitor's journey, in the order it actually happens. Anything in
// ALLOWED_EVENTS but missing here is still reported, under "other" — so adding
// a stage to the collector can never make it silently invisible in the report.
const FUNNEL = [
  ['free_course_start', 'Started the free course'],
  ['lesson_expand', 'Opened a lesson'],
  ['lesson_complete', 'Finished a lesson'],
  ['free_level_complete', 'Finished the free level'],
  ['quiz_start', 'Started the "what kind of trader" quiz'],
  ['quiz_complete', 'Finished the quiz'],
  ['lead_submit', 'Gave us an email address'],
  ['lock_view', 'Hit a paywall'],
  ['plan_cta', 'Clicked a pricing button'],
  ['whop_checkout', 'Went through to Whop checkout'],
  ['core_to_complete_upgrade', 'Clicked the Core → Complete upgrade'],
  ['google_link', 'Linked a Google account'],
];

function query(sql) {
  const out = execFileSync('npx', [
    '--yes', 'wrangler', 'd1', 'execute', DB, '--remote', '--json', '--command', sql,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  // wrangler prints banners before the JSON; take from the first bracket.
  const start = out.indexOf('[');
  if (start < 0) throw new Error(`no JSON in wrangler output:\n${out}`);
  return JSON.parse(out.slice(start))[0].results;
}

const since = `datetime('now', '-${Number.isFinite(DAYS) && DAYS > 0 ? DAYS : 30} days')`;

let rows;
let visitsTotal = 0;
try {
  rows = query(
    `SELECT name, COUNT(*) AS n, COUNT(DISTINCT visit_id) AS visits
       FROM analytics_events WHERE created_at >= ${since} GROUP BY name`
  );
  const v = query(`SELECT COUNT(DISTINCT visit_id) AS v FROM analytics_events WHERE created_at >= ${since}`);
  visitsTotal = Number((v[0] || {}).v || 0);
} catch (err) {
  console.error('Could not read the database.\n');
  console.error(String(err.message || err).split('\n').slice(0, 6).join('\n'));
  console.error('\nThis needs wrangler and a Cloudflare login:  npx wrangler login');
  process.exit(1);
}

const by = new Map(rows.map((r) => [r.name, r]));
const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s).padStart(n);

console.log(`\nFunnel — last ${DAYS} days`);
console.log(`${visitsTotal} visit${visitsTotal === 1 ? '' : 's'} recorded ` +
  `(a "visit" is one browser tab; it is not a person and not stable across devices)\n`);

if (!visitsTotal) {
  console.log('  Nothing recorded in this window.\n');
  console.log('  If the site is live and getting traffic, check that RESEARCH_DB is bound');
  console.log('  in Cloudflare Pages — the collector answers 503 and drops events without it.\n');
  process.exit(0);
}

console.log(`  ${pad('STAGE', 42)}${num('EVENTS', 7)}${num('VISITS', 8)}${num('% OF VISITS', 13)}`);
console.log(`  ${'-'.repeat(70)}`);
let seen = 0;
for (const [key, label] of FUNNEL) {
  const r = by.get(key);
  const visits = r ? Number(r.visits) : 0;
  const n = r ? Number(r.n) : 0;
  seen += n;
  const pct = visitsTotal ? `${((visits / visitsTotal) * 100).toFixed(0)}%` : '—';
  // A never-fired stage is shown, not skipped: "no data" and "nobody got here"
  // are opposite conclusions and must not look the same.
  console.log(`  ${pad(label, 42)}${num(n || '·', 7)}${num(visits || '·', 8)}${num(visits ? pct : '—', 13)}`);
}

const other = rows.filter((r) => !FUNNEL.some(([k]) => k === r.name));
if (other.length) {
  console.log(`\n  Stages the collector accepts but this report does not order:`);
  for (const r of other) console.log(`  ${pad(r.name, 42)}${num(r.n, 7)}${num(r.visits, 8)}`);
}

// The most useful single number on the page, and the one a raw table hides.
const locks = Number((by.get('lock_view') || {}).visits || 0);
const ctas = Number((by.get('plan_cta') || {}).visits || 0);
if (locks) {
  console.log(`\n  Of the ${locks} visit${locks === 1 ? '' : 's'} that hit a paywall, ` +
    `${ctas} went on to click a pricing button` +
    (locks ? ` (${((ctas / locks) * 100).toFixed(0)}%).` : '.'));
}

const unknown = [...ALLOWED_EVENTS].filter((e) => !FUNNEL.some(([k]) => k === e));
if (unknown.length) {
  console.log(`\n  Note: ${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} accepted by the ` +
    `collector but not placed in the funnel above — add ${unknown.length === 1 ? 'it' : 'them'} to FUNNEL in this file.`);
}

if (visitsTotal < 30) {
  console.log(`\n  Sample size is ${visitsTotal}. Percentages on a handful of visits are noise;` +
    `\n  treat this as "is the plumbing working" rather than as a conversion rate.`);
}
console.log();
