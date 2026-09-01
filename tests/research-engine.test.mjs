import assert from 'node:assert/strict';
import { __test } from '../functions/api/research-engine.js';

const {
  analyseFib,
  buildPriceActionModel,
  classifySweep,
  combineFibStats,
  cumulativeVwap,
  detectContinuationModel,
  findSweepIndex,
  groupProxyTradeDays,
  findGammaFlip,
  finite,
  median,
  metrics,
  marketProfileLevels,
  priorWeekRange,
  resampleMinutes,
  resampleWeekly,
  scanFvgs,
  splitSession,
  statsFromFibEvents,
  summarizeConditions,
  summarizeFvg,
  summarizeTiming,
  scanDisplacement,
  classifyDirectionalOutcome,
  barCloseTime,
  studyProvenance,
  TIMING_CONVENTION,
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

// ---------------------------------------------------------------------------
// LOOK-AHEAD: fib swing highs (analyseFib)
//
// A pivot with `pivot`=2 is only a pivot once TWO more bars have printed
// without exceeding it. Anything the study does between the pivot bar and its
// confirmation bar is trading on a high nobody had identified yet.
//
// The tape below is built to be hostile: the ONLY retracement into the fib
// band happens on the bar right after the (not yet confirmed) high, and from
// the confirmation bar onward price gaps up and never trades near the band
// again. A study that measures from the pivot bar therefore books a touch that
// fills 100% of the time; a study that waits for confirmation correctly finds
// no tradable event at all. The pre-fix engine reported 3 touches / 100% fill
// / 100% new-high here -- a fabricated perfect setup.
const lookAheadFibBars = [
  bar('2026-01-01T00:00:00Z', 94, 100, 90, 98),   // 0  swing low anchor (90)
  bar('2026-01-02T00:00:00Z', 98, 105, 95, 103),  // 1
  bar('2026-01-05T00:00:00Z', 103, 110, 100, 108),// 2
  bar('2026-01-06T00:00:00Z', 108, 120, 112, 118),// 3  swing high (120)
  bar('2026-01-07T00:00:00Z', 118, 115, 100, 113),// 4  the ONLY dip into the band
  bar('2026-01-08T00:00:00Z', 113, 118, 112, 117),// 5  confirmation bar for the high
  bar('2026-01-09T00:00:00Z', 125, 130, 125, 129),// 6  gone -- never returns
  bar('2026-01-12T00:00:00Z', 130, 140, 135, 139),// 7
  bar('2026-01-13T00:00:00Z', 140, 150, 145, 149),// 8
  bar('2026-01-14T00:00:00Z', 150, 160, 155, 159),// 9
];
const lookAheadFib = analyseFib(lookAheadFibBars, 2, 6, 'Daily');
assert.equal(
  lookAheadFib.events.length,
  0,
  'a retracement that happens before the swing high is confirmable is not tradable and must not be counted',
);
for (const row of lookAheadFib.stats) {
  assert.equal(row.touches, 0, `level ${row.level} must report no touches from unconfirmable pivots`);
  assert.equal(row.fillRate, null, `level ${row.level} must not report a fill rate built on look-ahead`);
}
assert.equal(
  lookAheadFib.latestSwing.confirmedDate,
  '2026-01-08',
  'the current swing must publish the date its pivot became confirmable, not just the high date',
);

// Positive control for the test above: move the identical dip to AFTER the
// confirmation bar and the same study finds it. This proves the assertion
// above is about timing, not about the study having stopped working.
const confirmedFibBars = [
  ...lookAheadFibBars.slice(0, 4),
  bar('2026-01-07T00:00:00Z', 118, 118, 116, 117),  // 4 no longer dips
  bar('2026-01-08T00:00:00Z', 117, 118, 115, 117),  // 5 confirmation bar
  bar('2026-01-09T00:00:00Z', 117, 118, 100, 105),  // 6 dip, now actionable
  bar('2026-01-12T00:00:00Z', 105, 121, 104, 120),  // 7 back through the high -> fill
  bar('2026-01-13T00:00:00Z', 120, 122, 118, 121),  // 8
  bar('2026-01-14T00:00:00Z', 121, 123, 119, 122),  // 9
];
const confirmedFib = analyseFib(confirmedFibBars, 2, 6, 'Daily');
const confirmed382 = confirmedFib.stats.find((row) => row.level === 0.382);
assert.ok(confirmed382.touches >= 1, '38.2% retracement after confirmation must still be detected');
assert.ok(confirmed382.fillRate > 0, 'a post-confirmation return to the prior high still counts as a fill');
const confirmedEvent = confirmedFib.events.find((row) => row.level === 0.382);
assert.equal(confirmedEvent.confirmDate, '2026-01-08', 'events carry the pivot confirmation date');
assert.ok(
  confirmedEvent.touchDate > confirmedEvent.confirmDate,
  'a touch can never be dated before the pivot that defines it was confirmable',
);
assert.equal(confirmedEvent.confirmBars, 2, 'events record how many bars the pivot needed to confirm');

// The touch bar's own high must not settle the touch: daily bars cannot order
// the intrabar path, so a same-bar spike back to the high is not a known fill.
const sameBarFibBars = [
  ...lookAheadFibBars.slice(0, 4),
  bar('2026-01-07T00:00:00Z', 118, 118, 116, 117),
  bar('2026-01-08T00:00:00Z', 117, 118, 115, 117),
  bar('2026-01-09T00:00:00Z', 117, 125, 100, 105),  // dips to the band AND tags the high
  bar('2026-01-12T00:00:00Z', 105, 106, 100, 101),  // then dies
  bar('2026-01-13T00:00:00Z', 101, 102, 98, 99),
  bar('2026-01-14T00:00:00Z', 99, 100, 96, 97),
];
const sameBarFib = analyseFib(sameBarFibBars, 2, 6, 'Daily');
for (const row of sameBarFib.events) {
  assert.equal(row.filled, false, 'a fill printed on the touch bar itself is unknowable and must not be scored');
}

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

const proxyDays = groupProxyTradeDays([
  bar('2026-08-24T22:30:00Z', 100, 101, 99, 100.5),
  bar('2026-08-25T08:30:00Z', 103, 104, 102, 103.5),
  bar('2026-08-25T13:30:00Z', 104, 105, 103, 104.5),
], [
  bar('2026-08-25T00:30:00Z', 101, 102, 100, 101.5),
  bar('2026-08-25T06:30:00Z', 102, 103, 101, 102.5),
]);
assert.deepEqual([...proxyDays.keys()], ['2026-08-25'], 'evening bars must be assigned to the following ETF trade date');
const proxySessions = splitSession(proxyDays.get('2026-08-25'));
assert.equal(proxySessions.evening.length, 1);
assert.equal(proxySessions.asia.length, 1);
assert.equal(proxySessions.london.length, 2);
assert.equal(proxySessions.pre.length, 1);
assert.equal(proxySessions.rth.length, 1);

const hourly = resampleMinutes([
  bar('2026-08-25T13:30:00Z', 100, 101, 99, 100.5),
  bar('2026-08-25T14:29:00Z', 100.5, 102, 100, 101.5),
  bar('2026-08-25T14:30:00Z', 101.5, 103, 101, 102.5),
], 60);
assert.equal(hourly.length, 2, 'one-hour bars must anchor to the 9:30 ET session start');
assert.equal(hourly[0].t, '2026-08-25T13:30:00.000Z');
assert.equal(hourly[0].c, 101.5);

const weeklyProxy = groupProxyTradeDays([
  bar('2026-08-14T13:30:00Z', 90, 92, 89, 91),
  bar('2026-08-17T13:30:00Z', 100, 105, 99, 104),
  bar('2026-08-21T13:30:00Z', 104, 110, 98, 109),
  bar('2026-08-25T13:30:00Z', 109, 112, 108, 111),
], []);
const priorWeek = priorWeekRange(weeklyProxy, '2026-08-25');
assert.equal(priorWeek.weekStart, '2026-08-17');
assert.equal(priorWeek.high, 110);
assert.equal(priorWeek.low, 98);

const profile = marketProfileLevels([
  bar('2026-08-25T13:30:00Z', 100, 101, 99, 100, 1000),
  bar('2026-08-25T13:31:00Z', 100, 102, 100, 101, 5000),
  bar('2026-08-25T13:32:00Z', 101, 103, 101, 102, 1000),
]);
assert.ok(profile.val <= profile.poc && profile.poc <= profile.vah, 'POC must remain inside the calculated value area');
assert.ok(profile.coverage >= .70, 'value area must include at least 70% of observed volume');

const fvgBars = [
  bar('2026-08-20T13:30:00Z', 99.5, 100, 99, 99.8),
  bar('2026-08-20T13:31:00Z', 100, 101.2, 99.9, 101),
  bar('2026-08-20T13:32:00Z', 101.2, 102.2, 101, 102),
  bar('2026-08-20T13:33:00Z', 102, 102.1, 100.5, 101.2),
  bar('2026-08-20T13:34:00Z', 101.2, 102.6, 101.1, 102.5),
];
const fvgScan = scanFvgs(fvgBars, '2026-08-20', 1);
const bullishFvg = fvgScan.records.find((row) => row.side === 'Bullish');
assert.equal(bullishFvg.retested, true);
assert.equal(bullishFvg.continuation, true);
assert.equal(bullishFvg.inverted, false);

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
const pdhTiming = timing.find((row) => row.label === 'PDH/PDL sweep');
assert.equal(pdhTiming.before1000, 1);
assert.equal(pdhTiming.before1100, 0.5);

// median() backs every premium research stat below it (fill rates, MFE/MAE) --
// its empty/single/even-length/non-finite-input branches had no direct coverage.
assert.equal(median([]), null, 'no observations must stay unavailable, not 0');
assert.equal(median([5]), 5);
assert.equal(median([1, 3]), 2, 'even-length must average the two middle values');
assert.equal(median([3, 1, 2]), 2, 'must sort before picking the middle, not use input order');
assert.equal(median(['4', null, 6]), 5, 'non-finite entries are dropped, not treated as 0');
assert.equal(median([NaN, 'abc']), null, 'an all-non-finite input must stay unavailable');

// statsFromFibEvents feeds the premium fib-retracement stats table directly;
// it always reports all three tracked levels, even ones with zero touches.
const fibEvents = [
  { level: 0.382, filled: true, newHigh: true, daysToFill: 2, mfe: 0.02, mae: -0.01 },
  { level: 0.382, filled: true, newHigh: false, daysToFill: 4, mfe: 0.01, mae: -0.03 },
  { level: 0.382, filled: false, newHigh: false, daysToFill: null, mfe: 0.005, mae: -0.02 },
  { level: 0.5, filled: false, newHigh: false, daysToFill: null, mfe: -0.01, mae: -0.04 },
];
const fibStats = statsFromFibEvents(fibEvents);
assert.equal(fibStats.length, 3, 'all three tracked fib levels must always be present');
const stats382 = fibStats.find((row) => row.level === 0.382);
assert.equal(stats382.touches, 3);
assert.ok(Math.abs(stats382.fillRate - 2 / 3) < 1e-12);
assert.ok(Math.abs(stats382.newHighRate - 1 / 3) < 1e-12);
assert.equal(stats382.medianDays, 3, 'medianDays is computed over filled touches only');
const stats618 = fibStats.find((row) => row.level === 0.618);
assert.deepEqual(
  { touches: stats618.touches, fillRate: stats618.fillRate, newHighRate: stats618.newHighRate, medianDays: stats618.medianDays },
  { touches: 0, fillRate: null, newHighRate: null, medianDays: null },
  'a level with zero touches must report null rates, not 0 or NaN',
);

// combineFibStats merges events across multiple timeframe results before
// re-aggregating -- confirm it actually pools them rather than only using one.
const combined = combineFibStats([{ events: [fibEvents[0]] }, { events: [fibEvents[1], fibEvents[2]] }]);
assert.equal(combined.find((row) => row.level === 0.382).touches, 3, 'must pool events from every result, not just the first');

// summarizeFvg groups by "timeframe side" and drives the premium FVG stats table.
const fvgRecords = [
  { timeframe: '5m', side: 'Bullish', retested: true, filled: true, continuation: true, inverted: false, minutesToRetest: 10 },
  { timeframe: '5m', side: 'Bullish', retested: false, filled: false, continuation: false, inverted: false, minutesToRetest: null },
  { timeframe: '5m', side: 'Bearish', retested: true, filled: false, continuation: false, inverted: true, minutesToRetest: 20 },
];
const fvgSummary = summarizeFvg(fvgRecords);
assert.equal(fvgSummary.length, 2, 'Bullish and Bearish must not be merged even at the same timeframe');
const bullishSummary = fvgSummary.find((row) => row.condition === '5m Bullish');
assert.equal(bullishSummary.n, 2);
assert.equal(bullishSummary.retestRate, 0.5);
assert.equal(bullishSummary.medianMinutesToRetest, 10, 'the untested row\'s null minutesToRetest must not pull the median down');

// buildPriceActionModel is the orchestrator behind the premium FVG/IFVG stats
// (it feeds fvgStats/conditions/timing in intradayModule) and was the one
// __test export with zero direct references -- everything it calls
// (splitSession, scanFvgs, scanDisplacement) was already pinned individually,
// but never that it actually scans all four timeframes, skips thin days, and
// respects the days window, rather than e.g. silently dropping a timeframe.
{
  // A January ET date (EST, UTC-5, no DST) so a fixed UTC offset maps cleanly
  // to RTH minutes without reimplementing the Intl formatter under test.
  function rthDay(dateIso, bars, jumpAt) {
    const rows = [];
    let price = 100;
    for (let minute = 0; minute < bars; minute++) {
      if (minute === jumpAt) price += 3; // a clean gap, guaranteed to form an FVG
      const open = price;
      const close = price + Math.sin(minute * 0.9) * 0.05;
      const high = Math.max(open, close) + 0.02;
      const low = Math.min(open, close) - 0.02;
      price = close;
      const utcMinute = 14 * 60 + 30 + minute; // 14:30 UTC = 09:30 ET in January
      const t = `${dateIso}T${String(Math.floor(utcMinute / 60)).padStart(2, '0')}:${String(utcMinute % 60).padStart(2, '0')}:00.000Z`;
      const etMinute = 570 + minute; // 09:30 ET
      const _time = `${String(Math.floor(etMinute / 60)).padStart(2, '0')}:${String(etMinute % 60).padStart(2, '0')}`;
      rows.push({ t, o: open, h: high, l: low, c: close, v: 1000, _time });
    }
    return rows;
  }

  const thinDay = rthDay('2024-01-08', 20, 10); // below splitSession's usable RTH size
  const fullDay1 = rthDay('2024-01-09', 390, 150);
  const fullDay2 = rthDay('2024-01-10', 390, 220);

  const daysMap = new Map([
    ['2024-01-08', thinDay],
    ['2024-01-09', fullDay1],
    ['2024-01-10', fullDay2],
  ]);

  // A day with fewer than 30 RTH bars must be skipped outright, not scanned
  // with whatever partial data it has.
  const skipThin = buildPriceActionModel(daysMap, 3);
  assert.ok(
    skipThin.events.every((e) => e.date !== '2024-01-08') && skipThin.fvgRecords.every((r) => r.date !== '2024-01-08'),
    'a day with under 30 RTH bars must never contribute events or records',
  );

  // days (limitDays) selects the most recent N calendar dates, sorted, not an
  // arbitrary N entries -- with limitDays=1 only the last full day should show.
  const onlyLatest = buildPriceActionModel(daysMap, 1);
  assert.ok(onlyLatest.fvgRecords.length > 0, 'the synthetic gap must actually produce FVG records to make this check meaningful');
  assert.ok(
    onlyLatest.events.every((e) => e.date === '2024-01-10') && onlyLatest.fvgRecords.every((r) => r.date === '2024-01-10'),
    'limitDays=1 must restrict to the single most recent trading day',
  );

  // With both full days in the window, the model must be the exact union of
  // scanning every one of the four timeframes (1/5/15/60) plus the
  // displacement scan on each day's RTH session -- not a subset, and not
  // double-counted. This is the regression this file's own comments warn
  // about: FVG/displacement work in this codebase has broken silently before
  // when a timeframe or session boundary was mishandled.
  const both = buildPriceActionModel(daysMap, 2);
  const expectedRecords = [];
  const expectedEvents = [];
  for (const date of ['2024-01-09', '2024-01-10']) {
    const rth = splitSession(daysMap.get(date)).rth;
    for (const timeframe of [1, 5, 15, 60]) {
      const scan = scanFvgs(rth, date, timeframe);
      expectedRecords.push(...scan.records);
      expectedEvents.push(...scan.events);
    }
    expectedEvents.push(...scanDisplacement(rth, date));
  }
  assert.deepEqual(both.fvgRecords, expectedRecords, 'fvgRecords must equal scanning every timeframe on every included day, in order');
  assert.deepEqual(both.events, expectedEvents, 'events must equal every timeframe\'s FVG events plus the displacement scan, in order');
}

// ---------------------------------------------------------------------------
// Client contract for the cookie session and the 403 "plan" state.
//
// The browser authenticates with the HttpOnly session cookie and nothing else,
// so a fetch that omits credentials silently sends no session at all -- the
// exact shape of the bug where the page showed itself unlocked while every
// data request 401'd. And a 403 is an entitlement answer, not a transient
// failure: it must not render as the generic retryable error.
// ---------------------------------------------------------------------------
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const clientJs = readFileSync(resolve(projectRoot, 'assets/research-engine.js'), 'utf8');
const clientHtml = readFileSync(resolve(projectRoot, 'research-engine.html'), 'utf8');

for (const match of clientJs.matchAll(/fetch\(([^)]*)\)/g)) {
  assert.ok(
    match[0].includes("credentials:'same-origin'") || match[0].includes("credentials: 'same-origin'"),
    `every fetch must send the session cookie: ${match[0]}`,
  );
}

