// Cloudflare Pages Function: POST /api/whop-webhook
//
// Whop → website entitlement automation.
//   1. Verifies HMAC-SHA256 signature over the RAW body (x-whop-signature)
//      and freshness of x-whop-timestamp (5-minute window).
//   2. Idempotent per event id (webhook_events table).
//   3. On grant: generates VJM-XXXX-XXXX access code, stores ONLY its SHA-256
//      hash + last4, marks pending delivery.
//   4. Delivery: posts the code to the private DISCORD_WHOP_CODES webhook
//      (owner-only channel) when configured; otherwise stays pending for the
//      owner to send manually. Raw codes are never persisted or emailed.
//   5. On revoke: flips matching member's code status to 'revoked' by
//      whop_member_id so the next bridge sync can deactivate it.
//
// Env: WHOP_WEBHOOK_SECRET (required), RESEARCH_DB (required),
//      DISCORD_WHOP_CODES_WEBHOOK (optional delivery channel).

import { json } from './_lib/http.js';
import { normalizeWhopEvent, generateAccessCodeShape, isValidGeneratedCode, timingSafeHexEqual } from './_lib/integrations-core.js';
import { postEmbed } from './_lib/discord.js';

const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.WHOP_WEBHOOK_SECRET) return json({ ok: false }, 503);
  if (!env.RESEARCH_DB) return json({ ok: false }, 503);

  const raw = await request.text();
  if (raw.length > 65536) return json({ ok: false }, 413);

  // ── Signature + timestamp verification ──────────────────────────────────
  const sigHeader = request.headers.get('x-whop-signature') || '';
  const tsHeader = request.headers.get('x-whop-timestamp') || '';
  if (!sigHeader || !tsHeader) return json({ ok: false, error: 'missing signature' }, 401);

  const ts = Number(tsHeader);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts * 1000) > TIMESTAMP_TOLERANCE_MS) {
    return json({ ok: false, error: 'stale timestamp' }, 401);
  }

  const expected = await hmacHex(env.WHOP_WEBHOOK_SECRET, `${tsHeader}.${raw}`);
  if (!timingSafeHexEqual(expected, sigHeader)) {
    return json({ ok: false, error: 'invalid signature' }, 401);
  }

  let body;
  try { body = JSON.parse(raw); } catch { return json({ ok: false, error: 'bad json' }, 400); }

  const evt = normalizeWhopEvent(body);
  if (!evt || evt.action === 'ignore' || !evt.eventId) return json({ ok: true, ignored: true });

  // ── Idempotency ─────────────────────────────────────────────────────────
  const seen = await env.RESEARCH_DB.prepare(
    'SELECT event_id FROM webhook_events WHERE provider=?1 AND event_id=?2'
  ).bind('whop', evt.eventId).first();
  if (seen) return json({ ok: true, duplicate: true });

  if (evt.action === 'grant') {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    let code = generateAccessCodeShape(bytes);
    let guard = 0;
    while (!isValidGeneratedCode(code) && guard++ < 5) {
      crypto.getRandomValues(bytes);
      code = generateAccessCodeShape(bytes);
    }
    const hash = await sha256Hex(code);

    await env.RESEARCH_DB.prepare(
      `INSERT INTO whop_codes (code_hash, code_last4, whop_event_id, whop_member_id, whop_product, status)
       VALUES (?1, ?2, ?3, ?4, ?5, 'pending')
       ON CONFLICT(code_hash) DO NOTHING`
    ).bind(hash, code.slice(-4), evt.eventId, evt.memberId, evt.productId).run();

    await env.RESEARCH_DB.prepare(
      "INSERT OR IGNORE INTO webhook_events (provider, event_id, note) VALUES ('whop', ?1, ?2)"
    ).bind(evt.eventId, 'grant:' + (evt.memberId || '?')).run();

    const hook = env.DISCORD_WHOP_CODES_WEBHOOK;
    let delivered = false;
    if (hook) {
      delivered = await postEmbed(hook, {
        title: 'New Whop purchase → premium code ready',
        description:
          `Member: \`${evt.memberId || 'unknown'}\`\n` +
          `Product: \`${evt.productId || 'unknown'}\`\n` +
          `Code: \`${code}\`\n\n` +
          `Deliver to the customer, then they sign in at /premium-guidance. ` +
          `Add the same code+status=Active to the Member sheet so the bridge recognizes it.`,
        fields: [{ name: 'Type', value: evt.type }],
      });
      if (delivered) {
        await env.RESEARCH_DB.prepare(
          "UPDATE whop_codes SET status='delivered' WHERE code_hash=?1"
        ).bind(hash).run();
      }
    }
    return json({ ok: true, action: 'grant', delivered });
  }

  if (evt.action === 'revoke') {
    await env.RESEARCH_DB.prepare(
      "UPDATE whop_codes SET status='revoked' WHERE whop_member_id=?1 AND status!='revoked'"
    ).bind(evt.memberId).run();
    await env.RESEARCH_DB.prepare(
      "INSERT OR IGNORE INTO webhook_events (provider, event_id, note) VALUES ('whop', ?1, 'revoke')"
    ).bind(evt.eventId).run();
    return json({ ok: true, action: 'revoke' });
  }

  return json({ ok: true, ignored: true });
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(s) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
