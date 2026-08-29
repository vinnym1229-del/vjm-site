// Cloudflare Pages Function: GET /api/forex-calendar?currency=USD&impact=major
//
// Economic calendar sourced from the public weekly ForexFactory JSON feed
// (nfs.faireconomy.media). Cached ~10 minutes. On upstream failure this
// endpoint returns an explicit unavailable state — never placeholder events.
//
// Response envelope:
// { ok, source, fetchedAt, asOf, cached, events: [{title,currency,date,
//   impact,forecast,previous,actual}], notice? }

import { checkRateLimit } from './_lib/http.js';

const FEED_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const ALLOWED_CURRENCIES = new Set(['USD', 'ALL']);
const MAX_EVENTS = 120;


export async function onRequestGet(context) {
  const { request, env } = context;
  // Abuse guard: unauthenticated route that proxies a third-party feed.
  const rl = await checkRateLimit(env, request, 'forex-cal', 30);
  if (!rl.allowed) return json({ ok: false, error: 'Too many requests. Wait a minute.' }, 429);
  const url = new URL(request.url);
  let currency = (url.searchParams.get('currency') || 'USD').toUpperCase();
  const impact = (url.searchParams.get('impact') || 'major').toLowerCase();

  if (!ALLOWED_CURRENCIES.has(currency)) currency = 'USD'; // unsupported values fall back to USD
  if (!['major', 'high', 'medium'].includes(impact)) {
    return json({ ok: false, error: 'Unsupported impact filter.' }, 400);
  }

  try {
    const res = await fetch(FEED_URL, {
      // faireconomy 429s bare Workers fetches; a browser-ish UA gets served.
      // Successes cache for 30 min so one good fetch rides out upstream
      // throttling windows (the feed is a weekly calendar — staleness is cheap).
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PJTradesBot/1.0)', Accept: 'application/json' },
      cf: { cacheTtl: 1800, cacheEverything: true },
      signal: AbortSignal.timeout(9000),
    });
    if (!res.ok) throw new Error('upstream status ' + res.status);
    const rows = await res.json();
    if (!Array.isArray(rows)) throw new Error('unexpected feed shape');

    const events = rows
      .map((e) => normalizeEvent(e))
      .filter(Boolean)
      .filter((e) => e.currency === 'USD' || currency === 'ALL')
      .filter((e) => impactClass(e.impact) === 'high' || (impact === 'medium' && impactClass(e.impact) === 'medium'))
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .slice(0, MAX_EVENTS);

    return json({
      ok: true,
      source: { name: 'ForexFactory weekly calendar (faireconomy.media)', url: 'https://www.forexfactory.com/calendar' },
      mode: 'observed',
      fetchedAt: new Date().toISOString(),
      cached: false,
      count: events.length,
      events,
      notice: 'Times shown in ET on the site. Actual values appear only after release.',
    });
  } catch (err) {
    return json({
      ok: false,
      error: 'Calendar feed is temporarily unavailable.',
      source: { name: 'ForexFactory weekly calendar (faireconomy.media)' },
      fetchedAt: new Date().toISOString(),
      detail: String(err && err.message || err).slice(0, 160),
    }, 502);
  }
}

function normalizeEvent(e) {
  if (!e || !e.title || !e.date) return null;
  const when = new Date(e.date);
  if (Number.isNaN(when.getTime())) return null;
  return {
    title: String(e.title).slice(0, 160),
    currency: String(e.country || e.currency || '').toUpperCase().slice(0, 4),
    date: when.toISOString(),
    impact: String(e.impact || '').slice(0, 24),
    forecast: e.forecast ? String(e.forecast).slice(0, 32) : '',
    previous: e.previous ? String(e.previous).slice(0, 32) : '',
    actual: e.actual ? String(e.actual).slice(0, 32) : '',
  };
}

function impactClass(v) {
  const s = String(v || '').toLowerCase();
  if (s.includes('high')) return 'high';
  if (s.includes('medium')) return 'medium';
  if (s.includes('low')) return 'low';
  return '';
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
