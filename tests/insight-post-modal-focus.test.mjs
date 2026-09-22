// Regression for index.html's "How to Understand 'The Markets'" blog post
// modal being a keyboard trap. The insight-card trigger was a bare <div
// onclick="openPost()"> with no tabindex, so it never entered the tab
// order -- a keyboard-only visitor could not reach the site's one piece of
// genuinely free, ungated education from the homepage at all. The modal
// itself also had no focus management: openPost()/closePost() only toggled
// a CSS class, leaving focus wherever it was, and nothing closed the modal
// on Escape. Fixed by giving the trigger role="button" tabindex="0" plus an
// Enter/Space handler, and having openPost()/closePost() move focus onto
// the modal's close button and back to the trigger on close (the same
// pattern tests/chatbot-close-focus.test.mjs and
// tests/nav-dropdown-focus.test.mjs already pin for the chatbot panel and
// nav dropdowns), with Escape closing the modal for parity with every
// other overlay on the site.
//
// That still left a second, deeper gap: this is the site's only real
// role="dialog" aria-modal="true" element (chatbot panel and nav dropdowns
// are non-modal popovers), but nothing actually trapped focus inside it --
// Shift+Tab off the close button walked straight past the dialog boundary
// into the footer links sitting behind the opaque overlay, and Tab off the
// "Back to Insights" button would have walked forward into whatever came
// after the modal in source order. Fixed by having the shared keydown
// listener wrap Tab/Shift+Tab between the dialog's two focusable elements
// while it's open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');

test('insight-card trigger markup is keyboard-focusable and the modal is a labelled dialog', () => {
  const triggerMatch = /<div class="insight-card"[^>]*>/.exec(html);
  assert.ok(triggerMatch, 'insight-card trigger div not found');
  assert.match(triggerMatch[0], /id="insight-card-trigger"/, 'trigger needs a stable id for its keydown handler');
  assert.match(triggerMatch[0], /role="button"/, 'trigger needs role="button" -- it is a <div>, not natively interactive');
  assert.match(triggerMatch[0], /tabindex="0"/, 'trigger needs tabindex="0" to join the tab order');

  const modalMatch = /<div class="modal" role="dialog"[^>]*>/.exec(html);
  assert.ok(modalMatch, 'post-modal .modal wrapper missing role="dialog"');
  assert.match(modalMatch[0], /aria-modal="true"/, 'dialog needs aria-modal="true"');
  assert.match(modalMatch[0], /aria-labelledby="post-modal-title"/, 'dialog needs aria-labelledby pointing at its heading');
  assert.match(html, /<h2 id="post-modal-title">/, 'the heading aria-labelledby points at must actually carry that id');
});

// Extract the contiguous block from `let postModalTrigger` through the
// Escape listener -- it's all one piece in the source, no brace-walking
// needed since nothing else sits between the declaration and the last
// addEventListener statement.
function extractBlogPostScript(source) {
  const start = source.indexOf('let postModalTrigger = null;');
  assert.ok(start > -1, 'postModalTrigger declaration not found in index.html');
  const endMarker = "    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }\n  }\n});";
  const endIdx = source.indexOf(endMarker, start);
  assert.ok(endIdx > -1, 'Tab-trap keydown listener for post-modal not found after postModalTrigger declaration');
  return source.slice(start, endIdx + endMarker.length);
}

const blogPostScript = extractBlogPostScript(html);

// A minimal DOM double: just enough for the extracted script to run.
// getElementById serves the two fixed ids it looks up; querySelector
// serves the one compound selector it uses for the close button.
function makeSandbox() {
  let activeElement = null;
  const docListeners = {};
  function makeNode(id) {
    const classes = new Set();
    return {
      id,
      style: {},
      classList: {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        contains: (c) => classes.has(c),
      },
      listeners: {},
      addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
      focus() { activeElement = this; },
    };
  }
  const trigger = makeNode('insight-card-trigger');
  const modal = makeNode('post-modal');
  const closeBtn = makeNode('modal-close-btn');
  const backBtn = makeNode('modal-back-btn');
  const body = { style: {} };
  const els = { 'insight-card-trigger': trigger, 'post-modal': modal };
  const selectors = { '#post-modal .modal-close': closeBtn, '#post-modal .btn-gold': backBtn };
  const document = {
    get activeElement() { return activeElement; },
    body,
    getElementById: (id) => els[id] || null,
    querySelector: (sel) => selectors[sel] || null,
    addEventListener(type, fn) { (docListeners[type] ||= []).push(fn); },
  };
  const sandbox = { document };
  vm.createContext(sandbox);
  return { sandbox, trigger, modal, closeBtn, backBtn, body, docListeners, getActiveElement: () => activeElement };
}

