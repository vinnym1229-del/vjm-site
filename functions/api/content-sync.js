// Cloudflare Pages Function: /api/content-sync
//
// POST (X-Research-Cron only): pulls the owner's content tables from the
// authenticated Apps Script content bridge, sanitizes + upserts into D1
// `site_content`, and forwards NEW announcements to the Discord announcements
// webhook when CONTENT_DISCORD_DRYRUN is not "true".
//
// Owner workflow: edit Google Sheet tabs (announcements / trade_reviews /
// prop_firms) → this sync runs hourly via GitHub Actions (or manual dispatch)
// → website + Discord update themselves. No code edits, no AI needed.

import { json, checkRateLimit } from './_lib/http.js';
import { timingSafeEqual } from './_lib/session.js';
import { sanitizeContentRow, CONTENT_TYPES } from './_lib/integrations-core.js';
import { postEmbed } from './_lib/discord.js';

const MAX_ROWS_PER_TYPE = 200;

export async function onRequestPost(context) {
  // Secret-gated, but without a limit the shared secret is brute-forceable.
  const _rl = await checkRateLimit(context.env, context.request, 'content-sync', 20);
  if (!_rl.allowed) return json({ ok: false, error: 'Too many requests. Wait a minute.' }, 429);
  const { request, env } = context;
  const cron = request.headers.get('X-Research-Cron') || '';
  // Constant-time compare: research-engine already does this for the same
  // header; a plain !== here leaked a timing oracle on the shared secret.
  if (!env.RESEARCH_CRON_SECRET || !timingSafeEqual(cron, env.RESEARCH_CRON_SECRET)) {
    return json({ ok: false, error: 'Unauthorized.' }, 401);
  }
  if (!env.CONTENT_BRIDGE_URL || !env.CONTENT_BRIDGE_SECRET) {
    return json({ ok: false, error: 'CONTENT_BRIDGE_URL / CONTENT_BRIDGE_SECRET not configured.' }, 503);
  }
  if (!env.RESEARCH_DB) {
    return json({ ok: false, error: 'D1 binding RESEARCH_DB required for content storage.' }, 503);
  }

  let bridgeData;
  try {
    bridgeData = await fetchContentBridge(env);
  } catch (err) {
    return json({ ok: false, error: 'Content bridge unreachable.' , detail: String(err && err.message || err).slice(0,120) }, 502);
  }

  const summary = {};
  const newAnnouncements = [];

  for (const type of CONTENT_TYPES) {
    const rows = Array.isArray(bridgeData[type]) ? bridgeData[type].slice(0, MAX_ROWS_PER_TYPE) : [];
    let upserted = 0;
    let skipped = 0;
    for (let i = 0; i < rows.length; i++) {
      const clean = sanitizeContentRow(type, rows[i]);
      if (!clean) { skipped++; continue; }
      try {
        await env.RESEARCH_DB.prepare(
          `INSERT INTO site_content (content_type, external_id, position, payload, source_updated_at, synced_at)
           VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))
           ON CONFLICT(content_type, external_id) DO UPDATE SET
             position=?3, payload=?4, source_updated_at=?5, synced_at=datetime('now')`
        ).bind(type, clean.id, rows.length - i, JSON.stringify(clean), clean.createdAt || clean.tradedAt || null).run();
        upserted++;
        if (type === 'announcements' && clean.id) newAnnouncements.push(clean);
      } catch { skipped++; }
    }
    summary[type] = { received: rows.length, upserted, skipped };
  }

  // Announcements already forwarded are recorded in webhook_events for idempotency.
  let discordPosted = 0;
  const dryRun = String(env.CONTENT_DISCORD_DRYRUN ?? 'true').toLowerCase() !== 'false';
  if (env.DISCORD_ANNOUNCEMENTS_WEBHOOK && !dryRun) {
    // Cap the number POSTED, not the number considered: newAnnouncements
    // holds every upserted row, so slicing candidates meant a genuinely new
    // announcement past index 9 was silently never posted once the sheet
    // held more than ten rows.
    for (const ann of newAnnouncements) {
      if (discordPosted >= 10) break;
      const already = await env.RESEARCH_DB.prepare(
        'SELECT event_id FROM webhook_events WHERE provider=?1 AND event_id=?2'
      ).bind('content_announcement', ann.id).first();
      if (already) continue;
      const ok = await postEmbed(env.DISCORD_ANNOUNCEMENTS_WEBHOOK, {
        title: ann.title || 'Announcement',
        description: [ann.body, ann.link ? `\nLink: <${ann.link}>` : ''].filter(Boolean).join('\n'),
      });
      if (ok) {
        discordPosted++;
        await env.RESEARCH_DB.prepare(
          "INSERT OR IGNORE INTO webhook_events (provider, event_id, note) VALUES ('content_announcement', ?1, 'posted')"
        ).bind(ann.id).run();
      }
    }
  }

  return json({
    ok: true,
    syncedAt: new Date().toISOString(),
    summary,
    discord: {
      posted: discordPosted,
      dryRun,
      configured: Boolean(env.DISCORD_ANNOUNCEMENTS_WEBHOOK),
    },
  });
}

// Same HMAC protocol as the member bridge (timestamp\nnonce\npayload).
async function fetchContentBridge(env) {
  const timestamp = Date.now();
  const nonce = crypto.randomUUID();
  const bodyJson = JSON.stringify({ action: 'all' });
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(String(env.CONTENT_BRIDGE_SECRET)),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}\n${nonce}\n${bodyJson}`));
  const mac = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');

  const res = await fetch(String(env.CONTENT_BRIDGE_URL), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ timestamp, nonce, payload: bodyJson, mac }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error('bridge status ' + res.status);
  const data = await res.json();
  // Apps Script Web Apps cannot return a real HTTP status from
  // ContentService — every doPost() response comes back 200 regardless of
  // what the script intended, including "unauthorized" and "not configured".
  // res.ok is therefore true even on a rejection, so the bridge's own `ok`
  // field is the only signal that exists. Surfacing data.error here (rather
  // than folding it into the generic shape-mismatch branch below) is what
  // makes "the HMAC didn't verify" distinguishable from "the bridge sent
  // something that isn't even JSON we recognize" — those need different fixes
  // and were previously indistinguishable from this side.
  if (data && data.ok === false) {
    throw new Error('bridge rejected the request: ' + (data.error || 'unknown reason'));
  }
  if (!data || data.ok !== true || typeof data.content !== 'object') {
    throw new Error('bridge returned unexpected shape');
  }
  return data.content;
}
