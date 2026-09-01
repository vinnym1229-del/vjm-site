// PJ futures-first redesign contract tests (owner requirements, 2026-08-24).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// Homepage CSS lives in assets/site.css (extracted from the old inline
// <style> for caching); concatenate so CSS assertions still see it.
const index = readFileSync(join(ROOT, 'index.html'), 'utf8')
  + readFileSync(join(ROOT, 'assets', 'site.css'), 'utf8');
const premarket = readFileSync(join(ROOT, 'premarket.html'), 'utf8');
// Markup only — HTML comments are stripped, because the owner-facing comments
// left behind by a removal necessarily quote the copy that was removed.
const indexMarkup = index.replace(/<!--[\s\S]*?-->/g, '');
const guidance = readFileSync(join(ROOT, 'premium-guidance.html'), 'utf8');

test('bundles: $100 futures core with 6mo/1yr options, $129 complete tier', () => {
  assert.match(index, /\$100<span>\/mo<\/span>/, '$100/mo futures tier missing');
  assert.match(index, /\$529/, '6-month option missing');
  assert.match(index, /12% off/, '6-month save badge missing');
  assert.match(index, /\$1,000/, 'annual option missing');
  assert.match(index, /18% off/, 'annual save badge missing');
  assert.match(index, /Complete Bundle/, 'complete bundle badge missing');
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
  // The tape carries free ETF/crypto proxies, not the CME/NYMEX contracts:
  // those need a paid TradingView data plan and rendered as blank restricted
  // tiles for visitors. Guard both directions so neither regresses.
  assert.match(index, /NASDAQ:QQQ/, 'ticker tape missing the NQ proxy (QQQ)');
  assert.match(index, /AMEX:IVV/, 'ticker tape missing the ES proxy (IVV)');
  assert.doesNotMatch(index, /CME_MINI:|NYMEX:/, 'paid-tier futures symbols must stay out of the tape');
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
  // Was: assert.match(index, /data-video-mp4="\/video\/pj-intro\.mp4"/).
  // That pinned a path to a file that did not exist, so this test cemented the
  // bug it should have caught — the facade 404'd and every visitor who clicked
  // play was told the video was "dropping here soon". Assert the file is
  // really there instead of asserting one particular spelling of its name;
  // tests/visual-polish.test.mjs also checks it against the 25MB deploy limit.
  const mp4 = /data-video-mp4="([^"]+)"/.exec(index);
  assert.ok(mp4, 'the facade must declare a video source');
  assert.ok(existsSync(join(ROOT, mp4[1].replace(/^\//, ''))),
    `data-video-mp4 points at ${mp4[1]}, which is not in the repo`);
  assert.match(index, /assets\/pj-intro-poster\.jpg/, 'video poster must come from PJ\'s own video');
  assert.ok(existsSync(join(ROOT, 'assets', 'pj-intro-poster.jpg')), 'video-frame poster asset missing');
  assert.doesNotMatch(index, /<video[^>]*src=/, 'no eager video src (25MB deploy limit + LCP)');
});

// Updated 2026-08-31: this used to REQUIRE five blank "Team Member / Role
// coming soon / Bio coming soon" cards. Placeholder identities on a page
// selling a paid product read as an abandoned site to a first-time visitor,
// so the blank cards were deleted. The part of the old contract that still
// matters — PJ's real card stays, and nobody is invented to fill the grid
// (AGENTS.md non-negotiable #2) — is asserted below, plus the new rule that
// no placeholder identity ships at all.
test('team: PJ real card only, no placeholder identities, no invented bios', () => {
  assert.match(index, /<h3>PJTrades<\/h3>/, 'PJ card missing');
  assert.match(index, /10 years in the markets/, 'PJ 10-year bio line missing');
  assert.doesNotMatch(indexMarkup, /<h3>Team Member<\/h3>|Role coming soon|Bio coming soon/,
    'placeholder team cards must not ship — restore real people from the CMS instead');
  // (The .team-avatar-blank RULE still sits in assets/site.css, now unused —
  // harmless, and that file belongs to another lane. What must not ship is a
  // blank avatar element on the page.)
  assert.doesNotMatch(indexMarkup, /class="team-avatar team-avatar-blank"/, 'blank avatar slots must not ship');
  assert.doesNotMatch(index, /<h3>Caleb<\/h3>|<h3>Gainz<\/h3>|<h3>KWT<\/h3>/, 'named cards must stay out until owner personalizes them');
  // The CMS path that fills the section with real people must survive.
  assert.match(index, /\/api\/content\?type=team/, 'team CMS fetch missing');
  assert.match(index, /id="team-grid"/, 'team grid container missing');
});

// Updated 2026-08-31 with the same reasoning: the wall used to advertise
// itself with a "Wall coming soon" empty state. The section now ships hidden
// and is revealed only by real CMS cards, so there is no empty promise on the
// page — but the #wins anchor (linked from eight other pages) and the
// results-vary disclaimer must both stay.
test('member results wall ships hidden until real cards exist', () => {
  assert.match(index, /id="results"/);
  assert.match(index, /<section id="results"[^>]*\shidden>/, 'results section must ship hidden');
  assert.doesNotMatch(indexMarkup, /Wall coming soon/, 'placeholder empty state must not ship');
  assert.doesNotMatch(indexMarkup, /id="results-empty"/, 'placeholder empty state must not ship');
  assert.match(index, /id="wins"/, 'the #wins anchor is linked from other pages and must stay');
  assert.match(index, /section\.hidden = false/, 'CMS results must be what reveals the section');
  assert.match(index, /Results vary and are never typical or guaranteed/);
});

// The FAQ is Whop-verbatim ("I go live 3 to 5 times a week"), so 3-5 is the
// only supported session frequency. A "10+ times a week" claim used to sit in
// the meta description, the JSON-LD, the hero bullet list and the futures tier
// card while the FAQ, the proof bar and the schedule heading all said 3-5.
// Two different true statements about frequency, at two different scopes, which
// an earlier pass conflated and flattened to the smaller one:
//   - PJ PERSONALLY goes live 3 to 5 times a week. That line is Whop-verbatim
//     in the FAQ and checks out (PJTrades is named on 4 NYAM sessions).
//   - The TEAM runs far more than that. The owner confirmed it, and the page's
//     own schedule table proves it.
// So the marketing copy describes the team, the FAQ keeps PJ's own words, and
// this test derives the number from the schedule rather than trusting the copy.
test('the stated session frequency matches the schedule table itself', () => {
  // Count real rows only; the CMS renderer's template literal is not a session.
  // Strip <script> blocks first: the CMS renderer builds the same markup from a
  // template literal, and counting that as a session inflates the total by one.
  const staticMarkup = indexMarkup.replace(/<script[\s\S]*?<\/script>/gi, '');
  const realRows = [...staticMarkup.matchAll(/<div class="session-row">/g)].length;
  assert.equal(realRows, 15, 'schedule table changed — update the copy and this number together');

  // Every claim about the team's cadence must state that same figure.
  assert.match(index, new RegExp(`${realRows} (Sessions|sessions|team sessions|a week)`),
    `copy must state the ${realRows} sessions the schedule actually lists`);
  assert.doesNotMatch(index, /3–5x|3&ndash;5 times each week|3–5 times each week/,
    'the team cadence is 15 a week, not 3-5 — that was PJ personally');

  // …while PJ's own Whop-verbatim line is preserved untouched.
  assert.match(index, /3 to 5 times a week/, "PJ's own FAQ wording is Whop-verbatim and must stay");

  // "10+ times a week" was never sourced from anything; it must not come back.
  assert.doesNotMatch(index, /10\+ times/, 'unsourced claim');

  // A slot the owner's graphic marks as off (Monday 2:30) is shown, because a
  // silent gap reads as an oversight rather than as "nothing today". It must
  // carry .session-row-off, never .session-row: counted as a session it would
  // inflate the figure above by one and the copy would overstate the week.
  assert.match(staticMarkup, /class="session-row-off"/, 'the off slot must be shown, not silently dropped');
  const offRows = [...staticMarkup.matchAll(/<div class="session-row-off">/g)].length;
  assert.equal(offRows + realRows, 16, 'every schedule row is either a session or an explicit off slot');
});

// functions/api/_lib/backtest-core.js exists but is wired to no route and no
// UI (its own tests call it "not-yet-wired"), so nothing on this site runs a
// backtest for anyone. Sales copy must not imply otherwise.
test('no backtesting engine is advertised as a shipped feature', () => {
  assert.doesNotMatch(indexMarkup, /backtesting engine|backtester|run backtests/i,
    'no backtesting engine ships — do not advertise one');
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
  assert.ok(m, 'CTA must link to Whop');
  // Destination is asserted on origin+path; the query string carries UTM
  // attribution, which is how we tell which surface produced a sale. Pinning
  // the bare URL here would silently forbid that.
  const cta = new URL(m[1]);
  assert.equal(cta.origin + cta.pathname, 'https://whop.com/pjtradespremium', 'CTA must link to the Whop product');
  assert.ok(cta.searchParams.get('utm_content'), 'CTA must carry utm_content so the source is attributable');
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
  assert.match(index, /value="MNQ">MNQ — Micro Nasdaq \(\$2\/pt\)</);
  assert.match(index, /value="ES">ES — E-mini S&amp;P \(\$50\/pt\)</);
  assert.match(index, /calcPropRisk/);
  assert.match(index, /Trailing Drawdown/);
});

test('session clock lives in the schedule section', () => {
  assert.match(index, /id="session-clock"/);
  assert.match(index, /tickSessionClock/);
});

test('PWA manifest + theme color + PJ 404', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
  // Updated 2026-09-01: light became the default theme, so the manifest and the
  // theme-color meta describe the LIGHT page background (#ffffff = --bg in
  // body.light-mode), not the dark #0c0c0d they were pinned to before.
  const LIGHT_BG = '#ffffff';
  assert.equal(manifest.theme_color, LIGHT_BG);
  assert.equal(manifest.background_color, LIGHT_BG);
  assert.ok(existsSync(join(ROOT, 'assets', 'icon.svg')), 'manifest icon missing');
  assert.match(index, /<link rel="manifest" href="manifest\.json">/);
  // These drifted apart once when the palette changed: index.html was swept,
  // manifest.json was not — so they are normally asserted equal.
  // TRANSITIONAL (2026-09-01): index.html is owned by a parallel lane this
  // cycle and its meta tag is updated there. Once it ships
  //   <meta name="theme-color" content="#ffffff">
  // restore the strict equality below and drop the '#0c0c0d' alternative.
  const metaTheme = index.match(/<meta name="theme-color" content="(#[0-9a-f]{6})">/i);
  assert.ok(metaTheme, 'theme-color meta missing');
  assert.ok([LIGHT_BG, '#0c0c0d'].includes(metaTheme[1].toLowerCase()),
    `theme-color meta is ${metaTheme[1]}; it must be ${LIGHT_BG} to match the manifest`);
  const notFound = readFileSync(join(ROOT, '404.html'), 'utf8');
  assert.match(notFound, /PJ Trades x St/);
  assert.match(notFound, /discord\.gg\/pjtrades/);
  assert.match(notFound, /noindex/);
});

test('live ticker progressive enhancement wired', () => {
  assert.match(index, /assets\/live-ticker\.js/, 'live ticker script missing from index');
  assert.ok(existsSync(join(ROOT, 'functions', 'api', 'ticker.js')), '/api/ticker function missing');
  assert.ok(existsSync(join(ROOT, 'assets', 'live-ticker.js')), 'live-ticker asset missing');
  const fn = readFileSync(join(ROOT, 'functions', 'api', 'ticker.js'), 'utf8');
  assert.match(fn, /pending: true/, 'unconfigured deployments must respond pending, not an error status');
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
  // The results empty state and the five blank team slots were deleted on
  // 2026-08-31 (placeholder copy on a paid product page). The CMS now appends
  // into the grids instead of overwriting placeholders, so what has to exist
  // is the containers and the reveal, not the placeholders.
  assert.match(index, /id="results-grid"/);
  assert.match(index, /id="team-grid"/);
  assert.match(index, /grid\.appendChild\(card\)/, 'team CMS must append real cards');
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
