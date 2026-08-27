// PJ futures-first redesign contract tests (owner requirements, 2026-08-24).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const index = readFileSync(join(ROOT, 'index.html'), 'utf8');
const premarket = readFileSync(join(ROOT, 'premarket.html'), 'utf8');
const guidance = readFileSync(join(ROOT, 'premium-guidance.html'), 'utf8');

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

test('video sits above bundles with a PJ video-frame poster and lazy facade', () => {
  const videoIdx = index.indexOf('id="video"');
  const bundleIdx = index.indexOf('Bundles</div>');
  assert.ok(videoIdx > -1 && bundleIdx > -1 && videoIdx < bundleIdx, 'video must appear before bundles');
  assert.match(index, /id="video-facade"/);
  assert.match(index, /data-video-mp4="\/video\/pj-intro\.mp4"/);
  assert.match(index, /assets\/pj-intro-poster\.jpg/, 'video poster must come from PJ\'s own video');
  assert.ok(existsSync(join(ROOT, 'assets', 'pj-intro-poster.jpg')), 'video-frame poster asset missing');
  assert.doesNotMatch(index, /<video[^>]*src=/, 'no eager video src (25MB deploy limit + LCP)');
});

test('team: PJ real card + blank owner-fillable slots (no invented bios)', () => {
  assert.match(index, /<h3>PJTrades<\/h3>/, 'PJ card missing');
  assert.match(index, /10 years in the markets/, 'PJ 10-year bio line missing');
  const blanks = [...index.matchAll(/team-avatar-blank/g)].length;
  assert.ok(blanks >= 5, 'expected at least 5 blank team slots, found ' + blanks);
  assert.doesNotMatch(index, /<h3>Caleb<\/h3>|<h3>Gainz<\/h3>|<h3>KWT<\/h3>/, 'named cards must stay out until owner personalizes them');
});

test('member results wall is blank and owner-ready', () => {
  assert.match(index, /id="results"/);
  assert.match(index, /results-empty/, 'placeholder state missing');
  assert.match(index, /To add a card later, copy this template/, 'owner template comment missing');
  assert.match(index, /Results vary and are never typical or guaranteed/);
});

