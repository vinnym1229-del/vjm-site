// Regression coverage for functions/api/_lib/backtest-core.js -- the
// deterministic event-study/backtest engine behind the (not-yet-wired) paid
// Edge Lab feature. Every other functions/api/_lib/*.js file has direct or
// indirect test coverage; this one, at 536 lines, had zero -- only
// wilsonInterval is currently re-exported (via integrations-core.js), so the
// rest of the module is latent rather than dead, per commit 83dc371's own
// note: "Both are latent today (the module is imported only for
// wilsonInterval). But wrong math shipped behind a paid feature is worth
// fixing before it is wired up." That commit fixed two real bugs here and
// nothing pinned either one, so a regression could silently ship back in
// before this ever reaches a user.
//
// Pins: the short-side MFE/MAE fix (excursions must read the LOW for a
// short's favourable move and the HIGH for its adverse move, not the other
// way around -- the old code negated the extremes and added them to entry,
// producing numbers off by two orders of magnitude), the streak_reversal
// direction fix (a reversal day must carry the OPPOSITE sign from the
// streak, not the same one), plus sanity coverage for the indicators and
// statistics helpers that feed both simulateEvent and the UI-facing summary.
import assert from 'node:assert/strict';
import {
  sma, atr, rsi, TRIGGERS, triggerWarmup, simulateEvent, runEventStudy,
  wilsonInterval, summarizeReturns, monteCarloPaths,
  TIMING_CONVENTION, SAME_TOUCH_POLICY,
} from '../functions/api/_lib/backtest-core.js';

function bar(t, o, h, l, c, v = 1000) {
  return { t, o, h, l, c, v };
}

// ─── simulateEvent: short vs long MFE/MAE must use opposite extremes ───────
// Same three bars for both directions: signal at index 0, entry at index 1's
// open (100), exit two sessions later at index 2's close (101) with no
// stop/target configured (pure timeout). Holding window spans indices 1-2:
// high 105, low 98.
{
  const bars = [
    bar('d0', 100, 101, 99, 100),
    bar('d1', 100, 105, 99, 102),
    bar('d2', 102, 103, 98, 101),
  ];
  const opts = { holdDays: 2, stopR: 0, targetR: 0, atrValue: 0 };

  // Short: favourable move is price falling to the 98 low (+2% from entry
  // 100); adverse move is price rising to the 105 high (-5% from entry).
  const short = simulateEvent(bars, 0, { ...opts, direction: 'short' });
  assert.equal(short.status, 'ok');
  assert.equal(short.result, 'timeout');
  assert.equal(short.retPct, -1, 'short lost 1% when price closed at 101 vs entry 100');
  assert.equal(short.mfe, 2, 'short MFE must read the 98 low, not the 105 high');
  assert.equal(short.mae, -5, 'short MAE must read the 105 high, not the 98 low');

  // Long on the identical bars: the extremes swap. Favourable is the 105
  // high (+5%), adverse is the 98 low (-2%) -- exact mirror of the short case,
  // which is the whole point: a short and a long on the same tape must never
  // report the same-signed excursions.
  const long = simulateEvent(bars, 0, { ...opts, direction: 'long' });
  assert.equal(long.retPct, 1);
  assert.equal(long.mfe, 5, 'long MFE must read the 105 high');
  assert.equal(long.mae, -2, 'long MAE must read the 98 low');
}

// simulateEvent still resolves same-bar stop+target ambiguity as
// pessimistic stop-first, and reports it.
{
  const bars = [
    bar('d0', 100, 101, 99, 100),
    bar('d1', 100, 102, 98, 100),
    bar('d2', 100, 112, 88, 100),
  ];
  const res = simulateEvent(bars, 0, {
    holdDays: 2, direction: 'long', stopR: 2, targetR: 2, atrValue: 5,
  });
  assert.equal(res.result, 'stop');
  assert.equal(res.ambiguousTouch, true);
  assert.equal(res.exitPx, 90);
}

