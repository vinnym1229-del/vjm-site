// Sitewide ambient lightning accent — drop-in on any page:
//   <script src="/assets/lightning-bg.js" defer></script>
// Absolutely positioned against body (scrolls with the page, not fixed to
// the viewport) so the red/lightning theme reads on every page without the
// per-scroll-frame repaint cost a fixed + SVG-filtered element forces.
// Static, not animated — the filter is real work for the GPU/CPU and isn't
// worth paying for continuously just to pulse a decorative accent.
// Decorative only: aria-hidden, pointer-events:none.
(() => {
  'use strict';
  if (document.getElementById('site-bolt-layer')) return;

  const wrap = document.createElement('div');
  wrap.id = 'site-bolt-layer';
  wrap.setAttribute('aria-hidden', 'true');
  wrap.innerHTML = `
<svg class="site-bolt site-bolt-r" viewBox="0 0 300 500" preserveAspectRatio="xMidYMid meet">
  <use href="#siteBoltShape" class="sb-core"/>
</svg>
<svg class="site-bolt site-bolt-l" viewBox="0 0 300 500" preserveAspectRatio="xMidYMid meet">
  <use href="#siteBoltShape" class="sb-core"/>
</svg>
<svg width="0" height="0" style="position:absolute">
  <defs>
    <filter id="siteBoltJitter" x="-40%" y="-40%" width="180%" height="180%">
      <feTurbulence type="fractalNoise" baseFrequency="0.014 0.08" numOctaves="1" seed="7" result="n"/>
      <feDisplacementMap in="SourceGraphic" in2="n" scale="12" xChannelSelector="R" yChannelSelector="G"/>
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
#site-bolt-layer{position:absolute;top:0;left:0;width:100%;height:1400px;z-index:1;pointer-events:none;overflow:hidden;}
.site-bolt{position:absolute;top:0;height:100%;width:min(30vw,320px);opacity:.18;}
.site-bolt-r{right:-6%;}
.site-bolt-l{left:-6%;transform:scaleX(-1);opacity:.12;}
.site-bolt .sb-core{stroke:#ff5252;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;
  filter:url(#siteBoltJitter) drop-shadow(0 0 5px rgba(255,60,60,.5));}
@media (max-width:768px){.site-bolt{width:min(40vw,200px);}}
`;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  // body needs its own stacking/containing context for absolute positioning
  // to anchor to the page rather than an ancestor further up.
  const bodyPos = getComputedStyle(document.body).position;
  if (bodyPos === 'static') document.body.style.position = 'relative';
})();
