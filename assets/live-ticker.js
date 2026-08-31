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
  const SPEED = 55; // px/sec baseline auto-scroll rate
  let built = false;
  let track = null;
  let viewport = null;
  let pos = 0; // px scrolled so far; content shifts left as this grows
  let half = 0; // width of one copy of the (doubled) row, for seamless wraparound
  let hovering = false;
  let dragging = false;
  let dragMoved = false;
  let dragStartX = 0;
  let dragStartPos = 0;
  let dragPointerId = null;
  let resumeAt = 0; // performance.now() timestamp; auto-scroll stays paused until then
  let lastTs = null;

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

  // Values originate from our own endpoint, but they pass through a
  // third-party API on the way, so nothing reaches innerHTML unescaped.
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Crypto trades around the clock; equities run four distinct sessions.
  // Computed from wall-clock America/New_York time (Intl handles DST) rather
  // than a second API call — accurate enough for a tape badge, no round trip.
  //
  // The weekend boundary is the part worth stating explicitly: the US equity
  // week ends Friday 8:00pm ET and does not resume until Sunday 8:00pm ET,
  // so Friday night, all of Saturday, and Sunday daytime are CLOSED — not
  // "overnight". Overnight means a session is actually running.
  const MINS = { PRE: 4 * 60, OPEN: 9 * 60 + 30, CLOSE: 16 * 60, AFTER_END: 20 * 60 };
  const DAYNUM = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  function marketSession(asset) {
    if (asset === 'crypto') return { code: '24/7', cls: 'sess-247', title: 'Crypto trades 24 hours a day, 7 days a week' };
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit',
    }).formatToParts(new Date());
    const get = (t) => { const p = parts.find((x) => x.type === t); return p ? p.value : ''; };
    const day = DAYNUM[get('weekday')];
    // Intl can return hour "24" for midnight in some engines; normalize.
    const mins = (Number(get('hour')) % 24) * 60 + Number(get('minute'));

    const CLOSED = { code: 'CLOSED', cls: 'sess-cl', title: 'Market closed — US equities reopen Sunday 8:00pm ET' };
    if (day === 6) return CLOSED;                                  // all Saturday
    if (day === 0 && mins < MINS.AFTER_END) return CLOSED;         // Sunday until 8pm
    if (day === 5 && mins >= MINS.AFTER_END) return CLOSED;        // Friday after 8pm

    const OVERNIGHT = { code: '🌙 OVERNIGHT', cls: 'sess-on', title: 'Overnight session (8:00pm–4:00am ET)' };
    if (day === 0) return OVERNIGHT;                               // Sunday 8pm onward
    if (mins >= MINS.OPEN && mins < MINS.CLOSE) {
      return { code: 'OPEN', cls: 'sess-op', title: 'Regular market hours (9:30am–4:00pm ET)' };
    }
    if (mins >= MINS.PRE && mins < MINS.OPEN) {
      return { code: '🌅 PRE-MARKET', cls: 'sess-ah', title: 'Pre-market extended hours (4:00am–9:30am ET)' };
    }
    if (mins >= MINS.CLOSE && mins < MINS.AFTER_END) {
      return { code: '🌅 AFTER HOURS', cls: 'sess-ah', title: 'After-hours extended trading (4:00pm–8:00pm ET)' };
    }
    return OVERNIGHT;
  }

  function tvHref(item) {
    return item.tv ? 'https://www.tradingview.com/chart/?symbol=' + encodeURIComponent(item.tv) : null;
  }

  function cellHtml(item) {
    const dir = Number.isFinite(item.changePct) ? (item.changePct >= 0 ? 'up' : 'down') : '';
    const sess = marketSession(item.asset);
    const href = tvHref(item);
    const openAttrs = href ? ' href="' + esc(href) + '" target="_blank" rel="noopener"' : '';
    const tag = href ? 'a' : 'span';
    return (
      '<' + tag + ' class="lt-cell" data-sym="' + esc(item.symbol) + '"' + openAttrs +
        ' title="' + (href ? 'Open ' + esc(item.symbol) + ' on TradingView · ' : '') + esc(sess.title) + '">' +
        '<span class="lt-label">' + esc(item.label) + '</span>' +
        '<span class="lt-price">' + fmtPrice(item.price) + '</span>' +
        '<span class="lt-pct ' + dir + '">' + fmtPct(item.changePct) + '</span>' +
        '<span class="lt-sess ' + sess.cls + '">' + sess.code + '</span>' +
      '</' + tag + '>'
    );
  }

  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
