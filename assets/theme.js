// Shared theme bootstrap.
//
// LIGHT IS THE DEFAULT (owner request, 2026-09-01). The site used to boot dark
// and only go light when localStorage['st-theme'] === 'light', so a first-time
// visitor landed on a black page. The rule is now inverted: every visitor gets
// light unless they have explicitly chosen dark, and that choice is remembered.
//
//   stored 'dark'  -> dark   (explicit opt-in, honoured)
//   stored 'light' -> light  (explicit opt-in, honoured)
//   nothing stored -> light  (the new default; this is the only case that changed)
//
// Load it as a plain (non-deferred) script in <head> so the class is on <body>
// by the time the first frame is composited and the page never flashes dark.
(() => {
  'use strict';
  let stored = null;
  try { stored = localStorage.getItem('st-theme'); } catch { /* storage blocked */ }
  if (stored === 'dark') return;
  const apply = () => document.body && document.body.classList.add('light-mode');
  if (document.body) { apply(); return; }
  // In <head> the <body> element does not exist yet, and DOMContentLoaded only
  // fires once the whole document is parsed — a browser can paint several
  // frames before that. Catching the <body> insertion itself is what keeps the
  // theme class ahead of the first paint (this is the flash the toggle used to
  // show). DOMContentLoaded stays as a belt-and-braces fallback.
  if (typeof MutationObserver === 'function') {
    const obs = new MutationObserver(() => { if (document.body) { apply(); obs.disconnect(); } });
    obs.observe(document.documentElement, { childList: true });
  }
  document.addEventListener('DOMContentLoaded', apply, { once: true });
})();
