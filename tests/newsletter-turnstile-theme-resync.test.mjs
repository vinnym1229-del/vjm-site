// Regression for the homepage/giveaway/quiz-lead and prop-firms.html
// newsletter forms' Turnstile widgets freezing in the stale theme on toggle.
//
// The curriculum pages' lock-form widgets (assets/curriculum.js) and four
// standalone tool pages' gate widgets already got a resyncTurnstileTheme()
// fix for this: Cloudflare bakes a widget's theme into its rendered iframe
// once, with no live-restyle hook, so flipping #theme-toggle after a widget
// has already rendered left it stuck in the old theme. assets/newsletter.js's
// mountTurnstile() has the exact same one-shot `theme: ...` option and never
// got the matching fix, so index.html's newsletter/giveaway/quiz-lead forms
// and prop-firms.html's newsletter form were still exposed: a visitor who
// loads light (the default), scrolls to one of these forms so the widget
// renders, then flips to dark mid-signup is left solving a CAPTCHA box
// frozen in the wrong theme next to the now-recolored card around it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const newsletterSrc = read('assets/newsletter.js');

/** A stand-in for a real <form>/<div> node: enough for querySelector/closest/dataset. */
function makeEl(tag) {
  const el = { tag, dataset: {}, _children: {}, _parent: null,
    querySelector(sel) { return this._children[sel] || null; },
    closest(sel) { return sel === 'form' && this.tag === 'form' ? this : (this._parent ? this._parent.closest(sel) : null); },
  };
  return el;
}

/**
 * Boots newsletter.js with one static nl-signup form (standing in for
 * index.html's two and prop-firms.html's one) plus a fake Cloudflare
 * Turnstile client that records every remove()/render() call.
 */
function load({ lightMode = true } = {}) {
  const form = makeEl('form');
  const slot = makeEl('div');
  slot._parent = form;
  form._children['.nl-turnstile'] = slot;
  form.addEventListener = () => {};

  const removeCalls = [];
  let renderCount = 0;
  let scriptNode = null;
  const fakeCfTurnstile = {
    render(el, opts) { renderCount += 1; el._renderOpts = opts; return 'widget-' + renderCount; },
    remove(idOrEl) { removeCalls.push(idOrEl); },
  };

  const bodyClasses = new Set();
  if (lightMode) bodyClasses.add('light-mode');
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
      body: { classList: { contains: (c) => bodyClasses.has(c) } },
      querySelectorAll(sel) {
        if (sel === 'form.nl-signup') return [form];
        if (sel === '.nl-turnstile') return [slot];
        return [];
      },
    },
    location: { search: '', pathname: '/' },
    fetch: async () => ({ ok: true, json: async () => ({ required: true, siteKey: 'sk_test' }) }),
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(newsletterSrc, sandbox);
  return { win: sandbox, form, slot, removeCalls, fireScriptLoad: () => scriptNode && scriptNode.onload() };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

/** Mounts the one static form's widget for real, the same path mountTurnstile() uses on page load. */
async function loadAndMount(opts) {
  const state = load(opts);
  await settle();
  state.fireScriptLoad();
  return state;
}

test('window.vjmTurnstile exposes resyncTheme alongside mount/required/misconfigured', async () => {
  const { win } = await loadAndMount();
  assert.equal(typeof win.vjmTurnstile.resyncTheme, 'function');
});

test('resyncTheme() removes and re-renders an already-mounted widget with the new theme', async () => {
  const { win, form, slot, removeCalls } = await loadAndMount({ lightMode: true });
  assert.equal(slot._renderOpts.theme, 'light', 'sanity check: widget mounted light, matching the page');
  const firstWidgetId = form.dataset.turnstileWidgetId;

  win.vjmTurnstile.resyncTheme(false);

  assert.deepEqual(removeCalls, [firstWidgetId], 'must remove the exact widget id mountTurnstile() recorded, not a bare reset()');
  assert.equal(slot._renderOpts.theme, 'dark', 'the re-rendered widget must carry the new theme');
  assert.equal(slot._renderOpts.sitekey, 'sk_test', 'the re-rendered widget must still carry the real site key');
  assert.notEqual(form.dataset.turnstileWidgetId, firstWidgetId, 'the new widget must get its own id, not reuse the removed one');
});

test('resyncTheme() wires the same token callback a fresh mount would, so solving the new widget still unlocks submit', async () => {
  const { win, form } = await loadAndMount({ lightMode: true });
  form.dataset.turnstileToken = 'stale-token-from-the-old-widget';

  win.vjmTurnstile.resyncTheme(false);
  assert.equal(form.dataset.turnstileToken, undefined, 'a token tied to the removed widget must not survive the resync');

  const newOpts = form._children['.nl-turnstile']._renderOpts;
  newOpts.callback('fresh-token');
  assert.equal(form.dataset.turnstileToken, 'fresh-token', 'the re-rendered widget\'s callback must still populate dataset.turnstileToken');

  newOpts['expired-callback']();
  assert.equal(form.dataset.turnstileToken, undefined, 'the re-rendered widget must still clear the token on expiry');
});

test('resyncTheme() leaves a never-rendered widget alone (nothing to resync yet)', async () => {
  const { win, removeCalls } = load({ lightMode: true }); // no fireScriptLoad: the widget never mounted
  assert.doesNotThrow(() => win.vjmTurnstile.resyncTheme(false));
  assert.deepEqual(removeCalls, [], 'a slot with no rendered widget must not be removed/re-rendered');
});

test('resyncTheme() no-ops when the Turnstile script never loaded (window.turnstile missing)', async () => {
  const { win, removeCalls } = await loadAndMount({ lightMode: true });
  delete win.turnstile;
  assert.doesNotThrow(() => win.vjmTurnstile.resyncTheme(false));
  assert.deepEqual(removeCalls, [], 'with no window.turnstile there is nothing to remove or re-render');
});
