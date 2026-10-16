// Cloudflare Pages Function: GET /api/stock-research?symbol=TSLA
//
// Basic quote snapshot via Alpaca (server-side keys only). Free-tier reality:
// realtime quote comes from the IEX feed; SIP aggregates are delayed.
// Every response carries feed + asOf so the UI can label freshness honestly.

import { json, cleanSymbol, fetchJsonWithTimeout, checkRateLimit } from './_lib/http.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const symbol = cleanSymbol(url.searchParams.get('symbol'));

  if (!symbol) {
    return json({ ok: false, error: 'Provide a valid ticker symbol.' }, 400);
  }

  if (!env.ALPACA_API_KEY || !env.ALPACA_SECRET_KEY) {
    return json({
      ok: false,
      error: 'Live quotes are not configured on the server.',
      hint: 'Market data requires ALPACA_API_KEY / ALPACA_SECRET_KEY in Cloudflare Pages secrets.',
    }, 503);
  }

  // No per-symbol identifier here on purpose: this route costs a real Alpaca
  // call per request, and keying the bucket by the symbol in the query string
  // -- as this call used to -- let an attacker cycle through a new fake
  // symbol (cleanSymbol() accepts any 1-10 char [A-Z0-9.^-] string) on every
  // request, each one starting its own fresh, unthrottled bucket, for
  // unbounded request volume against the shared Alpaca key from one IP.
  // Every sibling route that also costs an upstream call (yahoo-news.js,
  // which takes the same ?symbol= param; ticker.js; research-engine.js;
  // market-brief.js) already caps per-IP only, with no identifier; this call
  // was the outlier.
  const limit = await checkRateLimit(env, request, 'stock-research', 30);
  if (!limit.allowed) {
    return json({ ok: false, error: 'Too many requests. Try again shortly.' }, 429);
  }

  try {
    const { res, text } = await fetchJsonWithTimeout(
      `https://data.alpaca.markets/v2/stocks/snapshots?symbols=${encodeURIComponent(symbol)}&feed=iex`,
      8000,
      {
        'APCA-API-KEY-ID': env.ALPACA_API_KEY,
        'APCA-API-SECRET-KEY': env.ALPACA_SECRET_KEY,
      }
    );
    if (!res.ok) throw new Error('upstream status ' + res.status);
    const data = JSON.parse(text);
    // /v2/stocks/snapshots returns the symbol->snapshot map at the TOP
    // LEVEL, not wrapped in a "snapshots" key (see _lib/alpaca.js, where
    // this same bug was already fixed once). Accept either shape so a
    // future upstream change cannot silently empty this out again.
    const snapMap = (data && data.snapshots) ? data.snapshots : data;
    const snap = snapMap && snapMap[symbol];
    if (!snap) throw new Error('empty snapshot');

    const bar = snap.dailyBar || snap.prevDailyBar || null;
    const last = snap.latestTrade && Number(snap.latestTrade.p);
    const prevClose = snap.prevDailyBar ? Number(snap.prevDailyBar.c) : null;
    const price = Number.isFinite(last) ? last : (bar ? Number(bar.c) : null);
    if (!Number.isFinite(price)) throw new Error('no price in snapshot');

    const change = Number.isFinite(prevClose) ? price - prevClose : null;
    const changePercent = Number.isFinite(change) && prevClose ? (change / prevClose) * 100 : null;

    return json({
      ok: true,
      symbol,
      source: { name: 'Alpaca Market Data (IEX)', feed: 'IEX' },
      mode: 'observed',
      precision: 'IEX-only snapshot; consolidated tape may differ slightly',
      asOf: snap.latestTrade && snap.latestTrade.t ? snap.latestTrade.t : new Date().toISOString(),
      fetchedAt: new Date().toISOString(),
      quote: {
        price,
        change,
        changePercent,
        volume: bar ? Number(bar.v) : null,
        vwap: snap.dailyBar && Number.isFinite(Number(snap.dailyBar.vw)) ? Number(snap.dailyBar.vw) : null,
        prevClose,
        // marketCap intentionally omitted: no shares-outstanding source on
        // the free tier — showing a stale number would be fabrication.
        marketCap: null,
      },
    });
  } catch (err) {
    return json({
      ok: false,
      error: 'Quote is temporarily unavailable.',
      symbol,
      detail: String(err && err.message || err).slice(0, 160),
    }, 502);
  }
}
