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
