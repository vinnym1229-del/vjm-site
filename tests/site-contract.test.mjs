// Site contract tests: routes referenced by the frontend must exist as
// Pages Functions; security regressions must never reappear.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HTML_PAGES = ['index.html', 'stock-lab.html', 'options-lab.html', 'premium-guidance.html', 'forex-calendar.html', 'research-engine.html', '404.html'];

function read(p) {
  return readFileSync(join(ROOT, p), 'utf8');
}

test('every /api/ route referenced by HTML has a Function implementation', () => {
  const functionsDir = join(ROOT, 'functions', 'api');
  const implemented = new Set(
    readdirSync(functionsDir)
      .filter((f) => f.endsWith('.js') && !f.startsWith('_'))
      .map((f) => '/api/' + f.replace(/\.js$/, ''))
  );
  const missing = [];
  for (const page of HTML_PAGES) {
    if (!existsSync(join(ROOT, page))) continue;
    const html = read(page);
    for (const m of html.matchAll(/['"`]\/api\/([a-z0-9-]+)/gi)) {
      const route = '/api/' + m[1];
      if (!implemented.has(route) && !missing.includes(route)) missing.push(route);
    }
  }
  // assets/*.js too
  if (existsSync(join(ROOT, 'assets'))) {
    for (const f of readdirSync(join(ROOT, 'assets')).filter((f) => f.endsWith('.js'))) {
      const src = read(join('assets', f));
      for (const m of src.matchAll(/['"`]\/api\/([a-z0-9-]+)/g)) {
        const route = '/api/' + m[1];
        if (!implemented.has(route) && !missing.includes(route)) missing.push(route);
      }
    }
  }
  assert.deepEqual(missing, [], `frontend calls unimplemented routes: ${missing.join(', ')}`);
});

const COMPROMISED_MARKERS = [
  ['VINNY_ADMIN_01', 'browser admin password'],
  ['st-trades-fallback-signing-secret', 'hard-coded HMAC fallback key'],
  ['activeMembersFallback', 'client-side member list'],
];

for (const [marker, label] of COMPROMISED_MARKERS) {
  test(`removed secret stays removed: ${label}`, () => {
    for (const page of HTML_PAGES) {
      if (!existsSync(join(ROOT, page))) continue;
      assert.ok(!read(page).includes(marker), `${marker} reappeared in ${page}`);
    }
  });
  test(`${label} absent from Functions`, () => {
    const dir = join(ROOT, 'functions', 'api');
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.js')) assert.ok(!readFileSync(join(dir, f), 'utf8').includes(marker), `${marker} in functions/api/${f}`);
    }
  });
}

test('no localStorage token/session keys remain on any page or asset', () => {
  const forbidden = [
    'vjm_premium_session_token_v1',
    'vjm_premium_session_expires_v1',
    'blueprint_premium_unlocked_v2',
  ];
  const offenders = [];
  const files = [...HTML_PAGES.map((p) => [p, true]), ['assets/research-engine.js', true]];
  for (const [file] of files) {
    if (!existsSync(join(ROOT, file))) continue;
    const src = read(file);
    for (const key of forbidden) {
      if (src.includes(key)) offenders.push(`${file}: ${key}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('no duplicate static id= attributes within any HTML page', () => {
  const problems = [];
  for (const page of HTML_PAGES) {
    if (!existsSync(join(ROOT, page))) continue;
    const html = read(page);
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    const seen = new Set();
    for (const id of ids) {
      if (seen.has(id)) problems.push(`${page}: #${id}`);
      seen.add(id);
    }
  }
  assert.deepEqual(problems, []);
});

test('verify-premium issues cookies and never returns tokens', () => {
  const src = read('functions/api/verify-premium.js');
  assert.ok(src.includes('jsonWithSession'), 'must set session cookie');
  assert.ok(!src.match(/token:\s*token/), 'token must not be returned in body');
});

test('_headers defines CSP, HSTS, nosniff, frame protection', () => {
  const headers = read('_headers');
  for (const directive of ['Content-Security-Policy:', 'Strict-Transport-Security:', 'X-Content-Type-Options: nosniff', "frame-ancestors 'self'", "object-src 'none'", 'Referrer-Policy:']) {
    assert.ok(headers.includes(directive), `missing ${directive}`);
  }
});

test('.env.example contains placeholders only (no real-looking secrets)', () => {
  const envExample = read('.env.example');
  assert.ok(envExample.includes('SESSION_SIGNING_SECRET'));
  // Every non-comment assignment must be an obvious placeholder.
  for (const line of envExample.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    const value = m[2].trim();
    if (value === '') continue;
    const looksReal = /[a-z0-9]{24,}/.test(value) && !/set-a|your-|placeholder|__|DEPLOYMENT_ID|OLD_/.test(value);
    assert.ok(!looksReal, `${m[1]} may contain a real value`);
  }
});

test('fabricated-data markers stay out of index.html', () => {
  const html = read('index.html');
  for (const marker of ['watching</span>', 'spots-left', "base = 28", "'First 20 Members"]) {
    assert.ok(!html.includes(marker), `fabricated data marker reappeared: ${marker}`);
  }
});

test('broken premium-screener iframe reference is gone', () => {
  assert.ok(!read('stock-lab.html').includes('premium-screener.html'));
});

// ─── Canonical / sitemap consolidation ───────────────────────────────────────
// The site previously spread itself over two path shapes (`/` and `/pj/`) and
// a sitemap that disagreed with the canonicals it pointed at. These tests pin
// the consolidation so it cannot drift back: the origin is declared exactly
// once (the `canonical-origin:` comment in robots.txt) and everything else is
// checked against it. To move hosts, change that one line; the failures listed
// here are then the complete to-do list.

function canonicalOrigin() {
  const m = read('robots.txt').match(/^#\s*canonical-origin:\s*(\S+)$/m);
  assert.ok(m, 'robots.txt must declare the canonical origin once, as `# canonical-origin: <url>`');
  return m[1].replace(/\/$/, '');
}

/** Root path a page's URL should use: index.html -> "/", terms.html -> "/terms". */
function pathForPage(page) {
  return page === 'index.html' ? '/' : '/' + page.replace(/\.html$/, '');
}

function canonicalOf(html) {
  const m = html.match(/<link rel="canonical" href="([^"]+)"/);
  return m ? m[1] : null;
}

test('every page canonical uses the single origin and the root path shape', () => {
  const origin = canonicalOrigin();
  const pages = readdirSync(ROOT).filter((f) => f.endsWith('.html'));
  for (const page of pages) {
    const html = read(page);
    const canonical = canonicalOf(html);
    if (canonical === null) continue; // e.g. 404.html, which must not claim one
    assert.ok(canonical.startsWith(origin + '/'), `${page}: canonical ${canonical} does not use ${origin}`);
    assert.ok(!canonical.includes('/pj/'), `${page}: canonical must not carry the /pj/ prefix`);
    assert.ok(!canonical.endsWith('.html'), `${page}: canonical must use the extensionless path (.html redirects)`);
    assert.equal(canonical, origin + pathForPage(page), `${page}: canonical must be its own root-path URL`);
    // og:url / twitter:url must not contradict the canonical.
    for (const [label, re] of [
      ['og:url', /<meta property="og:url" content="([^"]+)"/g],
      ['twitter:url', /<meta name="twitter:url" content="([^"]+)"/g],
    ]) {
      for (const m of html.matchAll(re)) {
        assert.equal(m[1], canonical, `${page}: ${label} must equal the canonical`);
      }
    }
    // No absolute self-references on the old path shape anywhere in the page.
    assert.ok(!html.includes(origin + '/pj/'), `${page}: absolute ${origin}/pj/ links must be gone`);
  }
});

test('sitemap lists only canonical, indexable URLs and matches every page canonical', () => {
  const origin = canonicalOrigin();
  const sitemap = read('sitemap.xml');
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.ok(locs.length > 0, 'sitemap must list URLs');
  assert.equal(new Set(locs).size, locs.length, 'sitemap must not repeat a URL');

  for (const loc of locs) {
    assert.ok(loc.startsWith(origin + '/'), `sitemap entry ${loc} does not use ${origin}`);
    assert.ok(!loc.includes('/pj/'), `sitemap entry ${loc} must not carry the /pj/ prefix`);
    assert.ok(!loc.endsWith('.html'), `sitemap entry ${loc} is a redirecting .html alias`);

    const path = loc.slice(origin.length);
    const page = path === '/' ? 'index.html' : path.slice(1) + '.html';
    assert.ok(existsSync(join(ROOT, page)), `sitemap entry ${loc} has no page (${page})`);

    const html = read(page);
    assert.equal(canonicalOf(html), loc, `sitemap entry ${loc} disagrees with the canonical in ${page}`);
    assert.doesNotMatch(html, /<meta name="robots" content="[^"]*noindex/i, `sitemap must not list the noindexed page ${page}`);
  }

  // Pages that must never be advertised, whatever their canonical says.
  for (const page of ['stock-lab', 'research-engine', 'premium-guidance', '404']) {
    assert.ok(!locs.includes(origin + '/' + page), `${page} must not appear in the sitemap`);
  }

  // robots.txt must point at the sitemap on the same origin.
  assert.match(read('robots.txt'), new RegExp('^Sitemap: ' + origin + '/sitemap\\.xml$', 'm'));
});

test('indexing stays off, coherently, in one place', () => {
  const headers = read('_headers');
  // Site-wide hold, not a /pj/-only hold.
  assert.match(headers, /\/\*\n(?:[^\n]*\n)*?\s+X-Robots-Tag: noindex/, '_headers must apply the noindex hold site-wide');
  // Member/app, labs, research engine, premium guidance and APIs stay
  // noindexed even after the site-wide hold is lifted.
  for (const path of ['/api/*', '/stock-lab', '/research-engine', '/premium-guidance', '/pj/*']) {
    const block = new RegExp(path.replace(/[*/]/g, (c) => '\\' + c) + '\\n\\s+X-Robots-Tag: noindex');
    assert.match(headers, block, `${path} must be noindexed independently of the site-wide hold`);
  }
  for (const page of ['stock-lab.html', 'research-engine.html', '404.html']) {
    assert.match(read(page), /<meta name="robots" content="noindex/i, `${page} must declare noindex itself`);
  }
  // No page may claim index,follow while the site-wide hold is on — that was
  // the contradiction this consolidation removed. Now enforced across EVERY
  // page: `_headers` is the single indexing switch, so a page carrying its own
  // `index` directive is either redundant or a contradiction waiting to be
  // trusted by someone reading the page instead of the header. Pages that must
  // never be indexed still declare noindex themselves (asserted above).
  for (const page of readdirSync(ROOT).filter((f) => f.endsWith('.html'))) {
    assert.doesNotMatch(read(page), /<meta name="robots" content="index/i, `${page} contradicts the site-wide indexing hold`);
  }
});

// stock-lab.html's premium gate only checks "is there an active session" (any
// tier), but the /api/premium-stock-research call it makes once unlocked is
// Complete-tier gated (see functions/api/_lib/entitlements.js). A Futures Core
// member reaches the gate fine and then gets a 403 the moment they analyze a
// stock -- that 403 is an entitlement answer, not a transient failure, and
// must not be presented as one telling the member to re-enter a code that is
// already valid.
test('stock-lab.html premium research 403 is not shown as a re-unlock prompt', () => {
  const clientHtml = read('stock-lab.html');
  assert.match(clientHtml, /planLocked\s*=\s*res\.status\s*===\s*403\s*\|\|\s*data\.code\s*===\s*'upgrade_required'/, 'a 403/upgrade_required response must be recognised as a plan-tier state');
  const catchStart = clientHtml.indexOf('}catch(err){', clientHtml.indexOf('runPremiumResearch'));
  assert.ok(catchStart > 0, 'runPremiumResearch must have a catch branch');
  const catchBranch = clientHtml.slice(catchStart, clientHtml.indexOf('}}function setDefaultFib', catchStart));
  assert.match(catchBranch, /err\.planLocked\s*\?/, 'the plan-locked case must render different copy than a generic failure');
  assert.ok(!/planLocked\?'Unlock again/.test(catchBranch), 'a plan-locked 403 must not tell the member to unlock again');
});
