#!/usr/bin/env node
/* Dry-run your Whop product IDs against the real entitlement logic.
 *
 * Setting WHOP_PRODUCTS_FUTURES / WHOP_PRODUCTS_COMPLETE in Cloudflare is the
 * step that finally makes the $100 and $129 products different. It is also the
 * step where a typo is invisible: a mistyped id is not "not allowlisted" in any
 * obvious way, it just silently sends that product down the wrong branch —
 * either granting Complete to a Futures buyer, or granting nothing to a paying
 * customer. Neither shows up until someone pays.
 *
 * This runs the ids you are about to paste through resolveTier() and
 * authorizeResource() — the same functions the live middleware and webhook use,
 * imported, not reimplemented — and prints what each one would actually do.
 *
 * Usage:
 *   node tools/entitlement-check.mjs --futures="prod_a,plan_b" --complete="prod_c"
 *   WHOP_PRODUCTS_FUTURES=... WHOP_PRODUCTS_COMPLETE=... node tools/entitlement-check.mjs
 *
 * Exits non-zero if anything about the configuration would misbehave.
 */
import {
  TIERS, resolveTier, parseIdList, authorizeResource, RESOURCE_TIERS,
} from '../functions/api/_lib/entitlements.js';

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3).replace(/^["']|["']$/g, '') : undefined;
}

const futures = arg('futures') ?? process.env.WHOP_PRODUCTS_FUTURES ?? '';
const complete = arg('complete') ?? process.env.WHOP_PRODUCTS_COMPLETE ?? '';
const env = { WHOP_PRODUCTS_FUTURES: futures, WHOP_PRODUCTS_COMPLETE: complete };

const problems = [];
const warn = (m) => problems.push(m);

console.log('\nWHOP_PRODUCTS_FUTURES  =', futures || '(empty)');
console.log('WHOP_PRODUCTS_COMPLETE =', complete || '(empty)');

const fList = parseIdList(futures);
const cList = parseIdList(complete);

if (!fList.size && !cList.size) {
  warn('Both lists are empty, so strict mode is OFF: every verified member still '
     + 'resolves to Complete and the two products remain identical. This is the '
     + 'state the site ships in — setting these two variables is the actual fix.');
} else if (!fList.size || !cList.size) {
  console.log('\nNote: only one list is set. That is valid — anything not in it is '
    + 'rejected rather than granted — but double-check it is deliberate.');
}

for (const id of fList) if (cList.has(id)) {
  warn(`"${id}" is in BOTH lists. Complete wins, so this product grants the $129 `
     + 'tier. If it is the $100 product, remove it from WHOP_PRODUCTS_COMPLETE.');
}
for (const [label, list] of [['futures', fList], ['complete', cList]]) {
  for (const id of list) {
    if (/\s/.test(id)) warn(`"${id}" (${label}) contains whitespace — check the separator.`);
    if (id.length < 4) warn(`"${id}" (${label}) looks too short to be a Whop id.`);
    if (/^(prod|plan)_?$/i.test(id)) warn(`"${id}" (${label}) looks like a truncated id.`);
  }
}

console.log('\nWhat each configured id would grant:');
const rows = [
  ...[...fList].map((id) => [id, 'you listed it as Futures']),
  ...[...cList].map((id) => [id, 'you listed it as Complete']),
];
if (!rows.length) console.log('  (nothing configured)');
for (const [id, intent] of rows) {
  const { tier, reason } = resolveTier(env, { product: id });
  const label = tier === null ? 'NOTHING (rejected)' : tier;
  console.log(`  ${id.padEnd(28)} -> ${String(label).padEnd(14)} [${reason}]  (${intent})`);
  const expected = fList.has(id) && !cList.has(id) ? TIERS.FUTURES_CORE : TIERS.COMPLETE;
  if (tier !== expected) warn(`"${id}" resolves to ${label}, but you listed it as ${expected}.`);
}

// A product nobody configured must grant nothing — this is what stops a cheap
// add-on or a separately sold indicator becoming a full-course credential.
const stray = resolveTier(env, { product: 'prod_some_other_thing_you_sell' });
console.log(`\n  an UNLISTED product      -> ${stray.tier === null ? 'NOTHING (correct)' : String(stray.tier).toUpperCase() + ' (!!)'}  [${stray.reason}]`);
if (stray.tier !== null && (fList.size || cList.size)) {
  warn('An unlisted product still grants access — the allowlist is not taking effect.');
}

console.log('\nWhat each tier can then reach:');
const pages = [...new Set(Object.keys(RESOURCE_TIERS).filter((p) => !p.endsWith('.html')))];
for (const tier of [TIERS.FUTURES_CORE, TIERS.COMPLETE]) {
  const session = { v: 2, mr: 'check', t: tier };
  const allowed = pages.filter((p) => authorizeResource(session, p, env).allowed);
  const denied = pages.filter((p) => !authorizeResource(session, p, env).allowed);
  console.log(`  ${tier.padEnd(13)} yes: ${allowed.join(', ') || '(none)'}`);
  console.log(`  ${''.padEnd(13)} no : ${denied.join(', ') || '(none)'}`);
}

if (problems.length) {
  console.log(`\n${problems.length} problem(s):`);
  problems.forEach((p) => console.log(`  - ${p}`));
  process.exitCode = 1;
} else {
  console.log('\nConfiguration looks correct.');
}
