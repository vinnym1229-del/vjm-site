// Regression for the one-click email-unsubscribe banner going silent.
//
// unsubscribe.html's #nl-state <p role="status" aria-live="polite"> reports
// the outcome of the one-click link from an email footer (?state=done|
// invalid|error): assets/newsletter.js's init() sets its text on
// DOMContentLoaded, essentially the instant the page loads. That is exactly
// the race the signup-success fix (tests/newsletter-signup-success-a11y.
// test.mjs, commit 8cd2250) called unreliable on its own -- a live-region
// update that fires before some screen readers finish registering the
// region can go unannounced -- which is why that fix paired aria-live with
// an explicit focus() move. #nl-state had aria-live but no focus() and no
// tabindex, so a screen-reader user who clicks "unsubscribe" in an email
// could land on the page and hear nothing confirming the opt-out worked.
//
// Fixed by giving #nl-state a tabindex="-1" (unsubscribe.html) and having
// init() call banner.focus() right after setting the text, guarded by the
// same `if (copy)` the text-setting already uses so a plain page load with
// no ?state= param never steals focus.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const newsletterSrc = readFileSync(join(ROOT, 'assets/newsletter.js'), 'utf8');

/**
 * document.readyState is 'complete' from the start (same as the real page,
 * script runs deferred at the end of body), so the IIFE's own `else init()`
 * tail runs init() exactly once, synchronously, during vm.runInContext()
 * below -- same approach as tests/newsletter-signup-success-a11y.test.mjs.
 */
function run(search) {
  const banner = { className: '', textContent: '', focusCalled: false, focus() { this.focusCalled = true; } };
  const sandbox = {
    document: {
      readyState: 'complete',
      addEventListener() {},
      getElementById: (id) => (id === 'nl-state' ? banner : null),
      querySelectorAll: () => [],
    },
    location: { search },
    fetch: async () => { throw new Error('no forms on this page; fetch must not be called'); },
    URLSearchParams,
    console,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(newsletterSrc, sandbox);
  return banner;
}

test('a one-click unsubscribe success moves focus onto the banner it just wrote', () => {
  const banner = run('?state=done');
  assert.equal(banner.textContent, 'You are unsubscribed. That address will not receive any more emails from us.');
  assert.equal(banner.focusCalled, true, 'focus must move onto the result, or a screen-reader user hears nothing confirming the opt-out worked');
});

test('an invalid-token redirect also moves focus onto the banner', () => {
  const banner = run('?state=invalid');
  assert.match(banner.textContent, /not valid/);
  assert.equal(banner.focusCalled, true);
});

test('a plain page load with no ?state= param never steals focus', () => {
  const banner = run('');
  assert.equal(banner.textContent, '');
  assert.equal(banner.focusCalled, false, 'nothing to announce, so focus must stay wherever the browser put it');
});