test('premium Alpaca AI trend analyst: gated endpoint + member UI', () => {
  const analyst = readFileSync(join(ROOT, 'functions', 'api', 'premium-market-analyst.js'), 'utf8');
  assert.match(analyst, /premium session is required/, 'must fail with premium-required message');
  assert.match(analyst, /verifySessionToken/, 'must verify the premium session');
  assert.match(analyst, /feed=iex|feed=\$\{FEED\}/, 'must label the IEX feed');
  assert.match(analyst, /not financial advice/i, 'disclaimer required');
  assert.match(guidance, /\/api\/premium-market-analyst/, 'member UI must call the analyst endpoint');
  assert.match(guidance, /id="market-analyst"/);
  assert.match(guidance, /hidden>/, 'analyst panel must be hidden until premium is verified');
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

test('fonts load via link+preconnect, not render-blocking @import', () => {
  assert.match(index, /<link rel="preconnect" href="https:\/\/fonts\.gstatic\.com" crossorigin>/);
  assert.match(index, /<link href="https:\/\/fonts\.googleapis\.com\/css2\?family=Barlow\+Condensed/);
  assert.doesNotMatch(index, /@import url\('https:\/\/fonts\.googleapis/);
});

test('sticky mobile CTA appears after hero and never covers the chat FAB', () => {
  assert.match(index, /id="mobile-cta"/);
  assert.match(index, /show-ctabar/, 'body toggle class missing');
  assert.match(index, /body\.show-ctabar \.vjm-chat-fab\{bottom:\d+px;\}/, 'chat FAB offset missing');
  assert.match(index, /IntersectionObserver/, 'reveal or cta observer missing');
  const m = index.match(/id="mobile-cta"[\s\S]*?href="(https:\/\/whop\.com[^"]*)"/);
  assert.ok(m && m[1] === 'https://whop.com/pjtradespremium', 'CTA must link to Whop');
});

test('latest-from-the-desk: CMS feeds + AI lean chip, hidden until data exists', () => {
  assert.match(index, /id="latest"[^>]*display:none;/, 'section must start hidden');
  assert.match(index, /\/api\/content\?type=announcements/);
  assert.match(index, /\/api\/content\?type=trade_reviews/);
  assert.match(index, /\/api\/market-brief/, 'lean chip fetch missing');
  assert.match(index, /low-confidence ETF proxy/);
  assert.match(index, /not trade signals/i, 'trade-review disclaimer missing');
});

test('futures calculators: real contract math + prop risk guard', () => {
  assert.match(index, /calcFutures/);
  assert.match(index, /value="2">MNQ — Micro Nasdaq \(\$2\/pt\)</);
  assert.match(index, /value="50">ES — E-mini S&amp;P \(\$50\/pt\)</);
  assert.match(index, /calcPropRisk/);
  assert.match(index, /Trailing Drawdown/);
});

test('session clock lives in the schedule section', () => {
  assert.match(index, /id="session-clock"/);
  assert.match(index, /tickSessionClock/);
});

test('PWA manifest + theme color + PJ 404', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
  assert.equal(manifest.theme_color, '#06090d');
  assert.ok(existsSync(join(ROOT, 'assets', 'icon.svg')), 'manifest icon missing');
  assert.match(index, /<link rel="manifest" href="manifest\.json">/);
  assert.match(index, /<meta name="theme-color" content="#06090d">/);
  const notFound = readFileSync(join(ROOT, '404.html'), 'utf8');
  assert.match(notFound, /PJ Trades x St/);
  assert.match(notFound, /discord\.gg\/pjtrades/);
  assert.match(notFound, /noindex/);
});

test('Organization JSON-LD with founder + socials', () => {
  assert.match(index, /"@type": "Organization"/);
  assert.match(index, /"founder": \{ "@type": "Person", "name": "PJ Trades"/);
  assert.match(index, /"@type": "FAQPage"/);
});

test('CMS Phase 3: schedule/team/faqs/bundles/stats/results wired with fallbacks intact', () => {
  const contentJs = readFileSync(join(ROOT, 'functions', 'api', 'content.js'), 'utf8');
  const core = readFileSync(join(ROOT, 'functions', 'api', '_lib', 'integrations-core.js'), 'utf8');
  for (const t of ['schedule', 'team', 'faqs', 'bundles', 'stats', 'results']) {
    assert.match(contentJs, new RegExp("'" + t + "'"), 'content.js TYPES missing ' + t);
    assert.match(core, new RegExp("'" + t + "'"), 'CONTENT_TYPES missing ' + t);
    assert.match(index, new RegExp('/api/content\\?type=' + t), 'index.html missing fetch for ' + t);
  }
  // Fallbacks must remain in the static markup — only replaced client-side once the CMS has rows.
  assert.match(index, /class="week-grid" id="week-grid"/, 'schedule fallback grid missing');
  assert.match(index, /Monday/, 'static schedule fallback content missing');
  assert.match(index, /class="tier-grid" id="tier-grid"/, 'bundles fallback tiers missing');
  assert.match(index, /\$100<span>\/mo<\/span>/, 'static bundle price fallback missing');
  assert.match(index, /id="faq-list"/);
  assert.match(index, /Do you offer live trading\?/, 'static FAQ fallback missing');
  assert.match(index, /id="results-empty"/);
  assert.match(index, /id="results-grid"/);
  const blanks = [...index.matchAll(/data-blank/g)].length;
  assert.ok(blanks >= 5, 'expected at least 5 data-blank team slots for CMS fill-in, found ' + blanks);
});

test('apps-script content bridge reads the new CMS tabs', () => {
  const gs = readFileSync(join(ROOT, 'apps-script', 'content-sync', 'Code.gs'), 'utf8');
  for (const tab of ['Schedule', 'Team', 'Faqs', 'Bundles', 'Stats', 'Results']) {
    assert.match(gs, new RegExp("readRows_\\(ss, '" + tab + "'\\)"), 'Code.gs missing tab reader for ' + tab);
  }
});

test('package.json check:syntax covers content.js', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.scripts['check:syntax'], /functions\/api\/content\.js/);
});
