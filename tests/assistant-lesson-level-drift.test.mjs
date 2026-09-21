// LESSON_LIBRARY in functions/api/assistant.js is a hand-maintained copy of
// course prose, keyed by a `level` field the /api/assistant GET response
// reports verbatim to members (and the coverage note summarizes). Nothing
// tied that field to the course page's own `data-level` panel the text was
// copied from, so three psychology entries (psychology-l1-04/05/06) sat
// stamped 'Foundational' for months while their source page shelved the same
// titles under its Intermediate (level 2) tab -- caught by a fresh-eyes
// audit, not by any test. This file re-derives each lesson's real level from
// the shipped course HTML and pins the coverage note's counts to
// LESSON_LIBRARY itself, so both classes of drift fail loudly next time.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LESSON_LIBRARY, LESSON_COVERAGE_NOTE } from '../functions/api/assistant.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const LEVEL_NAME_BY_NUMBER = {
  1: 'Foundational',
  2: 'Intermediate',
  3: 'Advanced',
  4: 'Expert/Professional',
};

// Splits a course page into its `<section class="level-panel" data-level="N"
// ...>` blocks and returns, for each block, the panel's level name plus its
// raw text (used only for an .includes() title search, not re-parsed).
function levelPanels(html) {
  const starts = [...html.matchAll(/<section class="level-panel(?: active)?" data-level="(\d)"[^>]*>/g)];
  return starts.map((m, i) => {
    const from = m.index + m[0].length;
    const to = i + 1 < starts.length ? starts[i + 1].index : html.length;
    return { levelName: LEVEL_NAME_BY_NUMBER[Number(m[1])], text: html.slice(from, to) };
  });
}

const pageCache = new Map();
function panelsFor(resource) {
  if (!pageCache.has(resource)) {
    pageCache.set(resource, levelPanels(read(resource.replace(/^\//, ''))));
  }
  return pageCache.get(resource);
}

// LESSON_LIBRARY's titles are hand-typed with straight quotes; the shipped
// pages use curly/smart quotes for the same text. Normalize both sides so a
// typography difference can't mask (or fake) a real title/level mismatch.
const straighten = (s) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');

test('every LESSON_LIBRARY entry\'s level matches the course page tab it was copied from', () => {
  for (const lesson of LESSON_LIBRARY) {
    if (lesson.level === 'Free start-here') continue; // not a numbered course tab
    const panels = panelsFor(lesson.resource);
    const owningPanel = panels.find((p) => straighten(p.text).includes(straighten(lesson.title)));
    assert.ok(
      owningPanel,
      `${lesson.id}: title not found in any level panel of ${lesson.resource} -- source page may have changed`,
    );
    assert.equal(
      lesson.level,
      owningPanel.levelName,
      `${lesson.id}: LESSON_LIBRARY says level '${lesson.level}' but ${lesson.resource} has this title under '${owningPanel.levelName}'`,
    );
  }
});

test('the coverage note\'s counts stay pinned to LESSON_LIBRARY\'s actual level mix', () => {
  const foundational = LESSON_LIBRARY.filter((l) => l.level === 'Foundational').length;
  const deeper = LESSON_LIBRARY.filter((l) => l.level !== 'Foundational' && l.level !== 'Free start-here').length;
  assert.match(LESSON_COVERAGE_NOTE, new RegExp(`^${foundational} Foundational \\(level 1\\)`));
  if (deeper > 0) {
    assert.match(LESSON_COVERAGE_NOTE, new RegExp(`plus ${deeper} lessons? wired from a deeper level`));
  } else {
    assert.doesNotMatch(LESSON_COVERAGE_NOTE, /wired from a deeper level/);
  }
});

console.log('VJM assistant lesson-level drift tests passed.');
