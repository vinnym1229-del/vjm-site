// Cloudflare Pages Function: POST /api/whop-webhook
//
// Whop → website entitlement automation.
//   1. Verifies HMAC-SHA256 signature over the RAW body (x-whop-signature)
//      and freshness of x-whop-timestamp (5-minute window).
//   2. Idempotent per event id (webhook_events table).
//   3. On grant: PROVISIONS ACCESS IMMEDIATELY. It generates a VJM-XXXX-XXXX
//      access code, stores ONLY its SHA-256 hash + last4, and writes the row
//      as status='active' with its member_ref, tier and expiry (migration
//      0006). Access is live the moment this row lands — it does not wait for
//      anybody to copy a code into the owner's Google Sheet. Sign-in reads
//      this row directly (verify-premium.js by code hash, auth-google.js by
//      email hash).
//   4. Delivery: posts the plaintext code to the private DISCORD_WHOP_CODES
//      webhook (owner-only channel). This is now a NOTIFICATION, not the gate
//      on entitlement — see the delivery block below for the one case where a
//      failed post still has to roll the grant back.
//   5. On revoke: flips matching member's rows to 'revoked' AND bumps their
//      session_epoch, which invalidates every cookie already issued to them.
//      Before migration 0006 a revoke only touched the row, so a signed-in
//      member kept full access for up to 30 more days.
//   6. Tier: the grant's product/plan is resolved to an entitlement tier
//      (see _lib/entitlements.js) and persisted on the row (migration 0005),
//      so the session minted later carries what was actually bought. A
//      product that resolves to NO tier grants nothing at all — see below.
//
// Env: WHOP_WEBHOOK_SECRET (required), RESEARCH_DB (required),
//      DISCORD_WHOP_CODES_WEBHOOK (optional delivery channel).

