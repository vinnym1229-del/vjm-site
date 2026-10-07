// Coverage for a logic bug in tools/audit-live-hero.mjs's rotation check.
//
// This tool can't run in this suite (it needs a real browser against a real
// SITE= URL, and this sandbox has no egress to the live domain), so this is
// a static-source pin, the same class this repo already uses for dozens of
// "source must say X" assertions.
//
// The bug: the tool captures two screenshots of #fsStage (t0, t1) a few
// seconds apart with zero interaction in between, then
// tools/audit-hero-pixels.py fails the pair unless they differ ("rotating
// on its own"). That was correct while the WebGL turntable auto-rotated on
// its own, but the fs-ready branch right above this code (the one that is
// actually live in production — the <img class="pj-car-image"> markup is
// always present) superseded that with a photo-mode hero that only animates
// in response to real cursor position. Two un-interacted frames are
// therefore pixel-identical by construction, so the rotation check failed
// unconditionally, on every run, since the 2026-09-09 photo-mode redesign.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const src = readFileSync(join(ROOT, 'tools', 'audit-live-hero.mjs'), 'utf8');

test('audit-live-hero moves the pointer across the hero between its t0/t1 captures', () => {
  const t0At = src.indexOf("${OUT}/w${width}-t0.png");
  const t1At = src.indexOf("${OUT}/w${width}-t1.png");
  assert.ok(t0At > -1 && t1At > t0At, 'expected a t0 screenshot followed by a t1 screenshot');

  const between = src.slice(t0At, t1At);
  const moveCalls = between.match(/page\.mouse\.move\(/g) || [];
  assert.ok(
    moveCalls.length >= 2,
    'expected at least two page.mouse.move() calls between the t0 and t1 screenshots -- ' +
      'today\'s live hero only animates in response to real cursor position, so two frames ' +
      'captured with no interaction are pixel-identical and always fail the "rotating on its ' +
      'own" check, regardless of whether the feature actually works'
  );
});