// ─── streak_reversal: the reversal day must be the OPPOSITE sign ──────────
{
  // Three closing down-days (100->99->98->97) then a green day (97->99):
  // this is the documented reversal shape and must fire.
  const reversal = [100, 99, 98, 97, 99].map((c, i) => bar('d' + i, c, c + 1, c - 1, c));
  assert.equal(
    TRIGGERS.streak_reversal.test(reversal, 4, { streak: 3, dir: 'down' }),
    true,
    'three down days followed by an up day must count as a reversal',
  );

  // Four closing down-days in a row (100->99->98->97->96): the streak never
  // reverses. The bug this pins tested the reversal day with the SAME sign
  // as the streak, so a same-direction 4th day matched and this returned
  // true when it must return false.
  const continuation = [100, 99, 98, 97, 96].map((c, i) => bar('d' + i, c, c + 1, c - 1, c));
  assert.equal(
    TRIGGERS.streak_reversal.test(continuation, 4, { streak: 3, dir: 'down' }),
    false,
    'a same-direction 4th day is a continuation, not a reversal, and must not match',
  );

  // Mirror case: an up-streak reversing down.
  const upReversal = [100, 101, 102, 103, 101].map((c, i) => bar('d' + i, c, c + 1, c - 1, c));
  assert.equal(TRIGGERS.streak_reversal.test(upReversal, 4, { streak: 3, dir: 'up' }), true);
}

// ─── Indicators: causal (value at i depends only on indices <= i) ─────────
{
  const closes = [10, 11, 12, 11, 10, 12, 14, 13, 15, 16];
  const s = sma(closes, 3);
  assert.equal(s[0], null);
  assert.equal(s[1], null);
  assert.equal(s[2], (10 + 11 + 12) / 3);
  assert.equal(s[9], (13 + 15 + 16) / 3);

  const highs = closes.map((c) => c + 1);
  const lows = closes.map((c) => c - 1);
  const a = atr(highs, lows, closes, 3);
  assert.equal(a[0], null);
  assert.equal(a[1], null);
  assert.equal(a[2], 2, 'first ATR reading is the simple average of the first n true ranges (all 2 here)');
  assert.ok(a[9] > 0);

  // RSI: a monotonically rising series has no losses, so it pins at 100
  // rather than dividing by zero.
  const rising = Array.from({ length: 20 }, (_, i) => 100 + i);
  const r = rsi(rising, 14);
  assert.equal(r[14], 100);
  assert.equal(r[19], 100);
}

// ─── wilsonInterval ─────────────────────────────────────────────────────
{
  assert.deepEqual(wilsonInterval(0, 0), { lo: 0, hi: 100, note: 'no sample' });
  const ci = wilsonInterval(50, 100);
  assert.ok(ci.lo < 50 && 50 < ci.hi, 'the point estimate must sit inside its own interval');
  assert.ok(ci.lo >= 0 && ci.hi <= 100);
  // A larger sample at the same win rate must narrow the interval.
  const wide = wilsonInterval(5, 10);
  const narrow = wilsonInterval(500, 1000);
  assert.ok(narrow.hi - narrow.lo < wide.hi - wide.lo);
}

// ─── summarizeReturns: small/empty-sample warnings the UI relies on ───────
{
  const empty = summarizeReturns([]);
  assert.equal(empty.sampleSize, 0);
  assert.match(empty.warning, /No events matched/);

  const small = summarizeReturns([1, 2, 3, 4, 5]);
  assert.equal(small.sampleSize, 5);
  assert.match(small.warning, /small \(<30\)/);

  const large = summarizeReturns(Array.from({ length: 30 }, (_, i) => i - 15));
  assert.equal(large.warning, undefined, '30+ samples must not carry the small-sample warning');
}

