// Cloudflare Pages Function: GET /api/premium-market-analyst?years=1|3|5
//
// PREMIUM-GATED AI trend analyst. Members-only per owner request: Alpaca
// historical bars for QQQ (Nasdaq-100 proxy — the tradable Nasdaq vehicle on
// the IEX free feed) over the last 1/3/5 years, deterministic trend metrics
// computed server-side, then a Workers AI narrative grounded ONLY on those
// metrics. No advice, no predictions — educational trend readout.
//
// Auth: HttpOnly premium session cookie (issued by /api/verify-premium),
// verified with the shared session lib, then checked against RESOURCE_TIERS —
// this tool is part of the Complete membership. No session at all is a 401;
// an authenticated member below the required tier is a 403 so the UI can say
// "your plan does not include this" instead of asking them to sign in again.
// This endpoint is served to the members' hub (premium-guidance.html) and to
// the research engine, both of which use cookie sessions.

import {
  resolveSigningSecret, verifySessionToken, readSessionCookie,
} from './_lib/session.js';
import { json, fetchJsonWithTimeout, checkRateLimit } from './_lib/http.js';
import { complete } from './_lib/ai.js';
import { authorizeResource } from './_lib/entitlements.js';

const RESOURCE_PATH = '/api/premium-market-analyst';
const ALLOW = { allowed: true };
const DENY_401 = { allowed: false, status: 401, body: { ok: false, error: 'A premium session is required.' } };

const SYMBOL = 'QQQ';
const FEED = 'iex';
const YEARS_ALLOWED = new Set([1, 3, 5]);

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const years = Number(url.searchParams.get('years') || 3);

  const decision = await isAuthorized(request, env);
  if (!decision.allowed) return json(decision.body, decision.status);

  if (!YEARS_ALLOWED.has(years)) {
    return json({ ok: false, error: 'years must be 1, 3, or 5.' }, 400);
  }
  if (!env.ALPACA_API_KEY || !env.ALPACA_SECRET_KEY) {
    return json({ ok: false, error: 'Market history is not configured on the server.' }, 503);
  }

  const limit = await checkRateLimit(env, request, 'market-analyst', 6);
  if (!limit.allowed) return json({ ok: false, error: 'Too many analyses in a row — give it a minute.' }, 429);

  const end = new Date();
  const start = new Date(end);
  start.setFullYear(start.getFullYear() - years);

  const fmt = (d) => d.toISOString().slice(0, 10);
  const barsUrl = 'https://data.alpaca.markets/v2/stocks/bars' +
    `?symbols=${SYMBOL}&timeframe=1Day&start=${fmt(start)}&end=${fmt(end)}` +
    `&adjustment=split&feed=${FEED}&limit=10000`;

  let bars;
  try {
    const { res, text } = await fetchJsonWithTimeout(barsUrl, 12000, {
      'APCA-API-KEY-ID': env.ALPACA_API_KEY,
      'APCA-API-SECRET-KEY': env.ALPACA_SECRET_KEY,
    });
    if (!res.ok) throw new Error('upstream status ' + res.status);
    const data = JSON.parse(text);
    bars = data && data.bars && Array.isArray(data.bars[SYMBOL]) ? data.bars[SYMBOL] : null;
    if (!bars || bars.length < 60) throw new Error('insufficient history returned');
  } catch (err) {
    return json({
      ok: false,
      error: 'History feed unavailable right now.',
      detail: String(err && err.message || err).slice(0, 120),
    }, 502);
  }

  const metrics = computeMetrics(bars);
  const dataBlock = buildDataBlock(SYMBOL, years, metrics);

  const narrative = await complete(env, {
    system: 'You are the PJ Trades premium market analyst for an EDUCATIONAL trading community.' +
      ' Analyze ONLY the metrics in the DATA block. Never give personalized financial advice,' +
      ' never tell the member to buy or sell, never predict prices with certainty.' +
      ' Structure: 1) Trend read (price vs 50/200-day averages, 12-month momentum).' +
      ' 2) Risk character (volatility, max drawdown context).' +
      ' 3) One educational takeaway about what this regime historically rewards patience-wise.' +
      ' Keep under 160 words. Mention this is QQQ as a Nasdaq-100 proxy on delayed IEX data.',
    messages: [{ role: 'user', content: 'DATA BLOCK:\n' + dataBlock }],
    maxTokens: 420,
  });

  return json({
    ok: true,
    symbol: SYMBOL,
    label: SYMBOL + ' (Nasdaq-100 proxy)',
    years,
    coverage: metrics.coverage,
    metrics: {
      totalReturnPct: metrics.totalReturnPct,
      cagrPct: metrics.cagrPct,
      maxDrawdownPct: metrics.maxDrawdownPct,
      vol30AnnualizedPct: metrics.vol30AnnPct,
      sma50: metrics.sma50,
      sma200: metrics.sma200,
      lastClose: metrics.lastClose,
      // A null average means not enough history, not "price is above it":
      // `lastClose > null` coerces to `> 0` and reported true for every
      // symbol with under 200 bars.
      aboveSma50: Number.isFinite(metrics.sma50) ? metrics.lastClose > metrics.sma50 : null,
      aboveSma200: Number.isFinite(metrics.sma200) ? metrics.lastClose > metrics.sma200 : null,
      momentum: metrics.momentum,
      from52wHighPct: metrics.from52wHighPct,
      upDayRatioPct: metrics.upDayRatioPct,
    },
    narrative,
    narrativeEngine: narrative ? 'cloudflare-workers-ai' : null,
    dataOnly: !narrative,
    source: { name: 'Alpaca Market Data (IEX)', feed: 'IEX', note: 'IEX free feed; consolidated tape may differ.' },
    disclaimer: 'Educational analysis of historical data — not financial advice. Past performance never guarantees future results.',
  }, 200);
}

