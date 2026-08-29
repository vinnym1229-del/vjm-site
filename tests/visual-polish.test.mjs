// Visual polish + assistant wiring contract tests (pj branch).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// Homepage CSS now lives in assets/site.css (extracted for caching);
// concatenate so pattern assertions keep covering markup + styles.
const siteCss = read('assets/site.css');
const index = read('index.html') + siteCss;
const guidance = read('premium-guidance.html');
const propFirms = read('prop-firms.html');

test('liquid system extends across the page sections', () => {
  const instances = [...index.matchAll(/class="liquid-bg[^"]*"/g)].length;
  assert.equal(instances, 5, `expected liquid-bg in hero, features, premium, faq, about — found ${instances}`);
  assert.ok(/<section id="premium"[^>]*>\s*<div class="liquid-bg soft"/.test(index), '#premium must open with its own scoped liquid-bg');
  assert.ok(/<section id="about"[^>]*>\s*<div class="liquid-bg soft"/.test(index), '#about must open with its own scoped liquid-bg');
});

test('blob budget respected and sections scope their blobs', () => {
  const blobs = [...index.matchAll(/class="liquid-blob /g)].length;
  assert.ok(blobs <= 9, `perf budget: max 3+2+2+1+1 blobs, found ${blobs}`);
  // New sections must clip their blobs so nothing bleeds into neighbors.
  assert.match(index, /#premium, #about, #features, #faq \{ position:relative; overflow:hidden; \}/);
});

test('reduced-motion guard covers every blob instance', () => {
  const css = siteCss;
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\{\.liquid-blob\{animation:none!important;\}\}/);
});

test('scroll-reveal is progressive enhancement (no-JS keeps content visible)', () => {
  // Content must NOT be hidden by default CSS; hiding is JS-only.
  assert.doesNotMatch(index, /\[data-reveal\][^}]*opacity:\s*0/);
  // Hidden state is added by JS only…
  assert.match(index, /el\.classList\.add\('reveal-init'\)/);
  // …and never when IntersectionObserver or motion safety is missing.
  assert.match(index, /!reduced && !\('IntersectionObserver' in window\)|if \(reduced \|\| !\('IntersectionObserver' in window\)\) return/);
  assert.match(index, /prefers-reduced-motion: reduce/, 'reveal JS/CSS must reference reduced-motion guard');
});

test('scroll-reveal animation stays subtle', () => {
  assert.match(index, /\.reveal-init\{opacity:0;transform:translateY\(12px\);\}/);
  assert.match(index, /transition:opacity \.4s ease-out, transform \.4s ease-out/);
});

test('floating market assistant is wired into member-facing pages', () => {
  for (const page of ['index.html', 'stock-lab.html', 'options-lab.html', 'forex-calendar.html', 'premarket.html', 'prop-firms.html']) {
    assert.match(read(page), /<script src="assets\/chatbot\.js" defer><\/script>/, `${page} should load the chatbot widget`);
  }
});

test('lesson companion answers only from lesson text via assistant endpoint', () => {
  assert.match(guidance, /id="lesson-companion"/);
  assert.match(guidance, /hidden>/, 'lesson companion must be hidden until premium is verified');
  assert.match(guidance, /lessonText:/, 'must send lessonText so the server grounds answers on it');
  assert.match(read('functions/api/assistant.js'), /Answer ONLY using the LESSON TEXT/);
  // Companion must stay hidden until a verified session exists.
  assert.match(guidance, /function showVerifiedCard\(\)[\s\S]*?showLessonCompanion\(\)/);
});

test('prop-firms page states no unverified specifics in code', () => {
  // Directory is owner-data driven; the HTML must not hardcode firms/prices.
  assert.doesNotMatch(propFirms, /(topstep|apex trader|myfundedfutures|mffx|bulenox|takeprofit trader|ftmo|echelon)/i);
  assert.doesNotMatch(propFirms, /\$\d{2,4}\s*\/\s*(mo|month)/i);
  assert.match(propFirms, /rel="noopener noreferrer sponsored"/, 'outbound firm links must be marked sponsored');
  assert.match(propFirms, /TODO: owner to confirm/);
});