// ─── monteCarloPaths: seeded so results must be exactly reproducible ─────
{
  const a = monteCarloPaths({ seed: 7, trials: 50, steps: 20 });
  const b = monteCarloPaths({ seed: 7, trials: 50, steps: 20 });
  assert.deepEqual(a, b, 'identical seed and params must produce byte-identical output');
  assert.ok(a.ruinPct >= 0 && a.ruinPct <= 100);

  const c = monteCarloPaths({ seed: 8, trials: 50, steps: 20 });
  assert.notDeepEqual(a, c, 'a different seed must not collide with seed 7 on this small a run');
}

// ─── runEventStudy: end-to-end wiring smoke test ──────────────────────────
{
  // 40 sessions with a couple of clean gap-ups planted past warmup so the
  // trigger has something to find.
  const bars = [];
  let px = 100;
  for (let i = 0; i < 40; i++) {
    const gapUp = i === 20 || i === 30;
    const o = gapUp ? px * 1.03 : px;
    const c = o + (gapUp ? 1 : 0.2);
    bars.push(bar('d' + i, o, Math.max(o, c) + 0.5, Math.min(o, c) - 0.5, c));
    px = c;
  }
  const result = runEventStudy(bars, {
    triggerType: 'gap_up', triggerParams: { pct: 1 }, holdDays: 3, direction: 'long',
  });
  assert.equal(result.definition, TRIGGERS.gap_up.describe({ pct: 1 }));
  assert.ok(result.events.length >= 1, 'the planted gap-ups must be found past warmup');
  assert.equal(result.stats.sampleSize, result.events.length);
  assert.equal(result.stats.sameTouchPolicy, 'conservative (stop assumed first when both touched in one bar)');

  assert.throws(() => runEventStudy(bars, { triggerType: 'not_a_real_trigger' }), /unknown trigger type/);
}

console.log('# VJM backtest-core (Edge Lab) library tests passed.');

// ─── The frozen timing convention ─────────────────────────────────────────
// This module is where the methodology is pinned down; research-engine.js
// imports TIMING_CONVENTION and stamps it onto every study it publishes. An
// audit found two look-ahead defects in those studies (pivots measured from
// the pivot bar, grouped bars acted on at their opening timestamp), so the
// convention is a contract: it must stay frozen, stay versioned, and keep
// saying that these results are hypothetical and gross.
{
  assert.ok(TIMING_CONVENTION.version, 'the convention must be versioned so downstream can detect a change');
  assert.equal(Object.isFrozen(TIMING_CONVENTION), true, 'a study must not be able to redefine the convention at runtime');
  assert.equal(TIMING_CONVENTION.ambiguity, SAME_TOUCH_POLICY, 'unresolvable intrabar order stays resolved against the study');
  for (const key of ['observable', 'actionable', 'fill', 'outcome', 'costs', 'nature']) {
    assert.equal(typeof TIMING_CONVENTION[key], 'string', `the convention must state its ${key} clause`);
    assert.ok(TIMING_CONVENTION[key].length > 20, `the ${key} clause must actually say something`);
  }
  assert.match(TIMING_CONVENTION.costs, /slippage/i, 'the convention must disclose that no cost model exists');
  assert.match(TIMING_CONVENTION.nature, /[Hh]ypothetical/, 'the convention must state results are hypothetical');
}

// ─── simulateEvent obeys the convention: nothing before the entry bar ──────
// The signal bar itself carries an enormous favourable spike. It printed
// BEFORE the entry (next bar's open) existed, so none of it may show up as
// excursion, and it must not settle a target. This is the daily-bar form of
// the same bug fixed in the intraday studies.
{
  const bars = [
    bar('d0', 100, 130, 99, 100),   // signal bar: +30% spike, already history
    bar('d1', 100, 101, 99, 100),   // entry at 100
    bar('d2', 100, 101, 98, 99),
    bar('d3', 99, 100, 97, 98),
  ];
  const res = simulateEvent(bars, 0, { holdDays: 3, direction: 'long', stopR: 0, targetR: 0, atrValue: 0 });
  assert.equal(res.status, 'ok');
  assert.equal(res.entryDate, 'd1', 'entry is the bar AFTER the signal, never the signal bar');
  assert.equal(res.entryPx, 100);
  assert.ok(res.mfe <= 1, 'the signal bar’s own 30% spike must not be scored as favourable excursion');

  const withTarget = simulateEvent(bars, 0, {
    holdDays: 3, direction: 'long', stopR: 2, targetR: 2, atrValue: 5,
  });
  assert.notEqual(withTarget.result, 'target', 'a target reachable only on the signal bar must never be filled');
}

