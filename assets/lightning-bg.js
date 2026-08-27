// Sitewide ambient lightning accent — drop-in on any page:
//   <script src="/assets/lightning-bg.js" defer></script>
//
// ONE absolutely-positioned element with tiled SVG backgrounds hugging the
// left and right page edges, spanning the full document height so the effect
// holds no matter how far you scroll.
//
// Deliberately NOT a tree of <svg>/<path> nodes (thousands of path elements
// on long pages) and NOT position:fixed (forces a repaint every scroll
// frame). No SVG filters either — the crackle is baked into the path data,
// and the glow is a wider translucent stroke under a thin bright one.
//
// Decorative only: aria-hidden, pointer-events:none, sits behind content.
(() => {
  'use strict';
  if (document.getElementById('site-bolt-layer')) return;

  const RIGHT = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 300 500\" preserveAspectRatio=\"none\"><g fill=\"none\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M150,0 L137.1,19.2 L162.9,38.5 L187.4,57.7 L167.3,76.9 L146.4,96.2 L172.3,115.4 L172.8,134.6 L195.4,153.8 L212.2,173.1 L224.4,192.3 L249.4,211.5 L260.0,230.8 L246.1,250.0 L227.3,269.2 L242.3,288.5 L260.0,307.7 L260.0,326.9 L254.9,346.2 L260.0,365.4 L238.2,384.6 L243.2,403.8 L223.7,423.1 L207.0,442.3 L208.4,461.5 L224.6,480.8 L207.6,500.0\" stroke=\"#ff2b2b\" stroke-width=\"6\" opacity=\"0.13\"/><path d=\"M187.4,57.7 L171.1,63.9 M172.3,115.4 L154.3,129.6 M154.3,129.6 L151.8,151.0 M212.2,173.1 L181.1,169.9 M260.0,230.8 L235.8,226.7 M235.8,226.7 L240.4,241.7 M242.3,288.5 L260.6,295.9 M254.9,346.2 L289.6,361.4 M289.6,361.4 L288.2,379.7 M243.2,403.8 L262.1,404.2 M208.4,461.5 L192.5,466.1 M192.5,466.1 L177.1,480.9\" stroke=\"#ff2b2b\" stroke-width=\"3\" opacity=\"0.091\"/><path d=\"M150,0 L137.1,19.2 L162.9,38.5 L187.4,57.7 L167.3,76.9 L146.4,96.2 L172.3,115.4 L172.8,134.6 L195.4,153.8 L212.2,173.1 L224.4,192.3 L249.4,211.5 L260.0,230.8 L246.1,250.0 L227.3,269.2 L242.3,288.5 L260.0,307.7 L260.0,326.9 L254.9,346.2 L260.0,365.4 L238.2,384.6 L243.2,403.8 L223.7,423.1 L207.0,442.3 L208.4,461.5 L224.6,480.8 L207.6,500.0\" stroke=\"#ff5252\" stroke-width=\"1.7\" opacity=\"0.38\"/><path d=\"M187.4,57.7 L171.1,63.9 M172.3,115.4 L154.3,129.6 M154.3,129.6 L151.8,151.0 M212.2,173.1 L181.1,169.9 M260.0,230.8 L235.8,226.7 M235.8,226.7 L240.4,241.7 M242.3,288.5 L260.6,295.9 M254.9,346.2 L289.6,361.4 M289.6,361.4 L288.2,379.7 M243.2,403.8 L262.1,404.2 M208.4,461.5 L192.5,466.1 M192.5,466.1 L177.1,480.9\" stroke=\"#ff6b6b\" stroke-width=\"1\" opacity=\"0.304\"/></g></svg>";
  const LEFT = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 300 500\" preserveAspectRatio=\"none\"><g fill=\"none\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M150,0 L137.4,19.2 L158.1,38.5 L161.4,57.7 L135.2,76.9 L122.0,96.2 L108.6,115.4 L117.3,134.6 L100.6,153.8 L92.3,173.1 L111.0,192.3 L133.9,211.5 L153.0,230.8 L165.3,250.0 L137.7,269.2 L151.1,288.5 L156.6,307.7 L147.6,326.9 L137.8,346.2 L123.5,365.4 L110.7,384.6 L115.0,403.8 L102.3,423.1 L124.0,442.3 L131.9,461.5 L142.1,480.8 L157.5,500.0\" stroke=\"#ff2b2b\" stroke-width=\"6\" opacity=\"0.1\"/><path d=\"M161.4,57.7 L140.3,65.5 M108.6,115.4 L83.0,118.9 M83.0,118.9 L73.0,135.8 M92.3,173.1 L61.6,174.6 M153.0,230.8 L121.9,240.2 M121.9,240.2 L131.9,257.8 M151.1,288.5 L128.1,282.3 M137.8,346.2 L160.0,349.9 M160.0,349.9 L161.7,375.7 M115.0,403.8 L150.8,407.1 M131.9,461.5 L149.0,449.0 M149.0,449.0 L140.8,471.8\" stroke=\"#ff2b2b\" stroke-width=\"3\" opacity=\"0.070\"/><path d=\"M150,0 L137.4,19.2 L158.1,38.5 L161.4,57.7 L135.2,76.9 L122.0,96.2 L108.6,115.4 L117.3,134.6 L100.6,153.8 L92.3,173.1 L111.0,192.3 L133.9,211.5 L153.0,230.8 L165.3,250.0 L137.7,269.2 L151.1,288.5 L156.6,307.7 L147.6,326.9 L137.8,346.2 L123.5,365.4 L110.7,384.6 L115.0,403.8 L102.3,423.1 L124.0,442.3 L131.9,461.5 L142.1,480.8 L157.5,500.0\" stroke=\"#ff5252\" stroke-width=\"1.7\" opacity=\"0.3\"/><path d=\"M161.4,57.7 L140.3,65.5 M108.6,115.4 L83.0,118.9 M83.0,118.9 L73.0,135.8 M92.3,173.1 L61.6,174.6 M153.0,230.8 L121.9,240.2 M121.9,240.2 L131.9,257.8 M151.1,288.5 L128.1,282.3 M137.8,346.2 L160.0,349.9 M160.0,349.9 L161.7,375.7 M115.0,403.8 L150.8,407.1 M131.9,461.5 L149.0,449.0 M149.0,449.0 L140.8,471.8\" stroke=\"#ff6b6b\" stroke-width=\"1\" opacity=\"0.240\"/></g></svg>";
  const uri = (svg) => 'data:image/svg+xml,' + encodeURIComponent(svg);

  const wrap = document.createElement('div');
  wrap.id = 'site-bolt-layer';
  wrap.setAttribute('aria-hidden', 'true');
  document.body.insertBefore(wrap, document.body.firstChild);

  const style = document.createElement('style');
  style.textContent = `
#site-bolt-layer{
  position:absolute; inset:0; z-index:1; pointer-events:none; overflow:hidden;
  background-image:url("${uri(RIGHT)}"),url("${uri(LEFT)}");
  background-repeat:repeat-y,repeat-y;
  background-position:right -14px top 0,left -14px top 420px;
  background-size:min(19vw,230px) 940px,min(19vw,230px) 940px;
}
@media (max-width:768px){
  #site-bolt-layer{background-size:min(32vw,150px) 760px,min(32vw,150px) 760px;}
}
`;
  document.head.appendChild(style);

  // inset:0 needs body as the containing block so the layer spans the whole
  // document rather than an ancestor higher up.
  if (getComputedStyle(document.body).position === 'static') {
    document.body.style.position = 'relative';
  }
})();
