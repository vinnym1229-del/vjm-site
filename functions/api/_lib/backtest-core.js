// VJM Edge Lab — deterministic event-study engine.
//
// Pure functions only (no fetch, no DOM) so the whole methodology is unit-
// testable and identical on server and client. Core rules:
//   • Signals use data UP TO AND INCLUDING the signal bar. Nothing after it.
//   • Entries happen at the NEXT bar's open. Exits at close of the hold window,
//     or at target/stop if touched intrabar.
//   • Same-bar target+stop ambiguity resolves CONSERVATIVELY as stop-first
//     (pessimistic), and is flagged in every result summary.
//   • Events without enough forward bars are dropped and counted.

export const SAME_TOUCH_POLICY = 'conservative (stop assumed first when both touched in one bar)';

// ─── Indicators (all causal: value at index i uses indices ≤ i) ───────────

export function sma(values, n) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

// Wilder's ATR.
export function atr(highs, lows, closes, n = 14) {
  const out = new Array(closes.length).fill(null);
  let prevClose = null;
  let atrSum = 0;
  let count = 0;
  let runningAtr = null;
  for (let i = 0; i < closes.length; i++) {
    let tr;
    if (prevClose === null) {
      tr = highs[i] - lows[i];
    } else {
      tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - prevClose), Math.abs(lows[i] - prevClose));
    }
    if (i < n) {
      atrSum += tr;
      count++;
      if (count === n) {
        runningAtr = atrSum / n;
        out[i] = runningAtr;
      }
    } else {
      runningAtr = (runningAtr * (n - 1) + tr) / n;
      out[i] = runningAtr;
    }
    prevClose = closes[i];
  }
  return out;
}

// Wilder's RSI.
export function rsi(closes, n = 14) {
  const out = new Array(closes.length).fill(null);
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    if (i <= n) {
      avgGain += gain / n;
      avgLoss += loss / n;
      if (i === n) out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    } else {
      avgGain = (avgGain * (n - 1) + gain) / n;
      avgLoss = (avgLoss * (n - 1) + loss) / n;
      out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
  }
  return out;
}

function rangeOf(bar) {
  return bar.h - bar.l;
}

function highestCloses(bars, i, n) {
  let m = -Infinity;
  for (let j = Math.max(0, i - n + 1); j <= i; j++) m = Math.max(m, bars[j].c);
  return m;
}

function lowestCloses(bars, i, n) {
  let m = Infinity;
  for (let j = Math.max(0, i - n + 1); j <= i; j++) m = Math.min(m, bars[j].c);
  return m;
}

function meanVolume(bars, i, n) {
  let sum = 0;
  let count = 0;
  for (let j = Math.max(0, i - n); j < i; j++) {
    sum += bars[j].v;
    count++;
  }
  return count ? sum / count : NaN;
}

// ─── Triggers ─────────────────────────────────────────────────────────────
// Each returns true/false for bar i, assuming enough warmup exists.
// Descriptions double as UI copy so definitions stay beside outputs.

