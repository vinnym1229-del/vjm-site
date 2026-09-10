// Regression contracts for bug classes actually hit on this site. Each test
// names the incident it guards against — if one fails, read that history
// before "fixing" the test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const PAGES = readdirSync(ROOT).filter((f) => f.endsWith('.html'));

// ---------------------------------------------------------------------------
// Incident: #bundles and #wins were referenced from six pages (including the
// homepage Join button) but never existed, so those clicks jumped nowhere.
test('every same-site fragment link resolves to a real id', () => {
  const ids = {};
  for (const p of PAGES) ids[p] = new Set([...read(p).matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const broken = [];
  for (const p of PAGES) {
    const html = read(p);
    for (const m of html.matchAll(/href="(?:([a-z0-9-]+\.html))?#([A-Za-z0-9_-]+)"/g)) {
      const target = m[1] || p;
      if (!ids[target]) continue; // link to a non-page (should not happen)
      if (!ids[target].has(m[2])) broken.push(`${p} -> ${target}#${m[2]}`);
    }
  }
  assert.deepEqual(broken, [], `broken fragment links:\n  ${broken.join('\n  ')}`);
});

// ---------------------------------------------------------------------------
// Incident: research-engine.html's premium access-code field carried
// autocomplete="current-password" while every other copy of the same gate
// (stock-lab, premium-guidance, futures-dissection, psychology-enhancer,
// stock-breakdown, options-lab) used "off" -- a copy-paste divergence that
// invited browsers to offer saved account passwords for autofill into a
// one-time access code field.
test('every premium/member access-code input opts out of password autofill', () => {
  const offenders = [];
  for (const p of PAGES) {
    const html = read(p);
    for (const m of html.matchAll(/<input\b[^>]*\btype="password"[^>]*>/g)) {
      const tag = m[0];
      if (!/placeholder="[^"]*access code"/i.test(tag)) continue;
      if (!/autocomplete="off"/.test(tag)) offenders.push(`${p}: ${tag}`);
    }
  }
  assert.deepEqual(offenders, [], `access-code inputs without autocomplete="off":\n  ${offenders.join('\n  ')}`);
});

// ---------------------------------------------------------------------------
// Incident: the premium/course unlock flow posts its result text ("Enter
// your access code", "Incorrect code.", "Premium unlocked...") into a plain
// div with no role or aria-live -- on stock-lab.html's #premiumMsg, and on
// the four curriculum pages' shared .lock-msg (set via assets/curriculum.js's
// setMsg()) -- while the identical flow on premium-guidance.html
// (#guidance-msg) and research-engine.html (#gateMessage) both mark their
// status node role="status" aria-live="polite". A screen-reader user who
// submits a right or wrong access code on the affected pages hears nothing
// happen; on the two unaffected pages they hear the result.
test('every premium/course unlock status message is an announced live region', () => {
  const offenders = [];
  for (const p of PAGES) {
    const html = read(p);
    for (const m of html.matchAll(/<div class="lock-msg"[^>]*>/g)) {
      if (!/role="status"/.test(m[0]) || !/aria-live="polite"/.test(m[0])) offenders.push(`${p}: ${m[0]}`);
    }
    const premiumMsg = html.match(/<div[^>]*\bid="premiumMsg"[^>]*>/);
    if (premiumMsg && (!/role="status"/.test(premiumMsg[0]) || !/aria-live="polite"/.test(premiumMsg[0]))) {
      offenders.push(`${p}: ${premiumMsg[0]}`);
    }
  }
  assert.deepEqual(offenders, [], `unlock status messages missing role="status"/aria-live="polite":\n  ${offenders.join('\n  ')}`);
});

// ---------------------------------------------------------------------------
// Incident: the same silent-status-change defect as the unlock-message fix
// above, on a different flow. forex-calendar.html's #calendar-status and
// #finance-news-status divs, and premarket.html's #statusRow chip, all get
// their text swapped by inline-script fetches (loadCalendar(),
// loadYahooNews(), statusChip()) with no role or aria-live anywhere on the
// page -- e.g. a throttled feed silently relabels "Live" as "Cached" and a
// screen-reader user hears nothing change.
test('live-refreshing calendar/premarket status regions are announced', () => {
  const offenders = [];
  const checks = [
    ['forex-calendar.html', 'calendar-status'],
    ['forex-calendar.html', 'finance-news-status'],
    ['premarket.html', 'statusRow'],
  ];
  for (const [page, id] of checks) {
    const html = read(page);
    const m = html.match(new RegExp(`<div[^>]*\\bid="${id}"[^>]*>`));
    if (!m) { offenders.push(`${page}: #${id} not found`); continue; }
    if (!/role="status"/.test(m[0]) || !/aria-live="polite"/.test(m[0])) offenders.push(`${page}: ${m[0]}`);
  }
  assert.deepEqual(offenders, [], `status regions missing role="status"/aria-live="polite":\n  ${offenders.join('\n  ')}`);
});

// ---------------------------------------------------------------------------
// Incident: the same silent-status-change defect once more on this same
// page, missed by the fix above because it's a second, independent status
// widget in the hero rather than the #calendar-status/#finance-news-status
// pair. setMode() rewrites the hero status card's #feed-mode ("Loading" ->
// "Live feed"/"Cached feed"/"Live feed blocked") and #feed-message together
// on every loadCalendar() run (including the manual Refresh button), with no
// role or aria-live anywhere on either node -- a screen-reader user hits
// Refresh and hears nothing when the feed comes back live, cached, or dead.
test('forex-calendar.html hero feed-status pair is an announced live region', () => {
  const html = read('forex-calendar.html');
  const m = html.match(/<div role="status" aria-live="polite">\s*<b id="feed-mode">[^<]*<\/b>\s*<p id="feed-message">[\s\S]*?<\/p>\s*<\/div>/);
  assert.ok(m, '#feed-mode/#feed-message not wrapped in an announced role="status" region');
});

// ---------------------------------------------------------------------------
// Incident: the identical silent-status-change pattern as the two checks
// above, one flow over -- and missed by that run because it isn't a
// calendar/premarket page. stock-lab.html's free "Basic Stock Research" tool
// has its own status() helper (distinct from #premiumMsg's unlock flow,
// already covered by the first test in this file) that rewrites #basicStatus
// and #newsStatus between "Loading...", a success line, and a "feed
// unavailable" line via runBasicResearch()/loadNews(), with no role or
// aria-live on either node. A screen-reader user researching a free ticker
// hears nothing when the Yahoo feed falls back to "unavailable here."
test('stock-lab.html basic-research status regions are announced', () => {
  const offenders = [];
  const checks = [
    ['stock-lab.html', 'basicStatus'],
    ['stock-lab.html', 'newsStatus'],
  ];
  for (const [page, id] of checks) {
    const html = read(page);
    const m = html.match(new RegExp(`<div[^>]*\\bid="${id}"[^>]*>`));
    if (!m) { offenders.push(`${page}: #${id} not found`); continue; }
    if (!/role="status"/.test(m[0]) || !/aria-live="polite"/.test(m[0])) offenders.push(`${page}: ${m[0]}`);
  }
  assert.deepEqual(offenders, [], `status regions missing role="status"/aria-live="polite":\n  ${offenders.join('\n  ')}`);
});

// ---------------------------------------------------------------------------
// Incident: the same silent-status-change pattern once more, on stock-lab.html's
// actual research output panels -- distinct from #basicStatus/#newsStatus
// above (short one-line status text) and #premiumMsg (the unlock-flow
// message), already covered. #basicReport and #premiumReport are the result
// panels runBasicResearch()/runPremiumResearch() rewrite with the quote and
// research summary, triggered by a user clicking Research or selecting a
// watchlist stock -- a direct result of a user action, the same case as
// research-engine.html's module status spans above, not a page-load brief
// like premarket.html's #narrative (deliberately left alone elsewhere). A
// screen-reader user who clicks Research hears nothing when the result
// panel updates.
test('stock-lab.html research result panels are announced', () => {
  const offenders = [];
  const ids = ['basicReport', 'premiumReport'];
  const html = read('stock-lab.html');
  for (const id of ids) {
    const m = html.match(new RegExp(`<div[^>]*\\bid="${id}"[^>]*>`));
    if (!m) { offenders.push(`${id}: not found`); continue; }
    if (!/role="status"/.test(m[0]) || !/aria-live="polite"/.test(m[0])) offenders.push(`stock-lab.html: ${m[0]}`);
  }
  assert.deepEqual(offenders, [], `status regions missing role="status"/aria-live="polite":\n  ${offenders.join('\n  ')}`);
});

// ---------------------------------------------------------------------------
// Incident: the same silent-status-change pattern once more, on the Lesson
// Assistant's own coverage line. premium-guidance.html's #lesson-coverage
// <p> is rewritten by loadLessonCatalogue() between a sign-in/no-lessons
// error and a "N lessons available to your membership" summary, with no
// role or aria-live -- a screen-reader user opening the assistant hears
// nothing when the lesson list finishes loading or fails to load at all.
test('premium-guidance.html lesson-coverage status region is announced', () => {
  const html = read('premium-guidance.html');
  const m = html.match(/<p[^>]*\bid="lesson-coverage"[^>]*>/);
  assert.ok(m, '#lesson-coverage not found');
  assert.match(m[0], /role="status"/, `missing role="status": ${m[0]}`);
  assert.match(m[0], /aria-live="polite"/, `missing aria-live="polite": ${m[0]}`);
});

// ---------------------------------------------------------------------------
// Incident: the same silent-status-change pattern again, on the site's paid
// flagship tool. research-engine.html's #storageStatus and its four
// #*SourceStatus spans (loadOptions/loadStock/loadSectors/loadBiotech,
// plus the shared showModuleError() helper) rewrite between "Waiting to
// load"/"Checking", a loading message, a success summary, and an error or
// "Locked on your current plan." with no role or aria-live anywhere --
// distinct from #gateMessage/#planNotice (the entitlement-gate messages,
// already covered) since these are the module data-load status nodes. A
// Complete-tier member using a screen reader gets no announcement that a
// module finished loading, failed, or is plan-locked.
test('research-engine.html module status regions are announced', () => {
  const offenders = [];
  const ids = ['storageStatus', 'optionsSourceStatus', 'stockSourceStatus', 'sectorSourceStatus', 'biotechSourceStatus'];
  const html = read('research-engine.html');
  for (const id of ids) {
    const m = html.match(new RegExp(`<[a-z]+[^>]*\\bid="${id}"[^>]*>`));
    if (!m) { offenders.push(`${id}: not found`); continue; }
    if (!/role="status"/.test(m[0]) || !/aria-live="polite"/.test(m[0])) offenders.push(`research-engine.html: ${m[0]}`);
  }
  assert.deepEqual(offenders, [], `status regions missing role="status"/aria-live="polite":\n  ${offenders.join('\n  ')}`);
});

// ---------------------------------------------------------------------------
// Incident: index.html's hero stream countdown (#cd-status, tickCountdown()
// every 1s) and schedule-section clock (#session-clock, tickSessionClock()
// every 30s) were the last two silent-status-change gaps in this class of
// bug, left unclaimed across several runs specifically because they tick so
// often -- a naive role="status" aria-live="polite" would make a screen
// reader re-announce the identical "Next: NYAM -- Today 9:30 AM ET" line
// every single tick forever, which is worse than the original silence. Both
// ticks now guard their innerHTML write behind an equality check (setStatus/
// setEl below tickCountdown/tickSessionClock) so the DOM -- and therefore
// the live region -- only actually changes when the announced text does:
// the next session changes, a session goes LIVE, or the weekend toggles.
test('index.html countdown/session-clock status regions are announced', () => {
  const html = read('index.html');
  for (const [tag, id] of [['span', 'cd-status'], ['div', 'session-clock']]) {
    const m = html.match(new RegExp(`<${tag}[^>]*\\bid="${id}"[^>]*>`));
    assert.ok(m, `#${id} not found`);
    assert.match(m[0], /role="status"/, `#${id} missing role="status": ${m[0]}`);
    assert.match(m[0], /aria-live="polite"/, `#${id} missing aria-live="polite": ${m[0]}`);
  }
});

test("index.html session-clock only re-announces when its status text actually changes", () => {
  const index = read('index.html');
  const sessionsSrc = index.match(/const PJ_SESSIONS = \[[\s\S]*?\n\];/)[0];
  const dayNamesSrc = index.match(/const PJ_DAY_NAMES = \[[^\]]*\];/)[0];
  const nextSessionSrc = index.match(/function pjNextSession\(\) \{[\s\S]*?\n\}\n/)[0];
  const fmtClockSrc = index.match(/function pjFmtClock\(mins\) \{[\s\S]*?\n\}\n/)[0];
  const tickSrc = index.match(/function tickSessionClock\(\) \{[\s\S]*?\n\}\n/)[0];
  assert.ok(tickSrc, 'tickSessionClock() not found');

  const writes = [];
  const el = {
    _html: '',
    get innerHTML() { return this._html; },
    set innerHTML(v) { writes.push(v); this._html = v; },
  };
  const sandbox = {
    document: { getElementById: (id) => (id === 'session-clock' ? el : null) },
    __FAKE_NOW__: null,
  };
  vm.createContext(sandbox);
  vm.runInContext(
    'function pjEtNow(){ const n = __FAKE_NOW__; return new Date(n.y, n.m, n.d, n.h, n.min); }\n' +
    sessionsSrc + '\n' + dayNamesSrc + '\n' + nextSessionSrc + '\n' + fmtClockSrc + '\n' + tickSrc +
    'this.tickSessionClock = tickSessionClock;',
    sandbox,
  );

  // A real Tuesday, 7:00am ET -- NYAM (9:30) is next, well before it starts.
  const tue = new Date(2024, 0, 2);
  sandbox.__FAKE_NOW__ = { y: tue.getFullYear(), m: tue.getMonth(), d: tue.getDate(), h: 7, min: 0 };
  sandbox.tickSessionClock();
  sandbox.tickSessionClock();
  assert.equal(writes.length, 1, 'must not rewrite the announced status text on a tick when nothing changed');
  assert.match(writes[0], /Next up: NYAM/);

  sandbox.__FAKE_NOW__ = { y: tue.getFullYear(), m: tue.getMonth(), d: tue.getDate(), h: 7, min: 5 };
  sandbox.tickSessionClock();
  assert.equal(writes.length, 1, 'a few minutes passing with the same next session must not trigger a re-announce');

  // Cross into the NYAM window -- the status text genuinely changes to LIVE.
  sandbox.__FAKE_NOW__ = { y: tue.getFullYear(), m: tue.getMonth(), d: tue.getDate(), h: 9, min: 31 };
  sandbox.tickSessionClock();
  assert.equal(writes.length, 2, 'a genuine state change (session goes live) must still be announced');
  assert.match(writes[1], /LIVE now/);
});

test('index.html hero countdown status only re-announces when its text actually changes', () => {
  const index = read('index.html');
  const sessionsSrc = index.match(/const PJ_SESSIONS = \[[\s\S]*?\n\];/)[0];
  const dayNamesSrc = index.match(/const PJ_DAY_NAMES = \[[^\]]*\];/)[0];
  const nextSessionSrc = index.match(/function pjNextSession\(\) \{[\s\S]*?\n\}\n/)[0];
  const fmtClockSrc = index.match(/function pjFmtClock\(mins\) \{[\s\S]*?\n\}\n/)[0];
  const tickSrc = index.match(/function tickCountdown\(\) \{[\s\S]*?\n\}\n/)[0];
  assert.ok(tickSrc, 'tickCountdown() not found');

  const writes = [];
  const status = {
    _html: '',
    get innerHTML() { return this._html; },
    set innerHTML(v) { writes.push(v); this._html = v; },
  };
  const display = { textContent: '', className: '' };
  const bar = { style: {} };
  const sandbox = {
    document: {
      getElementById: (id) => (id === 'cd-status' ? status : id === 'cd-display' ? display : id === 'stream-countdown-bar' ? bar : null),
    },
    __FAKE_NOW__: null,
  };
  vm.createContext(sandbox);
  vm.runInContext(
    'function pjEtNow(){ const n = __FAKE_NOW__; return new Date(n.y, n.m, n.d, n.h, n.min); }\n' +
    sessionsSrc + '\n' + dayNamesSrc + '\n' + nextSessionSrc + '\n' + fmtClockSrc + '\n' + tickSrc +
    'this.tickCountdown = tickCountdown;',
    sandbox,
  );

  // A real Tuesday, 7:00am ET -- ticking every second while NYAM is still
  // over two hours out must not touch #cd-status a second time.
  const tue = new Date(2024, 0, 2);
  sandbox.__FAKE_NOW__ = { y: tue.getFullYear(), m: tue.getMonth(), d: tue.getDate(), h: 7, min: 0 };
  sandbox.tickCountdown();
  sandbox.tickCountdown();
  assert.equal(writes.length, 1, 'must not rewrite #cd-status on a tick when the announced text is unchanged');
  assert.match(writes[0], /Next: NYAM/);

  // Cross into the NYAM window -- a genuine transition must still announce.
  sandbox.__FAKE_NOW__ = { y: tue.getFullYear(), m: tue.getMonth(), d: tue.getDate(), h: 9, min: 31 };
  sandbox.tickCountdown();
  assert.equal(writes.length, 2, 'a genuine state change (session goes live) must still be announced');
  assert.match(writes[1], /LIVE NOW/);
});