assert.match(clientJs, /planLocked\s*=\s*res\.status === 403/, 'a 403 must be recognised as a plan/entitlement state');
assert.ok(clientJs.includes('showPlanNotice'), 'a 403 must render a dedicated plan notice, not the generic error');
assert.match(clientHtml, /id="planNotice"[^>]*hidden/, 'the plan notice must ship hidden and be revealed only on a 403');

// The site is mid-rebrand to white/black with red as a restrained accent: the
// new state must borrow existing tokens rather than introduce a colour.
const planBranchStart = clientJs.indexOf('if (err && err.planLocked)');
assert.ok(planBranchStart > 0, 'showModuleError must branch on the plan-locked state');
const planBranch = clientJs.slice(planBranchStart, clientJs.indexOf('return;', planBranchStart));
assert.doesNotMatch(planBranch, /#[0-9a-fA-F]{3,8}/, 'the plan state must not add a new colour literal');
assert.ok(planBranch.includes('var(--amber)'), 'the plan state reuses an existing palette token');


// ---------------------------------------------------------------------------
// LOOK-AHEAD: grouped (5m/15m/60m) bars carry a completed candle's values but
// are timestamped at the group's OPEN.
//
// A 5m FVG whose third candle spans 13:40-13:45 does not exist until 13:45.
// Reacting at 13:40 means the "retest" can be a one-minute bar that is still
// building the very candle that defines the zone -- the study sees its own
// future. The tape below is hostile on purpose: the only visit to the zone
// happens INSIDE the third candle, and once that candle closes price leaves
// and never comes back. Pre-fix this reported a retested zone with
// continuation; post-fix there is nothing to react to.
// ---------------------------------------------------------------------------
const groupedFvgBars = [
  // 13:30-13:34 -> group A, high 100
  bar('2026-08-20T13:30:00Z', 95, 100, 94, 99),
  bar('2026-08-20T13:31:00Z', 99, 100, 95, 99.5),
  bar('2026-08-20T13:32:00Z', 99.5, 100, 96, 99.8),
  bar('2026-08-20T13:33:00Z', 99.8, 100, 97, 99.9),
  bar('2026-08-20T13:34:00Z', 99.9, 100, 98, 100),
  // 13:35-13:39 -> group B
  bar('2026-08-20T13:35:00Z', 100.5, 104, 100.5, 103),
  bar('2026-08-20T13:36:00Z', 103, 104, 101, 103),
  bar('2026-08-20T13:37:00Z', 103, 104, 101, 103),
  bar('2026-08-20T13:38:00Z', 103, 104, 101, 103),
  bar('2026-08-20T13:39:00Z', 103, 104, 101, 104),
  // 13:40-13:44 -> group C: low 101 > group A high 100 => bullish 5m FVG,
  // zone [100, 101]. The 13:41 bar dips to 101 -- inside the forming candle.
  bar('2026-08-20T13:40:00Z', 105, 106, 105, 105.5),
  bar('2026-08-20T13:41:00Z', 105.5, 105.5, 101, 104),
  bar('2026-08-20T13:42:00Z', 104, 106, 104, 105),
  bar('2026-08-20T13:43:00Z', 105, 106, 104, 105),
  bar('2026-08-20T13:44:00Z', 105, 106, 104, 106),
  // 13:45 onward: gone. Nothing ever trades back down to the zone.
  bar('2026-08-20T13:45:00Z', 112, 114, 110, 113),
  bar('2026-08-20T13:46:00Z', 113, 116, 112, 115),
  bar('2026-08-20T13:47:00Z', 115, 118, 114, 117),
  bar('2026-08-20T13:48:00Z', 117, 120, 116, 119),
  bar('2026-08-20T13:49:00Z', 119, 122, 118, 121),
  bar('2026-08-20T13:50:00Z', 121, 124, 120, 123),
  bar('2026-08-20T13:51:00Z', 123, 126, 122, 125),
  bar('2026-08-20T13:52:00Z', 125, 128, 124, 127),
  bar('2026-08-20T13:53:00Z', 127, 130, 126, 129),
  bar('2026-08-20T13:54:00Z', 129, 132, 128, 131),
];
const groupedScan = scanFvgs(groupedFvgBars, '2026-08-20', 5);
const zoneRecord = groupedScan.records.find((row) => row.zoneLow === 100 && row.zoneHigh === 101);
assert.ok(zoneRecord, 'the 5m bullish imbalance must still be detected');
assert.equal(zoneRecord.formedAt, '09:40', 'the zone is drawn at the third candle’s open');
assert.equal(
  zoneRecord.observableAt,
  '09:45',
  'a grouped bar is only observable when its group ends -- results must publish that instant',
);
assert.equal(
  zoneRecord.retested,
  false,
  'a "retest" printed inside the still-forming third candle is look-ahead and must not count',
);
assert.equal(zoneRecord.continuation, false, 'continuation cannot follow a retest that never happened');
assert.equal(zoneRecord.minutesToRetest, null);
assert.equal(
  groupedScan.events.length,
  0,
  'no tradable FVG event exists on this tape once the zone is timed to its completion',
);

// Positive control: same shape, but the visit to the zone happens AFTER the
// third candle completes, so the study is expected to find it.
const tradableFvgBars = groupedFvgBars.slice(0, 11).concat([
  bar('2026-08-20T13:41:00Z', 105.5, 106, 104, 105),
  bar('2026-08-20T13:42:00Z', 105, 106, 104, 105),
  bar('2026-08-20T13:43:00Z', 105, 106, 104, 105),
  bar('2026-08-20T13:44:00Z', 105, 106, 101, 102),
  bar('2026-08-20T13:45:00Z', 102, 102.5, 100.5, 101),
  bar('2026-08-20T13:46:00Z', 101, 104, 100.8, 103),
  bar('2026-08-20T13:47:00Z', 103, 108, 102, 107),
  bar('2026-08-20T13:48:00Z', 107, 110, 106, 109),
  bar('2026-08-20T13:49:00Z', 109, 112, 108, 111),
]);
const tradableScan = scanFvgs(tradableFvgBars, '2026-08-20', 5);
const tradableRecord = tradableScan.records.find((row) => row.zoneLow === 100 && row.zoneHigh === 101);
assert.equal(tradableRecord.retested, true, 'a retest after the candle completed is real and must count');
assert.ok(tradableRecord.minutesToRetest >= 0, 'time-to-retest is measured from the observation instant, never negative');

// barCloseTime is the single gate the studies use. It must never hand back the
// bar's drawing timestamp for a grouped bar.
const oneHour = resampleMinutes(groupedFvgBars, 60);
assert.equal(oneHour[0].t, '2026-08-20T13:30:00.000Z');
assert.equal(
  barCloseTime(oneHour[0], 60) - Date.parse(oneHour[0].t),
  60 * 60000,
  'a 60m bar is observable one hour after the timestamp it is drawn at',
);
assert.equal(
  barCloseTime(bar('2026-08-20T13:30:00Z', 1, 1, 1, 1), 1) - Date.parse('2026-08-20T13:30:00Z'),
  60000,
  'a plain one-minute bar is observable at its own close',
);

// ---------------------------------------------------------------------------
// LOOK-AHEAD: five-minute displacement is stamped at the group open too.
//
// The displacement candle below runs 100 -> 110 across its five minutes and
// then the tape reverses hard. Entering at the group's OPENING minute books
// the whole 10-point candle as favourable excursion; entering when the candle
// actually completed books the reversal that followed. Pre-fix this printed
// continuation; post-fix it prints the reversal that really happened.
// ---------------------------------------------------------------------------
const SESSION_OPEN = Date.parse('2026-08-20T13:30:00Z');
const minuteAt = (index) => new Date(SESSION_OPEN + index * 60000).toISOString();
const displacementBars = [];
// 100 quiet minutes -> 20 uneventful 5m bars establishing the median body/range.
for (let i = 0; i < 100; i++) displacementBars.push(bar(minuteAt(i), 100, 100.3, 99.9, 100.2));
// Minutes 100-104 (11:10-11:15 ET) are the displacement candle: 100 -> 110,
// closing on its high.
const rise = [102, 104, 106, 108, 110];
for (let i = 0; i < 5; i++) displacementBars.push(bar(minuteAt(100 + i), rise[i] - 2, rise[i], rise[i] - 2, rise[i]));
// From 11:15 on, the tape drifts straight back down (gently enough not to be a
// displacement candle of its own).
for (let i = 0; i < 60; i++) {
  const price = 110 - i * 0.05;
  displacementBars.push(bar(minuteAt(105 + i), price, price + 0.02, price - 0.06, price - 0.05));
}
const displacementEvents = scanDisplacement(displacementBars, '2026-08-20');
assert.equal(displacementEvents.length, 1, 'exactly one displacement candle exists on this tape');
const displacement = displacementEvents[0];
assert.equal(
  displacement.time,
  '11:15',
  'a 5m displacement candle spanning 11:10-11:15 is actionable at 11:15, not at 11:10',
);
assert.equal(
  displacement.continuation,
  false,
  'the move inside the displacement candle is not a post-signal continuation',
);
assert.equal(displacement.reversal, true, 'the tape reversed immediately after the candle completed');

// ---------------------------------------------------------------------------
// The entry bar's own excursion is already history when the entry price
// exists. A sweep bar that spikes 0.3% past the level and then closes back at
// the level, followed by a tape that only falls, is a reversal -- not a
// continuation manufactured out of the entry bar's own high.
// ---------------------------------------------------------------------------
const entryBarSweep = classifySweep([
  bar('2026-08-20T13:30:00Z', 99.9, 100.4, 99.8, 100),   // sweep + the whole up-move, entry 100
  bar('2026-08-20T13:31:00Z', 100, 100.05, 99.7, 99.75),
  bar('2026-08-20T13:32:00Z', 99.75, 99.8, 99.5, 99.6),
], 100, 'high', 'PDH', '2026-08-20');
assert.equal(
  entryBarSweep.continuation,
  false,
  'the sweep bar’s own high printed before the entry close and must not score as continuation',
);
assert.equal(entryBarSweep.reversal, true, 'the only post-entry move was down');
assert.ok(entryBarSweep.mfe <= 0.0006, 'MFE must be measured from the entry bar forward only');

const directional = classifyDirectionalOutcome([
  bar('2026-08-20T13:30:00Z', 100, 101, 99.9, 100),      // entry bar, already spiked
  bar('2026-08-20T13:31:00Z', 100, 100.02, 99.6, 99.7),
  bar('2026-08-20T13:32:00Z', 99.7, 99.8, 99.4, 99.5),
], 0, 'up', 'test', '2026-08-20');
assert.equal(directional.continuation, false, 'entry-bar excursion is not post-entry excursion');
assert.equal(directional.reversal, true);
assert.equal(
  classifyDirectionalOutcome([bar('2026-08-20T13:30:00Z', 100, 101, 99, 100)], 0, 'up', 'test', '2026-08-20'),
  null,
  'an event with no bar after entry has no measurable outcome and must be dropped, not scored from its own bar',
);

// ---------------------------------------------------------------------------
// Provenance: every study result must be able to say what it is.
// ---------------------------------------------------------------------------
const provenance = studyProvenance('Test study');
assert.equal(provenance.results, 'hypothetical-gross');
assert.equal(provenance.timingConvention, TIMING_CONVENTION, 'studies stamp the single frozen convention');
assert.match(provenance.disclaimer, /not achieved or live-tradable results/i);
assert.match(provenance.disclaimer, /no commissions, fees, spread, slippage/i);
assert.ok(TIMING_CONVENTION.version, 'the timing convention is versioned so a change is visible downstream');
assert.throws(
  () => { TIMING_CONVENTION.fill = 'anything'; },
  'the timing convention is frozen: a study may not quietly redefine when it fills',
);

console.log('VJM research-engine calculation tests passed.');

// ---------------------------------------------------------------------------
// PROVENANCE IN THE UI
//
// The API stamps every study response with what the numbers are (hypothetical,
// gross) and the timing convention that produced them. Until this was
// rendered, a member read a hit rate with nothing on screen saying it was
// gross of every cost and computed under a specific look-ahead-free timing
// rule -- the exact claim posture the compliance audit flagged.
//
// These tests actually run the shipped client module against a stub DOM and
// assert on what it writes, so a silent regression (a renamed hook, a dropped
// call site) fails here rather than in front of a paying member.
// ---------------------------------------------------------------------------
assert.match(clientHtml, /id="optionsProvenance"/, 'the options study must ship a provenance region');
assert.match(clientHtml, /id="stocksProvenance"/, 'the fib study must ship a provenance region');
assert.equal(
  (clientHtml.match(/data-provenance-short=/g) || []).length,
  4,
  'every study table/heatmap carries the short form beside its numbers',
);
assert.match(clientHtml, /<details class="provenance-detail">/, 'the full timing convention is reachable in an expander');
// Not a footer: the audit criticised burying the basis at the bottom of the
// page. The provenance regions must sit inside the study modules themselves.
const footerStart = clientHtml.indexOf('<footer');
assert.ok(footerStart > 0);
assert.ok(clientHtml.indexOf('id="optionsProvenance"') < footerStart, 'provenance must not live in the footer');
assert.ok(clientHtml.indexOf('id="stocksProvenance"') < footerStart, 'provenance must not live in the footer');
assert.ok(
  clientJs.includes("renderProvenance('options', intradayResponse.provenance)"),
  "the options tab's rate tables are the intraday study, so its provenance governs them",
);
assert.ok(clientJs.includes("renderProvenance('stocks', response.provenance)"), 'the fib study renders its own provenance');

// --- run the real client module against a stub DOM ---------------------------
function stubNode() {
  const n = { textContent: '', innerHTML: '', classes: new Set() };
  n.classList = { toggle: (c, on) => { if (on) n.classes.add(c); else n.classes.delete(c); }, contains: (c) => n.classes.has(c) };
  return n;
}
function renderProvenanceWith(provenance) {
  const tag = stubNode(), line = stubNode(), body = stubNode();
  const basis = stubNode(), pill = stubNode(), shortA = stubNode(), shortB = stubNode();
  const root = stubNode();
  root.querySelector = (sel) => ({ '[data-provenance-tag]': tag, '[data-provenance-line]': line, '[data-provenance-body]': body }[sel] || null);
  const byId = { optionsProvenance: root, globalBasis: basis, globalBasisPill: pill };
  const priorDocument = globalThis.document, priorStyle = globalThis.getComputedStyle;
  globalThis.document = {
    body: {},
    getElementById: (id) => byId[id] || null,
    querySelectorAll: (sel) => (sel.includes('data-provenance-short') ? [shortA, shortB] : []),
    addEventListener() {},
  };
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
  try {
    // Swap only the boot line so nothing else in the module changes.
    const bootable = clientJs.replace(
      "document.addEventListener('DOMContentLoaded',wire);",
      'globalThis.__researchEngineTestHooks = { renderProvenance };',
    );
    assert.ok(bootable !== clientJs, 'the client module must still boot from DOMContentLoaded');
    new Function(bootable)();
    globalThis.__researchEngineTestHooks.renderProvenance('options', provenance);
  } finally {
    globalThis.document = priorDocument;
    globalThis.getComputedStyle = priorStyle;
  }
  return { root, tag, line, body, basis, pill, shorts: [shortA, shortB] };
}

const liveProvenance = studyProvenance('Intraday sweep / FVG / SMT event study');
const rendered = renderProvenanceWith(liveProvenance);
assert.match(rendered.tag.textContent, /hypothetical/i, 'the short tag states the numbers are hypothetical');
assert.match(rendered.tag.textContent, /gross/i, 'the short tag states the numbers are gross');
assert.match(rendered.line.textContent, /Intraday sweep/, 'the strip names the study');
assert.match(rendered.line.textContent, /no commissions, fees, spread, slippage/i, 'the absent cost model is stated, not implied');
assert.ok(rendered.line.textContent.includes(TIMING_CONVENTION.version), 'the frozen convention version is on screen');
assert.match(rendered.basis.textContent, /hypothetical/i, 'the toolbar basis pill states the result basis');
for (const short of rendered.shorts) {
  assert.match(short.textContent, /Hypothetical/i, 'every study table carries the short form beside its numbers');
  assert.equal(short.classes.has('missing'), false);
}
for (const key of ['observable', 'actionable', 'fill', 'outcome', 'costs', 'nature']) {
  assert.ok(rendered.body.innerHTML.includes(TIMING_CONVENTION[key].slice(0, 40)), `the expander must state the convention's "${key}" rule verbatim`);
}
assert.ok(rendered.body.innerHTML.includes(liveProvenance.disclaimer.slice(0, 50)), 'the full disclaimer is reachable');
assert.equal(rendered.root.classes.has('missing'), false);

// A snapshot cached in D1 before the look-ahead fix has no provenance block.
// It must NOT be given an invented one -- an assumed convention would be a
// stronger claim than the missing one. It is labelled as suspect instead.
for (const preFix of [undefined, null, {}, { study: 'Old study' }, { study: 'Old', results: 'hypothetical-gross' }]) {
  const stale = renderProvenanceWith(preFix);
  assert.match(stale.line.textContent, /predates the timing-convention fix/i, 'the pre-fix state must say so explicitly');
  assert.match(stale.line.textContent, /may be overstated/i, 'the pre-fix state must warn the numbers can be inflated');
  assert.match(stale.tag.textContent, /missing/i);
  assert.equal(stale.root.classes.has('missing'), true, 'the pre-fix state is styled as a warning, not as a normal result');
  assert.match(stale.body.innerHTML, /predates the timing-convention fix/i);
  assert.doesNotMatch(stale.line.textContent, /timing convention 20/, 'a missing convention must never be invented');
  assert.doesNotMatch(stale.body.innerHTML, new RegExp(TIMING_CONVENTION.version), 'a missing convention must never be invented');
  for (const short of stale.shorts) {
    assert.match(short.textContent, /pre-fix|missing/i, 'the short form beside the numbers also flags the pre-fix result');
    assert.equal(short.classes.has('missing'), true);
  }
}

// --- palette: the new state must not introduce a colour --------------------
// The site is white/black with red as a restrained accent and
// tests/palette.test.mjs asserts zero non-red chromatic hues site-wide. The
// provenance UI must therefore be built from existing tokens only.
const clientCss = readFileSync(resolve(projectRoot, 'assets/research-engine.css'), 'utf8');
const provenanceCss = clientCss.slice(clientCss.indexOf('/* ─── RESULT PROVENANCE'));
assert.ok(provenanceCss.length > 200, 'the provenance styles must be present');
assert.doesNotMatch(provenanceCss, /#[0-9a-fA-F]{3,8}\b/, 'the provenance styles must not add a colour literal');
assert.doesNotMatch(provenanceCss, /\brgba?\(\s*(?!0\s*,\s*0\s*,\s*0|255\s*,\s*255\s*,\s*255)/, 'only neutral black/white washes are allowed; hues come from tokens');
assert.ok(provenanceCss.includes('var(--red-ink)'), 'the warning state reuses the existing red accent token');
assert.ok(provenanceCss.includes('body.light-mode .provenance'), 'the provenance UI must be readable in the light theme too');
const provenanceJs = clientJs.slice(clientJs.indexOf('  function setBasis('), clientJs.indexOf('const PLAN_LOCKED_TEXT'));
assert.doesNotMatch(provenanceJs, /#[0-9a-fA-F]{3,8}\b/, 'the provenance renderer must not inline a colour');
assert.doesNotMatch(provenanceJs, /\brgba?\(/, 'the provenance renderer must not inline a colour');

// --- canonical / OG / JSON-LD ----------------------------------------------
// Single origin, root path shape, no /pj/ prefix, no .html alias -- and the
// page stays noindexed: it is a member tool, not a public document.
const CANONICAL = 'https://not-financial-advice-vjm.com/research-engine';
assert.ok(clientHtml.includes(`<link rel="canonical" href="${CANONICAL}">`), 'canonical uses the shared origin and root path');
assert.ok(clientHtml.includes(`<meta property="og:url" content="${CANONICAL}">`), 'og:url must not contradict the canonical');
assert.ok(clientHtml.includes(`<meta name="twitter:url" content="${CANONICAL}">`), 'twitter:url must not contradict the canonical');
assert.doesNotMatch(clientHtml, /not-financial-advice-vjm\.com\/pj\//, 'no absolute link may keep the retired /pj/ path shape');
const ldMatch = clientHtml.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
assert.ok(ldMatch, 'the page ships structured data');
const ld = JSON.parse(ldMatch[1]);
assert.equal(ld.url, CANONICAL, 'JSON-LD url must equal the canonical');
assert.equal(ld['@id'], CANONICAL + '#app');
assert.equal(ld.isAccessibleForFree, false, 'the research engine is not free — do not mark a paid tool free');
assert.match(ld.disclaimer, /not achieved or live-tradable/i, 'structured data must not claim more than the page does');
assert.match(clientHtml, /<meta name="robots" content="noindex/i, 'the research engine stays noindexed');
