// Entitlement model tests — the allow/deny matrix the two paid tiers depend on.
//
// Before this module existed, verify-premium.js signed { v, mr, dn, exp } with
// no tier and _middleware.js gated every course on "is there any valid
// session", so a $100 Futures buyer received the $129 Complete library. These
// tests pin the rules that make the two products actually different, and in
// particular that an unrecognized Whop product can never become a credential.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TIERS, SESSION_VERSION, isTier, tierRank, tierAllows, parseIdList,
  resolveTier, sessionTier, isLegacySession, authorizeResource,
  requiredTierFor, RESOURCE_TIERS,
} from '../functions/api/_lib/entitlements.js';

const ALLOWLIST = {
  WHOP_PRODUCTS_FUTURES: 'prod_futures_100, plan_futures_monthly',
  WHOP_PRODUCTS_COMPLETE: 'prod_complete_129',
};

test('tier ordering: higher tiers satisfy lower requirements, never the reverse', () => {
  assert.ok(tierRank(TIERS.COMPLETE) > tierRank(TIERS.FUTURES_CORE));
  assert.ok(tierRank(TIERS.FUTURES_CORE) > tierRank(TIERS.FREE));

  assert.ok(tierAllows(TIERS.COMPLETE, TIERS.FUTURES_CORE), 'Complete covers Core content');
  assert.ok(tierAllows(TIERS.COMPLETE, TIERS.COMPLETE));
  assert.ok(tierAllows(TIERS.FUTURES_CORE, TIERS.FUTURES_CORE));

  // The whole point: Core must NOT reach Complete-only material.
  assert.equal(tierAllows(TIERS.FUTURES_CORE, TIERS.COMPLETE), false);
  assert.equal(tierAllows(TIERS.FREE, TIERS.FUTURES_CORE), false);
});

test('unknown tiers and unknown requirements fail closed', () => {
  assert.equal(tierAllows('admin', TIERS.COMPLETE), false);
  assert.equal(tierAllows(TIERS.COMPLETE, 'vip'), false, 'an unrecognized requirement must not be satisfiable');
  assert.equal(tierAllows(undefined, TIERS.FREE), false);
  assert.equal(tierAllows(null, null), false);
  assert.equal(isTier('Complete'), false, 'tier matching is exact, not case-folded');
});

test('a product outside the allowlist never grants a tier', () => {
  // The exact scenario the audit called out: a cheaper or separately sold
  // product (an indicator, a one-off) whose event reaches our endpoint.
  for (const bad of ['prod_indicator_29', 'prod_unknown', 'PROD_REFUNDED', '']) {
    const { tier } = resolveTier(ALLOWLIST, { product: bad });
    assert.equal(tier, null, `${bad || '(empty)'} must not grant access`);
  }
  assert.equal(resolveTier(ALLOWLIST, {}).reason, 'no_product_id');
  assert.equal(resolveTier(ALLOWLIST, { product: 'prod_indicator_29' }).reason, 'not_allowlisted');
});

test('allowlisted products resolve to their own tier, matching on product or plan', () => {
  assert.equal(resolveTier(ALLOWLIST, { product: 'prod_futures_100' }).tier, TIERS.FUTURES_CORE);
  assert.equal(resolveTier(ALLOWLIST, { product: 'prod_complete_129' }).tier, TIERS.COMPLETE);
  // Whop sends plan ids on some events and product ids on others.
  assert.equal(resolveTier(ALLOWLIST, { plan: 'plan_futures_monthly' }).tier, TIERS.FUTURES_CORE);
  // Ids are compared case/whitespace-insensitively.
  assert.equal(resolveTier(ALLOWLIST, { product: '  PROD_COMPLETE_129 ' }).tier, TIERS.COMPLETE);
  // Listed in both: take the higher tier, never downgrade a paying member.
  const both = { WHOP_PRODUCTS_FUTURES: 'p1', WHOP_PRODUCTS_COMPLETE: 'p1' };
  assert.equal(resolveTier(both, { product: 'p1' }).tier, TIERS.COMPLETE);
});

test('an unconfigured deployment keeps working instead of locking members out', () => {
  // Shipping this must not black out a live site before the owner sets env
  // vars — but the reason has to say strict mode is off.
  const r = resolveTier({}, { product: 'anything' });
  assert.equal(r.tier, TIERS.COMPLETE);
  assert.equal(r.reason, 'unconfigured_default');
  // …and the fallback is overridable.
  assert.equal(resolveTier({ WHOP_DEFAULT_TIER: 'futures_core' }, { product: 'x' }).tier, TIERS.FUTURES_CORE);
  // A bogus override does not become a tier.
  assert.equal(resolveTier({ WHOP_DEFAULT_TIER: 'god_mode' }, { product: 'x' }).tier, TIERS.COMPLETE);
  // Configuring only ONE list still enables strict rejection of the other.
  const onlyFutures = { WHOP_PRODUCTS_FUTURES: 'prod_futures_100' };
  assert.equal(resolveTier(onlyFutures, { product: 'prod_futures_100' }).tier, TIERS.FUTURES_CORE);
  assert.equal(resolveTier(onlyFutures, { product: 'prod_complete_129' }).tier, null);
});

