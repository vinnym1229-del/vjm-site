// Sitewide ambient lightning accent — drop-in on any page:
//   <script src="/assets/lightning-bg.js" defer></script>
// Fixed to the viewport (stays put while scrolling) so the red/lightning
// theme reads on every page, not just the homepage hero. Decorative only:
// aria-hidden, pointer-events:none, negative z-index so it never sits over
// text or intercepts clicks — it paints behind normal page content and only
// shows through in the gaps (page edges, transparent/gradient sections).
(() => {
  'use strict';
  if (document.getElementById('site-bolt-layer')) return;

  const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const wrap = document.createElement('div');
  wrap.id = 'site-bolt-layer';
  wrap.setAttribute('aria-hidden', 'true');
  wrap.innerHTML = `
<svg class="site-bolt site-bolt-r" viewBox="0 0 300 500" preserveAspectRatio="xMidYMid meet">
  <use href="#siteBoltShape" class="sb-glow"/>
  <use href="#siteBoltShape" class="sb-core"/>
</svg>
<svg class="site-bolt site-bolt-l" viewBox="0 0 300 500" preserveAspectRatio="xMidYMid meet">
  <use href="#siteBoltShape" class="sb-glow"/>
  <use href="#siteBoltShape" class="sb-core"/>
</svg>
<svg width="0" height="0" style="position:absolute">
  <defs>
    <filter id="siteBoltJitter" x="-40%" y="-40%" width="180%" height="180%">
      <feTurbulence type="fractalNoise" baseFrequency="0.014 0.08" numOctaves="2" seed="7" result="n"/>
      <feDisplacementMap in="SourceGraphic" in2="n" scale="12" xChannelSelector="R" yChannelSelector="G"/>
    </filter>
    <filter id="siteBoltGlowBlur" x="-140%" y="-140%" width="380%" height="380%">
      <feTurbulence type="fractalNoise" baseFrequency="0.011 0.07" numOctaves="2" seed="7" result="n"/>
      <feDisplacementMap in="SourceGraphic" in2="n" scale="15" xChannelSelector="R" yChannelSelector="G" result="disp"/>
      <feGaussianBlur in="disp" stdDeviation="9"/>
    </filter>
    <g id="siteBoltShape" fill="none">
      <path d="M150,10 L120,120 L155,132 L96,260 L134,272 L70,410 L112,392 L150,490"/>
      <path d="M120,120 L92,108"/>
      <path d="M155,132 L182,120"/>
      <path d="M96,260 L66,248"/>
      <path d="M134,272 L162,262"/>
      <path d="M70,410 L44,400"/>
    </g>
  </defs>
</svg>`;
  document.body.insertBefore(wrap, document.body.firstChild);

  const css = `
#site-bolt-layer{position:fixed;inset:0;z-index:1;pointer-events:none;overflow:hidden;}
.site-bolt{position:absolute;top:0;height:100%;width:min(30vw,320px);opacity:.22;}
.site-bolt-r{right:-6%;}
.site-bolt-l{left:-6%;transform:scaleX(-1);opacity:.14;animation-delay:-3.5s;}
.site-bolt .sb-glow{stroke:#ff2b2b;stroke-width:7;stroke-linecap:round;stroke-linejoin:round;filter:url(#siteBoltGlowBlur);opacity:.55;}
.site-bolt .sb-core{stroke:#ff5252;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round;filter:url(#siteBoltJitter);
  filter:url(#siteBoltJitter) drop-shadow(0 0 6px rgba(255,60,60,.6));animation:siteBoltPulse 7s ease-in-out infinite;}
@keyframes siteBoltPulse{0%,100%{opacity:.5;}50%{opacity:1;}}
@media (max-width:768px){.site-bolt{width:min(40vw,200px);}}
@media (prefers-reduced-motion:reduce){.site-bolt .sb-core{animation:none;opacity:.8;}}
`;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  if (REDUCED) wrap.querySelectorAll('.sb-core').forEach((n) => { n.style.animation = 'none'; });
})();
