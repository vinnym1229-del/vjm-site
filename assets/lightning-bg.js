// Sitewide ambient lightning accent — drop-in on any page:
//   <script src="/assets/lightning-bg.js" defer></script>
//
// ONE absolutely-positioned element with tiled SVG backgrounds hugging the
// left and right page edges, spanning the full document height. Both sides
// use the SAME generation parameters (glow width/opacity, core width/
// opacity, secondary + tertiary branch opacity) so neither side reads as
// weaker -- only the jagged path data itself differs, via a different seed.
//
// Three-level branching (main path -> secondary flicks -> tertiary hair
// branches) for the organic, fractal look, without any SVG filter: no
// feTurbulence/feDisplacementMap recomputation, so this stays cheap even
// though it now includes a subtle animation.
//
// The flash animation only touches this element's own opacity/filter, and
// the element is NOT position:fixed and has no SVG filter applied to it, so
// it's compositor-only -- no layout, no repaint of page content, no
// per-scroll-frame cost. That combination (fixed position + filtered +
// animated) was the real performance problem in an earlier version; this
// keeps the animation but drops the other two.
//
// Decorative only: aria-hidden, pointer-events:none, sits behind content.
(() => {
  'use strict';
  if (document.getElementById('site-bolt-layer')) return;

  const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const RIGHT = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 300 940\" preserveAspectRatio=\"none\"><g fill=\"none\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M150.0,0 L174.5,27.6 L197.0,55.3 L236.4,82.9 L273.2,110.6 L251.9,138.2 L276.0,165.9 L241.4,193.5 L276.0,221.2 L274.5,248.8 L276.0,276.5 L276.0,304.1 L276.0,331.8 L263.8,359.4 L237.6,387.1 L209.4,414.7 L244.8,442.4 L223.7,470.0 L191.2,497.6 L236.5,525.3 L245.0,552.9 L276.0,580.6 L276.0,608.2 L246.8,635.9 L269.4,663.5 L276.0,691.2 L231.7,718.8 L237.2,746.5 L197.5,774.1 L242.8,801.8 L251.6,829.4 L241.6,857.1 L223.3,884.7 L192.3,912.4 L196.8,940.0 M174.5,27.6 L224.4,40.2 M273.2,110.6 L217.2,95.1 M276.0,165.9 L221.2,183.7 M241.4,193.5 L323.8,223.8 M276.0,221.2 L355.5,178.5 M276.0,276.5 L322.3,260.3 M263.8,359.4 L300.4,379.9 M209.4,414.7 L171.3,397.2 M223.7,470.0 L155.9,441.2 M245.0,552.9 L315.5,521.1 M246.8,635.9 L291.4,622.2 M242.8,801.8 L284.6,824.2 M251.6,829.4 L175.0,849.6 M241.6,857.1 L190.0,871.1 M192.3,912.4 L251.9,944.7\" stroke=\"#ff2b2b\" stroke-width=\"6.5\" opacity=\"0.16\"/><path d=\"M150.0,0 L174.5,27.6 L197.0,55.3 L236.4,82.9 L273.2,110.6 L251.9,138.2 L276.0,165.9 L241.4,193.5 L276.0,221.2 L274.5,248.8 L276.0,276.5 L276.0,304.1 L276.0,331.8 L263.8,359.4 L237.6,387.1 L209.4,414.7 L244.8,442.4 L223.7,470.0 L191.2,497.6 L236.5,525.3 L245.0,552.9 L276.0,580.6 L276.0,608.2 L246.8,635.9 L269.4,663.5 L276.0,691.2 L231.7,718.8 L237.2,746.5 L197.5,774.1 L242.8,801.8 L251.6,829.4 L241.6,857.1 L223.3,884.7 L192.3,912.4 L196.8,940.0\" stroke=\"#ff5252\" stroke-width=\"1.9\" opacity=\"0.42\"/><path d=\"M174.5,27.6 L224.4,40.2 M273.2,110.6 L217.2,95.1 M276.0,165.9 L221.2,183.7 M241.4,193.5 L323.8,223.8 M276.0,221.2 L355.5,178.5 M276.0,276.5 L322.3,260.3 M263.8,359.4 L300.4,379.9 M209.4,414.7 L171.3,397.2 M223.7,470.0 L155.9,441.2 M245.0,552.9 L315.5,521.1 M246.8,635.9 L291.4,622.2 M242.8,801.8 L284.6,824.2 M251.6,829.4 L175.0,849.6 M241.6,857.1 L190.0,871.1 M192.3,912.4 L251.9,944.7\" stroke=\"#ff6b6b\" stroke-width=\"1.3679999999999999\" opacity=\"0.3\"/><path d=\"M224.4,40.2 L206.2,55.6 M217.2,95.1 L230.5,118.3 M323.8,223.8 L321.1,237.6 M190.0,871.1 L194.5,895.0 M251.9,944.7 L219.9,976.3\" stroke=\"#ff8a8a\" stroke-width=\"0.95\" opacity=\"0.2\"/></g></svg>";
  const LEFT = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 300 940\" preserveAspectRatio=\"none\"><g fill=\"none\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M150.0,0 L168.6,27.6 L193.8,55.3 L196.9,82.9 L231.2,110.6 L267.9,138.2 L266.4,165.9 L267.1,193.5 L276.0,221.2 L276.0,248.8 L276.0,276.5 L247.6,304.1 L236.6,331.8 L216.2,359.4 L179.3,387.1 L167.0,414.7 L145.2,442.4 L132.8,470.0 L95.7,497.6 L67.7,525.3 L59.4,552.9 L74.6,580.6 L35.8,608.2 L64.9,635.9 L88.4,663.5 L116.7,691.2 L108.8,718.8 L69.8,746.5 L97.9,774.1 L118.9,801.8 L85.0,829.4 L125.4,857.1 L115.9,884.7 L75.4,912.4 L36.1,940.0 M231.2,110.6 L305.4,134.4 M267.9,138.2 L306.2,149.7 M267.1,193.5 L303.7,180.4 M276.0,221.2 L225.4,249.6 M179.3,387.1 L117.4,402.8 M145.2,442.4 L207.7,458.5 M95.7,497.6 L55.9,511.8 M59.4,552.9 L-22.1,513.7 M64.9,635.9 L121.3,614.4 M69.8,746.5 L-2.9,724.9 M118.9,801.8 L188.0,781.4 M115.9,884.7 L57.6,916.5 M75.4,912.4 L-2.1,941.8\" stroke=\"#ff2b2b\" stroke-width=\"6.5\" opacity=\"0.16\"/><path d=\"M150.0,0 L168.6,27.6 L193.8,55.3 L196.9,82.9 L231.2,110.6 L267.9,138.2 L266.4,165.9 L267.1,193.5 L276.0,221.2 L276.0,248.8 L276.0,276.5 L247.6,304.1 L236.6,331.8 L216.2,359.4 L179.3,387.1 L167.0,414.7 L145.2,442.4 L132.8,470.0 L95.7,497.6 L67.7,525.3 L59.4,552.9 L74.6,580.6 L35.8,608.2 L64.9,635.9 L88.4,663.5 L116.7,691.2 L108.8,718.8 L69.8,746.5 L97.9,774.1 L118.9,801.8 L85.0,829.4 L125.4,857.1 L115.9,884.7 L75.4,912.4 L36.1,940.0\" stroke=\"#ff5252\" stroke-width=\"1.9\" opacity=\"0.42\"/><path d=\"M231.2,110.6 L305.4,134.4 M267.9,138.2 L306.2,149.7 M267.1,193.5 L303.7,180.4 M276.0,221.2 L225.4,249.6 M179.3,387.1 L117.4,402.8 M145.2,442.4 L207.7,458.5 M95.7,497.6 L55.9,511.8 M59.4,552.9 L-22.1,513.7 M64.9,635.9 L121.3,614.4 M69.8,746.5 L-2.9,724.9 M118.9,801.8 L188.0,781.4 M115.9,884.7 L57.6,916.5 M75.4,912.4 L-2.1,941.8\" stroke=\"#ff6b6b\" stroke-width=\"1.3679999999999999\" opacity=\"0.3\"/><path d=\"M303.7,180.4 L304.7,204.1 M117.4,402.8 L120.4,423.8 M-22.1,513.7 L-20.5,549.3 M-2.9,724.9 L-2.9,744.7 M-2.1,941.8 L-19.2,959.1\" stroke=\"#ff8a8a\" stroke-width=\"0.95\" opacity=\"0.2\"/></g></svg>";
  const uri = (svg) => 'data:image/svg+xml,' + encodeURIComponent(svg);

  const wrap = document.createElement('div');
  wrap.id = 'site-bolt-layer';
  wrap.setAttribute('aria-hidden', 'true');
  wrap.innerHTML = '<div class="sbl-r"></div><div class="sbl-l"></div>';
  document.body.insertBefore(wrap, document.body.firstChild);

  const style = document.createElement('style');
  style.textContent = `
#site-bolt-layer{position:absolute; inset:0; z-index:1; pointer-events:none; overflow:hidden;}
#site-bolt-layer .sbl-r,#site-bolt-layer .sbl-l{position:absolute; inset:0;
  background-repeat:repeat-y; background-size:min(20vw,240px) 940px;}
#site-bolt-layer .sbl-r{background-image:url("${uri(RIGHT)}"); background-position:right -14px top 0;
  animation:${REDUCED ? 'none' : 'sblFlashR 6.5s ease-in-out infinite'};}
#site-bolt-layer .sbl-l{background-image:url("${uri(LEFT)}"); background-position:left -14px top 470px;
  animation:${REDUCED ? 'none' : 'sblFlashL 6.5s ease-in-out infinite'}; animation-delay:-3.25s;}
@keyframes sblFlashR{0%,100%{opacity:.72;}45%{opacity:.72;}55%{opacity:1;}62%{opacity:.85;}70%{opacity:1;}100%{opacity:.72;}}
@keyframes sblFlashL{0%,100%{opacity:.72;}45%{opacity:.72;}55%{opacity:1;}62%{opacity:.85;}70%{opacity:1;}100%{opacity:.72;}}
@media (max-width:768px){
  #site-bolt-layer .sbl-r,#site-bolt-layer .sbl-l{background-size:min(34vw,160px) 760px;}
}
`;
  document.head.appendChild(style);

  // inset:0 needs body as the containing block so the layer spans the whole
  // document instead of an ancestor higher up.
  if (getComputedStyle(document.body).position === 'static') {
    document.body.style.position = 'relative';
  }
})();
