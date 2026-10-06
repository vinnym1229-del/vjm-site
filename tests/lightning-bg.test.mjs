// assets/lightning-bg.js (the sitewide ambient lightning backdrop that runs
// on every page except index.html, which uses candles-bg.js instead) was
// never wired into check:syntax by name and no test executed it -- unlike
// every sibling decorative script (candles-bg.js, tilt.js, theme.js,
// funnel.js, chatbot.js, curriculum.js, newsletter.js, live-ticker.js), each
// of which has its own vm-sandboxed test. tools/check-syntax.mjs now
// auto-discovers assets/*.js, so a pure syntax error here is already caught --
// but a logic regression in the idempotency guard, the reduced-motion
// branch, the body-position fallback, or the NEUTRAL->palette colour
// substitution (the thing that makes the light theme "all red, no white" per
// the file's own owner-note comment) would sail through untouched. This test
// runs the script's IIFE in a vm sandbox against a minimal DOM double so
// those behaviours actually have a regression test, the same pattern
// tests/candles-bg.test.mjs uses since this repo has no DOM parser available
// to tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

function makeSandbox({ existingLayer = null, reducedMotion = false, bodyPosition = 'static' } = {}) {
  const created = [];
  const body = {
    firstChild: null,
    insertBefore(node, ref) {
      assert.equal(ref, body.firstChild, 'inserts relative to the current firstChild');
      body.firstChild = node;
      return node;
    },
    style: {},
  };
  const head = { appendChild(node) { head.lastStyle = node; } };
  const document = {
    getElementById(id) { return id === 'site-bolt-layer' ? existingLayer : null; },
    createElement(tag) {
      const attrs = {};
      let html = '';
      const el = {
        tag,
        style: {},
        setAttribute(k, v) { attrs[k] = v; },
        getAttribute(k) { return attrs[k]; },
        get innerHTML() { return html; },
        set innerHTML(v) { html = v; },
      };
      created.push(el);
      return el;
    },
    body,
    head,
  };
  const window = { matchMedia() { return { matches: reducedMotion }; } };
  const getComputedStyle = () => ({ position: bodyPosition });
  const sandbox = { document, window, getComputedStyle };
  vm.createContext(sandbox);
  vm.runInContext(read('assets/lightning-bg.js'), sandbox);
  return { created, body, head };
}

test('lightning-bg.js inserts one aria-hidden layer as body\'s first child with two bolt divs', () => {
  const { created, body } = makeSandbox();
  assert.equal(created.length, 2, 'the wrapper div plus the <style> element');
  const wrap = created[0];
  assert.equal(wrap.tag, 'div');
  assert.equal(wrap.id, 'site-bolt-layer');
  assert.equal(wrap.getAttribute('aria-hidden'), 'true');
  assert.equal(body.firstChild, wrap, 'layer inserted as the first child of <body>');
  assert.match(wrap.innerHTML, /class="sbl-r"/);
  assert.match(wrap.innerHTML, /class="sbl-l"/);
});

test('lightning-bg.js is idempotent: does nothing if #site-bolt-layer already exists', () => {
  const existing = { tag: 'div', style: {} };
  const { created, head } = makeSandbox({ existingLayer: existing });
  assert.equal(created.length, 0, 'no new elements created on a second run');
  assert.equal(head.lastStyle, undefined, 'no <style> appended either');
});

test('lightning-bg.js disables the strike keyframe animation under prefers-reduced-motion', () => {
  const { head } = makeSandbox({ reducedMotion: true });
  const css = head.lastStyle.textContent;
  assert.match(css, /animation:none/, 'both bolts fall back to animation:none');
  assert.doesNotMatch(css, /sblStrike 5s/, 'the strike keyframe is never referenced when reduced motion is requested');
});

test('lightning-bg.js runs the strike keyframe animation when motion is not reduced', () => {
  const { head } = makeSandbox({ reducedMotion: false });
  const css = head.lastStyle.textContent;
  assert.match(css, /sblStrike 5s ease-in-out infinite/);
  assert.doesNotMatch(css, /animation:none/);
});

test('lightning-bg.js only sets body position to relative when it was static', () => {
  const { body: staticBody } = makeSandbox({ bodyPosition: 'static' });
  assert.equal(staticBody.style.position, 'relative', 'static body gets a positioning context so the absolutely-positioned layer anchors to it');

  const { body: positionedBody } = makeSandbox({ bodyPosition: 'relative' });
  assert.equal(positionedBody.style.position, undefined, 'an already-positioned body is left untouched');
});

test('lightning-bg.js paints the light theme bolts all red, with no leftover white from the dark art', () => {
  const { head } = makeSandbox();
  const css = head.lastStyle.textContent;
  const urls = [...css.matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1]);
  assert.equal(urls.length, 4, 'dark .sbl-r, dark .sbl-l, light .sbl-r, light .sbl-l');
  const [rightDark, leftDark, rightLight, leftLight] = urls;

  assert.match(rightDark, /%23ffffff/, 'dark theme keeps a white-hot core (the "part white" half of the owner note)');
  assert.match(leftDark, /%23ffffff/);
  assert.doesNotMatch(rightLight, /%23ffffff/, 'light theme must be all red -- a white bolt on a white page is invisible');
  assert.doesNotMatch(leftLight, /%23ffffff/);

  assert.notEqual(rightDark, rightLight, 'the light palette actually substituted, not a no-op copy');
  assert.notEqual(leftDark, leftLight);
});