// ---------------------------------------------------------------------------
// Incident: replacing a quiz question without re-pointing the JSON answer key
// (a sibling <script type="application/json"> keyed by choice index) would
// silently grade the quiz wrong.
const COURSE_PAGES = ['stock-breakdown.html', 'options-lab.html', 'futures-dissection.html', 'psychology-enhancer.html'];
test('every quiz keeps its answer key in sync with its markup', () => {
  for (const p of COURSE_PAGES) {
    const html = read(p);
    const quizzes = html.match(/<div class="quiz">[\s\S]*?<script type="application\/json">[\s\S]*?<\/script>/g) || [];
    assert.ok(quizzes.length > 0, `${p}: no quizzes found`);
    quizzes.forEach((q, qi) => {
      const key = JSON.parse(/<script type="application\/json">([\s\S]*?)<\/script>/.exec(q)[1]);
      const questions = q.match(/class="quiz-q" data-qi="\d+"/g) || [];
      assert.equal(questions.length, key.length, `${p} quiz #${qi}: ${questions.length} questions vs ${key.length} key entries`);
      const blocks = q.split(/<div class="quiz-q" data-qi="\d+">/).slice(1);
      blocks.forEach((b, bi) => {
        const choices = (b.match(/type="radio"/g) || []).length;
        const correct = key[bi].correct;
        assert.ok(Number.isInteger(correct) && correct >= 0 && correct < choices,
          `${p} quiz #${qi} q${bi}: correct=${correct} outside 0..${choices - 1}`);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Business rule (owner decision 2026-08): the ONLY free course content is the
// futures starter course Level 1; the psychology essay stays public.
test('free tier is exactly the futures starter course + the essay', () => {
  const futures = read('futures-dissection.html');
  const fL1 = /<section class="level-panel active" data-level="1"[\s\S]*?<\/section>/.exec(futures)[0];
  assert.doesNotMatch(fL1, /lock-gate/, 'futures L1 must stay free');

  for (const p of ['stock-breakdown.html', 'options-lab.html']) {
    const html = read(p);
    const L1 = /<section class="level-panel active" data-level="1"[\s\S]*?lock-gate/.exec(html);
    assert.ok(L1, `${p}: Level 1 must be gated`);
  }
  const psych = read('psychology-enhancer.html');
  for (const pair of ['psych-A', 'psych-B', 'psych-C']) {
    const re = new RegExp(`<section class="level-panel active" data-level="1" data-pair="${pair}"[\\s\\S]{0,900}lock-gate`);
    assert.match(psych, re, `${pair} L1 must be gated`);
  }
  // Essay is public: its section opens before any gated wrapper around it.
  const essayIdx = psych.indexOf('<section class="essay" id="essay">');
  assert.ok(essayIdx > -1, 'essay section missing');
  const before = psych.slice(0, essayIdx);
  const opens = (before.match(/class="gated-content" hidden/g) || []).length;
  const closesNeeded = opens; // every gated block before the essay must be closed before it
  assert.ok(opens === 0 || psych.slice(0, essayIdx).split('gated-content').length >= closesNeeded,
    'essay must not sit inside a gated block');
  assert.doesNotMatch(before, /class="gated-content" hidden>(?![\s\S]*?<\/section>)/, 'essay preceded by unclosed gate');
});

// ---------------------------------------------------------------------------
// Incident: the discipline essay's Robinhood-attention citation read
// "(2, 3141)" -- a stray numbered-citation-style "2" spliced onto the real
// MLA page number (3141, Barber et al.'s Journal of Finance article, cited
// correctly elsewhere on the same page). "2" isn't a page in that article's
// own 3141-3190 range and doesn't match any citation convention the essay
// uses anywhere else. This is the site's free, citation-backed essay --
// unlike its paid siblings, a reader can actually check the sourcing, and
// this citation didn't parse.
test("psychology essay's Robinhood citation matches its own MLA convention", () => {
  const psych = read('psychology-enhancer.html');
  assert.doesNotMatch(psych, /\(2, 3141\)/, 'stray numbered-citation index spliced onto an MLA page number');
  assert.match(psych, /most-bought stocks averaging &minus;4\.7% over the following 20 days \(Barber et al\. 3141\)/,
    'Robinhood attention-trading claim must cite Barber et al. by name and page, like every other citation of this source on the page');
});

// Incident: two more citations to Barber, Lee, Liu, and Odean's 2017 paper
// ("Do Day Traders Rationally Learn About Their Ability?") gave specific
// pages -- "(Barber et al. 2)" and "(Barber et al. 2, 19)" -- but that
// paper's own Works Cited entry lists no page range at all (it's a working
// paper, unlike the 2022 Journal of Finance article cited elsewhere on the
// page, which does have pages and is cited with them). A reader following
// the citation to check page 2 or 19 has nothing to check it against. MLA
// omits the page number entirely when a source has none; the fix drops the
// fabricated pages rather than inventing a page range this repo can't verify.
test("psychology essay's 2017 Barber et al. citations don't cite pages its own bibliography doesn't give", () => {
  const psych = read('psychology-enhancer.html');
  assert.doesNotMatch(psych, /\(Barber et al\. 2\)/, 'page cited against a source with no page range');
  assert.doesNotMatch(psych, /\(Barber et al\. 2, 19\)/, 'page range cited against a source with no page range');
  const worksCited = psych.match(/Barber, Brad M\., Yi-Tsung Lee[^<]*<\/li>/)?.[0] || '';
  assert.doesNotMatch(worksCited, /pp?\.\s*\d/, 'this Works Cited entry has no pagination -- if that ever changes, the in-text citations above should cite the real pages instead of none');
});

// ---------------------------------------------------------------------------
// Incident: four API routes shipped without rate limiting; one exposed a
// brute-forceable shared secret.
test('every API route is rate limited (webhook + logout excepted)', () => {
  const EXEMPT = new Set([
    'logout-premium.js', // destroys a session; nothing to brute-force
    'whop-webhook.js',   // HMAC-verified; limiting risks dropping provider bursts
  ]);
  const dir = join(ROOT, 'functions', 'api');
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    if (EXEMPT.has(f)) continue;
    assert.match(readFileSync(join(dir, f), 'utf8'), /checkRateLimit/, `${f} has no rate limit`);
  }
});

// ---------------------------------------------------------------------------
// Incident: CSP silently blocked Turnstile (which would have locked every
// member out once the secret key was set) and later Google Sign-In's styles
// and Cloudflare's analytics beacon.
test('CSP allowlists every third-party host the site actually uses', () => {
  const csp = /Content-Security-Policy: ([^\n]+)/.exec(read('_headers'))[1];
  const need = {
    'script-src': ['challenges.cloudflare.com', 'static.cloudflareinsights.com', 'accounts.google.com', 's3.tradingview.com'],
    'style-src': ['accounts.google.com', 'fonts.googleapis.com'],
    'connect-src': ['challenges.cloudflare.com', 'cloudflareinsights.com', 'alpaca.markets'],
    'frame-src': ['challenges.cloudflare.com', 'accounts.google.com', 'tradingview.com'],
  };
  for (const [directive, hosts] of Object.entries(need)) {
    const seg = new RegExp(`${directive} ([^;]+)`).exec(csp);
    assert.ok(seg, `${directive} missing from CSP`);
    for (const h of hosts) assert.ok(seg[1].includes(h), `CSP ${directive} lost ${h}`);
  }
});

// ---------------------------------------------------------------------------
// Incident: .gitignore had no env pattern while .env.example invites copying
// it to .env — one `git add -A` away from committing real secrets.
test('.gitignore blocks real env files but keeps the example', () => {
  const gi = read('.gitignore');
  assert.match(gi, /^\.env$/m);
  assert.match(gi, /^\.env\.\*$/m);
  assert.match(gi, /^!\.env\.example$/m);
});

// ---------------------------------------------------------------------------
// Incident: generator artifacts ('---', ' -</p>', literal **bold**) shipped
// inside lesson prose across all four course pages.
test('no generator artifacts in course prose', () => {
  for (const p of COURSE_PAGES) {
    const html = read(p);
    assert.doesNotMatch(html, /---(?![-])/, `${p}: stray --- artifact`);
    assert.doesNotMatch(html, /[a-z0-9)]\. -<\/p>/, `${p}: stray trailing dash`);
    assert.doesNotMatch(html, /\*\*[A-Za-z]/, `${p}: unrendered **markdown**`);
  }
});

// ---------------------------------------------------------------------------
// Incident: homepage CSS was extracted to assets/site.css; a typo'd link
// would ship an unstyled homepage that tests reading raw HTML would miss.
test('homepage links its extracted stylesheet and the file is substantial', () => {
  assert.match(read('index.html'), /<link rel="stylesheet" href="assets\/site\.css(\?v=[\w.-]+)?">/);
  assert.ok(existsSync(join(ROOT, 'assets', 'site.css')), 'assets/site.css missing');
  assert.ok(read('assets/site.css').length > 50000, 'site.css suspiciously small — extraction broken?');
});

// ---------------------------------------------------------------------------
// Incident: /v2/stocks/snapshots shape bug was fixed in the shared lib but
// lived on in two routes that carried their own copy of the fetch.
test('no route reads data.snapshots from the stocks snapshot endpoint without a top-level fallback', () => {
  const dir = join(ROOT, 'functions', 'api');
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const src = readFileSync(join(dir, f), 'utf8');
    if (!src.includes('/v2/stocks/snapshots')) continue;
    assert.ok(/data\.snapshots\) \? data\.snapshots : data|top level/i.test(src),
      `${f} fetches /v2/stocks/snapshots but may still assume a .snapshots wrapper`);
  }
});

// ---------------------------------------------------------------------------
// Incident: the brand-unification pass (657a6fa) renamed the nav brand to
// PJ TRADES everywhere except privacy.html, terms.html, and risk-disclosure.html,
// which still showed the pre-rebrand "ST TRADES" — stale legal-page branding
// undiscovered because no test read those three pages' nav markup.
test('no page still shows the pre-rebrand ST TRADES brand name', () => {
  const stale = PAGES.filter((p) => /class="(?:brand|nav-brand)"[^>]*>\s*ST TRADES\s*</.test(read(p)));
  assert.deepEqual(stale, [], `pages with stale brand name:\n  ${stale.join('\n  ')}`);
});

// ---------------------------------------------------------------------------
// Incident: a later sweep (602b6f2) cleared "ST TRADES" from titles, og:title,
// JSON-LD, footers, and copyright lines but assumed the nav brand was already
// clean — it had actually been left as PJ TRADES <span>× ST</span> on five
// pages (futures-dissection, premium-guidance, stock-breakdown,
// psychology-enhancer, stock-lab). The regex above only matches a bare
// "ST TRADES" string, so it never saw this trailing "× ST" fragment and
// passed while the leftover branding stayed live.
test('the nav brand carries no leftover "x ST" suffix', () => {
  const stale = PAGES.filter((p) => {
    const m = /class="(?:brand|nav-brand)"[^>]*>([\s\S]*?)<\/a>/.exec(read(p));
    return m && /(?:x|×)\s*ST\b/i.test(m[1]);
  });
  assert.deepEqual(stale, [], `pages with a leftover "x ST" brand suffix:\n  ${stale.join('\n  ')}`);
});

// ---------------------------------------------------------------------------
// Incident: the same two brand-cleanup sweeps (602b6f2, a96acd9) only ever
// grepped .html files, so manifest.json's own "name" field -- what a visitor
// who installs the site as a PWA sees on their home screen and splash
// screen -- kept the pre-rebrand "PJ Trades x St" suffix while every HTML
// brand surface was already clean.
test('the PWA manifest name carries no leftover "x St" suffix', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.ok(!/(?:x|×)\s*St\b/i.test(manifest.name), `manifest.json name still has a leftover brand suffix: "${manifest.name}"`);
});

// ---------------------------------------------------------------------------
// Incident: 96 of 100 quiz answers were the longest option, so a member who
// never opened a lesson scored 96% by always picking the longest. Chance is
// 25%; this pins the leak closed.
test('quizzes do not leak their answers through option length', async () => {
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync(process.execPath, [join(ROOT, 'tools', 'quiz-audit.mjs')],
    { cwd: ROOT, encoding: 'utf8' });
  const m = /OVERALL\s+\d+ questions\s+longest-is-correct\s+(\d+)%/.exec(out);
  assert.ok(m, `quiz-audit produced no OVERALL line:\n${out}`);
  const pct = Number(m[1]);
  assert.ok(pct <= 45, `correct answer is the longest option ${pct}% of the time (chance is 25%):\n${out}`);
});

// ---------------------------------------------------------------------------
// Course pages carry Course structured data so they are eligible for rich
// results; isAccessibleForFree must track the real gating.
test('course pages ship Course JSON-LD matching the free-tier rule', () => {
  // Every course page is a PAID course: futures-dissection used to claim
  // isAccessibleForFree:true for the whole four-level course when only Level 1
  // is ungated, which advertises three paid levels as free. The free unit is
  // now modelled where it actually is — a hasPart Course that is itself free —
  // so the parent course is correctly false on all four pages.
  for (const page of ['futures-dissection.html', 'stock-breakdown.html', 'options-lab.html', 'psychology-enhancer.html']) {
    const m = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(read(page));
    assert.ok(m, `${page}: no JSON-LD block`);
    const ld = JSON.parse(m[1]);
    assert.equal(ld['@type'], 'Course', `${page}: JSON-LD is not a Course`);
    assert.equal(ld.isAccessibleForFree, false, `${page}: a paid course must not be marked free`);
    assert.ok(ld.name && ld.description && ld.url, `${page}: Course missing name/description/url`);
    // Unsupported claims: numberOfCredits was a lesson count (not credit
    // hours) and courseWorkload was never-measured seat time.
    assert.equal(ld.numberOfCredits, undefined, `${page}: numberOfCredits is not a lesson count`);
    assert.equal(ld.hasCourseInstance?.courseWorkload, undefined, `${page}: unmeasured courseWorkload must stay removed`);
    // Offers must be purchasable: Futures Core is $100/mo and covers futures
    // + psychology; Complete is $129/mo and adds stocks and options
    // (functions/api/_lib/entitlements.js is the authority on that split).
    const expectedPrice = ['futures-dissection.html', 'psychology-enhancer.html'].includes(page) ? '100.00' : '129.00';
    assert.equal(ld.offers?.price, expectedPrice, `${page}: offer must match the tier that unlocks it`);
  }
  // Futures Level 1 is genuinely ungated, and only that unit.
  const futuresLd = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(read('futures-dissection.html'))[1]);
  assert.equal(futuresLd.hasPart?.isAccessibleForFree, true, 'futures Level 1 is the free starter unit and must be modelled as such');
});

// Canonical/social URLs use one origin at the root path shape (no /pj/), so
// search engines are not asked to choose between two URLs for one page.
test('course and member pages agree on one canonical origin and path shape', () => {
  const ORIGIN = 'https://not-financial-advice-vjm.com';
  const pages = {
    'futures-dissection.html': '/futures-dissection',
    'stock-breakdown.html': '/stock-breakdown',
    'options-lab.html': '/options-lab',
    'psychology-enhancer.html': '/psychology-enhancer',
    'premium-guidance.html': '/premium-guidance',
  };
  for (const [page, path] of Object.entries(pages)) {
    const src = read(page);
    const url = ORIGIN + path;
    for (const [label, re] of [
      ['canonical', /<link rel="canonical" href="([^"]+)"/],
      ['og:url', /<meta property="og:url" content="([^"]+)"/],
      ['twitter:url', /<meta name="twitter:url" content="([^"]+)"/],
    ]) {
      const m = re.exec(src);
      assert.ok(m, `${page}: missing ${label}`);
      assert.equal(m[1], url, `${page}: ${label} must be ${url}`);
    }
    assert.doesNotMatch(src.replace(/<!--[\s\S]*?-->/g, ''), /not-financial-advice-vjm\.com\/pj\//,
      `${page}: /pj/ path prefix must be gone`);
  }
  // The member sign-in page stays out of the index whatever the site decides.
  assert.match(read('premium-guidance.html'), /<meta name="robots" content="noindex,nofollow">/);
});

