// Shared theme bootstrap.
//
// The light/dark preference is written by the homepage toggle as
// localStorage['st-theme'], but only index.html and options-lab.html used to
// read it back — so choosing Light on the homepage left every other page black.
// This applies the stored preference on any page that loads it, before paint.
//
// Load it as a plain (non-deferred) script in <head> so the class is on <body>
// by the time the first frame is composited and the page never flashes dark.
(() => {
  'use strict';
  let stored = null;
  try { stored = localStorage.getItem('st-theme'); } catch { /* storage blocked */ }
  if (stored !== 'light') return;
  const apply = () => document.body && document.body.classList.add('light-mode');
  apply();
  if (!document.body) document.addEventListener('DOMContentLoaded', apply, { once: true });
})();
