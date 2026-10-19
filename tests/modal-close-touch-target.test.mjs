// Regression for the blog-post modal's "x" close button shipping with a
// sub-24px touch target -- the same bug class fixed in assets/chatbot.js's
// .vjm-chat-close (see tests/chatbot-close-touch-target.test.mjs). assets/
// site.css's .modal-close had position/offset and color rules but no
// padding or min dimensions at all, so its real clickable box was just the
// "x" glyph itself: ~24px square at 1.5rem/line-height default. That is
// under WCAG 2.2 AA's 24x24 "Target Size (Minimum)" floor with no margin
// for its actual rendered size. Fixed by giving .modal-close the same
// min-width/min-height:44px convention the chatbot panel's controls use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const siteCss = readFileSync(join(ROOT, 'assets/site.css'), 'utf8');

function ruleBody(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  assert.ok(m, `${selector} rule not found in assets/site.css`);
  return m[1];
}

function minPx(ruleText, prop) {
  const m = new RegExp(`${prop}:\\s*(\\d+)px`).exec(ruleText);
  return m ? Number(m[1]) : 0;
}

test('blog-post modal close button gets a touch target at least WCAG\'s 24px floor', () => {
  const closeRule = ruleBody(siteCss, '.modal-close');
  const closeMinHeight = minPx(closeRule, 'min-height');
  const closeMinWidth = minPx(closeRule, 'min-width');
  assert.ok(closeMinHeight >= 24,
    `.modal-close min-height is ${closeMinHeight}px, under WCAG 2.2 AA's 24px target-size floor`);
  assert.ok(closeMinWidth >= 24,
    `.modal-close min-width is ${closeMinWidth}px, under WCAG 2.2 AA's 24px target-size floor`);
});
