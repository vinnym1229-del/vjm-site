// LESSON_LIBRARY's `sections[].text` is documented (functions/api/assistant.js's
// own header comment) as a hand-maintained VERBATIM copy of each lesson's
// "Why it matters" / "Watch for" prose on its source course page, specifically
// so "lesson text cannot drift from the page a member is reading." Nothing
// enforced that promise for the text itself: tests/assistant-lesson-level-drift
// .test.mjs cross-checks the `level` field and the lesson's title, never the
// section bodies. That gap let a real drift ship silently -- futures-l1-04's
// "Why it matters" text read "...Margin: Know What's Needed ." (stray space
// before the period) while the source page's `<a>Margin: Know What's
// Needed</a>.` has no space there, because the period sits directly after the
// closing anchor tag. `buildLessonPrompt()` fences this text verbatim into the
// assistant's LLM prompt whenever a member asks about the lesson, so the typo
// could be echoed back in an AI answer. This test re-derives each lesson's
// "Why it matters"/"Watch for" text from the shipped course HTML (stripping
// only the `<a>` wrapper, as the hand-copy already does everywhere else) and
// diffs it against LESSON_LIBRARY's copy, so a future hand-edit to either side
// can't silently drift the other out of sync again.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LESSON_LIBRARY } from '../functions/api/assistant.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// LESSON_LIBRARY is hand-typed with straight quotes/apostrophes; the shipped
// pages use curly/smart quotes and the odd raw HTML entity for the same
// prose. Collapse whitespace too, since the source is unwrapped inline HTML.
const normalize = (s) =>
  s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

const straighten = (s) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');

// Strips only the <a> wrapper (keeping its link text) the way the hand-copy
// does; any other tag would mean the source structure changed underneath it.
const stripAnchor = (html) => html.replace(/<a\b[^>]*>([\s\S]*?)<\/a>/g, '$1').replace(/<[^>]+>/g, '');

// Splits a course page into each `<details class="lesson-card">...</details>`
// block so a section can be matched by its own lesson's title rather than by
// document order (which drifts every time a lesson is inserted or reordered).
function lessonCards(html) {
  const starts = [...html.matchAll(/<details class="lesson-card">/g)];
  return starts.map((m, i) => {
    const from = m.index;
    const to = i + 1 < starts.length ? starts[i + 1].index : html.length;
    return html.slice(from, to);
  });
}

const pageCardsCache = new Map();
function cardsFor(resource) {
  const path = resource.replace(/^\//, '');
  if (!pageCardsCache.has(path)) pageCardsCache.set(path, lessonCards(read(path)));
  return pageCardsCache.get(path);
}

function extract(cardHtml, regex) {
  const m = cardHtml.match(regex);
  return m ? normalize(stripAnchor(m[1])) : null;
}

const WHY_RE = /<p class="why">([\s\S]*?)<\/p>/;
const WATCH_RE = /<div class="correct"><span class="label">Watch for<\/span><p>([\s\S]*?)<\/p><\/div>/;

test('every LESSON_LIBRARY "Why it matters"/"Watch for" section matches the course page prose it was copied from', () => {
  let checked = 0;
  for (const lesson of LESSON_LIBRARY) {
    if (lesson.level === 'Free start-here') continue; // premium-guidance.html has no lesson-card structure; covered by its own test below
    const cards = cardsFor(lesson.resource);
    const card = cards.find((c) => straighten(c).includes(straighten(lesson.title)));
    assert.ok(card, `${lesson.id}: title not found in any lesson-card of ${lesson.resource}`);

    const why = lesson.sections.find((s) => s.heading === 'Why it matters');
    const watch = lesson.sections.find((s) => s.heading === 'Watch for');

    if (why) {
      const pageText = extract(card, WHY_RE);
      assert.ok(pageText, `${lesson.id}: no <p class="why"> found in its lesson-card in ${lesson.resource}`);
      assert.equal(
        normalize(why.text),
        pageText,
        `${lesson.id}: "Why it matters" text has drifted from ${lesson.resource}`,
      );
      checked++;
    }
    if (watch) {
      const pageText = extract(card, WATCH_RE);
      assert.ok(pageText, `${lesson.id}: no Watch-for block found in its lesson-card in ${lesson.resource}`);
      assert.equal(
        normalize(watch.text),
        pageText,
        `${lesson.id}: "Watch for" text has drifted from ${lesson.resource}`,
      );
      checked++;
    }
  }
  // Guards against the extraction itself silently matching nothing (e.g. a
  // page restructure that breaks WHY_RE/WATCH_RE) and the test passing empty.
  assert.ok(checked >= 40, `expected to check at least 40 sections, only checked ${checked}`);
});

// guidance-foundation (the free "Start Here" lesson) has no <details
// class="lesson-card"> on its source page -- premium-guidance.html's six
// steps are plain `.step` divs, not the numbered course-tab structure the
// test above parses -- so it was exempted from drift protection entirely
// rather than given its own. It carries the exact same risk: buildLessonPrompt()
// fences these six `sections[].text` values verbatim into the assistant's LLM
// prompt, and every signed-in member can reach this lesson (it isn't in
// RESOURCE_TIERS, so authorizeResource() allows it unconditionally).
test('the Free start-here lesson\'s six-step text matches premium-guidance.html\'s own .step markup', () => {
  const lesson = LESSON_LIBRARY.find((l) => l.id === 'guidance-foundation');
  assert.ok(lesson, 'guidance-foundation lesson missing from LESSON_LIBRARY');

  const steps = [...read('premium-guidance.html').matchAll(
    /<div class="step"><div class="num">\d+<\/div><h3>([^<]+)<\/h3><p>([^<]+)<\/p><\/div>/g,
  )].map((m) => ({ heading: normalize(m[1]), text: normalize(m[2]) }));
  assert.ok(steps.length >= 6, `expected at least 6 .step divs in premium-guidance.html, found ${steps.length}`);

  let checked = 0;
  for (const section of lesson.sections) {
    if (section.heading === 'Overview') continue; // a summary, not copied from any one .step div
    const heading = normalize(section.heading.replace(/^\d+\.\s*/, ''));
    const step = steps.find((s) => s.heading === heading);
    assert.ok(step, `${lesson.id} ${section.id}: no premium-guidance.html .step div titled "${heading}"`);
    assert.equal(
      normalize(section.text),
      step.text,
      `${lesson.id} ${section.id}: text has drifted from premium-guidance.html`,
    );
    checked++;
  }
  assert.equal(checked, 6, `expected to check exactly 6 steps, checked ${checked}`);
});

console.log('VJM assistant lesson-text drift tests passed.');
