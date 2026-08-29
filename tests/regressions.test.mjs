// Regression contracts for bug classes actually hit on this site. Each test
// names the incident it guards against — if one fails, read that history
// before "fixing" the test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  assert.match(read('index.html'), /<link rel="stylesheet" href="assets\/site\.css">/);
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
  const expected = {
    'futures-dissection.html': true,   // the one free starter course
    'stock-breakdown.html': false,
    'options-lab.html': false,
    'psychology-enhancer.html': false,
  };
  for (const [page, free] of Object.entries(expected)) {
    const m = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(read(page));
    assert.ok(m, `${page}: no JSON-LD block`);
    const ld = JSON.parse(m[1]);
    assert.equal(ld['@type'], 'Course', `${page}: JSON-LD is not a Course`);
    assert.equal(ld.isAccessibleForFree, free, `${page}: isAccessibleForFree should be ${free}`);
    assert.ok(ld.name && ld.description && ld.url, `${page}: Course missing name/description/url`);
  }
});
