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
    'stock-breakdown.html': ['Complete', '$129/mo'],
    'options-lab.html': ['Complete', '$129/mo'],
  };
  for (const [page, [plan, price]] of Object.entries(expected)) {
    const html = read(page);
    const gates = html.split('<div class="lock-gate">').slice(1).map((s) => s.slice(0, 900));
    assert.ok(gates.length, `${page}: no lock gate`);
    for (const gate of gates) {
      assert.ok(gate.includes(plan) && gate.includes(price), `${page}: a lock gate does not name ${plan} at ${price}`);
      assert.doesNotMatch(gate, /Futures or Complete membership/, `${page}: stale ambiguous plan copy`);
    }
    if (plan === 'Complete') {
      for (const gate of gates) {
        assert.match(gate, /Futures Core does not/, `${page}: a Complete-only course must say Futures Core does not include it`);
      }
    }
  }
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
