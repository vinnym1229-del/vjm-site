// Regression for the homepage quiz's lead-capture form skipping Turnstile.
//
// docs/NEWSLETTER.md claims Turnstile is "wired end to end" for all four
// forms feeding /api/newsletter/subscribe. Three of them are static
// <form class="nl-signup"> markup that assets/newsletter.js finds with
// document.querySelectorAll('form.nl-signup') on page load and mounts a
// widget into. The fourth — the box renderQuizLead() builds in index.html
// after the "where should I start" quiz recommends a track — is created at
// runtime, well after that querySelectorAll ran, so it was never found and
// never got a widget, a required-token guard, or a token in its submit
// payload. The server enforces the token the moment the owner sets
// TURNSTILE_SECRET_KEY (functions/api/_lib/turnstile.js: no token is always
// a fail), so this form would have 403'd on every submit from that point on
// while the other three kept working.
//
// Fixed by giving assets/newsletter.js a public window.vjmTurnstile hook
// (mount/required/misconfigured) that reuses its one fetch-config/render
// flow for a form it did not find itself, and having renderQuizLead call it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const newsletterSrc = read('assets/newsletter.js');
const index = read('index.html');

/** A stand-in for a real <form>/<div> node: enough for querySelector/dataset. */
function makeEl() {
  return { dataset: {}, _children: {}, querySelector(sel) { return this._children[sel] || null; } };
}

/**
 * Enough of a browser for newsletter.js to run init() -> initTurnstile() and
 * expose window.vjmTurnstile. One static nl-signup form stands in for the
 * two real ones on index.html, so the fetch-config guard (`if (!forms.length)
 * return`) behaves the way it does on the real page.
 */
function load({ required = true, siteKey = 'sk_test' } = {}) {
  const staticForm = makeEl();
  staticForm._children['.nl-turnstile'] = makeEl();
  staticForm.addEventListener = () => {};

  let scriptNode = null;
  const fakeCfTurnstile = { render(slot, opts) { slot._renderOpts = opts; return 'widget-1'; } };

  const sandbox = {
    console: { log() {}, warn() {} },
    turnstile: fakeCfTurnstile,
    document: {
      readyState: 'complete',
      addEventListener() {},
      getElementById: () => null,
      createElement(tag) {
        const el = { tag, dataset: {} };
        if (tag === 'script') scriptNode = el;
        return el;
      },
      head: { appendChild() {} },
      querySelectorAll(sel) {
        if (sel === 'form.nl-signup') return [staticForm];
        return [];
      },
    },
    location: { search: '', pathname: '/' },
    fetch: async () => ({ ok: true, json: async () => ({ required, siteKey }) }),
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(newsletterSrc, sandbox);
  return { win: sandbox, staticForm, fireScriptLoad: () => scriptNode && scriptNode.onload() };
}

/** Flush the microtask queue so initTurnstile()'s two awaited fetch/json calls land. */
const settle = () => new Promise((r) => setTimeout(r, 0));

test('window.vjmTurnstile is exposed with the mount/required/misconfigured contract', () => {
  const { win } = load();
  assert.equal(typeof win.vjmTurnstile, 'object');
  assert.equal(typeof win.vjmTurnstile.mount, 'function');
  assert.equal(typeof win.vjmTurnstile.required, 'function');
  assert.equal(typeof win.vjmTurnstile.misconfigured, 'function');
});

test('mount() on a form built after page load still gets the Turnstile widget once config resolves', async () => {
  const { win, fireScriptLoad } = load({ required: true, siteKey: 'sk_test' });
  const quizForm = makeEl();
  quizForm._children['.nl-turnstile'] = makeEl();

  // Called before initTurnstile's fetch has resolved -- must queue, not drop.
  win.vjmTurnstile.mount(quizForm);
  assert.equal(quizForm._children['.nl-turnstile']._renderOpts, undefined, 'must not render before config/script are ready');

  await settle();               // let the fetch + res.json() awaits land
  fireScriptLoad();             // simulate the Turnstile <script> finishing load

  const opts = quizForm._children['.nl-turnstile']._renderOpts;
  assert.ok(opts, 'the queued form must be rendered once the widget script loads');
  assert.equal(opts.sitekey, 'sk_test');

  opts.callback('tok-xyz');
  assert.equal(quizForm.dataset.turnstileToken, 'tok-xyz', 'the widget callback must set dataset.turnstileToken on the right form');

  assert.equal(win.vjmTurnstile.required(), true);
  assert.equal(win.vjmTurnstile.misconfigured(), false);
});

test('misconfigured (secret set, no site key) is reported rather than silently dropping submits', async () => {
  const { win } = load({ required: true, siteKey: null });
  await settle();
  assert.equal(win.vjmTurnstile.required(), true);
  assert.equal(win.vjmTurnstile.misconfigured(), true);
});

test('Turnstile off entirely: required() is false and nothing is misconfigured', async () => {
  const { win } = load({ required: false, siteKey: null });
  await settle();
  assert.equal(win.vjmTurnstile.required(), false);
  assert.equal(win.vjmTurnstile.misconfigured(), false);
});

test('the homepage quiz lead form carries a Turnstile mount point and wires it up', () => {
  const quizBlock = index.slice(index.indexOf('function renderQuizLead'), index.indexOf('function resetQuiz'));
  assert.match(quizBlock, /class="nl-turnstile"/, 'quiz-lead-form is missing the Turnstile mount div other newsletter forms have');
  assert.match(quizBlock, /window\.vjmTurnstile\.mount\(form\)/, 'quiz-lead-form never asks newsletter.js to mount a widget into it');
  assert.match(quizBlock, /window\.vjmTurnstile\.required\(\)\s*&&\s*!form\.dataset\.turnstileToken/,
    'submit is missing the same required-token guard the standalone newsletter forms use');
  assert.match(quizBlock, /vjmLead\.submit\([^)]*turnstileToken:\s*form\.dataset\.turnstileToken/s,
    'the token the widget produced is never forwarded to vjmLead.submit()');
});
