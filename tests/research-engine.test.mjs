import assert from 'node:assert/strict';
import { __test } from '../functions/api/research-engine.js';

const {
  analyseFib,
  classifySweep,
  cumulativeVwap,
  detectContinuationModel,
  findSweepIndex,
  findGammaFlip,
  finite,
  metrics,
  resampleWeekly,
  summarizeConditions,
  summarizeTiming,
} = __test;

function bar(t, o, h, l, c, v = 1000) {
  return { t, o, h, l, c, v };
}

assert.equal(finite(null), null, 'null market observations must stay unavailable');
assert.equal(finite(''), null, 'empty market observations must stay unavailable');
assert.equal(finite('12.5'), 12.5);

assert.equal(
  findGammaFlip([
    { strike: 100, netGexMm: -2 },
    { strike: 105, netGexMm: 3 },
    { strike: 110, netGexMm: 4 },
  ], 103),
  102,
  'gamma-flip interpolation should use the closest sign change',
);

const weekly = resampleWeekly([
  bar('2026-08-17T00:00:00Z', 10, 12, 9, 11, 100),
  bar('2026-08-18T00:00:00Z', 11, 13, 10, 12, 120),
  bar('2026-08-24T00:00:00Z', 14, 16, 13, 15, 140),
]);
assert.equal(weekly.length, 2);
assert.deepEqual(
  { o: weekly[0].o, h: weekly[0].h, l: weekly[0].l, c: weekly[0].c, v: weekly[0].v },
  { o: 10, h: 13, l: 9, c: 12, v: 220 },
);

const trendBars = Array.from({ length: 25 }, (_, index) => {
  const close = 100 + index;
  return bar(`2026-07-${String(index + 1).padStart(2, '0')}T00:00:00Z`, close - 1, close + 1, close - 2, close, 1000 + index * 10);
});
const trend = metrics(trendBars);
assert.ok(trend.return20 > 0);
assert.ok(trend.atr14Pct > 0);
assert.ok(trend.upDayShare > 0.99);

const fibBars = [
  bar('2026-01-01T00:00:00Z', 94, 100, 90, 98),
  bar('2026-01-02T00:00:00Z', 98, 105, 92, 103),
  bar('2026-01-03T00:00:00Z', 103, 110, 95, 108),
  bar('2026-01-04T00:00:00Z', 108, 120, 100, 117),
  bar('2026-01-05T00:00:00Z', 117, 115, 105, 108),
  bar('2026-01-06T00:00:00Z', 108, 112, 107, 110),
  bar('2026-01-07T00:00:00Z', 110, 121, 109, 120),
  bar('2026-01-08T00:00:00Z', 120, 116, 110, 114),
  bar('2026-01-09T00:00:00Z', 114, 113, 106, 109),
];
const fib = analyseFib(fibBars, 2, 4, 'Daily');
const fib382 = fib.stats.find((row) => row.level === 0.382);
assert.ok(fib382.touches >= 1, '38.2% retracement should be detected');
assert.ok(fib382.fillRate > 0, 'return to the prior high should count as a fill');

const sweepBars = [
  bar('2026-08-20T13:30:00Z', 99.9, 100, 99.9, 100),
  bar('2026-08-20T13:31:00Z', 100, 100.2, 99.95, 100.18),
  bar('2026-08-20T13:32:00Z', 100.18, 100.25, 100.05, 100.2),
];
const vwap = cumulativeVwap(sweepBars);
assert.equal(vwap.length, sweepBars.length);
assert.ok(vwap.every((value) => Number.isFinite(value)));
const sweep = classifySweep(sweepBars, 100, 'high', 'PDH', '2026-08-20', vwap);
assert.equal(sweep.continuation, true);
assert.equal(sweep.reversal, false);
assert.equal(findSweepIndex([bar('2026-08-20T13:30:00Z', 101, 102, 100.5, 101.5)], 100, 'high'), -1, 'a gap that opens entirely above a high must not count as a sweep');
assert.equal(findSweepIndex([bar('2026-08-20T13:30:00Z', 99.5, 100.2, 99.4, 100.1)], 100, 'high'), 0, 'a bar crossing a high from below must count as a sweep');

const modelBars = [
  bar('2026-08-20T13:30:00Z', 99.9, 100, 99.8, 99.95),
  bar('2026-08-20T13:31:00Z', 100, 100.15, 99.95, 100.1),
  bar('2026-08-20T13:32:00Z', 100.2, 100.5, 100.2, 100.45),
  bar('2026-08-20T13:33:00Z', 100.3, 100.4, 100.1, 100.25),
  bar('2026-08-20T13:34:00Z', 100.3, 100.65, 100.25, 100.6),
];
assert.equal(detectContinuationModel(modelBars, 0, 'high'), true);

const summarized = summarizeConditions([
  { condition: 'PDH', continuation: true, reversal: false, continuationModel: true, mfe: 0.01, mae: -0.002 },
  { condition: 'PDH', continuation: false, reversal: true, continuationModel: false, mfe: 0.003, mae: -0.008 },
]);
assert.equal(summarized[0].n, 2);
assert.equal(summarized[0].continuationRate, 0.5);
assert.ok(Math.abs(summarized[0].medianMfe - 0.0065) < 1e-12);
assert.equal(summarized.find((row) => row.condition === 'Continuation Model').n, 1, 'model events must remain in their parent condition and also appear in the model subset');

const timing = summarizeTiming([
  { condition: 'PDH', minute: 590, continuation: true },
  { condition: 'PDH', minute: 650, continuation: false },
]);
const pdhTiming = timing.find((row) => row.label === 'PDH sweep');
assert.equal(pdhTiming.before1000, 1);
assert.equal(pdhTiming.before1100, 0.5);

console.log('VJM research-engine calculation tests passed.');
