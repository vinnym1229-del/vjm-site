// Regression for the newsletter signup forms going silent on success.
//
// initSignup()'s success branch (assets/newsletter.js) replaces the whole
// <form> with "You're on the list" copy, on purpose -- a form that still
// looks submittable after a success is the reason people submit twice. But
// the swap deleted .nl-msg (the form's own role="status" aria-live="polite"
// element, see index.html/prop-firms.html's <form class="nl-signup"> markup)
// along with the rest of the form, and the replacement carried no live
// region of its own. A screen-reader user who submits successfully hears
// nothing -- the one outcome out of "ok"/"error"/"unreachable" that setMsg()
// never gets a chance to announce, since the success path bypasses it
// entirely. Worse, focus was on the submit button, which the swap also
// deletes; a keyboard user's focus falls back to <body>, dropping them at
// the top of the page's tab order instead of at the result they just caused.
//
// Fixed by giving the replacement its own role="status"/aria-live="polite"
// and a tabindex="-1" that the code explicitly focuses right after the swap
// -- the same "give screen readers both a live-region announcement and an
// explicit focus move" belt-and-suspenders the homepage quiz's lead form
// already gets right (its #quiz-lead-msg sits outside the form it hides, so
// it survives the equivalent success transition untouched).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const newsletterSrc = readFileSync(join(ROOT, 'assets/newsletter.js'), 'utf8');

/**
 * Just enough of a <form class="nl-signup"> for initSignup() to run a real
 * submit through to the success branch: its fixed set of named inputs/
 * buttons, plus an innerHTML setter that captures the raw string (this repo
 * has no DOM parser available to tests) and hands back a focusable stub for
 * '.nl-kicker' if and only if the assigned markup actually contains that
 * class -- so the test fails the same way a real browser would if the
 * success branch ever stopped writing that element.
 */
function makeForm() {
  const email = { value: 'reader@example.com' };
  const firstName = { value: '' };
  const website = { value: '' };
  const consent = { checked: true };
  const submitBtn = { disabled: false, textContent: 'Send it', isConnected: true };
  const msg = { textContent: '', className: '' };
  let kicker = null;
  let html = '';
  const form = {
    dataset: {},
    _attrs: { 'data-source': 'home' },
    getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; },
    listeners: {},
    addEventListener(type, fn) { (form.listeners[type] ||= []).push(fn); },
    querySelector(sel) {
      if (sel === '.nl-submit') return submitBtn;
      if (sel === 'input[name="consent"]') return consent;
      if (sel === 'input[name="email"]') return email;
      if (sel === 'input[name="firstName"]') return firstName;
      if (sel === 'input[name="website"]') return website;
      if (sel === '.nl-msg') return msg;
      if (sel === '.nl-kicker') return kicker;
      return null;
    },
    set innerHTML(v) {
      html = v;
      const m = /<p class="nl-kicker"([^>]*)>/.exec(v);
      kicker = m ? { attrs: m[1], focusCalled: false, focus() { this.focusCalled = true; } } : null;
    },
    get innerHTML() { return html; },
  };
  return { form, msg, kicker: () => kicker, html: () => html };
}

// document.readyState is 'complete' from the start (same as the real page by
// the time this script loads, deferred at the end of body), so the IIFE's own
// `else init()` tail runs init() exactly once, synchronously, during
// vm.runInContext() below -- mirroring tests/quiz-lead-turnstile.test.mjs's
// load() rather than calling the private init() a second time by hand.
function run(form, fetchImpl) {
  const sandbox = {
    document: {
      readyState: 'complete',
      addEventListener() {},
      getElementById: () => null,
      querySelectorAll: (sel) => (sel === 'form.nl-signup' ? [form] : []),
    },
    location: { search: '' },
    fetch: fetchImpl,
    console,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(newsletterSrc, sandbox);
  return sandbox;
}

const settle = () => new Promise((r) => setTimeout(r, 0));

test('a successful signup announces itself to screen readers and keeps keyboard focus', async () => {
  const { form, kicker, html } = makeForm();
  run(form, async () => ({ ok: true, json: async () => ({ ok: true }) }));

  form.listeners.submit[0]({ preventDefault() {} });
  await settle();
  await settle(); // two chained awaits (fetch, then res.json()) inside postJson()

  assert.match(html(), /class="nl-kicker"/, 'success branch must still render the kicker');
  assert.match(html(), /class="nl-kicker"[^>]*role="status"/, 'the replacement needs its own live region -- .nl-msg was just deleted with the rest of the form');
  assert.match(html(), /class="nl-kicker"[^>]*aria-live="polite"/);
  assert.ok(kicker(), 'querySelector(\'.nl-kicker\') must find the element the code just wrote');
  assert.equal(kicker().focusCalled, true, 'focus must move onto the success message, or a keyboard user is stranded on <body> once the submit button is deleted');
});
