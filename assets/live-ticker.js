// Real-time homepage tape — drop-in:
//   <script src="/assets/live-ticker.js" defer></script>
//
// Progressive enhancement over the TradingView embed in #ticker-wrap. The
// embed serves DELAYED data (the little "D" badge) because anonymous embeds
// cannot be entitled to real-time feeds regardless of anyone's personal
// TradingView plan. /api/ticker serves Alpaca IEX quotes, which ARE
// real-time on the free tier — so when that endpoint has data, this script
// swaps the embed for its own tape and refreshes prices every 15s.
// When the endpoint reports pending/unavailable, nothing happens and the
// TradingView tape keeps working exactly as before.
(() => {
  'use strict';
  const wrap = document.getElementById('ticker-wrap');
  if (!wrap) return;

  const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let built = false;

  function fmtPrice(n) {
    if (!Number.isFinite(n)) return '—';
    return n >= 1000
      ? n.toLocaleString(undefined, { maximumFractionDigits: 0 })
      : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtPct(n) {
    if (!Number.isFinite(n)) return '';
    return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
  }

  function cellHtml(item) {
    const dir = Number.isFinite(item.changePct) ? (item.changePct >= 0 ? 'up' : 'down') : '';
    return (
      '<span class="lt-cell" data-sym="' + item.symbol + '">' +
        '<span class="lt-label">' + item.label + '</span>' +
        '<span class="lt-price">' + fmtPrice(item.price) + '</span>' +
        '<span class="lt-pct ' + dir + '">' + fmtPct(item.changePct) + '</span>' +
      '</span>'
    );
  }

  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
#ticker-wrap{position:relative;}
#ticker-wrap .lt-live{position:absolute;left:0;top:0;bottom:0;z-index:2;display:flex;align-items:center;gap:6px;
  padding:0 12px;background:linear-gradient(90deg,#020508 72%,rgba(2,5,8,0));min-width:96px;
  font-family:'Inter',sans-serif;font-size:.62rem;font-weight:900;letter-spacing:1.4px;color:#7ee2a0;text-transform:uppercase;}
#ticker-wrap .lt-live .dot{width:6px;height:6px;border-radius:50%;background:#22c55e;box-shadow:0 0 8px #22c55e;
  animation:${REDUCED ? 'none' : 'ltPulse 1.6s ease-in-out infinite'};}
@keyframes ltPulse{0%,100%{opacity:1;}50%{opacity:.35;}}
#ticker-wrap .lt-viewport{position:absolute;inset:0;overflow:hidden;display:flex;align-items:center;}
#ticker-wrap .lt-track{display:inline-flex;align-items:center;white-space:nowrap;padding-left:110px;
  animation:${REDUCED ? 'none' : 'ltScroll var(--lt-dur,60s) linear infinite'};}
#ticker-wrap:hover .lt-track{animation-play-state:paused;}
@keyframes ltScroll{to{transform:translateX(-50%);}}
#ticker-wrap .lt-cell{display:inline-flex;align-items:baseline;gap:8px;padding:0 22px;border-right:1px solid rgba(255,255,255,.07);}
#ticker-wrap .lt-label{font-family:'Inter',sans-serif;font-size:.68rem;font-weight:800;letter-spacing:1px;color:#9b9296;text-transform:uppercase;}
#ticker-wrap .lt-price{font-family:'Barlow Condensed',sans-serif;font-size:1.06rem;font-weight:900;color:#eceaea;letter-spacing:.5px;}
#ticker-wrap .lt-pct{font-family:'Inter',sans-serif;font-size:.7rem;font-weight:800;}
#ticker-wrap .lt-pct.up{color:#4ade80;}
#ticker-wrap .lt-pct.down{color:#ff6b6b;}
`;
    document.head.appendChild(style);
  }

  function build(items) {
    injectStyles();
    const half = items.map(cellHtml).join('');
    wrap.innerHTML =
      '<div class="lt-live" aria-hidden="true"><span class="dot"></span>Live · IEX</div>' +
      // Track holds the row twice; translateX(-50%) loops seamlessly.
      '<div class="lt-viewport"><div class="lt-track">' + half + half + '</div></div>';
    const track = wrap.querySelector('.lt-track');
    // ~55px of travel per second, independent of how many symbols render.
    track.style.setProperty('--lt-dur', Math.max(30, Math.round(track.scrollWidth / 2 / 55)) + 's');
    built = true;
  }

  function update(items) {
    for (const item of items) {
      // Both copies of the row carry the cell; update each in place so the
      // loop stays seamless and nothing reflows.
      wrap.querySelectorAll('.lt-cell[data-sym="' + item.symbol + '"]').forEach((cell) => {
        cell.querySelector('.lt-price').textContent = fmtPrice(item.price);
        const pct = cell.querySelector('.lt-pct');
        pct.textContent = fmtPct(item.changePct);
        pct.className = 'lt-pct ' + (Number.isFinite(item.changePct) ? (item.changePct >= 0 ? 'up' : 'down') : '');
      });
    }
  }

  async function tick() {
    let data;
    try {
      const res = await fetch('/api/ticker', { cache: 'no-store' });
      data = await res.json();
    } catch { return; }
    if (!data || !data.ok || !Array.isArray(data.items) || data.items.length < 4) return;
    built ? update(data.items) : build(data.items);
  }

  tick();
  setInterval(tick, 15000);
})();
