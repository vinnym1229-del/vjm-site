// Coverage for tools/paywall-audit.mjs — the measurement behind docs/PAYWALL.md.
//
// The number in that document ("50,000-odd words of paid prose sit in public
// source") is only useful if the tool that produced it still measures the same
// thing. These tests pin the two behaviours that matter:
//
//   1. it finds gated regions the way the middleware's HTMLRewriter does —
//      by depth, not by a naive regex that stops at the first </div>; and
//   2. it fails loudly when paid lesson markup sits OUTSIDE a gated region,
//      which is the one exposure the edge gate cannot cover.
//
// It also asserts the real pages are measured (non-trivially), so a refactor
// that quietly stops matching `.gated-content` or `.lesson-card` shows up as a
// count collapsing to zero rather than as a reassuring clean report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  auditPage, auditSite, gatedPages, findRegions, hasClass, textOf, wordCount, strayCoursePages,
} from '../tools/paywall-audit.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------
test('findRegions closes a region by depth, not at the first matching close tag', () => {
  const html = '<div class="gated-content"><div><div>paid</div></div></div><div>public</div>';
  const [r] = findRegions(html, hasClass('gated-content'));
  assert.equal(findRegions(html, hasClass('gated-content')).length, 1);
  assert.equal(html.slice(r.innerStart, r.innerEnd), '<div><div>paid</div></div>');
  assert.ok(!html.slice(r.start, r.end).includes('public'), 'region must not swallow trailing markup');
});

test('findRegions is not confused by void or self-closing tags inside a region', () => {
  const html = '<section class="gated-content"><img src="a.png"><br/><section>x</section></section>after';
  const [r] = findRegions(html, hasClass('gated-content'));
  assert.equal(html.slice(r.end), 'after');
});

test('textOf strips markup and entities so word counts are prose, not tags', () => {
  const t = textOf('<p class="why">Two&nbsp;stocks &mdash; <b>float</b> matters.</p><script>var x=1;</script>');
  assert.equal(t, 'Two stocks — float matters.');
  assert.equal(wordCount(t), 4);
});

// ---------------------------------------------------------------------------
// The failing case: paid content outside a gated region
// ---------------------------------------------------------------------------
const LESSON = '<details class="lesson-card" id="leak-1"><summary><span class="lnum">3.</span> Leaked</summary>'
  + '<div class="lesson-body"><p class="why">Paid prose that no gate covers.</p></div></details>';

test('a lesson outside any gated region is reported as exposed', () => {
  const html = `<main><div class="gated-content">${LESSON.replace('leak-1', 'ok-1')}</div>${LESSON}</main>`;
  const row = auditPage('fixture.html', html);
  assert.equal(row.lessonsGated, 1);
  assert.deepEqual(row.lessonsExposed, ['leak-1'], 'the ungated lesson must be named');
});

test('a worked case outside any gated region is reported as exposed', () => {
  const worked = '<div class="extra"><span class="label">Worked case — the expensive one</span><p>numbers</p></div>';
  const row = auditPage('fixture.html', `<main><div class="gated-content"><p>a</p></div>${worked}</main>`);
  assert.equal(row.workedExposed, 1);
  assert.equal(row.workedGated, 0);
});

