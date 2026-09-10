// Hero backdrop: a faint candlestick chart behind the headline and the car.
//   <script src="assets/candles-bg.js" defer></script>
//
// Replaces the lightning layer on the homepage (owner decision, 2026-09-09:
// "candles instead of lightning"). Drawn ONCE to a canvas the size of the
// hero -- there is no per-frame work, so it costs nothing next to the WebGL
// car that already animates in the same section. Redrawn only on resize
// (debounced) and on theme change, because the two themes need different
// ink: on white the candles are near-black and brand red, on the dark theme
// they are near-white and the softer accent red.
//
// The series is seeded, so every load draws the same chart -- a backdrop
// that changes shape on every visit reads as a glitch, not a feature. Up
// candles are the neutral tone, down candles the red, matching how the
// site's own charts are coloured. Faded out toward the bottom and both
// edges so it never fights the copy or the car; decorative only.
//
// Shape (owner, 2026-09-10: "more visible and in a cooler formation"): a
// gentle mean-reverting walk reads as flat noise, not a chart anyone would
// screenshot. This is built from four named phases instead -- a base
// consolidation, a breakdown leg, a reversal, and a breakout -- so it
// reads as a deliberate setup (the kind of higher-low-then-breakout
// structure the site's own courses teach) rather than a random scribble.
(() => {
  'use strict';
  const hero = document.querySelector('.hero');
  if (!hero || document.getElementById('hero-candles')) return;
  const cv = document.createElement('canvas');
  cv.id = 'hero-candles';
  cv.setAttribute('aria-hidden', 'true');
  hero.insertBefore(cv, hero.firstChild);

  // Mulberry32: tiny, deterministic, good enough for a picture.
  const rng = (seed) => () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };

  function draw() {
    const w = hero.clientWidth, h = hero.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    cv.style.width = w + 'px'; cv.style.height = h + 'px';
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    const light = document.body.classList.contains('light-mode');
    // Roughly double the old alpha (was .16/.26 and .11/.22) -- the previous
    // values were nearly invisible once the CSS-side opacity multipliers
    // (see body.pj-home #hero-candles in site.css) were applied on top.
    const up   = light ? 'rgba(20,20,22,.32)'   : 'rgba(237,237,238,.24)';
    const down = light ? 'rgba(179,37,29,.44)'  : 'rgba(226,96,96,.40)';

    // Candle geometry scales with width so the chart has the same density
    // on a laptop and a 4K monitor rather than turning into a picket fence.
    const step = Math.max(14, Math.min(26, w / 70));
    const bodyW = step * 0.6;
    const n = Math.ceil(w / step) + 2;
    const r = rng(20260909);
    // Price band occupies the upper ~70% of the hero; the bottom third is
    // left clear for the CTAs and the trust line.
    // On a phone the hero stacks tall and the paragraph sits where the
    // chart would be, so the band stops at the headline instead.
    const narrow = w < 760;
    const top = h * 0.06, bottom = h * (narrow ? 0.42 : 0.70), band = bottom - top;

    // Four-phase structure -- base, breakdown, higher-low reversal, breakout
    // -- read as an intentional setup rather than a plain random walk. Each
    // phase targets a price LEVEL (0..1) and blends toward it with per-step
    // noise, so the shape is deliberate but no two candles look mechanical.
    const phaseAt = (frac) => {
      if (frac < 0.28) return { level: 0.46, noise: 0.045, pull: 0.10 };  // base / consolidation
      if (frac < 0.45) return { level: 0.22, noise: 0.035, pull: 0.16 };  // breakdown leg
      if (frac < 0.62) return { level: 0.42, noise: 0.045, pull: 0.14 };  // higher-low reversal
      return               { level: 0.88, noise: 0.05,  pull: 0.11 };    // breakout
    };
    let price = 0.50, drift = 0;
    for (let i = 0; i < n; i++) {
      const ph = phaseAt(i / n);
      drift = drift * 0.68 + (r() - 0.5) * ph.noise + (ph.level - price) * ph.pull;
      const open = price;
      const close = Math.min(0.97, Math.max(0.05, price + drift));
      const hi = Math.max(open, close) + r() * 0.055;
      const lo = Math.min(open, close) - r() * 0.055;
      price = close;
      const x = i * step + step / 2;
      const y = (v) => top + (1 - v) * band;
      const col = close >= open ? up : down;
      g.strokeStyle = col; g.fillStyle = col; g.lineWidth = 1;
      g.beginPath(); g.moveTo(x, y(hi)); g.lineTo(x, y(lo)); g.stroke();
      const by = y(Math.max(open, close)), bh = Math.max(1.5, Math.abs(y(open) - y(close)));
      g.fillRect(x - bodyW / 2, by, bodyW, bh);
    }
    // A few horizontal grid rules so it reads as a chart panel, very faint.
    g.strokeStyle = light ? 'rgba(20,20,22,.05)' : 'rgba(255,255,255,.04)';
    for (let k = 1; k < 5; k++) {
      const gy = top + band * k / 5;
      g.beginPath(); g.moveTo(0, gy); g.lineTo(w, gy); g.stroke();
    }
    // Fade: strongest through the middle band, gone at the bottom and both
    // edges. destination-in keeps only what the mask covers.
    g.globalCompositeOperation = 'destination-in';
    const vg = g.createLinearGradient(0, 0, 0, h);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(0.12, 'rgba(0,0,0,1)');
    vg.addColorStop(narrow ? 0.30 : 0.55, 'rgba(0,0,0,1)'); vg.addColorStop(narrow ? 0.50 : 0.82, 'rgba(0,0,0,0)');
    g.fillStyle = vg; g.fillRect(0, 0, w, h);
    const hg = g.createLinearGradient(0, 0, w, 0);
    hg.addColorStop(0, 'rgba(0,0,0,0)'); hg.addColorStop(0.1, 'rgba(0,0,0,1)');
    hg.addColorStop(0.9, 'rgba(0,0,0,1)'); hg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = hg; g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = 'source-over';
  }

  draw();
  let t;
  window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(draw, 150); }, { passive: true });
  let was = document.body.classList.contains('light-mode');
  new MutationObserver(() => {
    const now = document.body.classList.contains('light-mode');
    if (now !== was) { was = now; draw(); }
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
})();