export const TRIGGERS = {
  gap_up: {
    label: 'Gap up ≥ X%',
    defaults: { pct: 1 },
    warmup: 1,
    test: (b, i, p) => (b[i].o / b[i - 1].c - 1) * 100 >= p.pct,
    describe: (p) => `Open gaps up ${p.pct}% or more above the prior close`,
    directionHint: 'long',
  },
  gap_down: {
    label: 'Gap down ≥ X%',
    defaults: { pct: 1 },
    warmup: 1,
    test: (b, i, p) => (b[i].o / b[i - 1].c - 1) * 100 <= -p.pct,
    describe: (p) => `Open gaps down ${p.pct}% or more below the prior close`,
    directionHint: 'short',
  },
  inside_day: {
    label: 'Inside day',
    defaults: {},
    warmup: 1,
    test: (b, i) => b[i].h < b[i - 1].h && b[i].l > b[i - 1].l,
    describe: () => 'Bar range sits entirely inside the prior bar\'s range',
    directionHint: 'long',
  },
  outside_day: {
    label: 'Outside day',
    defaults: {},
    warmup: 1,
    test: (b, i) => b[i].h > b[i - 1].h && b[i].l < b[i - 1].l,
    describe: () => 'Bar range engulfs the prior bar\'s range',
    directionHint: 'long',
  },
  nr7: {
    label: 'NR7 (narrowest range of 7)',
    defaults: {},
    warmup: 7,
    test: (b, i) => {
      const r = rangeOf(b[i]);
      for (let j = i - 6; j < i; j++) if (rangeOf(b[j]) <= r) return false;
      return true;
    },
    describe: () => 'Today\'s range is the tightest of the last 7 sessions (squeeze)',
    directionHint: 'long',
  },
  streak_reversal: {
    label: 'N red days → green day (or mirror)',
    defaults: { streak: 3, dir: 'down' },
    warmup: 4,
    test: (b, i, p) => {
      const sign = p.dir === 'down' ? -1 : 1;
      for (let j = i - p.streak; j < i; j++) {
        if ((b[j].c - b[j - 1].c) * sign <= 0) return false;
      }
      // Opposite sign to the streak: the same sign matched an (N+1)th day in
      // the SAME direction, so this never detected a reversal at all.
      return (b[i].c - b[i - 1].c) * sign < 0;
    },
    describe: (p) => `${p.streak} consecutive ${p.dir} days then a close in the opposite direction`,
    directionHint: 'long',
  },
  sma_break: {
    label: 'Close crosses SMA(N)',
    defaults: { period: 50, dir: 'up' },
    warmup: null, // resolved from period
    test: (b, i, p, ind) => {
      const s = ind.sma[p.period];
      if (s[i] === null || s[i - 1] === null) return false;
      if (p.dir === 'up') return b[i - 1].c < s[i - 1] && b[i].c > s[i];
      return b[i - 1].c > s[i - 1] && b[i].c < s[i];
    },
    describe: (p) => `Close crosses ${p.dir === 'up' ? 'above' : 'below'} the ${p.period}-day simple moving average`,
    directionHint: 'long',
  },
  vol_spike: {
    label: 'Volume ≥ X× 20-day average',
    defaults: { mult: 2 },
    warmup: 21,
    test: (b, i, p) => b[i].v >= p.mult * meanVolume(b, i, 20),
    describe: (p) => `Volume at least ${p.mult}× the average of the prior 20 sessions`,
    directionHint: 'long',
  },
  rsi_cross: {
    label: 'RSI(14) crosses level',
    defaults: { level: 30, dir: 'up' },
    warmup: 15,
    test: (b, i, p, ind) => {
      const r = ind.rsi;
      if (r[i] === null || r[i - 1] === null) return false;
      if (p.dir === 'up') return r[i - 1] < p.level && r[i] >= p.level;
      return r[i - 1] > p.level && r[i] <= p.level;
    },
    describe: (p) => `RSI(14) crosses ${p.dir === 'up' ? 'up through' : 'down through'} ${p.level}`,
    directionHint: 'long',
  },
  new_n_day_close_high: {
    label: 'New N-day closing high',
    defaults: { n: 20 },
    warmup: null,
    test: (b, i, p) => b[i].c >= highestCloses(b, i - 1, p.n),
    describe: (p) => `Close is the highest close of the prior ${p.n} sessions`,
    directionHint: 'long',
  },
  new_n_day_close_low: {
    label: 'New N-day closing low',
    defaults: { n: 20 },
    warmup: null,
    test: (b, i, p) => b[i].c <= lowestCloses(b, i - 1, p.n),
    describe: (p) => `Close is the lowest close of the prior ${p.n} sessions`,
    directionHint: 'short',
  },
  big_move: {
    label: '|Move| ≥ X × ATR(14)',
    defaults: { mult: 2, dir: 'up' },
    warmup: 14,
    test: (b, i, p, ind) => {
      const a = ind.atr[i];
      if (!a || !b[i - 1]) return false;
      const move = b[i].c - b[i - 1].c;
      if (p.dir === 'up') return move >= p.mult * a;
      return move <= -p.mult * a;
    },
    describe: (p) => `Single-session move of at least ${p.mult}× ATR(14) to the ${p.dir === 'up' ? 'upside' : 'downside'}`,
    directionHint: 'long',
  },
};

export function triggerWarmup(type, params) {
  const t = TRIGGERS[type];
  if (!t) return 0;
  if (type === 'sma_break') return params.period;
  if (type === 'new_n_day_close_high' || type === 'new_n_day_close_low') return params.n;
  return t.warmup || 0;
}

// ─── Trade simulation ─────────────────────────────────────────────────────
// bars: ascending [{t,o,h,l,c,v}]; i = signal index; entry at i+1 open.
// stopR/targetR are multiples of ATR(14) captured at the signal bar.