// A trigger may only read bars up to and including the signal bar. gap_up at
// index i compares i's open with i-1's close and touches nothing later.
{
  const bars = [
    bar('d0', 100, 101, 99, 100),
    bar('d1', 105, 106, 104, 105),  // +5% gap
    bar('d2', 105, 106, 104, 105),
  ];
  assert.equal(TRIGGERS.gap_up.test(bars, 1, { pct: 1 }), true);
  const truncated = bars.slice(0, 2);
  assert.equal(
    TRIGGERS.gap_up.test(truncated, 1, { pct: 1 }),
    true,
    'a trigger must decide from history alone: removing every later bar cannot change it',
  );
}

// ─── The other 9 triggers: only gap_up and streak_reversal had ever been
// called directly (func coverage on this file sat at 51.61% because of it).
// Each one backs a real number in the Edge Lab's trigger picker, so a sign
// or off-by-one error here would silently misreport which days actually
// matched. Every case below is checked against a hand-picked bar where the
// trigger must fire, and a minimally-different bar where it must not.
{
  // gap_down: mirror of gap_up, on the downside.
  const gd = [bar('d0', 100, 101, 99, 100), bar('d1', 98, 99, 97, 98)];
  assert.equal(TRIGGERS.gap_down.test(gd, 1, { pct: 1 }), true, '2% gap down clears a 1% threshold');
  assert.equal(
    TRIGGERS.gap_down.test([bar('d0', 100, 101, 99, 100), bar('d1', 99.5, 100, 99, 99.5)], 1, { pct: 1 }),
    false,
    'a 0.5% gap does not clear a 1% threshold',
  );

  // inside_day: today's whole range sits strictly inside yesterday's.
  const inside = [bar('d0', 100, 110, 90, 100), bar('d1', 101, 105, 95, 102)];
  assert.equal(TRIGGERS.inside_day.test(inside, 1), true);
  const notInside = [bar('d0', 100, 110, 90, 100), bar('d1', 101, 110, 95, 102)];
  assert.equal(TRIGGERS.inside_day.test(notInside, 1), false, 'touching the prior high is not "inside"');

  // outside_day: today's range engulfs yesterday's on both sides.
  const outside = [bar('d0', 100, 105, 95, 100), bar('d1', 101, 110, 90, 102)];
  assert.equal(TRIGGERS.outside_day.test(outside, 1), true);
  assert.equal(
    TRIGGERS.outside_day.test([bar('d0', 100, 105, 95, 100), bar('d1', 101, 110, 96, 102)], 1),
    false,
    'engulfing only the high, not the low, does not count',
  );

  // nr7: today's range must be strictly tighter than each of the prior 6,
  // ties included -- a tie is not a new narrowest range.
  const rangeBar = (t, range) => bar(t, 100, 100 + range / 2, 100 - range / 2, 100);
  const tightest = [10, 5, 6, 4, 7, 8, 3, 2].map((r, i) => rangeBar('d' + i, r));
  assert.equal(TRIGGERS.nr7.test(tightest, 7), true, 'range 2 is narrower than every one of the prior 6 (5,6,4,7,8,3)');
  const tied = [10, 5, 6, 4, 7, 8, 3, 3].map((r, i) => rangeBar('d' + i, r));
  assert.equal(TRIGGERS.nr7.test(tied, 7), false, 'a tie with the prior narrowest range does not count as a new squeeze');

  // sma_break: ind.sma[period] is precomputed by runEventStudy and handed in;
  // exercise the raw contract directly, including the null-guard for a bar
  // still inside SMA warmup.
  const smaBars = ['x', 'x', 9, 11].map((c, i) => bar('d' + i, c, c === 'x' ? 1 : c + 1, c === 'x' ? 1 : c - 1, c === 'x' ? 1 : c));
  const smaInd = { sma: { 3: [null, null, 10, 10] } };
  assert.equal(TRIGGERS.sma_break.test(smaBars, 3, { period: 3, dir: 'up' }, smaInd), true, 'close 9->11 crosses up through SMA 10');
  const smaIndDown = { sma: { 3: [null, null, 10, 10] } };
  const smaBarsDown = ['x', 'x', 11, 9].map((c, i) => bar('d' + i, c, c === 'x' ? 1 : c + 1, c === 'x' ? 1 : c - 1, c === 'x' ? 1 : c));
  assert.equal(TRIGGERS.sma_break.test(smaBarsDown, 3, { period: 3, dir: 'down' }, smaIndDown), true, 'close 11->9 crosses down through SMA 10');
  assert.equal(
    TRIGGERS.sma_break.test(smaBars, 3, { period: 3, dir: 'up' }, { sma: { 3: [null, null, null, 10] } }),
    false,
    'a still-null SMA reading (inside warmup) must never match, not throw',
  );

  // vol_spike: current volume vs the mean of the prior 20 bars (window
  // clamps to whatever history exists, here 5 bars).
  const volBars = [1000, 1000, 1000, 1000, 1000, 2500].map((v, i) => bar('d' + i, 100, 101, 99, 100, v));
  assert.equal(TRIGGERS.vol_spike.test(volBars, 5, { mult: 2 }), true, '2500 is 2.5x the trailing 1000 average');
  assert.equal(
    TRIGGERS.vol_spike.test([1000, 1000, 1000, 1000, 1000, 1500].map((v, i) => bar('d' + i, 100, 101, 99, 100, v)), 5, { mult: 2 }),
    false,
    '1500 is only 1.5x the trailing average',
  );

  // rsi_cross: same precomputed-indicator contract as sma_break.
  const rsiUp = { rsi: [null, 29, 31] };
  assert.equal(TRIGGERS.rsi_cross.test([bar('d0', 1, 1, 1, 1), bar('d1', 1, 1, 1, 1), bar('d2', 1, 1, 1, 1)], 2, { level: 30, dir: 'up' }, rsiUp), true);
  const rsiDown = { rsi: [null, 31, 29] };
  assert.equal(TRIGGERS.rsi_cross.test([bar('d0', 1, 1, 1, 1), bar('d1', 1, 1, 1, 1), bar('d2', 1, 1, 1, 1)], 2, { level: 30, dir: 'down' }, rsiDown), true);

  // new_n_day_close_high / new_n_day_close_low: compare today's close
  // against the highest/lowest of the PRIOR n closes -- today's own close
  // must never be part of its own reference window.
  const closes5 = [10, 12, 11, 13, 9];
  const highBars = (today) => [...closes5, today].map((c, i) => bar('d' + i, c, c + 1, c - 1, c));
  assert.equal(TRIGGERS.new_n_day_close_high.test(highBars(14), 5, { n: 5 }), true, '14 beats the prior 5-day high of 13');
  assert.equal(TRIGGERS.new_n_day_close_high.test(highBars(12), 5, { n: 5 }), false, '12 does not beat 13');
  const lowBars = (today) => [...closes5, today].map((c, i) => bar('d' + i, c, c + 1, c - 1, c));
  assert.equal(TRIGGERS.new_n_day_close_low.test(lowBars(8), 5, { n: 5 }), true, '8 beats the prior 5-day low of 9');
  assert.equal(TRIGGERS.new_n_day_close_low.test(lowBars(10), 5, { n: 5 }), false, '10 does not beat 9');

  // big_move: |close-to-close move| vs a multiple of ATR(14) at the signal
  // bar, plus the guard for a still-null ATR reading during warmup.
  const bigMoveInd = { atr: [null, 5] };
  assert.equal(TRIGGERS.big_move.test([bar('d0', 100, 101, 99, 100), bar('d1', 100, 112, 99, 111)], 1, { mult: 2, dir: 'up' }, bigMoveInd), true, '11pt move clears 2x ATR(5)=10');
  assert.equal(TRIGGERS.big_move.test([bar('d0', 100, 101, 99, 100), bar('d1', 100, 106, 99, 105)], 1, { mult: 2, dir: 'up' }, bigMoveInd), false, '5pt move does not clear 10');
  assert.equal(TRIGGERS.big_move.test([bar('d0', 100, 101, 99, 100), bar('d1', 100, 101, 88, 89)], 1, { mult: 2, dir: 'down' }, bigMoveInd), true, '-11pt move clears 2x ATR(5)=10 to the downside');
  assert.equal(
    TRIGGERS.big_move.test([bar('d0', 100, 101, 99, 100), bar('d1', 100, 112, 99, 111)], 1, { mult: 2, dir: 'up' }, { atr: [null, null] }),
    false,
    'a still-null ATR reading (inside warmup) must never match, not throw',
  );
}

