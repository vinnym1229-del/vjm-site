// Coverage for tools/entitlement-check.mjs — the owner's dry-run before pasting
// Whop product ids into Cloudflare.
//
// The tool simulates the real production env for resolveTier()/authorizeResource(),
// but until now it only forwarded WHOP_PRODUCTS_FUTURES/WHOP_PRODUCTS_COMPLETE and
// silently dropped WHOP_DEFAULT_TIER — a real, documented env var that controls the
// exact fallback this tool's own empty-lists warning describes. An owner running
// this with WHOP_DEFAULT_TIER=futures_core set (to intentionally default new
// members to the cheaper tier) got told everything still resolves to Complete and
// saw a false "(!!)" alarm on an unlisted product, because the tool's simulated env
// never looked at the variable at all. These tests pin that it now does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TOOL = join(ROOT, 'tools', 'entitlement-check.mjs');

function run(env) {
  try {
    return { stdout: execFileSync(process.execPath, [TOOL], { encoding: 'utf8', env }), status: 0 };
  } catch (err) {
    return { stdout: err.stdout, status: err.status };
  }
}

test('entitlement-check honors WHOP_DEFAULT_TIER for the empty-lists fallback', () => {
  const { stdout } = run({ ...process.env, WHOP_DEFAULT_TIER: 'futures_core', WHOP_PRODUCTS_FUTURES: '', WHOP_PRODUCTS_COMPLETE: '' });
  assert.match(stdout, /WHOP_DEFAULT_TIER\s+=\s+futures_core/);
  assert.match(stdout, /resolves to futures_core/);
  assert.doesNotMatch(stdout, /resolves to complete/);
  assert.match(stdout, /an UNLISTED product\s+-> FUTURES_CORE \(expected/);
  assert.doesNotMatch(stdout, /FUTURES_CORE \(!!\)/);
});

test('entitlement-check still defaults to Complete when WHOP_DEFAULT_TIER is unset', () => {
  const { stdout } = run({ ...process.env, WHOP_DEFAULT_TIER: '', WHOP_PRODUCTS_FUTURES: '', WHOP_PRODUCTS_COMPLETE: '' });
  assert.match(stdout, /WHOP_DEFAULT_TIER\s+=\s+\(unset\)/);
  assert.match(stdout, /resolves to complete/);
  assert.match(stdout, /an UNLISTED product\s+-> COMPLETE \(expected/);
});

test('entitlement-check still alarms on an unlisted product once an allowlist is configured', () => {
  const { stdout, status } = run({ ...process.env, WHOP_DEFAULT_TIER: '', WHOP_PRODUCTS_FUTURES: 'prod_a', WHOP_PRODUCTS_COMPLETE: 'prod_b' });
  assert.match(stdout, /an UNLISTED product\s+-> NOTHING \(correct\)/);
  assert.equal(status, 0);
});

test('entitlement-check notes when only one of the two lists is set', () => {
  const { stdout, status } = run({ ...process.env, WHOP_DEFAULT_TIER: '', WHOP_PRODUCTS_FUTURES: 'prod_futures_only', WHOP_PRODUCTS_COMPLETE: '' });
  assert.match(stdout, /only one list is set/);
  assert.equal(status, 0);
});

test('entitlement-check flags an id listed in both WHOP_PRODUCTS_FUTURES and WHOP_PRODUCTS_COMPLETE', () => {
  const { stdout, status } = run({ ...process.env, WHOP_DEFAULT_TIER: '', WHOP_PRODUCTS_FUTURES: 'prod_shared_id', WHOP_PRODUCTS_COMPLETE: 'prod_shared_id' });
  assert.match(stdout, /"prod_shared_id" is in BOTH lists\. Complete wins/);
  assert.equal(status, 1);
});

test('entitlement-check sounds the (!!) alarm when an unlisted product resolves to a real tier anyway', () => {
  // This is the tool's one actual safety tripwire: once an allowlist is
  // configured, a product nobody listed must come back `null`. Every other
  // test above only ever exercises the "correct" (null) side of that branch,
  // so the alarm itself — the thing an owner is trusting to catch a real
  // resolveTier() regression — had never been proven to fire. Forcing the
  // probe id itself into the allowlist is the simplest way to make
  // resolveTier() hand back a real tier for it, same as a genuine regression
  // would, without touching resolveTier()'s own source.
  const { stdout, status } = run({ ...process.env, WHOP_DEFAULT_TIER: '', WHOP_PRODUCTS_FUTURES: 'prod_some_other_thing_you_sell', WHOP_PRODUCTS_COMPLETE: 'prod_b' });
  assert.match(stdout, /an UNLISTED product\s+-> FUTURES_CORE \(!!\)/);
  assert.match(stdout, /An unlisted product still grants access — the allowlist is not taking effect\./);
  assert.equal(status, 1);
});
