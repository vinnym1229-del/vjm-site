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
import { conversionSql, headlineLine } from '../tools/funnel-report.mjs';

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
