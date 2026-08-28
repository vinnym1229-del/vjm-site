// TEMPORARY diagnostic for the Alpaca credential problem. Delete once the
// ticker is live. Gated behind an unguessable token so it is not a public
// information leak, and it never echoes key material — only lengths, a
// whitespace flag, and upstream HTTP statuses.
import { json } from './_lib/http.js';

const TOKEN = 'pjdiag-7f3a9c21';

// Reports shape only. A key's length and whether it was pasted with stray
// whitespace are the two things that actually diagnose this, and neither
// discloses the secret.
function fingerprint(v) {
  if (v === undefined) return { present: false, reason: 'undefined (not bound to this deployment)' };
  if (v === null) return { present: false, reason: 'null' };
  const s = String(v);
  if (!s) return { present: false, reason: 'empty string' };
  return {
    present: true,
    length: s.length,
    trimmedLength: s.trim().length,
    hasWhitespace: s !== s.trim(),
    hasQuotes: /^["'].*["']$/.test(s.trim()),
  };
}

async function probe(url, headers) {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    const body = await res.text();
    return { status: res.status, ok: res.ok, body: body.slice(0, 200) };
  } catch (err) {
    return { status: null, ok: false, error: String((err && err.message) || err).slice(0, 200) };
  }
}

export async function onRequestGet({ request, env }) {
  if (new URL(request.url).searchParams.get('t') !== TOKEN) {
    return json({ ok: false, error: 'Not found.' }, 404);
  }
  const key = env.ALPACA_API_KEY;
  const secret = env.ALPACA_SECRET_KEY;
  const h = { 'APCA-API-KEY-ID': String(key || '').trim(), 'APCA-API-SECRET-KEY': String(secret || '').trim() };

  return json({
    ok: true,
    keys: { ALPACA_API_KEY: fingerprint(key), ALPACA_SECRET_KEY: fingerprint(secret) },
    // Which host accepts the keys tells us paper-vs-live; whether the data
    // host accepts them tells us if it is a data-plan problem instead.
    probes: {
      liveTrading: await probe('https://api.alpaca.markets/v2/account', h),
      paperTrading: await probe('https://paper-api.alpaca.markets/v2/account', h),
      marketDataIex: await probe('https://data.alpaca.markets/v2/stocks/snapshots?symbols=SPY&feed=iex', h),
      // The exact calls the live ticker makes: full symbol list + crypto.
      tickerSymbolSet: await probe('https://data.alpaca.markets/v2/stocks/snapshots?symbols=QQQ,SPY,DIA,IWM,GLD,USO&feed=iex', h),
      cryptoBtc: await probe('https://data.alpaca.markets/v1beta3/crypto/us/snapshots?symbols=BTC/USD', h),
    },
  });
}