export function simulateEvent(bars, i, opts) {
  const { holdDays, direction, stopR, targetR, atrValue } = opts;
  const entryIdx = i + 1;
  if (entryIdx >= bars.length) return { status: 'dropped_no_entry' };
  const exitIdx = entryIdx + holdDays - 1;

  const entry = bars[entryIdx].o;
  if (!(entry > 0)) return { status: 'dropped_bad_entry' };
  if (exitIdx >= bars.length) return { status: 'dropped_incomplete' };

  const sign = direction === 'long' ? 1 : -1;
  let stopPx = null;
  let targetPx = null;
  let riskPerShare = null;
  if (stopR && atrValue > 0) {
    riskPerShare = stopR * atrValue;
    stopPx = entry - sign * riskPerShare;
  }
  if (targetR && atrValue > 0) {
    targetPx = entry + sign * targetR * atrValue;
  }

  let exitPx = bars[exitIdx].c;
  let exitDate = bars[exitIdx].t;
  let result = 'timeout';
  let ambiguousTouch = false;

  if (stopPx !== null || targetPx !== null) {
    for (let j = entryIdx; j <= exitIdx; j++) {
      const hitStop = stopPx !== null && (sign === 1 ? bars[j].l <= stopPx : bars[j].h >= stopPx);
      const hitTarget = targetPx !== null && (sign === 1 ? bars[j].h >= targetPx : bars[j].l <= targetPx);
      if (hitStop && hitTarget) {
        // Daily bars cannot tell which printed first: pessimistic stop-first.
        exitPx = stopPx;
        result = 'stop';
        ambiguousTouch = true;
        exitDate = bars[j].t;
        break;
      }
      if (hitStop) {
        exitPx = stopPx;
        result = 'stop';
        exitDate = bars[j].t;
        break;
      }
      if (hitTarget) {
        exitPx = targetPx;
        result = 'target';
        exitDate = bars[j].t;
        break;
      }
      if (j === exitIdx) result = 'timeout';
    }
  }

  const move = sign === 1 ? exitPx - entry : entry - exitPx;
  const retPct = (move / entry) * 100;
  const rMultiple = riskPerShare ? move / riskPerShare : null;

  // Excursions across the holding window (in R when risk known, else %).
  // Track raw extremes and derive per side. The previous form negated the
  // short-side extremes and then subtracted them from entry, so a short's MFE
  // came out as entry + highestHigh — e.g. entry 100 with a 105 high and 2
  // risk reported ~102R instead of ~2R.
  let hi = -Infinity;
  let lo = Infinity;
  for (let j = entryIdx; j <= exitIdx; j++) {
    hi = Math.max(hi, bars[j].h);
    lo = Math.min(lo, bars[j].l);
  }
  // MFE is the best move in the trade's favour (positive); MAE the worst move
  // against it (negative), both measured from entry.
  const mfeRaw = sign === 1 ? hi - entry : entry - lo;
  const maeRaw = sign === 1 ? lo - entry : entry - hi;
  const conv = (x) => (riskPerShare ? +(x / riskPerShare).toFixed(4) : +((x / entry) * 100).toFixed(4));

  return {
    status: 'ok',
    signalDate: bars[i].t,
    entryDate: bars[entryIdx].t,
    entryPx: +entry.toFixed(4),
    exitDate,
    exitPx: +exitPx.toFixed(4),
    retPct: +retPct.toFixed(4),
    rMultiple: rMultiple === null ? null : +rMultiple.toFixed(4),
    mfe: conv(Math.max(mfeRaw, 0)),
    mae: conv(maeRaw),
    result,
    ambiguousTouch,
  };
}

// ─── Event collection for one configuration ────────────────────────────────

export function runEventStudy(bars, config) {
  const { triggerType, triggerParams = {}, holdDays = 5, direction, stopR = 0, targetR = 0 } = config;

  const trigger = TRIGGERS[triggerType];
  if (!trigger) throw new Error('unknown trigger type: ' + triggerType);

  const closes = bars.map((b) => b.c);
  const highs = bars.map((b) => b.h);
  const lows = bars.map((b) => b.l);
  const indicators = {
    sma: {},
    atr: atr(highs, lows, closes, 14),
    rsi: rsi(closes, 14),
  };
  if (triggerType === 'sma_break') indicators.sma[triggerParams.period] = sma(closes, triggerParams.period);

  const warmup = Math.max(triggerWarmup(triggerType, triggerParams), 14);
  const dir = direction || trigger.directionHint || 'long';

  const events = [];
  let dropped = 0;
  let ambiguous = 0;

  const nonOverlap = Boolean(config.nonOverlapping);
  let blockedUntil = -1;

  for (let i = warmup; i < bars.length - 1; i++) {
    if (nonOverlap && i < blockedUntil) continue;
    if (!trigger.test(bars, i, triggerParams, indicators)) continue;

    const res = simulateEvent(bars, i, {
      holdDays,
      direction: dir,
      stopR,
      targetR,
      atrValue: indicators.atr[i] || 0,
    });
    if (res.status !== 'ok') {
      dropped++;
      continue;
    }
    if (res.ambiguousTouch) ambiguous++;
    events.push(res);
    if (nonOverlap) blockedUntil = i + 1 + holdDays;
  }

  const withRisk = events.filter((e) => e.rMultiple !== null);
  const stats = summarizeReturns(events.map((e) => e.retPct));
  stats.hitRateBasis = withRisk.length ? 'target-or-timeout-positive' : 'positive-return';
  if (withRisk.length) {
    const targetHits = withRisk.filter((e) => e.result === 'target').length;
    const stops = withRisk.filter((e) => e.result === 'stop').length;
    stats.targetHitRate = ratio(targetHits, withRisk.length);
    stats.stopRate = ratio(stops, withRisk.length);
    stats.avgRMultiple = round4(mean(withRisk.map((e) => e.rMultiple)));
    stats.medianRMultiple = round4(median(withRisk.map((e) => e.rMultiple)));
  }
  stats.mfeMedian = round4(median(events.map((e) => e.mfe)));
  stats.maeMedian = round4(median(events.map((e) => e.mae)));
  stats.ambiguousSameBarTouches = ambiguous;
  stats.sameTouchPolicy = SAME_TOUCH_POLICY;

  return {
    events,
    stats,
    droppedIncomplete: dropped,
    definition: trigger.describe(triggerParams),
    direction: dir,
    entryRule: 'next bar open after signal',
    exitRule: stopR || targetR
      ? `first touch of ${targetR || '—'}R target / ${stopR || '—'}R stop (ATR14 @ signal), else close after ${holdDays} sessions`
      : `market close ${holdDays} sessions after entry`,
  };
}

