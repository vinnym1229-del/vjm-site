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
  sma, atr, rsi, TRIGGERS, simulateEvent, runEventStudy,
  wilsonInterval, summarizeReturns, monteCarloPaths,
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