// ─── triggerWarmup: the value that decides where a study is allowed to
// START looking, which must always be at least as long as each trigger's
// own indicator/window needs (this is the same look-ahead-adjacent
// invariant TIMING_CONVENTION documents at the OBSERVABLE level).
{
  assert.equal(triggerWarmup('gap_up', {}), 1);
  assert.equal(triggerWarmup('nr7', {}), 7, 'needs the prior 6 bars plus itself');
  assert.equal(triggerWarmup('sma_break', { period: 50 }), 50, 'resolved from the configured period, not a fixed constant');
  assert.equal(triggerWarmup('new_n_day_close_high', { n: 25 }), 25, 'resolved from the configured n');
  assert.equal(triggerWarmup('new_n_day_close_low', { n: 10 }), 10);
  assert.equal(triggerWarmup('not_a_real_trigger', {}), 0, 'an unknown trigger type must not throw here -- runEventStudy throws first');
}

// ─── simulateEvent: a single-sided touch (stop only, or target only) must
// resolve on the day it actually happens, not run to the timeout exit.
// The existing coverage only exercised the no-stop/no-target timeout case
// and the same-bar-touches-both ambiguous case; the two ordinary paths in
// between (335-345 in the source) had never been called.
{
  const stopOnly = [
    bar('d0', 100, 101, 99, 100),
    bar('d1', 100, 101, 99, 100), // entry bar: no touch
    bar('d2', 100, 102, 94, 95),  // low 94 <= stop 95; high 102 < target 115
    bar('d3', 95, 96, 94, 95),
  ];
  const stopRes = simulateEvent(stopOnly, 0, { holdDays: 3, direction: 'long', stopR: 1, targetR: 3, atrValue: 5 });
  assert.equal(stopRes.result, 'stop');
  assert.equal(stopRes.ambiguousTouch, false);
  assert.equal(stopRes.exitPx, 95);
  assert.equal(stopRes.exitDate, 'd2', 'must exit on the day the stop actually touched, not run out the clock');

  const targetOnly = [
    bar('d0', 100, 101, 99, 100),
    bar('d1', 100, 101, 99, 100),
    bar('d2', 100, 116, 96, 110), // high 116 >= target 115; low 96 > stop 95
    bar('d3', 110, 111, 109, 110),
  ];
  const targetRes = simulateEvent(targetOnly, 0, { holdDays: 3, direction: 'long', stopR: 1, targetR: 3, atrValue: 5 });
  assert.equal(targetRes.result, 'target');
  assert.equal(targetRes.ambiguousTouch, false);
  assert.equal(targetRes.exitPx, 115);
  assert.equal(targetRes.exitDate, 'd2');
}

