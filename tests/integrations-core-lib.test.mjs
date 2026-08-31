// Regression coverage for functions/api/_lib/integrations-core.js -- "pure
// helpers... unit-testable deterministically" per its own header comment,
// yet the last functions/api/_lib/*.js file with zero direct test imports
// (ai.js and discord.js remain in that state too; http.js was closed last
// run). It's imported by three handlers -- content-sync.js, whop-webhook.js,
// market-brief.js -- each of which has handler-level tests, but none of them
// import these functions directly, so several invariants only this file
// documents were never pinned at the unit level:
//
//   - timingSafeHexEqual guards the whop-webhook HMAC signature check and
//     the content-sync bridge secret; a length-mismatch short-circuit that
//     leaks timing, or an empty-string false positive, would undermine both.
//   - sanitizeContentRow is the only defense between a Google Sheet cell an
//     owner (or anyone with edit access to that sheet) can put anything in
//     and that text landing directly in rendered HTML or a Discord embed --
//     cleanUrl's https-only allowlist and cleanStr's @everyone/@here
//     zero-width-space guard are both untested at the unit level, and 8 of
//     the 9 content types (all but announcements) have never had their
//     required-field validation exercised at all, even indirectly, since
//     content-sync-api.test.mjs only ever feeds announcements rows.
//   - generateAccessCodeShape/isValidGeneratedCode round-trip is what stands
//     between a purchase and a deliverable Whop access code; a shape drift
//     between the two functions would make whop-webhook.js's retry loop
//     exhaust its 5 guard attempts and silently fail to mint a code.
import assert from 'node:assert/strict';
import {
  timingSafeHexEqual,
  normalizeWhopEvent,
  generateAccessCodeShape,
  isValidGeneratedCode,
  computeFuturesLean,
  sanitizeContentRow,
  CONTENT_TYPES,
} from '../functions/api/_lib/integrations-core.js';

// ─── timingSafeHexEqual ─────────────────────────────────────────────────────
{
  assert.equal(timingSafeHexEqual('abc123', 'abc123'), true);
  assert.equal(timingSafeHexEqual('abc123', 'abc124'), false);
  assert.equal(timingSafeHexEqual('abc123', 'abc12'), false, 'length mismatch must reject, not compare a prefix');
  assert.equal(timingSafeHexEqual('', ''), false, 'two empty strings must never count as a valid match');
  assert.equal(timingSafeHexEqual(null, null), false);
  assert.equal(timingSafeHexEqual(undefined, 'x'), false);
}

// ─── normalizeWhopEvent ─────────────────────────────────────────────────────
{
  // Non-object body, or a body with no event id, is unusable -> null.
  assert.equal(normalizeWhopEvent(null), null);
  assert.equal(normalizeWhopEvent('a string'), null);
  assert.equal(normalizeWhopEvent({ type: 'membership.went_valid' }), null, 'no id/event_id -> null');

  // Grant classification, with enrichment pulled from the nested membership
  // object and email/planName/expiresAt/amountPaidCents/currency derived.
  const grant = normalizeWhopEvent({
    id: 'evt-1',
    type: 'membership.went_valid',
    data: {
      membership: {
        user_id: 'user-1',
        product_id: 'prod-1',
        plan_id: 'plan-1',
        renewal_period_end: 1893456000, // 2030-01-01T00:00:00Z
        user: { email: '  Trader@Example.COM  ' },
        product: { title: 'All-Markets' },
      },
      usd_total: 129,
      currency: 'usd',
    },
  });
  assert.equal(grant.action, 'grant');
  assert.equal(grant.memberId, 'user-1');
  assert.equal(grant.productId, 'prod-1');
  assert.equal(grant.email, 'trader@example.com', 'email must be trimmed and lowercased');
  assert.equal(grant.planName, 'All-Markets');
  assert.equal(grant.expiresAt, new Date(1893456000 * 1000).toISOString());
  assert.equal(grant.amountPaidCents, 12900, 'usd_total dollars -> integer cents');
  assert.equal(grant.currency, 'USD');

  // Revoke classification carries no enrichment fields (grant/revoke share
  // eventId/memberId/productId/planId only).
  const revoke = normalizeWhopEvent({
    id: 'evt-2',
    type: 'membership.went_invalid',
    data: { user_id: 'user-2' },
  });
  assert.equal(revoke.action, 'revoke');
  assert.equal(revoke.memberId, 'user-2');
  assert.equal('email' in revoke, false);

  // An event type outside both sets is explicitly 'ignore', not dropped or
  // misclassified as a grant/revoke.
  const ignored = normalizeWhopEvent({ id: 'evt-3', type: 'membership.metadata_updated' });
  assert.equal(ignored.action, 'ignore');

  // Top-level fields (no nested `membership`) are the fallback path.
  const flat = normalizeWhopEvent({ id: 'evt-4', type: 'payment.succeeded', data: { user_id: 'user-4' } });
  assert.equal(flat.memberId, 'user-4');

  // No renewal_period_end -> expiresAt stays null rather than 1970-01-01.
  const noExpiry = normalizeWhopEvent({ id: 'evt-5', type: 'payment.succeeded', data: { user_id: 'user-5' } });
  assert.equal(noExpiry.expiresAt, null);
}

