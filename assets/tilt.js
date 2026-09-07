// Perspective tilt for the homepage cards. Each card leans toward the cursor
// in real 3D (rotateX/rotateY under a parent perspective) and carries a
// highlight that follows the pointer, so the cards read as physical panels
// rather than flat rectangles. The transform is written through CSS custom
// properties rather than directly, so the stylesheet's own hover lift keeps
// working and the two compose instead of overwriting each other.
//
// Off entirely for reduced-motion users and for touch-only devices (a tilt
// that follows a finger reads as jitter, not depth).
//
// Delegated on document rather than bound per-card at load time: index.html's
// CMS content-sync replaces #tier-grid's whole innerHTML with fresh
// .tier-card nodes once the /api/content?type=bundles fetch resolves (which
// runs after this deferred script, since it needs a network round trip), so
// listeners attached directly to the original cards would go silently dead
// the moment an owner curates real bundles. Delegation survives that swap
// with no re-init call needed.
(function () {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;

  var MAX = 7; // degrees at the card's edge
  var SEL = '.feature-card, .tier-card';
  var raf = 0, active = null, px = 0, py = 0;

  function apply() {
    raf = 0;
    if (!active) return;
    var r = active.getBoundingClientRect();
    var x = (px - r.left) / r.width, y = (py - r.top) / r.height;
    active.style.setProperty('--ry', ((x - 0.5) * 2 * MAX).toFixed(2) + 'deg');
    active.style.setProperty('--rx', ((0.5 - y) * 2 * MAX).toFixed(2) + 'deg');
    active.style.setProperty('--mx', (x * 100).toFixed(1) + '%');
    active.style.setProperty('--my', (y * 100).toFixed(1) + '%');
  }
  function release() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (active) {
      active.style.setProperty('--rx', '0deg');
      active.style.setProperty('--ry', '0deg');
      active = null;
    }
  }

  document.addEventListener('pointermove', function (e) {
    var card = e.target.closest && e.target.closest(SEL);
    if (!card) { release(); return; }
    if (card !== active) active = card;
    px = e.clientX; py = e.clientY;
    if (!raf) raf = requestAnimationFrame(apply);
  });
  // pointerleave doesn't bubble, so a delegated listener can't use it for
  // "left a card" the way the old per-card binding did; pointermove finding
  // no matching card (above) covers moving onto a non-card area of the page,
  // and pointerout with a null relatedTarget covers leaving the window
  // entirely while still over a card.
  document.addEventListener('pointerout', function (e) {
    if (e.relatedTarget === null) release();
  });
})();
