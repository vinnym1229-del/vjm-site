// Shared behavior for the curriculum pages (Stock Breakdown, Options Lab
// curriculum section, Futures Dissection, Psychology Enhancer):
//   - group tabs (Psychology Enhancer only, switches A/B/C/D subsections)
//   - level tabs (1-4) within each group
//   - premium gating: Level 1 is always open; Levels 2-4 use the SAME
//     session-cookie system as stock-lab.html (/api/verify-premium), so
//     unlocking once on any page carries over here too.
(() => {
  'use strict';

  function toggleMenu() {
    const m = document.getElementById('curr-mmenu');
    const h = document.getElementById('curr-hamb');
    if (!m) return;
    // Pin the panel to the nav's real bottom edge: the bar's height varies
    // with the brand size, so a hard-coded offset would drift.
    const nav = document.querySelector('.curr nav, nav');
    if (nav) m.style.top = Math.round(nav.getBoundingClientRect().bottom) + 'px';
    m.classList.toggle('open');
    h?.setAttribute('aria-expanded', m.classList.contains('open'));
  }
  window.currToggleMenu = toggleMenu;

  function initGroupTabs() {
    document.querySelectorAll('.group-tabs').forEach((bar) => {
      bar.addEventListener('click', (e) => {
        const btn = e.target.closest('.group-tab');
        if (!btn) return;
        const group = bar.dataset.group;
        bar.querySelectorAll('.group-tab').forEach((b) => b.classList.toggle('active', b === btn));
        document.querySelectorAll(`.group-panel[data-group="${group}"]`).forEach((p) => {
          p.classList.toggle('active', p.dataset.groupValue === btn.dataset.groupValue);
        });
      });
    });
  }

  function initLevelTabs() {
    document.querySelectorAll('.level-tabs').forEach((bar) => {
      bar.addEventListener('click', (e) => {
        const btn = e.target.closest('.level-tab');
        if (!btn) return;
        const bar2 = btn.closest('.level-tabs');
        bar2.querySelectorAll('.level-tab').forEach((b) => b.classList.toggle('active', b === btn));
        // Panels are matched to their tab bar by a shared data-pair id, so
        // multiple independent tab groups (Psychology Enhancer's A/B/C/D
        // subsections) can coexist on one page without cross-talk.
        const pairId = bar2.dataset.pair;
        document.querySelectorAll(`.level-panel[data-pair="${pairId}"]`).forEach((p) => {
          p.classList.toggle('active', p.dataset.level === btn.dataset.level);
        });
      });
    });
  }

  async function checkPremium() {
    try {
      const res = await fetch('/api/verify-premium', { credentials: 'same-origin', cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      return !!(data.ok && data.active);
    } catch { return false; }
  }

  // Cloudflare Turnstile: public site key, safe to ship client-side. The
  // matching TURNSTILE_SECRET_KEY lives server-side only; until the owner
  // sets it, /api/verify-premium skips the check, so shipping the widget
  // here is safe ahead of that (see functions/api/_lib/turnstile.js).
  const TURNSTILE_SITE_KEY = '0x4AAAAAAEf5izeTKE41bl6z';

  // Turnstile's api.js auto-renders any .cf-turnstile div present when it
  // loads, but the curriculum pages load it via <script defer>, which can
  // race this init() running first. Inserting the div here (rather than in
  // the static HTML) keeps one call site owning the markup for every gate.
  function injectTurnstileWidgets() {
    document.querySelectorAll('.lock-form').forEach((form, i) => {
      if (form.querySelector('.cf-turnstile')) return;
      const holder = document.createElement('div');
      holder.className = 'cf-turnstile';
      holder.id = 'curr-ts-' + i;
      holder.dataset.sitekey = TURNSTILE_SITE_KEY;
      holder.dataset.theme = 'dark';
      const btn = form.querySelector('button[type="submit"], .quiz-submit, button');
      if (btn) form.insertBefore(holder, btn); else form.appendChild(holder);
    });
  }

  function unlockAll() {
    document.querySelectorAll('.lock-gate').forEach((gate) => {
      const content = gate.nextElementSibling;
      gate.style.display = 'none';
      if (content && content.classList.contains('gated-content')) content.hidden = false;
    });
    document.querySelectorAll('.level-tab .lock').forEach((l) => (l.textContent = ''));
  }

  function wireUnlockForms() {
    document.querySelectorAll('.lock-form').forEach((form) => {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const input = form.querySelector('input[type="password"]');
        const msg = form.parentElement.querySelector('.lock-msg');
        const code = (input.value || '').trim();
        if (!code) { setMsg(msg, 'Enter your premium access code.', false); return; }
        const tsHolder = form.querySelector('.cf-turnstile');
        const tsInput = form.querySelector('[name="cf-turnstile-response"]');
        const turnstileToken = tsInput ? tsInput.value : '';
        setMsg(msg, 'Checking premium access...', true);
        try {
          const res = await fetch('/api/verify-premium', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ code, turnstileToken }),
          });
          const data = await res.json().catch(() => ({ ok: false }));
          if (res.ok && data.ok) {
            // The lesson text for an anonymous visitor is stripped server-side
            // (see functions/_middleware.js), so unlockAll() has nothing to
            // reveal yet. Reload so this request carries the new session
            // cookie and comes back with the real content.
            setMsg(msg, 'Premium unlocked. Loading your course...', true);
            location.reload();
            return;
          }
          setMsg(msg, data.error || 'Incorrect code.', false);
          // Each Turnstile token is single-use; a rejected attempt needs a
          // fresh one before the visitor can retry.
          if (tsHolder && window.turnstile) window.turnstile.reset(tsHolder);
        } catch {
          setMsg(msg, 'Access check failed. Refresh and try again.', false);
          if (tsHolder && window.turnstile) window.turnstile.reset(tsHolder);
        }
      });
    });
    document.querySelectorAll('.check-status-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const msg = btn.closest('.lock-gate').querySelector('.lock-msg');
        setMsg(msg, 'Checking saved premium session...', true);
        const ok = await checkPremium();
        if (ok) { setMsg(msg, 'Premium session active. Loading your course...', true); location.reload(); }
        else setMsg(msg, 'No active session found. Enter your code above.', false);
      });
    });
  }

  function setMsg(node, text, ok) {
    if (!node) return;
    node.textContent = text;
    node.className = 'lock-msg ' + (ok ? 'ok' : 'err');
  }

  // Each .quiz block carries its question data as a JSON <script> sibling
  // (type="application/json") so no extra network fetch is needed and the
  // same static page still works offline. Grading is entirely client-side.
  function initQuizzes() {
    document.querySelectorAll('.quiz').forEach((quiz) => {
      const dataNode = quiz.querySelector('script[type="application/json"]');
      if (!dataNode) return;
      let questions;
      try { questions = JSON.parse(dataNode.textContent); } catch { return; }
      const submitBtn = quiz.querySelector('.quiz-submit');
      const scoreEl = quiz.querySelector('.quiz-score');
      if (!submitBtn) return;
      submitBtn.addEventListener('click', () => {
        let correct = 0;
        questions.forEach((q, qi) => {
          const block = quiz.querySelector(`.quiz-q[data-qi="${qi}"]`);
          if (!block) return;
          const checked = block.querySelector('input[type="radio"]:checked');
          const explain = block.querySelector('.quiz-explain');
          block.querySelectorAll('.quiz-choice').forEach((choiceEl, ci) => {
            choiceEl.classList.remove('correct', 'incorrect');
            if (ci === q.correct) choiceEl.classList.add('correct');
            else if (checked && Number(checked.value) === ci) choiceEl.classList.add('incorrect');
          });
          if (explain) explain.classList.add('show');
          if (checked && Number(checked.value) === q.correct) correct++;
        });
        if (scoreEl) {
          scoreEl.textContent = `Score: ${correct} / ${questions.length}`;
          scoreEl.classList.add('show');
        }
      });
    });
  }

  // Grouped nav dropdowns (same behavior as the homepage): hover opens via
  // CSS; this adds click + keyboard control and outside-click/Escape close.
  function initNavDropdowns() {
    var items = document.querySelectorAll('.nav-item');
    if (!items.length) return;
    function closeAll() {
      items.forEach(function (o) {
        o.classList.remove('open');
        var b = o.querySelector('.nav-top');
        if (b) b.setAttribute('aria-expanded', 'false');
      });
    }
    items.forEach(function (item) {
      var btn = item.querySelector('.nav-top');
      if (!btn) return;
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var wasOpen = item.classList.contains('open');
        closeAll();
        if (!wasOpen) { item.classList.add('open'); btn.setAttribute('aria-expanded', 'true'); }
      });
    });
    document.addEventListener('click', closeAll);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeAll(); });
  }

  async function init() {
    initNavDropdowns();
    initGroupTabs();
    initLevelTabs();
    injectTurnstileWidgets();
    wireUnlockForms();
    initQuizzes();
    if (await checkPremium()) unlockAll();
  }

  // ---- shared tiny canvas helpers, used by each page's own calculator ----
  function sizeCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(rect.width, 280);
    const h = canvas.dataset.h ? Number(canvas.dataset.h) : 220;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.height = h + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }

  // ---- series colour ----
  // Charts used to be monochrome red, which made every bar read as a warning
  // and left the series indistinguishable without the labels. Red is now
  // reserved for the loss/risk/alert series; everything else takes the neutral
  // accent. Values are read from the live custom properties so both themes work
  // (the neutral accent is near-white on dark, near-black on light).
  function cssVar(name, fallback) {
    const v = getComputedStyle(document.body).getPropertyValue(name);
    return (v && v.trim()) || fallback;
  }
  // --emerald is the neutral accent; --gold is the accent red (see PALETTE).
  const NEUTRAL = () => cssVar('--emerald', '#d9d9dd');
  const RED = () => cssVar('--gold', '#d14343');
  const RISK_RE = /loss|risk|drawdown|draw down|alert|max ?dd|worst|stop|danger/i;
  // A series means "loss/risk" when its value is negative or its label says so.
  // Call sites that still pass the old blanket red are normalised the same way,
  // so a positive, non-risk series is never drawn red.
  function isRisk(label, value) {
    return Number(value) < 0 || RISK_RE.test(String(label || ''));
  }
  const ACCENT_REDS = ['#d14343', '#e26060', '#a63333', '#b3251d', '#c9342b', '#8c1a14'];
  function seriesColor(label, value, requested) {
    const risk = isRisk(label, value);
    if (risk) return requested && !ACCENT_REDS.includes(String(requested).toLowerCase()) ? requested : RED();
    if (!requested || ACCENT_REDS.includes(String(requested).toLowerCase())) return NEUTRAL();
    return requested;
  }

  // bars: [{label, value, color}]. Draws a simple horizontal bar chart.
  window.currDrawBars = function currDrawBars(canvas, bars, opts = {}) {
    const { ctx, w, h } = sizeCanvas(canvas);
    ctx.clearRect(0, 0, w, h);
    const max = Math.max(1e-9, ...bars.map((b) => Math.abs(b.value)));
    const rowH = Math.min(46, (h - 20) / bars.length);
    const labelW = 96;
    const barMaxW = w - labelW - 70;
    const muted = getComputedStyle(document.body).getPropertyValue('--muted') || '#9a9aa0';
    const text = getComputedStyle(document.body).getPropertyValue('--text') || '#ededee';
    bars.forEach((b, i) => {
      const y = 10 + i * rowH;
      ctx.fillStyle = muted.trim();
      ctx.font = '600 12px Inter, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(b.label, 0, y + rowH / 2 - 8);
      const bw = Math.max(2, (Math.abs(b.value) / max) * barMaxW);
      ctx.fillStyle = seriesColor(b.label, b.value, b.color);
      const barY = y + rowH / 2;
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(labelW, barY - 8, bw, 16, 6) : ctx.rect(labelW, barY - 8, bw, 16);
      ctx.fill();
      ctx.fillStyle = text.trim();
      ctx.font = '700 12px Inter, sans-serif';
      ctx.fillText(opts.fmt ? opts.fmt(b.value) : String(b.value), labelW + bw + 8, barY);
    });
  };

  // points: [{x,y}] in data space; drawn as a line with a zero-axis and an
  // optional breakeven marker. xLabel/yLabel are formatter functions.
  window.currDrawLine = function currDrawLine(canvas, points, opts = {}) {
    const { ctx, w, h } = sizeCanvas(canvas);
    ctx.clearRect(0, 0, w, h);
    if (!points.length) return;
    const pad = { l: 54, r: 16, t: 14, b: 26 };
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const xMin = Math.min(...xs), xMax = Math.max(...xs);
    const yAbs = Math.max(1e-9, ...ys.map((y) => Math.abs(y)));
    const yMin = -yAbs, yMax = yAbs;
    const px = (x) => pad.l + ((x - xMin) / (xMax - xMin || 1)) * (w - pad.l - pad.r);
    const py = (y) => pad.t + (1 - (y - yMin) / (yMax - yMin || 1)) * (h - pad.t - pad.b);
    const border = getComputedStyle(document.body).getPropertyValue('--border') || '#2a2a2e';
    const muted = getComputedStyle(document.body).getPropertyValue('--muted') || '#9a9aa0';
    ctx.strokeStyle = border.trim();
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.l, py(0)); ctx.lineTo(w - pad.r, py(0)); ctx.stroke();
    ctx.fillStyle = muted.trim();
    ctx.font = '600 11px Inter, sans-serif';
    ctx.fillText(opts.yFmt ? opts.yFmt(0) : '0', 4, py(0) + 4);
    ctx.fillText(opts.xFmt ? opts.xFmt(xMin) : String(xMin), pad.l, h - 8);
    ctx.fillText(opts.xFmt ? opts.xFmt(xMax) : String(xMax), w - pad.r - 40, h - 8);
    // Primary (profit / at-or-above zero) stroke is the neutral accent; the
    // portion of the curve below the zero axis is the loss series and stays red.
    const primary = seriesColor('', 1, opts.color);
    const loss = RED();
    const zeroY = py(0);
    const drawSegment = (clipTop, clipH, color) => {
      if (clipH <= 0) return;
      ctx.save();
      ctx.beginPath();
      ctx.rect(pad.l, clipTop, w - pad.l - pad.r, clipH);
      ctx.clip();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      points.forEach((p, i) => { const x = px(p.x), y = py(p.y); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
      ctx.stroke();
      ctx.fillStyle = color + '22';
      ctx.lineTo(px(points[points.length - 1].x), zeroY);
      ctx.lineTo(px(points[0].x), zeroY);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    };
    drawSegment(pad.t, Math.max(0, zeroY - pad.t), primary);
    drawSegment(zeroY, Math.max(0, h - pad.b - zeroY), loss);
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
