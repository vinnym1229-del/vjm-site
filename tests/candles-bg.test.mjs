// assets/candles-bg.js (the homepage hero's decorative candlestick backdrop,
// replacing lightning-bg.js on index.html per the file's own header comment)
// was never wired into check:syntax and no test imports it -- unlike every
// other homepage script (theme.js, funnel.js, chatbot.js, tilt.js,
// live-ticker.js), which are either syntax-checked directly or pulled in
// transitively by a test's own import. Confirmed by deliberately breaking
// the file's syntax: `npm run check:syntax` and the full suite both stayed
// green. A real syntax error here today would silently break the hero
// backdrop on the site's highest-traffic page with nothing in CI to catch
// it. This test runs the script's IIFE in a vm sandbox against a minimal
// DOM double so a syntax or logic break actually fails a test; package.json
// separately gained `node --check assets/candles-bg.js` in check:syntax.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

function make2dContext() {
  return {
    setTransform() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {},
    stroke() {}, fillRect() {}, strokeStyle: '', fillStyle: '', lineWidth: 0,
    globalCompositeOperation: 'source-over',
    createLinearGradient() { return { addColorStop() {} }; },
  };
}

function makeHero(width, height) {
  const children = [];
  return {
    clientWidth: width,
    clientHeight: height,
    firstChild: null,
    insertBefore(node, ref) { children.unshift(node); node.parent = this; return node; },
    children,
  };
}

function makeSandbox({ hero, existingCandles = null, lightMode = false, dpr } = {}) {
  const created = [];
  const resizeListeners = [];
  let moInstance = null;
  const document = {
    querySelector(sel) { return sel === '.hero' ? hero : null; },
    getElementById(id) { return id === 'hero-candles' ? existingCandles : null; },
    createElement(tag) {
      const attrs = {};
      const el = {
        tag,
        style: {},
        setAttribute(k, v) { attrs[k] = v; },
        getAttribute(k) { return attrs[k]; },
        getContext(kind) { assert.equal(kind, '2d'); const ctx = make2dContext(); el.lastCtx = ctx; return ctx; },
      };
      created.push(el);
      return el;
    },
    body: { classList: { contains: (c) => c === 'light-mode' && lightMode } },
  };
  const window = {
    devicePixelRatio: dpr,
    addEventListener(type, fn) { if (type === 'resize') resizeListeners.push(fn); },
  };
  class MutationObserver {
    constructor(fn) { this.fn = fn; moInstance = this; }
    observe() {}
  }
  const sandbox = {
    document, window, MutationObserver,
    setTimeout: (fn) => { fn(); return 0; }, // run debounced redraws synchronously
    clearTimeout() {},
  };
  vm.createContext(sandbox);
  vm.runInContext(read('assets/candles-bg.js'), sandbox);
  return {
    created,
    fireResize() { resizeListeners.forEach((fn) => fn()); },
    fireThemeMutation() { moInstance.fn(); },
  };
}

test('candles-bg.js inserts one aria-hidden canvas as the hero\'s first child and draws into it', () => {
  const hero = makeHero(1400, 640);
  const { created } = makeSandbox({ hero, dpr: 2 });
  assert.equal(created.length, 1, 'exactly one canvas element created');
  const cv = created[0];
  assert.equal(cv.tag, 'canvas');
  assert.equal(cv.getAttribute('aria-hidden'), 'true');
  assert.equal(hero.children[0], cv, 'canvas inserted as the hero\'s first child');
  assert.equal(cv.width, 2800, 'backing-store width scales with devicePixelRatio');
  assert.equal(cv.height, 1280);
  assert.ok(cv.lastCtx, 'draw() actually called getContext(\"2d\") and rendered');
});

test('candles-bg.js does nothing when the page has no .hero section', () => {
  assert.doesNotThrow(() => makeSandbox({ hero: null }));
});

test('candles-bg.js is idempotent: does not insert a second canvas if #hero-candles already exists', () => {
  const hero = makeHero(1200, 600);
  const existing = { tag: 'canvas', style: {} };
  const { created } = makeSandbox({ hero, existingCandles: existing });
  assert.equal(created.length, 0, 'no new canvas created when one already exists');
});

test('candles-bg.js does not throw and skips drawing when the hero has no measured size yet', () => {
  const hero = makeHero(0, 0);
  const { created } = makeSandbox({ hero });
  assert.equal(created.length, 1, 'canvas element is still created');
  assert.equal(created[0].lastCtx, undefined, 'draw() bails out before touching the canvas context');
});

test('candles-bg.js redraws on window resize', () => {
  const hero = makeHero(1000, 500);
  const { created, fireResize } = makeSandbox({ hero, dpr: 1 });
  const cv = created[0];
  const firstCtx = cv.lastCtx;
  hero.clientWidth = 1600; hero.clientHeight = 700;
  fireResize();
  assert.notEqual(cv.lastCtx, firstCtx, 'resize triggers a fresh draw() with a new canvas context');
  assert.equal(cv.width, 1600);
});

test('candles-bg.js redraws only when the light/dark theme actually changes', () => {
  const hero = makeHero(1000, 500);
  const { created, fireThemeMutation } = makeSandbox({ hero, lightMode: false });
  const cv = created[0];
  const firstCtx = cv.lastCtx;
  fireThemeMutation(); // class attribute mutated, but still dark -- must not redraw
  assert.equal(cv.lastCtx, firstCtx, 'no redraw when the mutation observer fires but light-mode did not actually change');
});
