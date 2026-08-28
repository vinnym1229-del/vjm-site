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
        setMsg(msg, 'Checking premium access...', true);
        try {
          const res = await fetch('/api/verify-premium', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ code }),
          });
          const data = await res.json().catch(() => ({ ok: false }));
          if (res.ok && data.ok) { setMsg(msg, 'Premium unlocked.', true); unlockAll(); return; }
          setMsg(msg, data.error || 'Incorrect code.', false);
        } catch {
          setMsg(msg, 'Access check failed. Refresh and try again.', false);
        }
      });
    });
    document.querySelectorAll('.check-status-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const msg = btn.closest('.lock-gate').querySelector('.lock-msg');
        setMsg(msg, 'Checking saved premium session...', true);
        const ok = await checkPremium();
        if (ok) { setMsg(msg, 'Premium session active.', true); unlockAll(); }
        else setMsg(msg, 'No active session found. Enter your code above.', false);
      });
    });
  }

  function setMsg(node, text, ok) {
    if (!node) return;
    node.textContent = text;
    node.className = 'lock-msg ' + (ok ? 'ok' : 'err');
  }

  async function init() {
    initGroupTabs();
    initLevelTabs();
    wireUnlockForms();
    if (await checkPremium()) unlockAll();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