import { json } from './_lib/http.js';
import { normalizeWhopEvent, generateAccessCodeShape, isValidGeneratedCode, timingSafeHexEqual } from './_lib/integrations-core.js';
import { postEmbed } from './_lib/discord.js';
import { resolveTier } from './_lib/entitlements.js';
import { memberRefFromCodeHash } from './_lib/session.js';

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
  // Claim the event by INSERTing rather than SELECT-then-INSERT: two
  // concurrent deliveries of one event both passed the old check and minted
  // two codes for one purchase. INSERT OR IGNORE is atomic, so exactly one
  // request sees changes === 1 and proceeds.
  const claim = await env.RESEARCH_DB.prepare(
    "INSERT OR IGNORE INTO webhook_events (provider, event_id, note) VALUES ('whop', ?1, ?2)"
  ).bind(evt.eventId, 'claimed:' + evt.action).run();
  if (!claim || !claim.meta || claim.meta.changes !== 1) {
    return json({ ok: true, duplicate: true });
  }
  // Release the claim so Whop's retry can run this event again.
  const releaseClaim = async () => {
    await env.RESEARCH_DB.prepare(
      'DELETE FROM webhook_events WHERE provider=?1 AND event_id=?2'
    ).bind('whop', evt.eventId).run().catch(() => {});
  };

  if (evt.action === 'grant') {
    // An unrecognized product must never become a course credential. A
    // cheaper item, a separately sold indicator, or a product from another
    // storefront can reach this endpoint with a perfectly valid signature;
    // granting on it would hand out the paid library for the wrong price.
    //
    // Ack with 2xx anyway: a non-2xx makes Whop retry this event forever,
    // and no retry will ever change the answer. Record why on the claimed
    // webhook_events row (which stays claimed, so retries are duplicates)
    // and leave no code row, no Discord message, no credential behind.
    const { tier, reason } = resolveTier(env, { product: evt.productId, plan: evt.planId });
    if (!tier) {
      await env.RESEARCH_DB.prepare(
        "UPDATE webhook_events SET note=?2 WHERE provider='whop' AND event_id=?1"
      ).bind(evt.eventId, 'no_grant:' + reason + ':' + (evt.productId || evt.planId || 'no_product')).run().catch(() => {});
      console.error('whop-webhook: ' + evt.eventId + ' not granted (' + reason + '): product=' + (evt.productId || '?'));
      return json({ ok: true, action: 'ignored', granted: false, reason });
    }

    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    let code = generateAccessCodeShape(bytes);
    let guard = 0;
    while (!isValidGeneratedCode(code) && guard++ < 5) {
      crypto.getRandomValues(bytes);
      code = generateAccessCodeShape(bytes);
    }
    const hash = await sha256Hex(code);
    const emailHash = evt.email ? await sha256Hex(evt.email) : null;

    // Provision in ONE transactional write: status, tier, expiry, member_ref
    // and session epoch all land together, so there is no window in which the
    // site knows a member exists but not what they bought or until when.
    // status='active' from the start — the customer paid; access is theirs
    // now, not once a human has done something.
    await env.RESEARCH_DB.prepare(
      `INSERT INTO whop_codes (code_hash, code_last4, whop_event_id, whop_member_id, whop_product, status, email_hash, plan_name, expires_at, amount_paid_cents, currency, tier, member_ref, session_epoch, provisioned_at, source)
       VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, ?7, ?8, ?9, ?10, ?11, ?12, 1, ?13, 'whop')
       ON CONFLICT(code_hash) DO NOTHING`
    ).bind(
      hash, code.slice(-4), evt.eventId, evt.memberId, evt.productId,
      emailHash, evt.planName, evt.expiresAt, evt.amountPaidCents, evt.currency, tier,
      memberRefFromCodeHash(hash), new Date().toISOString()
    ).run();

    // The row above is what grants access. The Discord post below only
    // carries the PLAINTEXT code, which exists solely in this local variable
    // (the table holds a hash), and it is one of two ways a member can get
    // in — the other is Google sign-in, which matches on email_hash and needs
    // no code at all.
    //
    // So an undelivered code is fatal ONLY when we have no email on file: in
    // that case the code is the member's single route in and it is now
    // unrecoverable, so roll the whole grant back and release the claim, and
    // Whop's retry mints a fresh, deliverable one. When we DO have an email,
    // the member can already sign in with Google, so destroying their live
    // entitlement over a failed Discord post would be the worse outcome —
    // keep the row, ack, and flag the delivery on the event note.
    const hook = env.DISCORD_WHOP_CODES_WEBHOOK;
    let delivered = false;
    if (hook) {
      delivered = await postEmbed(hook, {
        title: 'New Whop purchase → access provisioned',
        description:
          `Member: \`${evt.memberId || 'unknown'}\`\n` +
          `Product: \`${evt.productId || 'unknown'}\`\n` +
          `Code: \`${code}\`\n\n` +
          `Access is ALREADY live in the database — send this code to the ` +
          `customer so they can sign in at /premium-guidance. No Google Sheet ` +
          `edit is required; the sheet is a legacy fallback only.`,
        fields: [{ name: 'Type', value: evt.type }, { name: 'Tier', value: tier }],
      });
    } else {
      console.error('whop-webhook: DISCORD_WHOP_CODES_WEBHOOK unset; cannot deliver code for ' + evt.eventId);
    }

    if (!delivered && !emailHash) {
      await env.RESEARCH_DB.prepare('DELETE FROM whop_codes WHERE code_hash=?1').bind(hash).run().catch(() => {});
      await releaseClaim();
      console.error('whop-webhook: undeliverable grant for ' + evt.eventId + ' with no email fallback; released for retry');
      return json({
        ok: false,
        error: hook ? 'Code delivery failed; will retry.' : 'Code delivery channel is not configured.',
      }, 503);
    }

    await env.RESEARCH_DB.prepare(
      "UPDATE webhook_events SET note=?2 WHERE provider='whop' AND event_id=?1"
    ).bind(
      evt.eventId,
      'grant:' + tier + ':' + (evt.memberId || '?') + (delivered ? ':delivered' : ':undelivered_email_fallback')
    ).run().catch(() => {});
    if (!delivered) {
      console.error('whop-webhook: code for ' + evt.eventId + ' undelivered; member must use Google sign-in');
    }
    return json({ ok: true, action: 'grant', delivered, provisioned: true, tier });
  }

  if (evt.action === 'revoke') {
    // A null memberId matches zero rows, so access would silently stay live
    // while the event was recorded as handled — fail-open on revocation.
    if (!evt.memberId) {
      await releaseClaim();
      console.error('whop-webhook: revoke event ' + evt.eventId + ' carried no member id');
      return json({ ok: false, error: 'Revoke event missing member id.' }, 422);
    }
    // Bumping session_epoch is what makes this revocation reach a member who
    // is ALREADY signed in: every cookie they hold was signed with the old
    // epoch, and _lib/session.js refuses any session whose `sv` is behind the
    // row. Without it the status flip only affected the NEXT sign-in, leaving
    // a canceled customer with up to 30 days of paid access.
    const res = await env.RESEARCH_DB.prepare(
      `UPDATE whop_codes
          SET status='revoked',
              revoked_at=?2,
              session_epoch = session_epoch + 1
        WHERE whop_member_id=?1 AND status!='revoked'`
    ).bind(evt.memberId, new Date().toISOString()).run();
    await env.RESEARCH_DB.prepare(
      "UPDATE webhook_events SET note='revoke' WHERE provider='whop' AND event_id=?1"
    ).bind(evt.eventId).run().catch(() => {});
    return json({ ok: true, action: 'revoke', revoked: (res && res.meta && res.meta.changes) || 0 });
  }
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