// ---------------------------------------------------------------------------
// Incident: the canonical-origin decision (robots.txt, sitemap.xml, every
// page's canonical/OG tags, and functions/api/_lib/indexing.js's
// CANONICAL_HOST) settled on the hyphenated not-financial-advice-vjm.com, and
// tests/indexing.test.mjs even pins the un-hyphenated form as a rejected,
// non-canonical host. INSTALL-FIRST.md never got the memo: it told a fresh
// owner to set the GitHub Actions RESEARCH_REFRESH_URL secret to
// notfinancialadvicevjm.com, a host research-refresh.yml/morning-automation.yml/
// audit-live-hero.yml would then curl against instead of the live site,
// silently failing the automation those workflows exist to run.
test('setup docs point automation at the real canonical domain, not the un-hyphenated one', () => {
  for (const doc of ['INSTALL-FIRST.md', 'docs/research-engine-setup.md']) {
    assert.doesNotMatch(read(doc), /notfinancialadvicevjm\.com/,
      `${doc} references the un-hyphenated, non-canonical domain`);
  }
});

// Incident: the same un-hyphenated/hyphenated mixup above was also fixed in
// INSTALL-FIRST.md and docs/research-engine-setup.md on 2026-09-05, but
// docs/API.md and docs/ARCHITECTURE.md were never checked — both still
// declared the un-hyphenated notfinancialadvicevjm.com "canonical" (backwards
// from what indexing.js/robots.txt/sitemap.xml/tests/indexing.test.mjs all
// settled on), actively misdirecting a developer following API.md or an
// owner reading ARCHITECTURE.md's domain section.
test('reference docs declare the real canonical domain, not the un-hyphenated one', () => {
  for (const doc of ['docs/API.md', 'docs/ARCHITECTURE.md']) {
    assert.doesNotMatch(read(doc), /notfinancialadvicevjm\.com/,
      `${doc} references the un-hyphenated, non-canonical domain`);
  }
});