test('parseIdList tolerates the shapes an env var actually arrives in', () => {
  assert.deepEqual([...parseIdList('a, b  c,,d ')], ['a', 'b', 'c', 'd']);
  assert.equal(parseIdList(undefined).size, 0);
  assert.equal(parseIdList('').size, 0);
  assert.equal(parseIdList(null).size, 0);
});

test('pre-tier sessions are grandfathered until they expire, and can be cut off', () => {
  const legacy = { v: 1, mr: 'm1', exp: Date.now() + 1000 };
  assert.ok(isLegacySession(legacy));
  // Default: keep existing members signed in; the window closes by itself
  // because no new untiered token can be minted after this ships.
  assert.equal(sessionTier(legacy, {}), TIERS.COMPLETE);
  // Owner can force everyone to re-authenticate once.
  assert.equal(sessionTier(legacy, { STRICT_LEGACY_SESSIONS: 'true' }), null);
  assert.equal(sessionTier(legacy, { STRICT_LEGACY_SESSIONS: 'TRUE' }), null);
  assert.equal(sessionTier(legacy, { STRICT_LEGACY_SESSIONS: 'false' }), TIERS.COMPLETE);

  const tiered = { v: SESSION_VERSION, mr: 'm1', t: TIERS.FUTURES_CORE };
  assert.equal(isLegacySession(tiered), false);
  assert.equal(sessionTier(tiered, {}), TIERS.FUTURES_CORE);
  // A tiered session is unaffected by the legacy switch.
  assert.equal(sessionTier(tiered, { STRICT_LEGACY_SESSIONS: 'true' }), TIERS.FUTURES_CORE);
});

test('a forged tier claim is not a tier', () => {
  assert.equal(sessionTier({ v: 2, t: 'complete ' }, {}), TIERS.COMPLETE, 'legacy fallback, not the forged value');
  assert.equal(sessionTier({ v: 2, t: 'superuser' }, { STRICT_LEGACY_SESSIONS: 'true' }), null);
  assert.equal(sessionTier(null, {}), null);
  assert.equal(sessionTier('complete', {}), null);
});

test('every gated course page declares a required tier', () => {
  // A new gated page must not be able to default to "any session will do".
  for (const page of ['/futures-dissection', '/psychology-enhancer', '/stock-breakdown', '/options-lab']) {
    assert.ok(requiredTierFor(page), `${page} must declare a tier`);
    assert.ok(requiredTierFor(`${page}.html`), `${page}.html must declare a tier`);
  }
  assert.equal(requiredTierFor('/index.html'), null, 'ungated pages stay ungated');
  assert.equal(requiredTierFor('/'), null);
});

test('the Core/Complete split is exactly the advertised split', () => {
  assert.equal(RESOURCE_TIERS['/futures-dissection'], TIERS.FUTURES_CORE);
  assert.equal(RESOURCE_TIERS['/psychology-enhancer'], TIERS.FUTURES_CORE);
  assert.equal(RESOURCE_TIERS['/stock-breakdown'], TIERS.COMPLETE);
  assert.equal(RESOURCE_TIERS['/options-lab'], TIERS.COMPLETE);
  assert.equal(RESOURCE_TIERS['/api/research-engine'], TIERS.COMPLETE);
});

test('authorizeResource: the full matrix a $100 buyer and a $129 buyer see', () => {
  const core = { v: 2, t: TIERS.FUTURES_CORE };
  const full = { v: 2, t: TIERS.COMPLETE };

  // What the $100 Futures member gets…
  assert.equal(authorizeResource(core, '/futures-dissection', {}).allowed, true);
  assert.equal(authorizeResource(core, '/psychology-enhancer', {}).allowed, true);
  // …and, crucially, does not.
  assert.equal(authorizeResource(core, '/stock-breakdown', {}).allowed, false);
  assert.equal(authorizeResource(core, '/options-lab', {}).allowed, false);
  assert.equal(authorizeResource(core, '/api/research-engine', {}).allowed, false);

  // The $129 member gets everything.
  for (const p of ['/futures-dissection', '/psychology-enhancer', '/stock-breakdown', '/options-lab', '/api/research-engine']) {
    assert.equal(authorizeResource(full, p, {}).allowed, true, `complete should reach ${p}`);
  }

  // No session at all reaches nothing gated, but ungated pages still render.
  assert.equal(authorizeResource(null, '/options-lab', {}).allowed, false);
  assert.equal(authorizeResource(null, '/index.html', {}).allowed, true);

  const denied = authorizeResource(core, '/options-lab', {});
  assert.equal(denied.held, TIERS.FUTURES_CORE);
  assert.equal(denied.required, TIERS.COMPLETE);
});