// ─── Metrics (deterministic, no AI involved) ───────────────────────────────

function computeMetrics(bars) {
  const closes = bars.map((b) => Number(b.c)).filter((c) => Number.isFinite(c) && c > 0);
  const n = closes.length;
  const last = closes[n - 1];
  const first = closes[0];

  const sma = (period) => {
    if (n < period) return null;
    let sum = 0;
    for (let i = n - period; i < n; i++) sum += closes[i];
    return +(sum / period).toFixed(2);
  };

  const totalReturnPct = +(((last - first) / first) * 100).toFixed(2);
  const yearsExact = n / 252;
  const cagrPct = +(((Math.pow(last / first, 1 / yearsExact) - 1) * 100)).toFixed(2);

  let peak = closes[0];
  let maxDd = 0;
  for (const c of closes) {
    if (c > peak) peak = c;
    const dd = (c - peak) / peak;
    if (dd < maxDd) maxDd = dd;
  }

  const rets = [];
  for (let i = 1; i < n; i++) rets.push(closes[i] / closes[i - 1] - 1);
  const win = Math.min(30, rets.length);
  const recent = rets.slice(-win);
  const mean = recent.reduce((a, b) => a + b, 0) / win;
  const variance = recent.reduce((a, b) => a + (b - mean) * (b - mean), 0) / win;
  const vol30AnnPct = +(Math.sqrt(variance * 252) * 100).toFixed(2);

  const atMonthsAgo = (months) => {
    const idx = Math.max(0, n - Math.round((months / 12) * 252));
    return closes[idx];
  };
  const mom = (months) => {
    const base = atMonthsAgo(months);
    return +(((last - base) / base) * 100).toFixed(2);
  };

  const high52 = Math.max(...closes.slice(-252));
  const upDays = rets.filter((r) => r > 0).length;

  return {
    coverage: { from: bars[0].t, to: bars[n - 1].t, tradingDays: n },
    lastClose: +last.toFixed(2),
    sma50: sma(50),
    sma200: sma(200),
    totalReturnPct,
    cagrPct,
    maxDrawdownPct: +(maxDd * 100).toFixed(2),
    vol30AnnPct,
    momentum: { m1: mom(1), m3: mom(3), m6: mom(6), m12: mom(12) },
    from52wHighPct: +(((last - high52) / high52) * 100).toFixed(2),
    upDayRatioPct: +((upDays / rets.length) * 100).toFixed(1),
  };
}

function buildDataBlock(symbol, years, m) {
  return [
    `Symbol: ${symbol} (Nasdaq-100 ETF proxy), daily bars, last ${years} year(s), IEX feed.`,
    `Coverage: ${m.coverage.from} to ${m.coverage.to} (${m.coverage.tradingDays} trading days).`,
    `Last close: ${m.lastClose}; 50-day avg: ${Number.isFinite(m.sma50) ? m.sma50 : 'not enough history'}; 200-day avg: ${Number.isFinite(m.sma200) ? m.sma200 : 'not enough history'}.`,
    `Total return: ${m.totalReturnPct}%; CAGR: ${m.cagrPct}%; max drawdown: ${m.maxDrawdownPct}%.`,
    `30-day annualized volatility: ${m.vol30AnnPct}%; up-day ratio: ${m.upDayRatioPct}%.`,
    `Momentum: 1M ${m.momentum.m1}%, 3M ${m.momentum.m3}%, 6M ${m.momentum.m6}%, 12M ${m.momentum.m12}%.`,
    `Distance from 52-week high: ${m.from52wHighPct}%.`,
  ].join('\n');
}

// ─── Auth (premium session cookie only) ────────────────────────────────────

// Returns {allowed:true} or {allowed:false,status,body}. Missing signing
// secret, missing cookie and a bad signature all fail closed as 401.
async function isAuthorized(request, env) {
  const secret = resolveSigningSecret(env);
  if (!secret) return DENY_401;
  const token = readSessionCookie(request);
  if (!token) return DENY_401;
  const payload = await verifySessionToken(token, secret);
  if (!payload) return DENY_401;
  const entitlement = authorizeResource(payload, RESOURCE_PATH, env);
  if (entitlement.allowed) return ALLOW;
  return {
    allowed: false,
    status: 403,
    body: {
      ok: false,
      code: 'upgrade_required',
      error: 'Your plan does not include the premium market analyst. It is part of the Complete membership.',
      requiredTier: entitlement.required,
      heldTier: entitlement.held,
    },
  };
}