#ticker-wrap{position:relative;}
#ticker-wrap .lt-live{position:absolute;left:0;top:0;bottom:0;z-index:2;display:flex;align-items:center;gap:6px;
  padding:0 12px;background:linear-gradient(90deg,#0c0c0d 72%,rgba(12,12,13,0));min-width:70px;
  font-family:'Inter',sans-serif;font-size:.62rem;font-weight:900;letter-spacing:1.4px;color:#d9d9dd;text-transform:uppercase;cursor:default;}
#ticker-wrap .lt-live .dot{width:6px;height:6px;border-radius:50%;background:#d14343;box-shadow:0 0 8px rgba(209,67,67,.45);
  animation:${REDUCED ? 'none' : 'ltPulse 1.6s ease-in-out infinite'};}
@keyframes ltPulse{0%,100%{opacity:1;}50%{opacity:.35;}}
#ticker-wrap .lt-viewport{position:absolute;inset:0;overflow:hidden;display:flex;align-items:center;
  cursor:${REDUCED ? 'default' : 'grab'};touch-action:pan-y;}
#ticker-wrap .lt-viewport.dragging{cursor:grabbing;}
#ticker-wrap .lt-track{display:inline-flex;align-items:center;white-space:nowrap;padding-left:86px;will-change:transform;}
#ticker-wrap .lt-cell{display:inline-flex;align-items:baseline;gap:7px;padding:0 20px;border-right:1px solid rgba(255,255,255,.07);
  text-decoration:none;-webkit-user-drag:none;user-select:none;}