// ─── generateAccessCodeShape / isValidGeneratedCode round trip ─────────────
{
  assert.equal(isValidGeneratedCode('VJM-2B3D-4E5F'), true);
  assert.equal(isValidGeneratedCode('vjm-2b3d-4e5f'), false, 'lowercase must not validate');
  assert.equal(isValidGeneratedCode('VJM-2B3D4E5F'), false, 'missing the second hyphen must not validate');
  assert.equal(isValidGeneratedCode('VJM-2B3-4E5F'), false, 'wrong group length must not validate');
  assert.equal(isValidGeneratedCode(''), false);
  assert.equal(isValidGeneratedCode(null), false);
  // Confusable characters I, L, O, 0, 1 are excluded from the alphabet, so a
  // code containing any of them (even otherwise well-formed) must fail.
  for (const ch of ['I', 'L', 'O', '0', '1']) {
    assert.equal(isValidGeneratedCode(`VJM-${ch}BCD-EFGH`), false, `${ch} must not be a valid code character`);
  }

  // Every byte value in the alphabet's range round-trips to a code that
  // passes validation -- this is the exact contract whop-webhook.js's
  // generate-then-validate retry loop depends on.
  for (let trial = 0; trial < 20; trial++) {
    const bytes = Array.from({ length: 8 }, () => Math.floor(Math.random() * 256));
    const code = generateAccessCodeShape(bytes);
    assert.match(code, /^VJM-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    assert.equal(isValidGeneratedCode(code), true, `generated code ${code} must pass its own validator`);
  }
}

// ─── computeFuturesLean ─────────────────────────────────────────────────────
{
  // QQQ counts double: a QQQ move alone must cross the +/-0.5 threshold at
  // half the SPY-equivalent percentage.
  assert.equal(computeFuturesLean({ spyChangePct: 0, qqqChangePct: 0.25 }).lean, 'long-leaning');
  assert.equal(computeFuturesLean({ spyChangePct: 0, qqqChangePct: -0.25 }).lean, 'short-leaning');
  assert.equal(computeFuturesLean({ spyChangePct: 0, qqqChangePct: 0.24 }).lean, 'neutral', 'just under the +0.5 raw threshold');

  // Composite: SPY weight x1 + QQQ weight x2.
  const composite = computeFuturesLean({ spyChangePct: 0.3, qqqChangePct: 0.2 });
  assert.equal(composite.score, 0.7); // 0.2*2 + 0.3
  assert.equal(composite.lean, 'long-leaning');
  assert.equal(composite.confidence, 'low');
  assert.equal(composite.drivers.length, 2);
  assert.match(composite.drivers[0], /QQQ \+0\.20% \(NQ proxy, weight ×2\)/);
  assert.match(composite.drivers[1], /SPY \+0\.30% \(ES proxy, weight ×1\)/);

  // Exact boundary values count as leaning, not neutral (>= / <=, not > / <).
  assert.equal(computeFuturesLean({ spyChangePct: 0.5, qqqChangePct: 0 }).lean, 'long-leaning');
  assert.equal(computeFuturesLean({ spyChangePct: -0.5, qqqChangePct: 0 }).lean, 'short-leaning');
}

// ─── sanitizeContentRow ─────────────────────────────────────────────────────
{
  // Every type is covered by CONTENT_TYPES; a row missing its own id is
  // rejected before any type-specific logic runs.
  for (const type of CONTENT_TYPES) {
    assert.equal(sanitizeContentRow(type, { id: '' }), null, `${type}: empty id must reject`);
  }
  assert.equal(sanitizeContentRow('announcements', null), null);
  assert.equal(sanitizeContentRow('not_a_real_type', { id: 'x', name: 'x' }), null);

  // cleanUrl: https-only allowlist. A javascript: URL or a bare http:// URL
  // must never survive into imageUrl/link/whopUrl/url fields.
  const badScheme = sanitizeContentRow('prop_firms', {
    id: 'p1', name: 'Firm', url: 'javascript:alert(1)',
  });
  assert.equal(badScheme, null, 'prop_firms requires a valid url; javascript: must not count as one');

  const httpRejected = sanitizeContentRow('results', { id: 'r1', image_url: 'http://example.com/x.jpg' });
  assert.equal(httpRejected, null, 'non-https image_url must be dropped, leaving no valid results row');

  const validUrl = sanitizeContentRow('prop_firms', { id: 'p2', name: 'Firm', url: 'https://example.com/ref?x=1' });
  assert.equal(validUrl.url, 'https://example.com/ref?x=1');

  // cleanStr: @everyone/@here get a zero-width space inserted so a sheet
  // owner (or anyone with edit access) can never mass-ping the Discord
  // announcements channel through synced content.
  const pingAttempt = sanitizeContentRow('announcements', {
    id: 'a1', title: 'Heads up', body: 'Reminder for @everyone and @here today',
  });
  assert.equal(pingAttempt.body.includes('@everyone'), false);
  assert.equal(pingAttempt.body.includes('@here'), false);
  assert.equal(pingAttempt.body.includes('@​everyone'), true, 'a zero-width space must be inserted, not the ping text dropped');
  assert.equal(pingAttempt.body.includes('@​here'), true);

  // Per-type required-field validation -- none of these 8 types (only
  // announcements) are exercised by content-sync-api.test.mjs, even
  // indirectly, since that suite only ever posts announcements rows.
  assert.equal(sanitizeContentRow('trade_reviews', { id: 't1', ticker: '' }), null, 'trade_reviews requires a ticker');
  const review = sanitizeContentRow('trade_reviews', { id: 't2', ticker: 'nq1!', direction: 'Short', result: 'WIN', r_multiple: '2.567' });
  assert.equal(review.ticker, 'NQ1');
  assert.equal(review.direction, 'short');
  assert.equal(review.result, 'win');
  assert.equal(review.rMultiple, 2.57);

  assert.equal(sanitizeContentRow('schedule', { id: 's1', day: 'Xyz', session: 'NYAM' }), null, 'unknown day must reject');
  assert.equal(sanitizeContentRow('schedule', { id: 's2', day: 'Mon', session: 'BADSESSION' }), null, 'unknown session must reject');
  const session = sanitizeContentRow('schedule', { id: 's3', day: 'Tue', session: 'nypm', active: 'no' });
  assert.equal(session.session, 'NYPM');
  assert.equal(session.active, 0);

  assert.equal(sanitizeContentRow('team', { id: 'tm1', name: '' }), null, 'team requires a name');
  assert.equal(sanitizeContentRow('faqs', { id: 'f1', question: '' }), null, 'faqs requires a question');
  assert.equal(sanitizeContentRow('bundles', { id: 'b1', name: '' }), null, 'bundles requires a name');
  const bundle = sanitizeContentRow('bundles', { id: 'b2', name: 'Futures Core', features: 'Live sessions | Discord | Replays' });
  assert.deepEqual(bundle.features, ['Live sessions', 'Discord', 'Replays']);
  assert.equal(sanitizeContentRow('stats', { id: 'st1', key: '' }), null, 'stats requires a key');
  assert.equal(sanitizeContentRow('results', { id: 'r2', image_url: '' }), null, 'results requires an image_url');

  // active/highlight/pinned boolean coercion: default true unless explicitly
  // false-ish; pinned/highlight default false unless explicitly true-ish.
  const propFirm = sanitizeContentRow('prop_firms', { id: 'p3', name: 'F', url: 'https://f.example.com' });
  assert.equal(propFirm.active, 1, 'active defaults to true when unset');
  const inactiveFirm = sanitizeContentRow('prop_firms', { id: 'p4', name: 'F', url: 'https://f.example.com', active: 'false' });
  assert.equal(inactiveFirm.active, 0);
}

console.log('# VJM integrations-core lib tests passed.');
