// Shared Alpaca accessors used by the assistant and market brief.
// Keys stay server-side; every result carries feed + asOf labeling.

const DATA_BASE = 'https://data.alpaca.markets';

function authHeaders(env) {
  return {
    'APCA-API-KEY-ID': env.ALPACA_API_KEY,
    'APCA-API-SECRET-KEY': env.ALPACA_SECRET_KEY,
  };
}

export function alpacaConfigured(env) {
  return Boolean(env.ALPACA_API_KEY && env.ALPACA_SECRET_KEY);
}

async function getJson(env, path, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(DATA_BASE + path, { headers: authHeaders(env), signal: controller.signal });
    if (!res.ok) throw new Error('alpaca status ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Snapshot map for a small symbol list. feed=iex works on the free tier.
export async function snapshots(env, symbols) {
  const list = symbols.map((s) => encodeURIComponent(s)).join(',');
  const data = await getJson(env, `/v2/stocks/snapshots?symbols=${list}&feed=iex`);
  return data.snapshots || {};
}

export function summarizeSnapshot(sym, snap) {
  if (!snap) return null;
  const last = snap.latestTrade && Number(snap.latestTrade.p);
  const prevClose = snap.prevDailyBar ? Number(snap.prevDailyBar.c) : null;
  const dayBar = snap.dailyBar || snap.prevDailyBar || null;
  if (!Number.isFinite(last)) return null;
  const change = Number.isFinite(prevClose) ? last - prevClose : null;
  return {
    symbol: sym,
    price: +last.toFixed(2),
    prevClose: prevClose === null ? null : +prevClose.toFixed(2),
    changePct: change !== null && prevClose ? +(((change / prevClose) * 100)).toFixed(2) : null,
    dayVolume: dayBar ? Number(dayBar.v) : null,
    asOf: snap.latestTrade && snap.latestTrade.t ? snap.latestTrade.t : null,
    feed: 'iex',
  };
}

// Official movers screener; falls back to null so callers label honestly.
export async function movers(env) {
  try {
    const data = await getJson(env, '/v1beta1/screener/stocks/movers?market=stocks');
    return {
      gainers: (data.gainers || []).slice(0, 8).map((m) => ({
        symbol: m.symbol, changePct: m.price_change_percent !== undefined ? +(Number(m.price_change_percent)).toFixed(2) : null, price: m.price,
      })),
      losers: (data.losers || []).slice(0, 8).map((m) => ({
        symbol: m.symbol, changePct: m.price_change_percent !== undefined ? +(Number(m.price_change_percent)).toFixed(2) : null, price: m.price,
      })),
      source: 'Alpaca market screener',
    };
  } catch {
    return null;
  }
}

// Computed fallback movers over a fixed universe (labeled as such).
export async function computedMovers(env, universe) {
  try {
    const snaps = await snapshots(env, universe);
    const rows = universe
      .map((s) => summarizeSnapshot(s, snaps[s]))
      .filter((r) => r && r.changePct !== null)
      .sort((a, b) => b.changePct - a.changePct);
    return {
      gainers: rows.slice(0, 8),
      losers: rows.slice(-8).reverse(),
      source: `computed from ${universe.length}-symbol IEX snapshot universe`,
    };
  } catch {
    return null;
  }
}