#ticker-wrap .lt-cell:hover .lt-label{color:#ededee;}
#ticker-wrap .lt-label{font-family:'Inter',sans-serif;font-size:.68rem;font-weight:800;letter-spacing:1px;color:#9a9aa0;text-transform:uppercase;transition:color .15s;}
#ticker-wrap .lt-price{font-family:'Barlow Condensed',sans-serif;font-size:1.06rem;font-weight:900;color:#ededee;letter-spacing:.5px;}
#ticker-wrap .lt-pct{font-family:'Inter',sans-serif;font-size:.7rem;font-weight:800;}
#ticker-wrap .lt-pct.up{color:#cfcfd4;}
#ticker-wrap .lt-pct.down{color:#d14343;}
#ticker-wrap .lt-sess{font-family:'Inter',sans-serif;font-size:.54rem;font-weight:900;letter-spacing:.4px;padding:2px 6px;border-radius:5px;white-space:nowrap;}
#ticker-wrap .lt-sess.sess-op{color:#cfcfd4;background:rgba(255,255,255,.10);}
#ticker-wrap .lt-sess.sess-ah{color:#9a9aa0;background:rgba(255,255,255,.07);}
#ticker-wrap .lt-sess.sess-on{color:#9a9aa0;background:rgba(255,255,255,.07);}
#ticker-wrap .lt-sess.sess-cl{color:#d14343;background:rgba(209,67,67,.10);}
#ticker-wrap .lt-sess.sess-247{color:#9a9aa0;background:rgba(255,255,255,.07);}
`;
    document.head.appendChild(style);
  }

  function render() {
    if (half > 0) pos = ((pos % half) + half) % half;
    track.style.transform = 'translateX(' + (-pos) + 'px)';
  }

  function raf(ts) {
    if (lastTs == null) lastTs = ts;
    const dt = Math.min(0.1, (ts - lastTs) / 1000);
    lastTs = ts;
    const paused = hovering || dragging || performance.now() < resumeAt;
    if (!paused) pos += SPEED * dt;
    render();
    requestAnimationFrame(raf);
  }

  // A manual scroll (wheel or drag) should not also fire the anchor's
  // click-through — only intercepted when the gesture actually moved.
  function wireInteraction() {
    viewport.addEventListener('mouseenter', () => { hovering = true; });
    viewport.addEventListener('mouseleave', () => { hovering = false; });

    viewport.addEventListener('wheel', (e) => {
      // Trackpad two-finger horizontal swipe reports deltaX directly;
      // shift+wheel is the standard modifier for horizontal intent on a
      // plain mouse. Plain vertical wheel is left alone so hovering the
      // ticker doesn't hijack normal page scrolling.
      const dx = e.deltaX !== 0 ? e.deltaX : (e.shiftKey ? e.deltaY : 0);
      if (!dx) return;
      e.preventDefault();
      pos += dx;
      resumeAt = performance.now() + 2200;
      render();
    }, { passive: false });

    viewport.addEventListener('pointerdown', (e) => {
      dragging = true;
      dragMoved = false;
      dragStartX = e.clientX;
      dragStartPos = pos;
      dragPointerId = e.pointerId;
      viewport.setPointerCapture(e.pointerId);
      viewport.classList.add('dragging');
    });
    viewport.addEventListener('pointermove', (e) => {
      if (!dragging || e.pointerId !== dragPointerId) return;
      const delta = dragStartX - e.clientX;
      if (Math.abs(delta) > 4) dragMoved = true;
      pos = dragStartPos + delta;
      render();
    });
    function endDrag(e) {
      if (!dragging || e.pointerId !== dragPointerId) return;
      dragging = false;
      dragPointerId = null;
      viewport.classList.remove('dragging');
      resumeAt = performance.now() + 1400;
    }
    viewport.addEventListener('pointerup', endDrag);
    viewport.addEventListener('pointercancel', endDrag);
    viewport.addEventListener('dragstart', (e) => e.preventDefault());
    // Capture phase: runs before the anchor's own click/navigation.
    viewport.addEventListener('click', (e) => {
      if (dragMoved) { e.preventDefault(); e.stopPropagation(); dragMoved = false; }
    }, true);
  }

  function build(items) {
    injectStyles();
    const rowHtml = items.map(cellHtml).join('');
    wrap.innerHTML =
      '<div class="lt-live" title="Real-time prices — IEX exchange feed" aria-hidden="true"><span class="dot"></span>Live</div>' +
      // Track holds the row twice; wraparound at the half-width loops seamlessly.
      '<div class="lt-viewport"><div class="lt-track">' + rowHtml + rowHtml + '</div></div>';
    track = wrap.querySelector('.lt-track');
    viewport = wrap.querySelector('.lt-viewport');
    // scrollWidth = padding-left + 2 x rowWidth; the repeat period is
    // rowWidth alone. Including half the padding made the tape jump ~43px
    // at every wraparound.
    const PAD = parseFloat(getComputedStyle(track).paddingLeft) || 0;
    half = (track.scrollWidth - PAD) / 2;
    // Widths measured before webfonts swap in can be slightly off; refine
    // once they've settled so the wraparound point stays accurate.
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => { if (track) { const p = parseFloat(getComputedStyle(track).paddingLeft) || 0; half = (track.scrollWidth - p) / 2; } });
    }
    built = true;
    if (!REDUCED) {
      wireInteraction();
      requestAnimationFrame(raf);
    }
  }

  function update(items) {
    for (const item of items) {
      const sess = marketSession(item.asset);
      // Both copies of the row carry the cell; update each in place so the
      // loop stays seamless and nothing reflows.
      wrap.querySelectorAll('.lt-cell[data-sym="' + esc(item.symbol) + '"]').forEach((cell) => {
        cell.querySelector('.lt-price').textContent = fmtPrice(item.price);
        const pct = cell.querySelector('.lt-pct');
        pct.textContent = fmtPct(item.changePct);
        pct.className = 'lt-pct ' + (Number.isFinite(item.changePct) ? (item.changePct >= 0 ? 'up' : 'down') : '');
        const sessEl = cell.querySelector('.lt-sess');
        if (sessEl) { sessEl.textContent = sess.code; sessEl.className = 'lt-sess ' + sess.cls; }
        const href = tvHref(item);
        cell.title = (href ? 'Open ' + item.symbol + ' on TradingView · ' : '') + sess.title;
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
