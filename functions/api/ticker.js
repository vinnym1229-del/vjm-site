// Cloudflare Pages Function: GET /api/ticker
//
// Live tape data for the homepage ticker. Equities/ETFs come from Alpaca's
// IEX feed (real-time on the free tier — unlike the anonymous TradingView
// embed, which serves delayed data with a "D" badge and cannot be upgraded
// by a personal TradingView subscription). BTC comes from Alpaca's crypto
// API. GLD/USO stand in for gold/oil since no free real-time commodities
// feed exists.
//
// The front-end (assets/live-ticker.js) treats this as progressive
// enhancement: when this endpoint has no data, the TradingView tape stays.
// Responds 200 with { ok:false, pending:true } when Alpaca isn't configured
// so an unconfigured deployment doesn't log console errors on every visit.
//
// Env: ALPACA_API_KEY, ALPACA_SECRET_KEY.

import { json } from './_lib/http.js';
import { alpacaConfigured, snapshots, summarizeSnapshot } from './_lib/alpaca.js';

const EQUITIES = [
  ['QQQ', 'NQ · QQQ'],
  ['SPY', 'ES · SPY'],
  ['DIA', 'YM · DIA'],
  ['IWM', 'RTY · IWM'],
  ['GLD', 'GOLD · GLD'],
  ['USO', 'OIL · USO'],
];

export async function onRequestGet(context) {
  const { env } = context;
  if (!alpacaConfigured(env)) {
    return json({ ok: false, pending: true, error: 'Live ticker not configured.' }, 200);
  }
  try {
    const snaps = await snapshots(env, EQUITIES.map((e) => e[0]));
    const items = [];
    for (const [sym, label] of EQUITIES) {
      const s = summarizeSnapshot(sym, snaps[sym]);
      if (s) items.push({ symbol: s.symbol, label, price: s.price, changePct: s.changePct, asOf: s.asOf });
    }
    const btc = await cryptoBtc(env);
    if (btc) items.push(btc);
    if (items.length < 4) throw new Error('insufficient data');
    return new Response(
      JSON.stringify({ ok: true, items, asOf: new Date().toISOString(), feed: 'iex' }),
      {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          // Shared edge cache absorbs polling: many visitors, one upstream
          // call per 10s window.
          'Cache-Control': 'public, max-age=10, s-maxage=10',
        },
      }
    );
  } catch {
    return json({ ok: false, error: 'Ticker data unavailable.' }, 200);
  }
}

async function cryptoBtc(env) {
  try {
    const res = await fetch('https://data.alpaca.markets/v1beta3/crypto/us/snapshots?symbols=BTC/USD', {
      headers: {
        'APCA-API-KEY-ID': env.ALPACA_API_KEY,
        'APCA-API-SECRET-KEY': env.ALPACA_SECRET_KEY,
      },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const snap = data.snapshots && data.snapshots['BTC/USD'];
    const last = snap && snap.latestTrade && Number(snap.latestTrade.p);
    if (!Number.isFinite(last)) return null;
    const prev = snap.prevDailyBar ? Number(snap.prevDailyBar.c) : null;
    return {
      symbol: 'BTCUSD',
      label: 'BTC',
      price: +last.toFixed(0),
      changePct: Number.isFinite(prev) && prev ? +(((last - prev) / prev) * 100).toFixed(2) : null,
      asOf: snap.latestTrade.t || null,
    };
  } catch {
    return null;
  }
}
