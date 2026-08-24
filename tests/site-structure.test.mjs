import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(resolve(root, 'research-engine.html'), 'utf8');
const javascript = readFileSync(resolve(root, 'assets/research-engine.js'), 'utf8');

const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
assert.deepEqual([...new Set(duplicates)], [], 'research page must not contain duplicate IDs');

const referencedIds = [...javascript.matchAll(/\$\('([^']+)'\)/g)].map((match) => match[1]);
const missingIds = [...new Set(referencedIds)].filter((id) => !ids.includes(id));
assert.deepEqual(missingIds, [], 'every JavaScript element reference must exist in the page');

for (const match of html.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
  const path = match[1];
  if (!path || /^(?:https?:|#|mailto:|data:)/.test(path)) continue;
  const clean = path.split('#')[0].split('?')[0];
  assert.ok(existsSync(resolve(root, clean)), `linked local asset must exist: ${clean}`);
}

for (const page of ['index.html', 'stock-lab.html', 'options-lab.html']) {
  const source = readFileSync(resolve(root, page), 'utf8');
  assert.ok(source.includes('research-engine.html'), `${page} must link to the research engine`);
}

for (const page of ['index.html', 'stock-lab.html', 'premium-guidance.html', 'research-engine.html']) {
  const source = readFileSync(resolve(root, page), 'utf8');
  assert.doesNotMatch(source, /verify-premium\?token/i, `${page} must send session tokens in an authorization header, not the URL`);
}

for (const file of ['research-engine.html', 'assets/research-engine.js', 'functions/api/research-engine.js']) {
  const source = readFileSync(resolve(root, file), 'utf8');
  assert.doesNotMatch(source, /ALPACA_API_KEY\s*=\s*["'][^"']+/i, `${file} must not contain an Alpaca key value`);
  assert.doesNotMatch(source, /ALPACA_SECRET_KEY\s*=\s*["'][^"']+/i, `${file} must not contain an Alpaca secret value`);
}

assert.match(html, /meta name="robots" content="noindex,nofollow"/);
assert.match(html, /Educational research only—not financial advice/);
// Sessions travel via HttpOnly cookies; no Bearer tokens in client code.
assert.doesNotMatch(javascript, /Authorization\s*=\s*'Bearer '/, 'client code must not attach Bearer tokens');
assert.doesNotMatch(javascript, /localStorage\.getItem\(/, 'client code must not read tokens from storage');
assert.doesNotMatch(readFileSync(resolve(root, 'CNAME'), 'utf8'), /\s+\n/, 'CNAME must not contain trailing whitespace');

console.log('VJM site structure and secret-leak tests passed.');