// Incident: functions/api/yahoo-news.js's own header comment documents that
// it dropped Yahoo's RSS feed (retired -- 404s/429s now) for the
// query1.finance.yahoo.com JSON search endpoint, but docs/API.md,
// docs/ARCHITECTURE.md, and docs/SECURITY.md all still called it "RSS"
// headlines / a "Yahoo RSS host", describing a host the deployment no longer
// calls and never naming the one it does -- exactly what docs/SECURITY.md's
// SSRF allowlist note exists to get right. docs/API.md also never documented
// the `topic` parameter at all, even though forex-calendar.html's headline
// panel calls the route with `?topic=forex` against a real, closed TOPICS
// allowlist in the handler.
test('yahoo-news docs describe the real JSON endpoint and the topic parameter, not RSS', () => {
  for (const doc of ['docs/API.md', 'docs/ARCHITECTURE.md', 'docs/SECURITY.md']) {
    assert.doesNotMatch(read(doc), /\bRSS headlines\b|\bRSS host\b|sanitized RSS/i,
      `${doc} still claims yahoo-news.js serves RSS`);
  }
  assert.match(read('docs/API.md'), /topic=/, 'docs/API.md must document the topic= parameter');
  assert.match(read('docs/SECURITY.md'), /query1\.finance\.yahoo\.com/,
    'docs/SECURITY.md must name the actual allowlisted Yahoo host');
});

// Incident: removing the homepage's "Live From PJ's Desk" section (2026-09-08)
// deleted the site's only consumer of the announcements/trade_reviews CMS
// content types (loadLatest(), #latest, .ann-card/.review-card), but
// docs/OWNER-CHECKLIST.md's sheet-sync section -- the line an owner reads to
// learn what filling in a tab actually does -- still promised "fill in
// announcements, team, FAQs, bundles, prop firms, stats, or results whenever
// you're ready and they'll appear on the next hourly sync." Team/FAQs/
// bundles/prop firms/stats/results still render live; announcements no
// longer render anywhere, so an owner following that line would fill in rows
// that sync into the API and then see nothing on the site with no error to
// explain why. Derives which content types actually still have a page-side
// consumer instead of just pinning the prose, so a future page re-adding (or
// removing) a type's renderer is caught here too.
test('docs/OWNER-CHECKLIST.md does not promise a CMS content type the site no longer renders', () => {
  const CONTENT_TYPES = ['announcements', 'trade_reviews', 'prop_firms', 'schedule', 'team', 'faqs', 'bundles', 'stats', 'results'];
  const rendered = new Set();
  for (const page of PAGES) {
    const src = read(page);
    for (const type of CONTENT_TYPES) {
      if (src.includes(`type=${type}`)) rendered.add(type);
    }
  }
  assert.ok(!rendered.has('announcements'),
    'test assumption stale: some page now fetches type=announcements again -- docs/OWNER-CHECKLIST.md can promise it once more');
  assert.ok(!rendered.has('trade_reviews'),
    'test assumption stale: some page now fetches type=trade_reviews again');

  const flat = read('docs/OWNER-CHECKLIST.md').replace(/\s+/g, ' ');
  const promise = /fill in ([^.]*?) whenever you're ready and they'll appear on the next hourly sync/i.exec(flat);
  assert.ok(promise, "docs/OWNER-CHECKLIST.md: expected the sheet-sync tab-fill-in promise");
  assert.doesNotMatch(promise[1], /\bannouncements\b/,
    'docs/OWNER-CHECKLIST.md promises announcements will "appear" but no page renders that content type any more');
});

