// Regression: the homepage bundle-period pricing (index.html's BUNDLE_PERIODS)
// advertises a "N% off" savings badge on its 6-month/yearly options, computed
// against that same tier's own monthly rate × the period's month count. That
// arithmetic is never re-derived by the page — it's hand-typed once per
// tier/period — so a copy-paste mistake between tiers (or a price update that
// forgets to update the badge) silently ships a false savings claim to a
// visitor comparing the numbers themselves on a page whose own copy says
// "Checkout and billing are handled securely by Whop."
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const index = readFileSync(join(ROOT, 'index.html'), 'utf8');

function extractBundlePeriods(src) {
  const m = src.match(/const BUNDLE_PERIODS = (\{[\s\S]*?\n\};)/);
  assert.ok(m, 'BUNDLE_PERIODS object literal not found in index.html — pricing script moved?');
  const literal = m[1].replace(/;\s*$/, '');
  // eslint-disable-next-line no-new-func -- eval'ing the site's own static
  // data literal, same pattern tests/pj-futures.test.mjs uses for inline data.
  return new Function('return ' + literal)();
}

const money = (s) => Number(String(s).replace(/[^0-9.]/g, ''));
const MONTHS_IN_PERIOD = { sixmo: 6, yearly: 12 };

// Most tiers' period entries show the period's own TOTAL in `amt` (futures'
// yearly: amt '$1,000', per ' /yr'). The ifvg tier's yearly entry instead
// shows a per-month equivalent in `amt` (per '/mo') with the real billed
// total spelled out in `sub` ("$671.40 billed yearly · ..."), so the "what
// did they actually pay" figure has to come from wherever it actually lives.
function paidAmountForPeriod(tier, period, entry) {
  if (/\/mo/.test(entry.per || '')) {
    const m = String(entry.sub || '').match(/\$([0-9,.]+)\s+billed/);
    assert.ok(m, `${tier}/${period}: amt is a /mo rate but no "$X billed ..." total found in sub`);
    return money(m[1]);
  }
  return money(entry.amt);
}

test('bundle period "% off" badges match the tier\'s own monthly rate x months', () => {
  const periods = extractBundlePeriods(index);
  const checked = [];
  for (const tier of ['futures', 'allmarkets', 'ifvg']) {
    const monthly = money(periods[tier].monthly.amt);
    assert.ok(monthly > 0, `${tier}: could not parse a monthly amount`);
    for (const period of Object.keys(MONTHS_IN_PERIOD)) {
      const entry = periods[tier][period];
      if (!entry) continue; // period not offered for this tier — fine
      const months = MONTHS_IN_PERIOD[period];
      const paid = paidAmountForPeriod(tier, period, entry);
      const fullPrice = monthly * months;
      const actualPct = Math.round(((fullPrice - paid) / fullPrice) * 100);
      const labelMatch = String(entry.sub || '').match(/(\d+)% off/);
      assert.ok(labelMatch, `${tier}/${period}: no "N% off" savings label found in sub copy`);
      const labeledPct = Number(labelMatch[1]);
      assert.equal(
        labeledPct,
        actualPct,
        `${tier}/${period}: badge says "${labeledPct}% off" but $${entry.amt} vs ` +
          `${months} x $${periods[tier].monthly.amt}/mo ($${fullPrice}) is actually ${actualPct}% off`
      );
      checked.push(`${tier}/${period}`);
    }
  }
  // Sanity: make sure the extraction actually walked real data, not an
  // accidentally-empty object that would make every assertion above vacuous.
  assert.ok(checked.length >= 4, `expected to check at least 4 tier/period combos, checked ${checked.length}`);
});
