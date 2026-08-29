// Cloudflare Pages Function: GET /api/content?type=announcements|trade_reviews|prop_firms|
//   schedule|team|faqs|bundles|stats|results
//
// Public read view over owner-managed content synced from their Google Sheet.
// Non-personal → short shared cache is appropriate.

import { json, cleanSymbol, checkRateLimit } from './_lib/http.js';

const TYPES = new Set([
  'announcements', 'trade_reviews', 'prop_firms',
  'schedule', 'team', 'faqs', 'bundles', 'stats', 'results',
]);
const ORDERED_TYPES = new Set(['team', 'faqs', 'results']);

export async function onRequestGet(context) {
  // Abuse guard: public read; generous cap stops hammering without touching normal browsing
  const _rl = await checkRateLimit(context.env, context.request, 'content', 120);
  if (!_rl.allowed) return json({ ok: false, error: 'Too many requests. Wait a minute.' }, 429);
  const { request, env } = context;
  const url = new URL(request.url);
  const type = (url.searchParams.get('type') || '').toLowerCase();

  if (!TYPES.has(type)) {
    return json({ ok: false, error: 'Unknown content type.', supported: [...TYPES] }, 400);
  }

  // Prop-firm page filters by ticker-style query? No — but trade reviews can filter by ticker.
  const tickerFilter = type === 'trade_reviews' ? cleanSymbol(url.searchParams.get('ticker')) : null;

  if (!env.RESEARCH_DB) {
    return json({
      ok: false,
      error: 'Content system not connected on this deployment.',
      hint: 'Requires D1 binding RESEARCH_DB plus a scheduled /api/content-sync run.',
    }, 503);
  }

  try {
    // The ticker filter used to run in JS after SQL had already truncated to
    // 60 rows by position, so once more than 60 reviews existed an older
    // ticker returned count:0 even though its rows were in the table. Push
    // the match into SQL (json_extract keeps it parameterized) so the LIMIT
    // applies to matching rows.
    const stmt = tickerFilter
      ? env.RESEARCH_DB.prepare(
        "SELECT payload, source_updated_at FROM site_content WHERE content_type = ?1"
        + " AND json_extract(payload, '$.ticker') = ?2 ORDER BY position LIMIT 60"
      ).bind(type, tickerFilter)
      : env.RESEARCH_DB.prepare(
        'SELECT payload, source_updated_at FROM site_content WHERE content_type = ?1 ORDER BY position LIMIT 60'
      ).bind(type);
    const { results } = await stmt.all();
    const items = (results || [])
      .map((r) => {
        try { return JSON.parse(r.payload); } catch { return null; }
      })
      .filter(Boolean)
      .filter((item) => !tickerFilter || item.ticker === tickerFilter);

    // Pinned announcements first.
    if (type === 'announcements') {
      items.sort((a, b) => (b.pinned || 0) - (a.pinned || 0));
    }
    if (ORDERED_TYPES.has(type)) {
      items.sort((a, b) => (a.order || 0) - (b.order || 0));
    }

    return json({
      ok: true,
      type,
      count: items.length,
      items,
      note: 'Owner-managed content. Trade reviews are examples, not recommendations; results vary and are not typical.',
      fetchedAt: new Date().toISOString(),
    }, 200, { 'Cache-Control': 'public, max-age=60' });
  } catch {
    return json({ ok: false, error: 'Content lookup failed temporarily.' }, 502);
  }
}