// ---------------------------------------------------------------------------
// Incident: gating was purely cosmetic. `.gated-content` used `hidden` +
// client-side JS to reveal paid lessons after /api/verify-premium succeeded,
// but the full lesson text (including quiz answer keys) was always present
// in the raw HTML — a plain unauthenticated curl of any course page returned
// every paid lesson for free, no session or payment required. Fixed by
// functions/_middleware.js, which strips .gated-content server-side for any
// request without a valid session, verified live via local wrangler pages
// dev (anonymous request returns 0 bytes of lesson text; a request carrying
// a validly-signed session cookie gets the full page).
test('gated course content is stripped server-side, not just hidden client-side', () => {
  const mw = read('functions/_middleware.js');
  assert.match(mw, /getSession/, 'middleware must check the real session, not reinvent auth');
  assert.match(mw, /HTMLRewriter/, 'middleware must actually transform the response, not just read it');
  assert.match(mw, /\.gated-content/, 'middleware must target the same class the course pages hide with');
  for (const page of COURSE_PAGES) {
    const clean = page.replace(/\.html$/, '');
    assert.match(mw, new RegExp(`['"\`]/${clean}['"\`]`), `${page}: middleware does not gate the extensionless route`);
    assert.match(mw, new RegExp(`['"\`]/${page}['"\`]`), `${page}: middleware does not gate the .html route`);
  }
  // Fail-closed: an error reading the session must not fall through to
  // serving the unstripped page (that would silently reopen the leak).
  assert.match(mw, /catch\s*\{[^}]*authorized\s*=\s*false/, 'session-check errors must default to unauthorized');
});

// ---------------------------------------------------------------------------
// Incident: the testimonials collage on index.html was `loading="lazy"` with
// only `style="width:100%;height:auto"` and no width/height attributes, so
// the browser had no intrinsic size to reserve — the page jumped when the
// 2000x1125 image finally loaded in, right above the "Already a Member?"
// CTA. Every other static lazy image already carried explicit dimensions;
// this pins that every one of them keeps doing so. CMS-driven <img> tags
// built in JS from owner-uploaded photos (unknown dimensions at render time)
// are exempt — this only checks literal <img> tags in the HTML source.
test('every lazy-loaded image reserves its layout space with width/height', () => {
  const offenders = [];
  for (const p of PAGES) {
    const live = read(p).replace(/<script[\s\S]*?<\/script>/g, '').replace(/<!--[\s\S]*?-->/g, '');
    for (const m of live.matchAll(/<img\b[^>]*>/g)) {
      const tag = m[0];
      if (!/loading="lazy"/.test(tag)) continue;
      if (!/\bwidth="\d+"/.test(tag) || !/\bheight="\d+"/.test(tag)) offenders.push(`${p}: ${tag}`);
    }
  }
  assert.deepEqual(offenders, [], `lazy images missing width/height:\n  ${offenders.join('\n  ')}`);
});

// ---------------------------------------------------------------------------
// Incident: three target="_blank" links on index.html (the members-dashboard
// "Join Discord" / "DM Support" cards and the psychology-essay Discord CTA)
// had no rel="noopener", unlike every other external link on the site. A
// target="_blank" page without it keeps a window.opener handle back to this
// tab, so the destination — Discord itself in these cases, but the pattern
// generalizes — could reverse-tabnab a signed-in member. Checked raw source
// (not script-stripped) since some links are JS template strings that render
// HTML anchors too.
test('every target="_blank" link carries rel="noopener"', () => {
  const offenders = [];
  for (const p of PAGES) {
    for (const m of read(p).matchAll(/<a\s[^>]*target="_blank"[^>]*>/g)) {
      if (!/rel="[^"]*noopener/.test(m[0])) offenders.push(`${p}: ${m[0]}`);
    }
  }
  assert.deepEqual(offenders, [], `target="_blank" missing rel="noopener":\n  ${offenders.join('\n  ')}`);
});

// ---------------------------------------------------------------------------
// Incident: tiers became real server-side (functions/api/_lib/entitlements.js:
// futures_core = $100/mo covers Futures + Psychology, complete = $129/mo adds
// Stocks, Options and the research tools) but the course pages never learned
// about them. assets/curriculum.js asked one question — "is there a session?"
// — so a $100 Futures Core member opening /options-lab passed that check,
// unlockAll() hid the gate, and the middleware had already blanked
// .gated-content: a valid paying member got an empty page with no explanation
// and no way to buy the plan that would fix it.
const curriculumJs = read('assets/curriculum.js');

test('a valid session alone no longer unlocks a page the server stripped', () => {
  assert.match(curriculumJs, /data-locked="1"/,
    'the client must read the middleware decision, not just the session');
  assert.match(curriculumJs, /if \(active && !stripped\) \{ unlockAll\(\); return 'entitled'; \}/,
    'unlockAll must require BOTH a session and content the server did not strip');
  assert.match(curriculumJs, /const state = active \? 'under_tier' : 'signed_out';/,
    'signed-in-but-under-tier and signed-out must be told apart');
});

test('a signed-in under-tier member is never shown an access-code box', () => {
  const fn = /function renderUnderTierGate\([\s\S]*?\n  \}/.exec(curriculumJs);
  assert.ok(fn, 'renderUnderTierGate must exist');
  assert.match(fn[0], /qsa\('\.lock-form', gate\)/, 'the code form must be removed for a member who already has a code');
  assert.match(fn[0], /check-status-btn/, 'the "I already unlocked" button is meaningless when already signed in');
  assert.match(fn[0], /core_to_complete_upgrade/, 'the Core -> Complete step must be reported where it happens');
});

