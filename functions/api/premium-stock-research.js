// Cloudflare Pages Function: GET /api/premium-stock-research?symbol=TSLA
//
// PREMIUM-GATED quote snapshot. Authorization is enforced server-side via
// either the HttpOnly session cookie or a valid Bearer token (used by the
// research engine during its migration window).
//
// Returns live Alpaca IEX snapshot + tradingViewSymbol. Owner memos stay
// client-side; this endpoint only serves sourced market data.

import {
  resolveSigningSecret, verifySessionToken, readSessionCookie,
} from '../_lib/session.js';
import { json, cleanSymbol, fetchJsonWithTimeout, checkRateLimit } from './_lib/http.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const symbol = cleanSymbol(url.searchParams.get('symbol'));

  if (!symbol) return json({ ok: false, error: 'Provide a valid ticker symbol.' }, 400);

  const authorized = await isAuthorized(request, env);
  if (!authorized) return json({ ok: false, error: 'A premium session is required.' }, 401);

  if (!env.ALPACA_API_KEY || !env.ALPACA_SECRET_KEY) {
    return json({ ok: false, error: 'Live quotes are not configured on the server.' }, 503);
  }

  const limit = await checkRateLimit(env, request, 'premium-stock', 30, symbol);
  if (!limit.allowed) return json({ ok: false, error: 'Too many requests. Try again shortly.' }, 429);

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
    const snap = data && data.snapshots && data.snapshots[symbol];
    if (!snap) throw new Error('empty snapshot');

    const bar = snap.dailyBar || snap.prevDailyBar || null;
    const last = snap.latestTrade && Number(snap.latestTrade.p);
    const prevClose = snap.prevDailyBar ? Number(snap.prevDailyBar.c) : null;
    const price = Number.isFinite(last) ? last : (bar ? Number(bar.c) : null);
    if (!Number.isFinite(price)) throw new Error('no price in snapshot');

    const change = Number.isFinite(prevClose) ? price - prevClose : null;

    return json({
      ok: true,
      symbol,
      tradingViewSymbol: 'NASDAQ:' + symbol,
      source: { name: 'Alpaca Market Data (IEX)', feed: 'IEX' },
      mode: 'observed',
      precision: 'IEX-only snapshot; consolidated tape may differ slightly',
      asOf: snap.latestTrade && snap.latestTrade.t ? snap.latestTrade.t : new Date().toISOString(),
      fetchedAt: new Date().toISOString(),
      quote: {
        price,
        change,
        changePercent: Number.isFinite(change) && prevClose ? (change / prevClose) * 100 : null,
        volume: bar ? Number(bar.v) : null,
        prevClose,
        marketCap: null, // no shares-outstanding source on free tier — never fabricate
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

async function isAuthorized(request, env) {
  // 1) Session cookie (primary).
  const secret = resolveSigningSecret(env);
  if (secret) {
    const token = readSessionCookie(request);
    if (token) {
      const payload = await verifySessionToken(token, secret);
      if (payload) return true;
    }
  }
  // 2) Legacy Bearer token (research-engine compatibility until migrated).
  const auth = request.headers.get('Authorization') || '';
  if (auth.startsWith('Bearer ') && env.PREMIUM_ACCESS_CODES) {
    const legacyToken = auth.slice(7).trim();
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(env.PREMIUM_ACCESS_CODES),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const parts = legacyToken.split('.');
    if (parts.length === 2) {
      const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(parts[0]));
      const expected = btoa(String.fromCharCode(...new Uint8Array(sig)))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      let diff = 0;
      const a = encoderBytes(parts[1]);
      const b = encoderBytes(expected);
      if (a.length === b.length) {
        for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
        if (diff === 0) {
          try {
            const json = atob(parts[0].replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((parts[0].length + 3) % 4));
            const payload = JSON.parse(json);
            if (Number(payload.exp) > Date.now()) return true;
          } catch { /* fallthrough */ }
        }
      }
    }
  }
  return false;
}

function encoderBytes(str) {
  return new TextEncoder().encode(String(str));
}
