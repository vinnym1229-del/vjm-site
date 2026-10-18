// index.html's intro-video facade (#video-facade) starts as a fake button
// -- role="button" tabindex="0" aria-label="Play introduction video" on a
// <div>, since nothing loads until the visitor clicks (protects LCP). Once
// activate() swaps in the real player (a YouTube iframe or the self-hosted
// <video>), that div is just a transparent wrapper -- but it kept its
// role/tabindex regardless, so a keyboard or screen-reader user who played
// the video landed on a dead "button" stop (activate() already returned,
// so Enter/Space/click do nothing) sitting right before the real player's
// own focusable controls. The fallback "video coming soon" note path
// (showNote()) already cleaned this up; the two success paths never did.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');

// Extract the contiguous IIFE from its own header comment through the
// closing `})();` -- it's all one piece in the source, no brace-walking
// needed since nothing else sits between them.
function extractVideoFacadeScript(source) {
  const start = source.indexOf("(function () {\n  'use strict';\n  const facade = document.getElementById('video-facade');");
  assert.ok(start > -1, 'video-facade IIFE opening not found in index.html');
  const endMarker = "  facade.addEventListener('click', activate);\n  facade.addEventListener('keydown', (e) => {\n    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }\n  });\n})();";
  const endIdx = source.indexOf(endMarker, start);
  assert.ok(endIdx > -1, 'video-facade IIFE closing block not found after its opening');
  return source.slice(start, endIdx + endMarker.length);
}

const videoFacadeScript = extractVideoFacadeScript(html);

// A minimal facade <div> double plus just enough of `document` for the
// extracted script to run: getElementById serves the one fixed id it looks
// up, createElement serves the iframe/video it builds on success.
function makeSandbox({ yt = '', mp4 = '/video/pj-intro.mp4', headOk = true } = {}) {
  const attrs = {
    'data-video-yt': yt,
    'data-video-mp4': mp4,
    role: 'button',
    tabindex: '0',
    'aria-label': 'Play introduction video',
  };
  const listeners = {};
  const children = [];
  let htmlStr = '';
  const facade = {
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    removeAttribute: (k) => { delete attrs[k]; },
    setAttribute: (k, v) => { attrs[k] = String(v); },
    hasAttribute: (k) => k in attrs,
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    appendChild(node) { children.push(node); return node; },
    get innerHTML() { return htmlStr; },
    set innerHTML(v) { htmlStr = v; children.length = 0; },
  };
  const document = {
    getElementById: (id) => (id === 'video-facade' ? facade : null),
    createElement: (tag) => ({ tagName: tag.toUpperCase() }),
  };
  const sandbox = {
    document,
    fetch: async () => ({ ok: headOk }),
  };
  vm.createContext(sandbox);
  vm.runInContext(videoFacadeScript, sandbox);
  return { sandbox, facade, attrs, listeners, children };
}

test('activating a YouTube embed drops the facade div\'s button role/tabindex', () => {
  const { facade, listeners } = makeSandbox({ yt: 'https://www.youtube.com/embed/abc123' });
  listeners.click[0]();
  assert.equal(facade.hasAttribute('role'), false,
    'role="button" must be removed once the div just wraps a real iframe player');
  assert.equal(facade.hasAttribute('tabindex'), false,
    'tabindex="0" must be removed so a dead stop does not sit in front of the iframe\'s own controls');
});

test('activating the self-hosted mp4 player drops the facade div\'s button role/tabindex', async () => {
  const { facade, listeners } = makeSandbox({ headOk: true });
  listeners.click[0]();
  await new Promise((r) => setTimeout(r, 0)); // flush the HEAD-check fetch().then()
  assert.equal(facade.hasAttribute('role'), false,
    'role="button" must be removed once the div just wraps a real <video> player');
  assert.equal(facade.hasAttribute('tabindex'), false,
    'tabindex="0" must be removed so a dead stop does not sit in front of the video\'s own controls');
});

test('a failed HEAD check still falls back to the note, unaffected by this fix', async () => {
  const { facade, listeners } = makeSandbox({ headOk: false });
  listeners.click[0]();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(facade.hasAttribute('role'), false, 'the pre-existing fallback-note path already cleared role');
  assert.equal(facade.hasAttribute('tabindex'), false, 'the pre-existing fallback-note path already cleared tabindex');
  assert.match(facade.innerHTML, /video-note/, 'should render the fallback note, not a player');
});