test('the upgrade copy is derived from the two real prices and invents nothing', () => {
  // $100 and $129 are the only prices the repo establishes; the $29 step is
  // computed from them rather than typed in, so it cannot drift.
  assert.match(curriculumJs, /futures_core: \{[^}]*price: 100/);
  assert.match(curriculumJs, /complete: \{[^}]*price: 129/);
  assert.match(curriculumJs, /need\.price - held\.price/, 'the upgrade delta must be computed, not asserted');
  const code = curriculumJs.replace(/^\s*\/\/.*$/gm, '');   // prose comments may quote a price
  const priceLiterals = [...code.matchAll(/\$\d[\d,.]*/g)].map((m) => m[0]);
  assert.deepEqual(priceLiterals, [], `curriculum.js must carry no hard-coded price strings: ${priceLiterals.join(', ')}`);
  // No urgency, no member counts, no invented per-plan checkout URL.
  assert.doesNotMatch(curriculumJs, /spots? left|only \d+ left|members? strong|join \d+/i);
  assert.match(curriculumJs, /TODO: owner to confirm per-plan Whop checkout URLs/);
  const whopLinks = [...curriculumJs.matchAll(/https:\/\/whop\.com\/[^\s'"]*/g)].map((m) => m[0]);
  assert.deepEqual([...new Set(whopLinks)], ['https://whop.com/pjtradespremium'],
    'only the Whop listing the site already uses may be linked');
});

test('the lock and upgrade UI renders outside the region the middleware blanks', () => {
  // .gated-content is emptied server-side for exactly the visitors this UI is
  // written for, so anything rendered into it would be invisible to them.
  assert.match(curriculumJs, /attach\(gate, panel\)/, 'plan panels attach to .lock-gate, a sibling of .gated-content');
  assert.match(curriculumJs, /if \(inGatedRegion\(quiz\)\) return;/, 'paid quizzes are left alone');
  assert.match(curriculumJs, /qsa\('\.lesson-card', panel\)\.filter\(\(c\) => !inGatedRegion\(c\)\)/,
    'only free lessons are tracked');
  for (const page of COURSE_PAGES) {
    const html = read(page);
    const gates = [...html.matchAll(/<div class="lock-gate">/g)];
    assert.ok(gates.length, `${page}: no lock gate found`);
    for (const g of gates) {
      const after = html.slice(g.index, g.index + 1400);
      assert.ok(after.includes('<div class="gated-content"'),
        `${page}: a lock gate must sit before its gated block, never inside it`);
    }
  }
});

test('local progress is stored defensively and never persists the rendered order', () => {
  assert.match(curriculumJs, /function storage\(\) \{\s*try \{/, 'localStorage access must be wrapped: it throws in private mode');
  assert.match(curriculumJs, /catch \{ return null; \}/);
  assert.match(curriculumJs, /rec\.quizzes\[id\] = \{[\s\S]*?missed: result\.missed\.map\(\(m\) => m\.qi\)/,
    'only original question indices may be stored');
  assert.doesNotMatch(curriculumJs, /rec\.[a-z]+\s*=\s*[^;]*orderChoices/i, 'the shuffled order must never be persisted');
  // Honest about what it is: a device-local convenience, not an account.
  assert.match(curriculumJs, /saved on this device only, not an account/);
});

test('course pages call the funnel contract without implementing it', () => {
  for (const stage of ['lesson_expand', 'free_level_complete', 'lock_view', 'plan_cta', 'core_to_complete_upgrade']) {
    assert.match(curriculumJs, new RegExp(`'${stage}'`), `${stage} is not instrumented on the course pages`);
  }
  assert.match(curriculumJs, /if \(window\.vjmTrack\) window\.vjmTrack\(name, props \|\| \{\}\);/,
    'vjmTrack must be called defensively — assets/funnel.js may not have loaded');
  assert.doesNotMatch(curriculumJs, /window\.vjmTrack\s*=/, 'assets/funnel.js owns vjmTrack; this file must not define it');
  for (const page of [...COURSE_PAGES, 'premium-guidance.html']) {
    const html = read(page);
    assert.match(html, /<script src="assets\/funnel\.js" defer><\/script>/, `${page} does not load the event layer`);
    assert.match(html, /window\.vjmTrackQueue = window\.vjmTrackQueue \|\| \[\]/, `${page} has no pre-load queue shim`);
  }
});

test('each course lock names the plan that actually unlocks that course', () => {
  // "Unlock it with your Futures or Complete membership access code" was on
  // all four pages, and it was false on two of them: Futures Core does not
  // include Stock Breakdown or Options Lab.
  const expected = {
    'futures-dissection.html': ['Futures Core', '$100/mo'],
    'psychology-enhancer.html': ['Futures Core', '$100/mo'],
    'stock-breakdown.html': ['The Trifecta', '$129/mo'],
    'options-lab.html': ['The Trifecta', '$129/mo'],
  };
  for (const [page, [plan, price]] of Object.entries(expected)) {
    const html = read(page);
    const gates = html.split('<div class="lock-gate">').slice(1).map((s) => s.slice(0, 900));
    assert.ok(gates.length, `${page}: no lock gate`);
    for (const gate of gates) {
      assert.ok(gate.includes(plan) && gate.includes(price), `${page}: a lock gate does not name ${plan} at ${price}`);
      assert.doesNotMatch(gate, /Futures or Complete membership/, `${page}: stale ambiguous plan copy`);
    }
    if (plan === 'The Trifecta') {
      for (const gate of gates) {
        assert.match(gate, /Futures Core does not/, `${page}: a Complete-only course must say Futures Core does not include it`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Incident: commit 05a2ede renamed the $129/mo "Complete" tier to "The
// Trifecta" across the hero, bundle cards, and stock-breakdown/options-lab's
// lock gates, but missed every other place the same tier name is spoken to a
// visitor: futures-dissection.html and psychology-enhancer.html's own
// (differently-worded) "Futures Core or Complete membership" lock-gate
// sentence, three backend 403 upgrade_required error strings
// (research-engine.js, premium-stock-research.js, premium-market-analyst.js),
// research-engine.html's static #planNotice fallback and its client-side
// assets/research-engine.js PLAN_LOCKED_TEXT mirror, and stock-lab.html's
// planLocked message. A Futures Core member hitting any of those paid tools
// was told to look for a "Complete membership" that no longer exists
// anywhere else on the site. Worse, curriculum.js's renderSignedOutGate only
// rewrites a lock-gate paragraph when it does NOT already contain
// /\b(Futures Core|Trifecta)\b/ — since the stale futures-dissection.html /
// psychology-enhancer.html text already said "Futures Core", that guard
// silently protected the stale copy from being client-side corrected too.
test('the "Complete" tier name was fully retired, not just renamed in the obvious spots', () => {
  for (const page of ['futures-dissection.html', 'psychology-enhancer.html', 'stock-breakdown.html', 'options-lab.html']) {
    const html = read(page);
    assert.doesNotMatch(html, /\bComplete membership\b/, `${page}: stale "Complete membership" lock-gate copy`);
  }
  for (const file of [
    'functions/api/research-engine.js',
    'functions/api/premium-stock-research.js',
    'functions/api/premium-market-analyst.js',
  ]) {
    assert.doesNotMatch(read(file), /Complete membership/, `${file}: stale upgrade_required error text`);
  }
  assert.doesNotMatch(read('research-engine.html'), /Complete membership/, 'research-engine.html: stale #planNotice fallback');
  assert.doesNotMatch(read('assets/research-engine.js'), /Complete membership/, 'assets/research-engine.js: stale PLAN_LOCKED_TEXT');
  assert.doesNotMatch(read('stock-lab.html'), /Complete membership/, 'stock-lab.html: stale planLocked message');
});

// ---------------------------------------------------------------------------
// Incident: the free futures-dissection Level-1 tool's "Compare an E-mini
// against its Micro" chart paired contracts by stripping a literal 'M' from
// both symbols and comparing what was left
// (`s[0].replace('M','')===sym.replace('M','')`). That happens to work for
// ES/MES and NQ/MNQ (neither root contains an 'M'), but YM already contains
// an 'M' ('YM'.replace('M','')='Y' vs 'MYM'.replace('M','')='YM' -- no
// match) and RTY/M2K don't share a root string at all -- so a visitor
// selecting YM, MYM, RTY, or M2K (exactly the two pairs Lesson 2's product
// map, right above the tool, is teaching) silently got a flat single-bar
// chart instead of the promised side-by-side 10x comparison. Fixed by giving
// each spec row its own family key instead of deriving one from the symbol
// string. Extracted the live IIFE so a future edit that reintroduces
// string-based pairing fails this test instead of shipping quietly.
test("futures-dissection tool: E-mini/Micro comparison chart pairs every contract family, not just ones without an 'M'", () => {
  const html = read('futures-dissection.html');
  const iife = html.match(/\(function\(\)\{\s*var wrapId='fut-tool';[\s\S]*?\}\)\(\);/)[0];
  const els = {};
  const el = (id) => (els[id] ||= { value: '', textContent: '', style: {}, addEventListener(_evt, fn) { this._handler = fn; } });
  const sandbox = {
    document: { getElementById: el, querySelector: () => null, readyState: 'complete', addEventListener() {} },
    window: { addEventListener() {}, currDrawBars: null },
    setTimeout: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(iife, sandbox);

  const cases = [
    ['ES', ['ES', 'MES']],
    ['MYM', ['YM', 'MYM']],
    ['RTY', ['RTY', 'M2K']],
    ['M2K', ['RTY', 'M2K']],
  ];
  for (const [sym, expectedFamily] of cases) {
    let bars = null;
    sandbox.window.currDrawBars = (_canvas, b) => { bars = b; };
    el('fu-contract').value = sym;
    el('fu-entry').value = '0';
    el('fu-exit').value = '10';
    el('fu-contracts').value = '1';
    els['fu-contract']._handler();
    // bars is an array/objects created inside the vm sandbox realm, so copy
    // its labels out via Array.from (not vm-array .map/.sort, which stay
    // cross-realm and fail deepStrictEqual against a plain local array even
    // when the contents are identical).
    const labels = Array.from(bars || [], (b) => String(b.label)).sort();
    assert.deepEqual(
      labels,
      [...expectedFamily].sort(),
      `selecting ${sym} must chart its whole E-mini/Micro family, got ${labels}`,
    );
  }
});

// The test above already extracts fut-tool's live IIFE and drives calc()
// through it, but only ever reads back the chart's `bars` array -- it never
// checks what calc() wrote to the tool's own #fu-out-points/#fu-out-ticks/
// #fu-out-pnl outputs, the numbers a free visitor actually reads. That is
// the same untested-calculator defect class as the FC_SPECS/MNQ-MES-RTY gap
// (tests/pj-futures.test.mjs) and the stock-lab calcRisk/calcFib gap
// (tests/stock-lab-calculators.test.mjs): a real per-contract regression (a
// flipped tick size, a dropped multiplier, an inverted sign on a loss) would
// ship undetected because nothing ever executes calc() and checks its math.
test('futures-dissection tool: calc() writes correct point/tick/P&L math across tick-size families', () => {
  const html = read('futures-dissection.html');
  const iife = html.match(/\(function\(\)\{\s*var wrapId='fut-tool';[\s\S]*?\}\)\(\);/)[0];
  const els = {};
  const el = (id) => (els[id] ||= { value: '', textContent: '', style: {}, addEventListener(_evt, fn) { this._handler = fn; } });
  const sandbox = {
    document: { getElementById: el, querySelector: () => null, readyState: 'complete', addEventListener() {} },
    window: { addEventListener() {}, currDrawBars: null },
    setTimeout: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(iife, sandbox);

  function run(sym, entry, exit, contracts) {
    el('fu-contract').value = sym;
    el('fu-entry').value = String(entry);
    el('fu-exit').value = String(exit);
    el('fu-contracts').value = String(contracts);
    els['fu-contract']._handler();
    return {
      points: els['fu-out-points'].textContent,
      ticks: els['fu-out-ticks'].textContent,
      pnl: els['fu-out-pnl'].textContent,
    };
  }

  // ES: page defaults, 0.25 tick, $50/point.
  assert.deepEqual(run('ES', 21500, 21568, 1), { points: '68.00', ticks: '272', pnl: '$3,400' });
  // YM: whole-point tick (1.00), $5/point -- the family the string-pairing bug above was about.
  assert.deepEqual(run('YM', 44000, 44010, 2), { points: '10.00', ticks: '10', pnl: '$100' });
  // RTY: 0.10 tick, $50/point, fractional point move.
  assert.deepEqual(run('RTY', 2200, 2200.5, 1), { points: '0.50', ticks: '5', pnl: '$25' });
  // A losing/short move must report negative P&L, not an absolute value.
  assert.deepEqual(run('NQ', 15000, 14980, 3), { points: '-20.00', ticks: '-80', pnl: '-$1,200' });
  // Contracts input rounds to the nearest whole contract rather than truncating.
  assert.deepEqual(run('MES', 100, 108, 2.6), { points: '8.00', ticks: '32', pnl: '$120' });
});

test('the vendored Three.js/model files get a long, cache-header path of their own', () => {
  // assets/vendor/three and assets/models/ferrari.glb were vendored once and
  // never edited in place, unlike site.css/lightning-bg.js which rely on a
  // manual ?v= bump to bust the blanket 5-minute /assets/* cache. Without a
  // more specific rule, repeat visitors re-fetch ~3.9MB of unchanged bytes
  // every 5 minutes. Guards against that rule quietly being dropped, and
  // against it regressing to a max-age shorter than the general default.
  const headers = read('_headers');
  const blanket = /\/assets\/\*\n\s*Cache-Control: public, max-age=(\d+)/.exec(headers);
  assert.ok(blanket, '_headers must still set a blanket /assets/* Cache-Control');
  const blanketMaxAge = Number(blanket[1]);

  for (const path of ['/assets/vendor/*', '/assets/models/*']) {
    const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rule = new RegExp(`${escaped}\\n\\s*Cache-Control: public, max-age=(\\d+), immutable`).exec(headers);
    assert.ok(rule, `_headers has no long-cache rule for ${path}`);
    assert.ok(Number(rule[1]) > blanketMaxAge, `${path}'s max-age must exceed the general /assets/* default`);
  }
});

// ---------------------------------------------------------------------------
// Incident: psychology-enhancer.html grew from 59 to 62 lesson-card entries
// over time, but its own hero stat ("59 Lessons"), index.html's curriculum
// card for it ("59 lessons · 4 modules"), and index.html's section headline
// ("206 Lessons. Start Free.") -- an aggregate of all four course pages'
// counts (50+51+46+59=206) -- were never updated alongside it. The section's
// own comment says "Lesson counts mirror each page's own hero stats", so this
// is that promise silently breaking. premium-guidance.html's sign-in trust
// badge ("206 Curriculum lessons") carried the identical stale aggregate.
// Every course page's own self-reported count now has to match its actual
// lesson-card count, and every place that quotes the four-course total has
// to match their live sum, so a future lesson addition/removal gets caught
// here instead of drifting again.
test('every course page quotes its own real lesson count, and every aggregate quotes the real total', () => {
  const COURSES = {
    'futures-dissection.html': 'futures-dissection',
    'stock-breakdown.html': 'stock-breakdown',
    'options-lab.html': 'options-lab',
    'psychology-enhancer.html': 'psychology-enhancer',
  };
  const counts = {};
  for (const page of Object.keys(COURSES)) {
    counts[page] = (read(page).match(/class="lesson-card"/g) || []).length;
    assert.ok(counts[page] > 0, `${page}: expected at least one lesson-card`);
  }

  // Each page with a "<n><span>Lessons</span>" hero stat must match its own count.
  for (const page of ['futures-dissection.html', 'stock-breakdown.html', 'psychology-enhancer.html']) {
    const hero = /<div>(\d+)<span>Lessons<\/span><\/div>/.exec(read(page));
    assert.ok(hero, `${page}: expected a "<n>Lessons" hero stat`);
    assert.equal(Number(hero[1]), counts[page], `${page}: hero stat lesson count is stale`);
  }
  // options-lab.html states its count in prose instead of a hero stat.
  const optionsLead = /All (\d+) lessons across four levels/.exec(read('options-lab.html'));
  assert.ok(optionsLead, 'options-lab.html: expected "All <n> lessons across four levels" copy');
  assert.equal(Number(optionsLead[1]), counts['options-lab.html'], 'options-lab.html: lead-copy lesson count is stale');

  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  const index = read('index.html');
  const headline = /<h2 class="section-title">(\d+) Lessons\.\s/.exec(index);
  assert.ok(headline, 'index.html: expected the curriculum section\'s "<n> Lessons. Start Free." headline');
  assert.equal(Number(headline[1]), total, 'index.html: curriculum headline lesson total is stale');

  for (const [page, slug] of Object.entries(COURSES)) {
    const card = new RegExp(`data-vjm-course="${slug}"[\\s\\S]*?<div class="course-meta">(\\d+) lessons`).exec(index);
    assert.ok(card, `index.html: expected a "${slug}" curriculum card with an "<n> lessons" meta line`);
    assert.equal(Number(card[1]), counts[page], `index.html: ${slug} curriculum card lesson count is stale`);
  }

  const trust = /<b>(\d+)<\/b><span>Curriculum lessons<\/span>/.exec(read('premium-guidance.html'));
  assert.ok(trust, 'premium-guidance.html: expected the "<n> Curriculum lessons" trust badge');
  assert.equal(Number(trust[1]), total, 'premium-guidance.html: curriculum lessons trust badge total is stale');
});

// Incident: docs/ENTITLEMENTS.md quotes the same four-course lesson total
// ("can read all 206 lessons straight from source", describing the
// public-repo lesson-body exposure) as the HTML pages fixed above, but this
// doc is not an HTML page, so that fix never reached it -- it kept the stale
// 206 (50+51+46+59) even after every on-site number was corrected to the
// true 209 (50+51+46+62). Re-derives the same total independently so a
// future lesson addition/removal is caught here too, not just on-site.
test('docs/ENTITLEMENTS.md quotes the real four-course lesson total', () => {
  const COURSES = ['futures-dissection.html', 'stock-breakdown.html', 'options-lab.html', 'psychology-enhancer.html'];
  const total = COURSES.reduce((sum, page) => sum + (read(page).match(/class="lesson-card"/g) || []).length, 0);
  assert.ok(total > 0, 'expected a positive combined lesson-card count across all four course pages');

  const entitlementsDoc = /can read all (\d+) lessons straight from source/.exec(read('docs/ENTITLEMENTS.md'));
  assert.ok(entitlementsDoc, 'docs/ENTITLEMENTS.md: expected the "can read all <n> lessons" line');
  assert.equal(Number(entitlementsDoc[1]), total, 'docs/ENTITLEMENTS.md: lesson total is stale');
});

// Incident: docs/NEWSLETTER.md described the three forms feeding
// newsletter_subscribers as "the homepage section, the prop-firms page, and
// the 'where should I start' quiz result" -- but no quiz-based newsletter
// form existed yet, and the real third source, the homepage's prop-firm
// giveaway entry form (data-source="giveaway"), was never mentioned at all.
// That was fixed by naming the three real sources -- but a fourth, genuinely
// real one existed all along and this fix's own detection missed it: the
// homepage quiz's own lead-capture box (renderQuizLead -> vjmLead.submit(),
// source 'homepage-quiz') is a real, working signup path, just not a static
// <form class="nl-signup" data-source="..."> the markup regex could see --
// it is built with document.createElement/innerHTML at runtime and its
// source is a JS object literal, not an HTML attribute. So the fix that
// stopped the doc from naming a quiz that didn't exist also asserted the doc
// must never mention "quiz" again, which quietly kept it wrong once one did.
// Derives sources from both shapes so a future form addition/removal in
// either shape is caught here, not just re-read by eye.
function realNewsletterSources() {
  const sources = new Set();
  for (const page of ['index.html', 'prop-firms.html']) {
    const html = read(page);
    for (const m of html.matchAll(/class="nl-signup"[^>]*data-source="([^"]+)"/g)) sources.add(m[1]);
    for (const m of html.matchAll(/vjmLead\.submit\([^)]*?source:\s*['"]([^'"]+)['"]/gs)) sources.add(m[1]);
  }
  return sources;
}

test('docs/NEWSLETTER.md names every real newsletter form source', () => {
  const sources = realNewsletterSources();
  assert.ok(sources.size > 0, 'expected at least one real newsletter lead source');

  const doc = read('docs/NEWSLETTER.md');
  for (const source of sources) {
    assert.match(doc, new RegExp('`' + source + '`'), `docs/NEWSLETTER.md: missing mention of the "${source}" source`);
  }
});

// A form could be added/removed with its backtick mention kept in sync (the
// test above) while the opening line's spelled-out count ("Three forms feed
// it") is left stale -- exactly how the quiz form above went unnoticed, just
// one field over. Pins the two counts together so they can't drift apart.
test('docs/NEWSLETTER.md states the correct count of newsletter form sources', () => {
  const count = realNewsletterSources().size;
  const WORDS = ['zero', 'one', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven'];
  const word = WORDS[count] || String(count);
  assert.match(read('docs/NEWSLETTER.md'), new RegExp(`\\b${word} forms feed it\\b`, 'i'),
    `docs/NEWSLETTER.md: expected "${word} forms feed it" for the ${count} real sources found`);
});

// Incident: privacy.html, terms.html and risk-disclosure.html each carry a
// small nav strip that links to stock-lab.html, but the link text still read
// "Stock Tracker" -- the tool's name before it became "Stock Lab" everywhere
// else on the site (nav dropdowns, footers, premium-guidance.html). A visitor
// on a legal page saw a tool name that appears nowhere else on the site.
test('the legal pages\' nav strip calls the stock tool "Stock Lab", not its old name', () => {
  for (const page of ['privacy.html', 'terms.html', 'risk-disclosure.html']) {
    const html = read(page);
    assert.doesNotMatch(html, /Stock Tracker/, `${page}: stale "Stock Tracker" label`);
    assert.match(html, /href="stock-lab\.html"[^>]*>Stock Lab</, `${page}: nav strip missing the "Stock Lab" link`);
  }
});

// ---------------------------------------------------------------------------
// Incident: the same silent-status-change pattern once more, on the
// homepage's "Am I Active" Discord status checker. checkStatus() rewrites
// #status-result (and its #status-icon/#status-text/#status-sub children)
// between "CHECKING...", "ACTIVE", "NOT ACTIVE" and "LOOKUP UNAVAILABLE"
// with no role or aria-live anywhere on the container -- a screen-reader
// user who submits their Discord username hears nothing when the lookup
// finishes or fails.
test('index.html "Am I Active" status result is an announced live region', () => {
  const html = read('index.html');
  const m = html.match(/<div[^>]*\bid="status-result"[^>]*>/);
  assert.ok(m, '#status-result not found');
  assert.match(m[0], /role="status"/, `missing role="status": ${m[0]}`);
  assert.match(m[0], /aria-live="polite"/, `missing aria-live="polite": ${m[0]}`);
});

// ---------------------------------------------------------------------------
// Incident: the same silent-status-change defect once more, one level up
// from the already-fixed .lock-msg sibling. Every .lock-gate block on the
// four curriculum pages (futures-dissection, options-lab, psychology-
// enhancer, stock-breakdown) opens with a placeholder <h3>/<p> pair --
// "Members-only content" / "Level N is part of the full curriculum..." --
// that assets/curriculum.js's renderUnderTierGate()/renderSignedOutGate()
// rewrite in place with the visitor's actual entitlement state (which plan
// they're short of, the price gap, or the sign-in prompt) once an async
// checkPremium() fetch resolves after page load. Neither node carried any
// role or aria-live, so a screen-reader user who lands on a locked level
// before that fetch resolves hears the generic placeholder and nothing else
// -- never their actual gap-to-unlock or sign-in message.
test('every curriculum lock-gate heading/lead pair is an announced live region', () => {
  const offenders = [];
  for (const page of ['futures-dissection.html', 'options-lab.html', 'psychology-enhancer.html', 'stock-breakdown.html']) {
    const html = read(page);
    const gates = (html.match(/<div class="lock-gate">/g) || []).length;
    const announced = (html.match(
      /<div class="lock-icon">[^<]*<\/div>\s*<div role="status" aria-live="polite">\s*<h3>[^<]*<\/h3>\s*<p>[\s\S]*?<\/p><\/div>\s*<form class="lock-form">/g,
    ) || []).length;
    if (announced !== gates) offenders.push(`${page}: ${gates} lock-gate blocks, only ${announced} with an announced h3/p wrapper`);
  }
  assert.deepEqual(offenders, [], `lock-gate heading/lead pairs missing role="status"/aria-live="polite":\n  ${offenders.join('\n  ')}`);
});

// ---------------------------------------------------------------------------
// Incident: docs/MASTER-AUDIT.md's structural-audit section stated
// "index.html = 2,496,321 bytes (~2.4 MB), 2,865 lines" with no date or
// commit attached, reading as a current fact. It was a real measurement --
// at the doc's own commit (6b5f811, 2026-08-23) index.html genuinely was
// that size -- but the site has been rebuilt since (fabricated widgets
// removed, research engine merged in, ongoing maintenance) and the number
// is now off by more than 10x from the working tree. The fix pinned the
// figure to that commit and added a "current size" callout instead of
// silently updating the original claim (which would misrepresent what the
// audit actually measured); this test keeps that callout from drifting the
// same way the original number did.
test('docs/MASTER-AUDIT.md current-size callout for index.html matches the working tree', () => {
  const doc = read('docs/MASTER-AUDIT.md');
  const m = doc.match(/current index\.html is \*\*([\d,]+) bytes \(~([\d,]+) KB\)\*\*, ([\d,]+) lines/);
  assert.ok(m, 'docs/MASTER-AUDIT.md: expected the "current index.html is N bytes (~N KB), N lines" callout');
  const html = read('index.html');
  const actualBytes = Buffer.byteLength(html, 'utf8');
  const actualLines = (html.match(/\n/g) || []).length;
  assert.equal(Number(m[1].replace(/,/g, '')), actualBytes,
    `docs/MASTER-AUDIT.md says index.html is ${m[1]} bytes, working tree is ${actualBytes}`);
  assert.equal(Number(m[2].replace(/,/g, '')), Math.round(actualBytes / 1024),
    `docs/MASTER-AUDIT.md says index.html is ~${m[2]} KB, working tree is ~${Math.round(actualBytes / 1024)} KB`);
  assert.equal(Number(m[3].replace(/,/g, '')), actualLines,
    `docs/MASTER-AUDIT.md says index.html is ${m[3]} lines, working tree is ${actualLines}`);
});

// ---------------------------------------------------------------------------
// Incident: stock-lab.html's WATCHLIST array (the $129/mo Complete-tier
// Premium Stock Screener's data) carried two different spellings of the
// same sector for MSFT ("AI / Software") and PLTR ("AI Software") -- both
// stocks already share the 'Cyber / Software' group tag, so this was never
// two distinct categories, just a slash dropped on one entry. Every other
// multi-word sector in the array ("AI / Semiconductors", "AI Infrastructure",
// "Energy / Power", "Health / Bio", "Space / Defense") is spelled the same
// way across every stock that carries it. A member scanning or searching the
// Sector column saw what looked like two categories for one concept. This
// test compares sectors by their letters only (spacing/slash-insensitive) so
// it catches any future re-drift without flagging genuinely different
// sectors that happen to share a word.
test('stock-lab.html watchlist sector labels spell each concept one way', () => {
  const html = read('stock-lab.html');
  const arr = html.match(/const WATCHLIST=\[[\s\S]*?\];/);
  assert.ok(arr, 'WATCHLIST array not found in stock-lab.html');
  const sectors = [...arr[0].matchAll(/sector:'([^']+)'/g)].map((m) => m[1]);
  const variantsByConcept = new Map();
  for (const sector of sectors) {
    const concept = sector.toLowerCase().replace(/[^a-z]/g, '');
    if (!variantsByConcept.has(concept)) variantsByConcept.set(concept, new Set());
    variantsByConcept.get(concept).add(sector);
  }
  const offenders = [...variantsByConcept.values()].filter((variants) => variants.size > 1);
  assert.deepEqual(offenders.map((v) => [...v]), [],
    `WATCHLIST spells the same sector inconsistently: ${offenders.map((v) => [...v].join(' vs ')).join('; ')}`);
});

// Incident: docs/DISCORD-INTEGRATION.md's Status line read "designed, not
// wired. No Discord calls are made anywhere on this branch" -- but
// functions/api/_lib/discord.js's postEmbed() was already live and called
// from three places (purchase-code delivery, market-brief announcements,
// content-sync announcements), each posting the instant its own webhook env
// var is set, no separate "enable" step needed. Only the OAuth/role-sync/
// slash-command design further down the doc was still unbuilt. Derives the
// real call sites from the source so a future one added without a doc
// update, or the doc drifting back to the blanket "no calls" claim, is
// caught here instead of by a reader trusting a stale contract.
function discordWebhookCallSites() {
  const sites = new Set();
  for (const file of ['functions/api/whop-webhook.js', 'functions/api/market-brief.js', 'functions/api/content-sync.js']) {
    if (/\bpostEmbed\(/.test(read(file))) sites.add(file);
  }
  return sites;
}

test('docs/DISCORD-INTEGRATION.md does not claim no Discord calls exist while postEmbed() call sites do', () => {
  assert.ok(discordWebhookCallSites().size > 0, 'expected at least one real postEmbed() call site');
  assert.doesNotMatch(read('docs/DISCORD-INTEGRATION.md'), /no discord calls are made/i,
    'docs/DISCORD-INTEGRATION.md: status line falsely claims no Discord calls happen while postEmbed() call sites do');
});

test('docs/DISCORD-INTEGRATION.md names every real postEmbed() call site', () => {
  const sites = discordWebhookCallSites();
  assert.ok(sites.size > 0, 'expected at least one real postEmbed() call site');
  const doc = read('docs/DISCORD-INTEGRATION.md');
  for (const site of sites) {
    const base = site.split('/').pop();
    assert.match(doc, new RegExp(base.replace('.', '\\.')), `docs/DISCORD-INTEGRATION.md: missing mention of ${site}`);
  }
});

// Incident: functions/api/verify-premium.js deliberately returns a distinct
// 403 with MEMBERSHIP_ENDED ("Renew on Whop...") for a D1 code found but
// revoked/expired, separate from the generic 401 GENERIC_BAD_CODE used for a
// malformed/unknown code (see the comment above MEMBERSHIP_ENDED's own
// definition for why that asymmetry is safe only in this one case). But
// docs/API.md's POST /api/verify-premium section only ever documented a
// single 401 "generic failure (unknown code and inactive code are
// indistinguishable)" line -- true of the legacy Sheet-bridge fallback, but
// false of the primary D1 path a developer or support agent would actually
// hit, and it never mentioned 403 existed at all. docs/SECURITY.md's own
// enumeration threat note made the identical blanket claim.
test('docs/API.md documents verify-premium\'s distinct 403 for a revoked/expired D1 membership', () => {
  assert.match(read('functions/api/verify-premium.js'), /MEMBERSHIP_ENDED/,
    'expected verify-premium.js to still export a distinct membership-ended message');
  const doc = read('docs/API.md');
  assert.match(doc, /403/, 'docs/API.md: verify-premium section must document the 403 status');
  assert.match(doc, /revoked or expired/i,
    'docs/API.md: verify-premium section must explain the 403 case is a revoked/expired D1 membership');
});

test('docs/SECURITY.md\'s enumeration threat note reflects the same 403/401 split, not a blanket "identical" claim', () => {
  const doc = read('docs/SECURITY.md');
  assert.doesNotMatch(doc, /unknown code vs inactive code return identical bodies\/status/i,
    'docs/SECURITY.md: enumeration note falsely claims unknown and inactive codes are always indistinguishable');
  assert.match(doc, /403/, 'docs/SECURITY.md: enumeration note must account for the distinct 403 case');
});