// ─── runEventStudy: incomplete events at the tail of the series are
// dropped and counted, not silently omitted or thrown.
{
  const bars = [];
  for (let i = 0; i < 25; i++) bars.push(bar('d' + i, 100, 101, 99, 100));
  // A clean gap-up with plenty of room to fill its 3-day hold.
  bars[15] = bar('d15', 101, 102, 100, 101);
  // The same gap-up planted one bar before the series ends: entryIdx=24 is
  // valid, but exitIdx=24+3-1=26 runs past the last bar (index 24), so this
  // one must be dropped rather than counted or crashing the loop.
  bars[23] = bar('d23', 101, 102, 100, 101);

  const result = runEventStudy(bars, { triggerType: 'gap_up', triggerParams: { pct: 1 }, holdDays: 3, direction: 'long' });
  assert.equal(result.events.length, 1, 'only the day-15 gap has enough forward bars to resolve');
  assert.equal(result.droppedIncomplete, 1, 'the day-23 gap must be counted as dropped, not silently disappear');
}

// ─── runEventStudy: the risk-adjusted summary (targetHitRate/stopRate/
// avgRMultiple/medianRMultiple) only appears when stopR/targetR are
// configured, and only over the subset of events that actually got a risk
// figure. Two gap-ups on an otherwise flat, constant-true-range tape (ATR
// stays put) engineered so one resolves at exactly +1R (target) and the
// other at exactly -1R (stop) -- with targetR===stopR the R-multiples are
// exact regardless of the ATR's precise value, so this is robust to drift.
{
  const bars = [];
  for (let i = 0; i < 35; i++) bars.push(bar('d' + i, 100, 101, 99, 100));
  bars[15] = bar('d15', 101, 101.5, 100.5, 101);       // signal: target-bound trade
  bars[17] = bar('d17', 100, 103, 99, 100);             // entry+1: only the target side is touched (close flat, no downstream gap)
  bars[25] = bar('d25', 101, 101.5, 100.5, 101);        // signal: stop-bound trade
  bars[27] = bar('d27', 100, 100.5, 95, 100);           // entry+1: only the stop side is touched (close flat, no downstream gap)

  const result = runEventStudy(bars, {
    triggerType: 'gap_up', triggerParams: { pct: 1 }, holdDays: 5, direction: 'long', stopR: 1, targetR: 1,
  });
  assert.equal(result.events.length, 2);
  assert.equal(result.stats.hitRateBasis, 'target-or-timeout-positive', 'stopR/targetR configured means risk-basis stats apply');
  assert.equal(result.stats.targetHitRate, 50, 'one of the two risk-carrying events hit target');
  assert.equal(result.stats.stopRate, 50, 'the other hit its stop');
  assert.equal(result.stats.avgRMultiple, 0, 'a +1R target and a -1R stop average to exactly 0R');
  assert.equal(result.stats.medianRMultiple, 0);
}

// ─── monteCarloPaths: the ruin counter (equity <= 25, i.e. down 75% from
// the starting 100) must actually increment, not just always read 0. A
// certain-loss configuration (winProb: 0) makes every path ruin within a
// few steps of 2R losses each.
{
  // -5% every step for 50 steps compounds to 100*0.95^50 ≈ 7.7, well past
  // the 25 ruin line; +5% every step only ever grows.
  const certainRuin = monteCarloPaths({ seed: 1, trials: 20, steps: 50, winProb: 0, winR: 5, lossR: 5, riskFraction: 1 });
  assert.equal(certainRuin.ruinPct, 100, 'losing every single trade must ruin every path');

  const certainSurvival = monteCarloPaths({ seed: 1, trials: 20, steps: 50, winProb: 1, winR: 5, lossR: 5, riskFraction: 1 });
  assert.equal(certainSurvival.ruinPct, 0, 'winning every single trade must never ruin a path');
}