test('openPost() moves focus into the dialog and remembers the trigger', () => {
  const { sandbox, trigger, modal, closeBtn, body, getActiveElement } = makeSandbox();
  vm.runInContext(blogPostScript, sandbox);
  trigger.focus(); // simulate the keyboard user having tabbed to the trigger
  vm.runInContext('openPost()', sandbox);
  assert.equal(modal.classList.contains('active'), true, 'openPost() should show the modal');
  assert.equal(body.style.overflow, 'hidden', 'openPost() should lock body scroll');
  assert.equal(getActiveElement(), closeBtn, 'openPost() should move focus onto the modal close button');
});

test('closePost() restores focus to whatever opened the modal', () => {
  const { sandbox, trigger, modal, getActiveElement } = makeSandbox();
  vm.runInContext(blogPostScript, sandbox);
  trigger.focus();
  vm.runInContext('openPost(); closePost();', sandbox);
  assert.equal(modal.classList.contains('active'), false, 'closePost() should hide the modal');
  assert.equal(getActiveElement(), trigger, 'closePost() should return focus to the element that opened it');
});

test('Enter/Space on the trigger opens the modal like a real button', () => {
  const { sandbox, trigger, modal } = makeSandbox();
  vm.runInContext(blogPostScript, sandbox);
  let defaultPrevented = false;
  trigger.listeners.keydown[0]({ key: 'Enter', preventDefault: () => { defaultPrevented = true; } });
  assert.equal(modal.classList.contains('active'), true, 'Enter on the trigger should open the modal');
  assert.equal(defaultPrevented, true, 'Enter should be prevented so it does not also scroll/activate anything else');
});

test('Escape closes the modal only while it is open', () => {
  const { sandbox, modal, docListeners } = makeSandbox();
  vm.runInContext(blogPostScript, sandbox);
  const escapeHandler = docListeners.keydown[0];
  escapeHandler({ key: 'Escape' });
  assert.equal(modal.classList.contains('active'), false, 'Escape should be a no-op while the modal is already closed');
  vm.runInContext('openPost()', sandbox);
  escapeHandler({ key: 'Escape' });
  assert.equal(modal.classList.contains('active'), false, 'Escape should close the open modal');
});

test('Tab off the last focusable element wraps forward to the first while the dialog is open', () => {
  const { sandbox, closeBtn, backBtn, docListeners, getActiveElement } = makeSandbox();
  vm.runInContext(blogPostScript, sandbox);
  vm.runInContext('openPost()', sandbox);
  backBtn.focus();
  let defaultPrevented = false;
  docListeners.keydown[0]({ key: 'Tab', shiftKey: false, preventDefault: () => { defaultPrevented = true; } });
  assert.equal(defaultPrevented, true, 'Tab off the back-to-insights button should be intercepted, not left to native tab order');
  assert.equal(getActiveElement(), closeBtn, 'Tab off the back-to-insights button should wrap focus to the close button');
});

test('Shift+Tab off the first focusable element wraps backward to the last while the dialog is open', () => {
  const { sandbox, backBtn, docListeners, getActiveElement } = makeSandbox();
  vm.runInContext(blogPostScript, sandbox);
  vm.runInContext('openPost()', sandbox); // openPost() already focuses the close button
  let defaultPrevented = false;
  docListeners.keydown[0]({ key: 'Tab', shiftKey: true, preventDefault: () => { defaultPrevented = true; } });
  assert.equal(defaultPrevented, true, 'Shift+Tab off the close button should be intercepted, not escape into the page behind the overlay');
  assert.equal(getActiveElement(), backBtn, 'Shift+Tab off the close button should wrap focus to the back-to-insights button');
});

test('Tab is left alone entirely while the dialog is closed', () => {
  const { sandbox, docListeners } = makeSandbox();
  vm.runInContext(blogPostScript, sandbox);
  let defaultPrevented = false;
  docListeners.keydown[0]({ key: 'Tab', shiftKey: false, preventDefault: () => { defaultPrevented = true; } });
  assert.equal(defaultPrevented, false, 'Tab should be a no-op while the dialog is not active, same as Escape');
});
