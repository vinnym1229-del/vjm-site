// PJ futures-first redesign contract tests (owner requirements, 2026-08-24).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const index = readFileSync(join(ROOT, 'index.html'), 'utf8');
const premarket = readFileSync(join(ROOT, 'premarket.html'), 'utf8');

test('bundles: $100 futures core with 6mo/1yr options, $129 all-markets tier', () => {
  assert.match(index, /\$100<span>\/mo<\/span>/, '$100/mo futures tier missing');
  assert.match(index, /\$529/, '6-month option missing');
  assert.match(index, /12% off/, '6-month save badge missing');
  assert.match(index, /\$1,000/, 'annual option missing');
  assert.match(index, /18% off/, 'annual save badge missing');
  assert.match(index, /All-Markets/, 'all-markets tier missing');
  assert.match(index, /\$129<span>\/mo<\/span>/, '$129 all-markets price missing');
  assert.match(index, /Futures \+ Options \+ Stocks/, 'all-markets scope label missing');
  assert.match(index, /Complete educational materials/i, 'educational materials line missing');
  assert.match(index, /Live callouts/i, 'live callouts line missing');
  // Old single-price copy must be gone.
  assert.doesNotMatch(index, /Join Premium — \$129\/mo/);
  assert.doesNotMatch(index, /\$50\/mo/);
});

test('futures-first identity', () => {
  assert.match(index, /Futures, Made Simple\./);
  assert.match(index, /NQ &amp; ES futures/);
  assert.match(index, /ten years/i, 'owner confirmed 10 years — must stay');
  assert.match(index, /CME_MINI:NQ1!/, 'futures ticker tape missing NQ');
  assert.doesNotMatch(index, /BINANCE:ETHUSDT/, 'crypto-heavy tape should be gone');
});

test('whop listing facts showcased (owner screenshots, 2026-08-24)', () => {
  assert.match(index, /2,240 reviews/);
  assert.match(index, /49,136/, 'joined count missing');
  assert.match(index, /2\.8K members/);
  assert.match(index, /97% \(2167\)/, '5-star review bar missing');
  assert.match(index, /win up to \$50,000/i, 'giveaway line missing');
});

test('FAQ matches Whop verbatim + JSON-LD schema present', () => {
  assert.match(index, /Yes! I go live 3 to 5 times a week, depending on the economic calendar and market conditions\./);
  assert.match(index, /Yes, all entries and exits are shared via discord live trading\./);
  assert.match(index, /There are no refunds\. You can cancel your membership at anytime\./);
  assert.match(index, /application\/ld\+json/);
  assert.match(index, /FAQPage/);
});

test('video sits above bundles with lazy facade (232MB file must not be embedded directly)', () => {
  const videoIdx = index.indexOf('id="video"');
  const bundleIdx = index.indexOf('Bundles</div>');
  assert.ok(videoIdx > -1 && bundleIdx > -1 && videoIdx < bundleIdx, 'video must appear before bundles');
  assert.match(index, /id="video-facade"/);
  assert.match(index, /data-video-mp4="assets\/pj-intro\.mp4"/);
  assert.doesNotMatch(index, /<video[^>]*src=/, 'no eager video src (25MB deploy limit + LCP)');
});

test('team roster from the schedule graphic', () => {
  for (const name of ['PJTrades', 'Caleb', 'Fin', 'Gainz', 'KWT']) {
    assert.match(index, new RegExp('/>' + name + '<|>' + name + '<'), 'team member missing: ' + name);
  }
  assert.doesNotMatch(index, /Coming Soon/, 'team placeholder must be gone');
});

test('schedule mirrors the weekly session structure', () => {
  for (const s of ['NYAM', 'NYPM', 'ASIA', '9:30 AM ET', '2:30 PM ET', '8:00 PM ET', '5:30 PM ET']) {
    assert.match(index, new RegExp(s), 'schedule missing: ' + s);
  }
  // Countdown must use the new session template, not the old 9:15–2:00 window.
  assert.match(index, /PJ_SESSIONS/);
  assert.doesNotMatch(index, /9:15 AM to 2:00 PM ET/);
  assert.doesNotMatch(index, /9 \* 60 \+ 15/);
});

test('social links wired (YouTube, X, TikTok, Instagram)', () => {
  assert.match(index, /https:\/\/www\.youtube\.com\/@PJTrades_NQ/);
  assert.match(index, /https:\/\/x\.com\/PJtrades_NQ/);
  assert.match(index, /https:\/\/www\.tiktok\.com\/@pjtrades/);
  assert.match(index, /https:\/\/www\.instagram\.com\/pjtradesnq/);
});

test('whop links normalized without trailing slash', () => {
  assert.match(index, /whop\.com\/pjtradespremium"/, 'normalized whop link missing');
  assert.doesNotMatch(index, /pjtradespremium\//, 'trailing-slash whop link still present');
});

test('premarket page carries PJ futures branding', () => {
  assert.match(premarket, /<title>Pre-Market Brief \| PJ Trades x St/);
  assert.match(premarket, /NQ\/ES/);
  assert.doesNotMatch(premarket, /VJM \/ St Trades/);
});
