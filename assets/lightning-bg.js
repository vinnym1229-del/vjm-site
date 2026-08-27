// Sitewide ambient lightning accent — drop-in on any page:
//   <script src="/assets/lightning-bg.js" defer></script>
//
// ONE absolutely-positioned element with a tiled SVG background. Deliberately
// not a tree of <svg>/<path> nodes: the page is long, so per-band elements
// meant thousands of path nodes, and not position:fixed either, since that
// forces the layer to be repainted every scroll frame. A repeating background
// on a single element tiles the full page for free.
//
// No SVG filters (feTurbulence/feDisplacementMap were the real cost of the
// first version) — the crackle is baked into the path data, and the glow is
// just a wider translucent stroke sitting under a thin bright one.
//
// Decorative only: aria-hidden, pointer-events:none, sits behind content.
(() => {
  'use strict';
  if (document.getElementById('site-bolt-layer')) return;

  const RIGHT_BOLT =
    'M150,0 L140,42 L158,58 L126,104 L148,124 L116,176 L138,198 L106,252 ' +
    'L130,278 L100,336 L124,362 L94,420 L118,448 L92,500' +
    'M140,42 L118,34M126,104 L102,96M116,176 L92,166' +
    'M106,252 L82,244M100,336 L74,328M94,420 L70,412';

  const LEFT_BOLT =
    'M150,0 L162,40 L142,58 L174,102 L152,126 L182,178 L160,200 L190,254 ' +
    'L166,280 L196,338 L172,364 L200,422 L176,450 L204,500' +
    'M162,40 L184,32M174,102 L198,94M182,178 L206,170' +
    'M190,254 L214,246M196,338 L220,330M200,422 L224,414';

  // Two stroked passes: wide + faint underneath (glow), thin + brighter on top.
  function boltUri(d, glowOpacity, coreOpacity) {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 500" preserveAspectRatio="none">' +
      '<g fill="none" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="' + d + '" stroke="#ff2b2b" stroke-width="6" opacity="' + glowOpacity + '"/>' +
      '<path d="' + d + '" stroke="#ff5252" stroke-width="1.6" opacity="' + coreOpacity + '"/>' +
      '</g></svg>';
    return 'data:image/svg+xml,' + encodeURIComponent(svg);
  }

  const wrap = document.createElement('div');
  wrap.id = 'site-bolt-layer';
  wrap.setAttribute('aria-hidden', 'true');
  document.body.insertBefore(wrap, document.body.firstChild);

  const style = document.createElement('style');
  style.textContent = `
#site-bolt-layer{
  position:absolute; inset:0; z-index:1; pointer-events:none; overflow:hidden;
  background-image:url("${boltUri(RIGHT_BOLT, 0.10, 0.30)}"),url("${boltUri(LEFT_BOLT, 0.07, 0.20)}");
  background-repeat:repeat-y,repeat-y;
  background-position:right -20px top 0,left -20px top 560px;
  background-size:min(30vw,320px) 1120px,min(30vw,320px) 1120px;
}
@media (max-width:768px){
  #site-bolt-layer{background-size:min(42vw,210px) 900px,min(42vw,210px) 900px;}
}
`;
  document.head.appendChild(style);

  // inset:0 needs body to be the containing block so the layer spans the
  // whole document instead of an ancestor higher up.
  if (getComputedStyle(document.body).position === 'static') {
    document.body.style.position = 'relative';
  }
})();