// ─── Statistics helpers ────────────────────────────────────────────────────

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function percentileSorted(s, p) {
  if (!s.length) return 0;
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

function ratio(a, b) {
  return b ? +(((a / b) * 100).toFixed(2)) : 0;
}

function round4(x) {
  return x === null || x === undefined || Number.isNaN(x) ? null : +(+x).toFixed(4);
}

// Wilson score interval (95%) for a binomial proportion.
export function wilsonInterval(successes, total, z = 1.96) {
  if (total === 0) return { lo: 0, hi: 100, note: 'no sample' };
  const p = successes / total;
  const denom = 1 + (z * z) / total;
  const centre = p + (z * z) / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return {
    lo: +(((centre - margin) / denom) * 100).toFixed(2),
    hi: +(((centre + margin) / denom) * 100).toFixed(2),
  };
}

export function summarizeReturns(rets) {
  const n = rets.length;
  if (!n) {
    return {
      sampleSize: 0,
      warning: 'No events matched. Loosen the trigger or widen the date range.',
    };
  }
  const wins = rets.filter((r) => r > 0).length;
  const sorted = [...rets].sort((a, b) => a - b);
  const win = wins / n;
  const ci = wilsonInterval(wins, n);
  const stats = {
    sampleSize: n,
    winRatePct: +(win * 100).toFixed(2),
    winRateCI95: ci,
    avgRetPct: round4(mean(rets)),
    medianRetPct: round4(median(rets)),
    stdRetPct: round4(Math.sqrt(mean(rets.map((r) => (r - mean(rets)) ** 2)))),
    p5: round4(percentileSorted(sorted, 0.05)),
    p25: round4(percentileSorted(sorted, 0.25)),
    p75: round4(percentileSorted(sorted, 0.75)),
    p95: round4(percentileSorted(sorted, 0.95)),
    expectancyPerEvent: round4(mean(rets)),
    bestPct: round4(sorted[sorted.length - 1]),
    worstPct: round4(sorted[0]),
  };
  if (n < 30) {
    stats.warning = `Sample of ${n} is small (<30). Treat every number here as anecdote, not evidence.`;
  }
  return stats;
}

// ─── Deterministic Monte Carlo (fixed-fractional growth paths) ─────────────
// Used by the Academy risk trainer. Seeded so results are reproducible.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function monteCarloPaths({ seed = 42, trials = 500, steps = 250, winProb = 0.45, winR = 2, lossR = 1, riskFraction = 1 }) {
  const rng = mulberry32(seed);
  const finals = [];
  let ruined = 0;
  for (let t = 0; t < trials; t++) {
    let equity = 100;
    let alive = true;
    for (let s = 0; s < steps; s++) {
      if (!alive) break;
      const won = rng() < winProb;
      const pnl = won ? winR * riskFraction : -lossR * riskFraction;
      equity *= 1 + pnl / 100;
      if (equity <= 25) {
        // Ruin threshold: lost 75% of starting capital.
        alive = false;
        ruined++;
      }
    }
    finals.push(equity);
  }
  finals.sort((a, b) => a - b);
  return {
    trials,
    steps,
    ruinPct: +((ruined / trials) * 100).toFixed(2),
    medianFinal: +percentileSorted(finals, 0.5).toFixed(2),
    p5Final: +percentileSorted(finals, 0.05).toFixed(2),
    p95Final: +percentileSorted(finals, 0.95).toFixed(2),
    seed,
  };
}
