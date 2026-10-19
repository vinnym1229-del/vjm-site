// Regression for the assistant widget's "x" close button shipping with a
// sub-24px touch target. assets/chatbot.js's injectStyles() gave the panel's
// other two interactive controls -- .vjm-chat-input, .vjm-chat-send -- an
// explicit min-height:44px (WCAG 2.2's recommended target size), but
// .vjm-chat-close had no padding or min dimensions at all, so its real
// clickable box was just the "x" glyph itself: ~19px square at 1.2rem/
// line-height:1. That is under both WCAG 2.2 AA's 24x24 "Target Size
// (Minimum)" floor and this exact file's own established 44px convention
// for this panel. Fixed by giving .vjm-chat-close the same min-width/
// min-height:44px its siblings already carry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const chatbotSrc = readFileSync(join(ROOT, 'assets/chatbot.js'), 'utf8');

function ruleBody(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`${escaped}\\{([^}]*)\\}`).exec(css);
  assert.ok(m, `${selector} rule not found in chatbot.js's injected styles`);
  return m[1];
}

function minPx(ruleText, prop) {
  const m = new RegExp(`${prop}:\\s*(\\d+)px`).exec(ruleText);
  return m ? Number(m[1]) : 0;
}

test('close button gets a touch target at least as large as its sibling controls', () => {
  const sendRule = ruleBody(chatbotSrc, '.vjm-chat-send');
  const sendMinHeight = minPx(sendRule, 'min-height');
  assert.ok(sendMinHeight >= 44, 'sanity check: .vjm-chat-send\'s own min-height assumption drifted');

  const closeRule = ruleBody(chatbotSrc, '.vjm-chat-close');
  const closeMinHeight = minPx(closeRule, 'min-height');
  const closeMinWidth = minPx(closeRule, 'min-width');
  assert.ok(closeMinHeight >= 24,
    `.vjm-chat-close min-height is ${closeMinHeight}px, under WCAG 2.2 AA's 24px target-size floor`);
  assert.ok(closeMinWidth >= 24,
    `.vjm-chat-close min-width is ${closeMinWidth}px, under WCAG 2.2 AA's 24px target-size floor`);
});