test('the CLI exits non-zero when paid content sits outside a gated region', async () => {
  const { mkdtempSync, writeFileSync, mkdirSync, cpSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { execFileSync } = await import('node:child_process');

  const dir = mkdtempSync(join(tmpdir(), 'paywall-'));
  mkdirSync(join(dir, 'functions'));
  cpSync(join(ROOT, 'functions', '_middleware.js'), join(dir, 'functions', '_middleware.js'));
  const page = `<html><body><div class="gated-content"><p>gated</p></div>${LESSON}</body></html>`;
  for (const p of gatedPages(ROOT, read)) writeFileSync(join(dir, p), page);

  const run = () => execFileSync(process.execPath, [join(ROOT, 'tools', 'paywall-audit.mjs'), '--root', dir], { encoding: 'utf8' });
  assert.throws(run, (err) => {
    assert.equal(err.status, 1, 'a live paywall hole must fail the audit');
    assert.match(err.stdout, /OUTSIDE ANY GATED REGION/);
    assert.match(err.stdout, /leak-1/);
    return true;
  });
});

test('a clean fixture exits zero', async () => {
  const { mkdtempSync, writeFileSync, mkdirSync, cpSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { execFileSync } = await import('node:child_process');

  const dir = mkdtempSync(join(tmpdir(), 'paywall-ok-'));
  mkdirSync(join(dir, 'functions'));
  cpSync(join(ROOT, 'functions', '_middleware.js'), join(dir, 'functions', '_middleware.js'));
  for (const p of gatedPages(ROOT, read)) {
    writeFileSync(join(dir, p), `<html><body><div class="gated-content">${LESSON}</div></body></html>`);
  }
  const out = execFileSync(process.execPath, [join(ROOT, 'tools', 'paywall-audit.mjs'), '--root', dir], { encoding: 'utf8' });
  assert.doesNotMatch(out, /OUTSIDE ANY GATED REGION/);
});

// ---------------------------------------------------------------------------
// The real site
// ---------------------------------------------------------------------------
const { rows, totals } = auditSite(ROOT, read);

test('the audited page list comes from the middleware, and is the four course pages', () => {
  assert.deepEqual(gatedPages(ROOT, read), [
    'futures-dissection.html', 'options-lab.html', 'psychology-enhancer.html', 'stock-breakdown.html',
  ]);
});

test('every course page has gated regions and gated lessons', () => {
  for (const r of rows) {
    assert.ok(r.gatedRegions > 0, `${r.path}: no .gated-content region found — the parser or the page changed`);
    assert.ok(r.lessonsGated >= 40, `${r.path}: only ${r.lessonsGated} gated lessons; expected the full level set`);
  }
});

test('all twelve worked cases are accounted for, and all of them are behind the gate', () => {
  const found = totals.workedGated + totals.workedFree + totals.workedExposed;
  assert.equal(found, 12, `expected twelve worked cases site-wide, found ${found}`);
  assert.equal(totals.workedGated, 12, 'every worked case must sit inside a gated region');
});

test('no paid lesson or worked case is served outside a gated region today', () => {
  const holes = rows.flatMap((r) => [
    ...r.lessonsExposed.map((id) => `${r.path}: ungated lesson ${id}`),
    ...(r.workedExposed ? [`${r.path}: ${r.workedExposed} ungated worked case(s)`] : []),
  ]);
  assert.deepEqual(holes, [], `paid content is readable without a session:\n${holes.join('\n')}`);
});

test('only the futures starter level is ungated-by-design', () => {
  // tests/regressions.test.mjs owns the business rule; this asserts the audit
  // agrees with it, so "0 exposed" can never be achieved by widening the
  // free-content exemption instead of gating content.
  assert.equal(totals.lessonsFree, 7, 'the free set is futures Level 1 only');
  const free = rows.filter((r) => r.lessonsFree > 0).map((r) => r.path);
  assert.deepEqual(free, ['futures-dissection.html']);
});

test('no course lesson markup has escaped onto an ungated page', () => {
  assert.deepEqual(strayCoursePages(ROOT, read), []);
});

test('the repo-exposure figure quoted in docs/PAYWALL.md is still the real one', () => {
  // docs/PAYWALL.md states ~50,000 words / ~454KB of paid prose in public
  // source. If the courses grow the doc should be re-run, not silently drift.
  assert.ok(totals.paidWords > 43000, `paid prose fell to ${totals.paidWords} words — re-check the parser before believing it`);
  assert.ok(totals.paidWords < 65000, `paid prose grew to ${totals.paidWords} words — regenerate docs/PAYWALL.md`);
  assert.ok(totals.paidBytes > 400 * 1024);
  const doc = read(join('docs', 'PAYWALL.md'));
  assert.match(doc, /49,967/, 'PAYWALL.md must quote the measured word count');
});
