// Perspective tilt for the homepage cards. Each card leans toward the cursor
// in real 3D (rotateX/rotateY under a parent perspective) and carries a
// highlight that follows the pointer, so the cards read as physical panels
// rather than flat rectangles. The transform is written through CSS custom
// properties rather than directly, so the stylesheet's own hover lift keeps
// working and the two compose instead of overwriting each other.
//
// Off entirely for reduced-motion users and for touch-only devices (a tilt
// that follows a finger reads as jitter, not depth).
(function () {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;

  var MAX = 7; // degrees at the card's edge
  var cards = document.querySelectorAll('.feature-card, .tier-card');
  cards.forEach(function (card) {
    var raf = 0, px = 0, py = 0;
    function apply() {
      raf = 0;
      var r = card.getBoundingClientRect();
      var x = (px - r.left) / r.width, y = (py - r.top) / r.height;
      card.style.setProperty('--ry', ((x - 0.5) * 2 * MAX).toFixed(2) + 'deg');
      card.style.setProperty('--rx', ((0.5 - y) * 2 * MAX).toFixed(2) + 'deg');
      card.style.setProperty('--mx', (x * 100).toFixed(1) + '%');
      card.style.setProperty('--my', (y * 100).toFixed(1) + '%');
    }
    card.addEventListener('pointermove', function (e) {
      px = e.clientX; py = e.clientY;
      if (!raf) raf = requestAnimationFrame(apply);
    });
    card.addEventListener('pointerleave', function () {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      card.style.setProperty('--rx', '0deg');
      card.style.setProperty('--ry', '0deg');
    });
  });
})();
