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
  //
  // Answer position is NOT trustworthy in the source HTML: the authored pages
  // put the correct option second almost every time, so "always click the
  // second choice" would score ~96% without reading a word. The fix that does
  // not require editing a hundred hand-written questions is to shuffle the
  // DISPLAYED order once per page load and key everything — grading and the
  // correct/incorrect highlight — to each choice's ORIGINAL index, which is
  // carried on the radio's value and mirrored onto the choice as data-oi.

  // Pure: given N choices, return them paired with their original index in a
  // shuffled order (Fisher-Yates). Exported for tests via window.__quizInternals.
  // Never drops, duplicates or rewrites a choice — it only reorders.
  function orderChoices(choices, rand) {
    const random = typeof rand === 'function' ? rand : Math.random;
    const out = Array.from(choices, (choice, oi) => ({ oi, choice }));
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      const tmp = out[i]; out[i] = out[j]; out[j] = tmp;
    }
    return out;
  }

  // Pure: grade one answer. `picked` is an ORIGINAL choice index (never a
  // rendered position), so shuffling the DOM can never change a score.
  function isCorrectPick(picked, question) {
    return Number.isInteger(question && question.correct) && picked === question.correct;
  }

  // Read the original index a choice element was stamped with at render time,
  // falling back to its radio value (which the authored HTML already sets to
  // the original index) and finally to its current DOM position.
  function originalIndexOf(choiceEl, fallback) {
    const stamped = choiceEl.getAttribute('data-oi');
    if (stamped !== null && stamped !== '' && Number.isInteger(Number(stamped))) return Number(stamped);
    const input = choiceEl.querySelector('input[type="radio"]');
    const raw = input ? input.value : '';
    if (raw !== '' && raw !== null && raw !== undefined && Number.isInteger(Number(raw))) return Number(raw);
    return fallback;
  }

  // Shuffle the rendered order of one question's choices. The whole
  // .quiz-choice node moves, so a label keeps whatever input it wraps or
  // points at (`for`/`id` pairs travel together) and the radio group `name`
  // is untouched; tab order follows DOM order, so keyboard and screen-reader
  // order match what is on screen.
  function shuffleQuestionChoices(block, rand) {
    const choices = [...block.querySelectorAll('.quiz-choice')];
    if (choices.length < 2) return;
    choices.forEach((el, i) => {
      const oi = originalIndexOf(el, i);
      el.setAttribute('data-oi', String(oi));
      const input = el.querySelector('input[type="radio"]');
      // The radio value IS the original index; keep the two in sync so a
      // grader reading either one gets the same answer.
      if (input) input.value = String(oi);
      // Keep an explicit label/input association intact when one is used.
      if (input && el.tagName === 'LABEL' && el.hasAttribute('for') && input.id) {
        el.setAttribute('for', input.id);
      }
    });
    const parent = choices[0].parentNode;
    if (!parent) return;
    const anchor = choices[choices.length - 1].nextSibling;
    for (const { choice } of orderChoices(choices, rand)) parent.insertBefore(choice, anchor);
  }

  function initQuizzes(rand) {
    document.querySelectorAll('.quiz').forEach((quiz) => {
      const dataNode = quiz.querySelector('script[type="application/json"]');
      if (!dataNode) return;
      let questions;
      try { questions = JSON.parse(dataNode.textContent); } catch { return; }
      const submitBtn = quiz.querySelector('.quiz-submit');
      const scoreEl = quiz.querySelector('.quiz-score');
      if (!submitBtn) return;
      // Shuffle once, at render time — not on submit — so a member's already
      // selected radio never jumps to a different answer under them.
      questions.forEach((q, qi) => {
        const block = quiz.querySelector(`.quiz-q[data-qi="${qi}"]`);
        if (block) shuffleQuestionChoices(block, rand);
      });
      submitBtn.addEventListener('click', () => {
        let correct = 0;
        // Missed questions are collected by ORIGINAL index (qi), which is the
        // authored order — never the shuffled render order.
        const missed = [];
        questions.forEach((q, qi) => {
          const block = quiz.querySelector(`.quiz-q[data-qi="${qi}"]`);
          if (!block) return;
          const checked = block.querySelector('input[type="radio"]:checked');
          const picked = checked ? Number(checked.value) : null;
          const explain = block.querySelector('.quiz-explain');
          block.querySelectorAll('.quiz-choice').forEach((choiceEl, ci) => {
            const oi = originalIndexOf(choiceEl, ci);
            choiceEl.classList.remove('correct', 'incorrect');
            if (isCorrectPick(oi, q)) choiceEl.classList.add('correct');
            else if (checked && picked === oi) choiceEl.classList.add('incorrect');
          });
          if (explain) explain.classList.add('show');
          if (checked && isCorrectPick(picked, q)) correct++;
          else {
            const qtext = block.querySelector('.qtext');
            missed.push({
              qi,
              answered: !!checked,
              question: (qtext && (qtext.textContent || '').trim()) || `Question ${qi + 1}`,
              explain: (explain && (explain.textContent || '').trim()) || '',
            });
          }
        });
        if (scoreEl) {
          scoreEl.textContent = `Score: ${correct} / ${questions.length}`;
          scoreEl.classList.add('show');
        }
        // Saving progress and drawing the next step must never be able to
        // swallow a score the learner already earned.
        try { onQuizGraded(quiz, { correct, total: questions.length, missed }); } catch { /* ignore */ }
      });
    });
  }

  // ─── FUNNEL INSTRUMENTATION ───────────────────────────────────────────
  // assets/funnel.js owns window.vjmTrack(name, props). It may not have
  // loaded yet, or at all, so every call site is defensive: analytics must
  // never be able to break a lesson.
  function track(name, props) {
    try { if (window.vjmTrack) window.vjmTrack(name, props || {}); } catch { /* ignore */ }
  }

  // ─── PLANS AND WHICH ONE ACTUALLY CONTAINS THIS PAGE ──────────────────
  // Mirrors RESOURCE_TIERS in functions/api/_lib/entitlements.js, which is
  // the authority. This copy grants nothing; it exists so a locked page can
  // say which plan contains it and what that plan costs, instead of the old
  // "Futures or Complete" line that was wrong on two of the four courses.
  const PLANS = {
    futures_core: {
      key: 'futures_core', name: 'Futures Core', price: 100,
      includes: 'Futures Dissection and Psychology Enhancer',
    },
    complete: {
      key: 'complete', name: 'Complete', price: 129,
      includes: 'everything in Futures Core plus Stock Breakdown, Options Lab and the premium research tools',
    },
  };
  const COURSES = {
    'futures-dissection': { title: 'Futures Dissection', plan: 'futures_core' },
    'psychology-enhancer': { title: 'Psychology Enhancer', plan: 'futures_core' },
    'stock-breakdown': { title: 'Stock Breakdown', plan: 'complete' },
    'options-lab': { title: 'Options Lab', plan: 'complete' },
  };
  // TODO: owner to confirm per-plan Whop checkout URLs. Whop currently lists
  // one product page for both plans, so every CTA points at that listing and
  // distinguishes itself with utm_content only. No invented checkout paths.
  const WHOP_LISTING = 'https://whop.com/pjtradespremium';
  function whopUrl(utmContent) {
    return WHOP_LISTING + '?utm_source=pjtrades&utm_medium=site&utm_content=' + encodeURIComponent(utmContent);
  }

  function pageKey() {
    try {
      const last = String(location.pathname || '').split('/').pop() || '';
      return last.replace(/\.html$/, '');
    } catch { return ''; }
  }
  function pageCourse() {
    const c = COURSES[pageKey()];
    return c ? { key: pageKey(), ...c } : null;
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function money(n) { return '$' + n; }

  // ─── LOCAL PROGRESS (this device only, never a server-side account) ────
  // localStorage throws outright in some private-browsing modes and inside
  // embedded webviews, so every read and write is wrapped and a failure just
  // degrades to "no saved progress" rather than breaking the page.
  const PROGRESS_KEY = 'vjm-progress-v1';
  function storage() {
    try {
      const s = window.localStorage;
      if (!s) return null;
      const probe = '__vjm_probe';
      s.setItem(probe, '1');
      s.removeItem(probe);
      return s;
    } catch { return null; }
  }
  function readAllProgress() {
    const s = storage();
    if (!s) return {};
    try {
      const raw = s.getItem(PROGRESS_KEY);
      const data = raw ? JSON.parse(raw) : {};
      return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch { return {}; }
  }
  function writeAllProgress(data) {
    const s = storage();
    if (!s) return false;
    try { s.setItem(PROGRESS_KEY, JSON.stringify(data)); return true; } catch { return false; }
  }
  function courseRecord(key) {
    const rec = readAllProgress()[key];
    return {
      lessons: (rec && rec.lessons && typeof rec.lessons === 'object') ? rec.lessons : {},
      quizzes: (rec && rec.quizzes && typeof rec.quizzes === 'object') ? rec.quizzes : {},
      updatedAt: (rec && Number(rec.updatedAt)) || 0,
    };
  }
  // Mutate one course's record. NOTHING here records the order choices were
  // drawn in: the shuffle is per render by design, and persisting it would
  // hand back the very position leak the shuffle exists to close. Only
  // ORIGINAL question indices are stored.
  function updateCourseRecord(key, mutate) {
    if (!key) return null;
    const all = readAllProgress();
    const rec = all[key] && typeof all[key] === 'object' ? all[key] : {};
    rec.lessons = rec.lessons && typeof rec.lessons === 'object' ? rec.lessons : {};
    rec.quizzes = rec.quizzes && typeof rec.quizzes === 'object' ? rec.quizzes : {};
    try { mutate(rec); } catch { return null; }
    rec.updatedAt = Date.now();
    all[key] = rec;
    writeAllProgress(all);
    return rec;
  }
  function clearCourseRecord(key) {
    const all = readAllProgress();
    if (key in all) { delete all[key]; writeAllProgress(all); }
  }

  // ─── SMALL DOM GUARDS ─────────────────────────────────────────────────
  // These run against real browsers and against the tiny DOM stub the tests
  // use, so every optional API is feature-checked before it is called.
  function canRender() {
    return typeof document !== 'undefined' && typeof document.createElement === 'function';
  }
  function qsa(sel, root) {
    const scope = root || (typeof document !== 'undefined' ? document : null);
    if (!scope || typeof scope.querySelectorAll !== 'function') return [];
    try { return [...scope.querySelectorAll(sel)]; } catch { return []; }
  }
  function qs(sel, root) {
    const scope = root || (typeof document !== 'undefined' ? document : null);
    if (!scope || typeof scope.querySelector !== 'function') return null;
    try { return scope.querySelector(sel); } catch { return null; }
  }
  function upTo(el, sel) {
    if (!el || typeof el.closest !== 'function') return null;
    try { return el.closest(sel); } catch { return null; }
  }
  function inGatedRegion(el) { return !!upTo(el, '.gated-content'); }
  function attach(parent, child) {
    if (!parent || !child) return null;
    if (typeof parent.appendChild === 'function') return parent.appendChild(child);
    if (typeof parent.append === 'function') return parent.append(child);
    return null;
  }
  function makeEl(tag, cls, html) {
    if (!canRender()) return null;
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (html != null) el.innerHTML = html;
    return el;
  }

  // ─── STYLES ───────────────────────────────────────────────────────────
  // assets/curriculum.css is owned elsewhere, so the styles for the panels
  // built here ship with the behaviour that needs them. Tokens only: no
  // colour literals, and both themes work because every value resolves
  // through the same custom properties body.light-mode redefines.
  const PANEL_CSS = `
.curr .vjm-panel{border:1px solid var(--border);background:var(--card);border-radius:14px;padding:16px 18px;margin:16px 0;text-align:left;}
.curr .vjm-panel h4{font-family:'Barlow Condensed',sans-serif;font-size:1.1rem;text-transform:uppercase;letter-spacing:.5px;color:var(--text);margin:0 0 6px;}
.curr .vjm-panel p{color:var(--muted);font-size:.86rem;margin:0 0 10px;max-width:640px;}
.curr .vjm-panel p.vjm-lead{color:var(--text);}
.curr .vjm-actions{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:4px;}
.curr .vjm-price{font-family:'Barlow Condensed',sans-serif;font-size:1.05rem;font-weight:900;color:var(--gold-ink);}
.curr .vjm-plan-row{display:flex;flex-wrap:wrap;gap:8px 18px;align-items:baseline;margin-bottom:8px;}
.curr .vjm-plan-row span{font-size:.78rem;color:var(--muted);text-transform:uppercase;letter-spacing:.6px;font-weight:800;}
.curr .vjm-link{color:var(--gold-ink);font-weight:800;font-size:.82rem;text-decoration:none;}
.curr .vjm-link:hover{text-decoration:underline;}
.curr .vjm-note{font-size:.76rem;color:var(--muted);margin-top:10px;}
.curr .vjm-progress{display:flex;flex-wrap:wrap;gap:10px 16px;align-items:center;border:1px solid var(--border);background:rgba(255,255,255,.03);border-radius:12px;padding:11px 14px;margin:0 0 16px;}
body.light-mode .curr .vjm-progress{background:rgba(0,0,0,.03);}
.curr .vjm-progress b{font-family:'Barlow Condensed',sans-serif;font-size:.98rem;color:var(--text);text-transform:uppercase;letter-spacing:.5px;}
.curr .vjm-progress .vjm-meter{flex:1;min-width:120px;height:6px;border-radius:999px;background:rgba(255,255,255,.10);overflow:hidden;}
body.light-mode .curr .vjm-progress .vjm-meter{background:rgba(0,0,0,.10);}
.curr .vjm-progress .vjm-meter i{display:block;height:100%;background:var(--gold);}
.curr .vjm-progress small{color:var(--muted);font-size:.76rem;}
.curr .vjm-btn-sm{border:1px solid var(--border);background:rgba(255,255,255,.05);color:var(--text);border-radius:999px;padding:7px 13px;font-size:.74rem;font-weight:800;cursor:pointer;font-family:'IBM Plex Sans',sans-serif;}
body.light-mode .curr .vjm-btn-sm{background:rgba(0,0,0,.04);}
.curr .lesson-card.vjm-seen>summary .lnum{opacity:.55;}
.curr .lesson-card.vjm-seen>summary::after{content:'seen';margin-left:auto;font-size:.62rem;letter-spacing:1px;text-transform:uppercase;color:var(--muted);font-weight:800;}
.curr .vjm-miss{border:1px solid var(--border);border-left:3px solid var(--gold);border-radius:0 10px 10px 0;padding:10px 12px;margin-bottom:8px;background:rgba(255,255,255,.03);}
body.light-mode .curr .vjm-miss{background:rgba(0,0,0,.03);}
.curr .vjm-miss b{display:block;font-size:.84rem;color:var(--text);margin-bottom:4px;}
.curr .vjm-miss span{font-size:.8rem;color:var(--muted);}
`;
  function injectStyles() {
    if (!canRender() || !document.head || qs('#vjm-curr-css')) return;
    const style = document.createElement('style');
    style.id = 'vjm-curr-css';
    style.textContent = PANEL_CSS;
    try { document.head.appendChild(style); } catch { /* ignore */ }
  }

  // ─── TIER-AWARE LOCK / UPGRADE STATE ──────────────────────────────────
  // Three different people hit a locked course page and they need three
  // different things:
  //   signed_out  — an anonymous visitor: tell them which plan contains this
  //                 course, what it costs, and where to sign in.
  //   under_tier  — a SIGNED-IN member whose plan does not include this
  //                 course. The server already made this distinction (the
  //                 middleware stripped .gated-content even though the
  //                 session is valid), so showing them an "enter your access
  //                 code" box is nonsense: they have a code, it works, it
  //                 just does not buy this course. On a Complete-only page
  //                 the only paid tier below Complete is Futures Core, so
  //                 the gap is exactly Complete minus Futures Core.
  //   entitled    — handled by unlockAll().
  //
  // All of this renders INSIDE .lock-gate, which is a sibling of
  // .gated-content, never inside it — the middleware blanks .gated-content
  // for exactly the people this UI is written for.
  function lockedByServer() {
    // The middleware stamps data-locked="1" on the blocks it strips.
    return !!qs('.gated-content[data-locked="1"]');
  }

  function planCtaButton(planKey, label, utm, placement, extraEvent) {
    const plan = PLANS[planKey];
    const a = makeEl('a', 'btn', esc(label));
    if (!a) return null;
    a.href = whopUrl(utm);
    a.target = '_blank';
    a.rel = 'noopener';
    a.addEventListener('click', () => {
      track('plan_cta', { course: pageKey(), plan: planKey, price: plan ? plan.price : null, placement });
      if (extraEvent) track(extraEvent.name, extraEvent.props);
    });
    return a;
  }

  function renderUnderTierGate(gate, course) {
    const need = PLANS[course.plan];
    const held = course.plan === 'complete' ? PLANS.futures_core : null;
    // A signed-in member does not need a code box or a "check my session"
    // button; both are removed, not merely hidden behind more copy.
    qsa('.lock-form', gate).forEach((f) => { f.hidden = true; f.style.display = 'none'; });
    qsa('.check-status-btn', gate).forEach((b) => {
      const wrap = b.parentElement || b;
      wrap.hidden = true; wrap.style.display = 'none';
    });
    const icon = qs('.lock-icon', gate);
    if (icon) icon.textContent = '⬆️';
    const h = qs('h3', gate);
    if (h) h.textContent = held ? 'Your plan does not include this course' : 'This course is not in your current session';
    const lead = qs('p', gate);
    if (lead) {
      lead.textContent = held
        ? `You are signed in on ${held.name} (${money(held.price)}/mo), which covers ${held.includes}. ${course.title} is part of ${need.name} (${money(need.price)}/mo) — a difference of ${money(need.price - held.price)}/mo.`
        : `You are signed in, but this session does not carry access to ${course.title}. It is part of ${need.name} (${money(need.price)}/mo), which covers ${need.includes}.`;
    }
    const panel = makeEl('div', 'vjm-panel vjm-upgrade');
    if (!panel) return;
    const rows = makeEl('div', 'vjm-plan-row',
      `<span>You have</span><b class="vjm-price">${esc(held ? held.name + ' · ' + money(held.price) + '/mo' : 'An active membership')}</b>`
      + `<span>This course needs</span><b class="vjm-price">${esc(need.name + ' · ' + money(need.price) + '/mo')}</b>`
      + (held ? `<span>Difference</span><b class="vjm-price">${esc(money(need.price - held.price) + '/mo')}</b>` : ''));
    attach(panel, rows);
    const actions = makeEl('div', 'vjm-actions');
    const isUpgrade = !!held && course.plan === 'complete';
    const cta = planCtaButton(
      course.plan,
      isUpgrade ? `Upgrade to Complete — ${money(need.price - held.price)}/mo more` : `Get ${need.name} — ${money(need.price)}/mo`,
      isUpgrade ? 'core-to-complete-upgrade' : 'under-tier-' + course.plan,
      'course_lock_under_tier',
      isUpgrade ? { name: 'core_to_complete_upgrade', props: { course: pageKey(), from: 'futures_core', to: 'complete', delta: need.price - held.price } } : null,
    );
    attach(actions, cta);
    if (held) {
      const back = makeEl('a', 'btn ghost', 'Open a course you already have');
      if (back) { back.href = 'futures-dissection.html'; attach(actions, back); }
    }
    attach(panel, actions);
    const note = makeEl('div', 'vjm-note',
      'Billing and plan changes are handled on Whop with the account you bought on. Questions: DM <b>St1101</b> on Discord.');
    attach(panel, note);
    attach(gate, panel);
  }

  function renderSignedOutGate(gate, course) {
    const need = PLANS[course.plan];
    const lead = qs('p', gate);
    if (lead && !/\b(Futures Core|Complete)\b/.test(lead.textContent || '')) {
      lead.textContent = `${course.title} is part of the ${need.name} plan. Enter your member access code below, or join to unlock it.`;
    }
    const panel = makeEl('div', 'vjm-panel vjm-plan-cta');
    if (!panel) return;
    attach(panel, makeEl('div', 'vjm-plan-row',
      `<span>Unlocked by</span><b class="vjm-price">${esc(need.name + ' · ' + money(need.price) + '/mo')}</b>`));
    attach(panel, makeEl('p', '', `${esc(need.name)} covers ${esc(need.includes)}.`));
    const actions = makeEl('div', 'vjm-actions');
    attach(actions, planCtaButton(course.plan, `Join ${need.name} — ${money(need.price)}/mo`, 'lock-' + course.plan, 'course_lock_signed_out'));
    const signin = makeEl('a', 'vjm-link', 'Already a member? Sign in with Google or your code →');
    if (signin) {
      signin.href = 'premium-guidance.html#signin';
      signin.addEventListener('click', () => track('plan_cta', { course: pageKey(), plan: course.plan, action: 'signin', placement: 'course_lock_signed_out' }));
      attach(actions, signin);
    }
    attach(panel, actions);
    attach(gate, panel);
  }

  function renderLockState(state) {
    const course = pageCourse();
    const gates = qsa('.lock-gate');
    if (!course || !gates.length || !canRender()) return;
    let rendered = 0;
    gates.forEach((gate) => {
      if (gate.getAttribute && gate.getAttribute('data-vjm-lock') === state) return;
      if (gate.setAttribute) gate.setAttribute('data-vjm-lock', state);
      try {
        if (state === 'under_tier') renderUnderTierGate(gate, course);
        else renderSignedOutGate(gate, course);
        rendered++;
      } catch { /* a broken panel must never hide the gate itself */ }
    });
    if (rendered) {
      track('lock_view', { course: course.key, state, required_plan: course.plan, gates: rendered });
    }
  }

  // ─── FREE PROGRESS: LESSONS ───────────────────────────────────────────
  // Only ungated lessons are tracked. Paid lessons live inside
  // .gated-content, which this code never reads, writes or reorders.
  function levelOf(panel) {
    return (panel && panel.getAttribute && panel.getAttribute('data-level')) || '1';
  }
  function pairOf(panel) {
    return (panel && panel.getAttribute && panel.getAttribute('data-pair')) || 'main';
  }
  function lessonId(panel, index) { return pairOf(panel) + ':' + levelOf(panel) + ':' + index; }
  function lessonTitle(card) {
    const s = qs('summary', card);
    return (s && (s.textContent || '').trim()) || 'this lesson';
  }
  function freeLessonCards(panel) {
    return qsa('.lesson-card', panel).filter((c) => !inGatedRegion(c));
  }

  function initLessonProgress() {
    const course = pageCourse();
    if (!course || !canRender()) return;
    qsa('.level-panel').forEach((panel) => {
      if (qs('.lock-gate', panel) || inGatedRegion(panel)) return;   // paid level
      const cards = freeLessonCards(panel);
      if (!cards.length) return;
      const saved = courseRecord(course.key).lessons;
      cards.forEach((card, i) => {
        const id = lessonId(panel, i);
        if (saved[id] && card.classList) card.classList.add('vjm-seen');
        card.addEventListener('toggle', () => {
          if (!card.open) return;
          if (card.classList) card.classList.add('vjm-seen');
          updateCourseRecord(course.key, (rec) => { rec.lessons[id] = Date.now(); });
          track('lesson_expand', {
            course: course.key, level: levelOf(panel), pair: pairOf(panel),
            lesson: i + 1, title: lessonTitle(card).slice(0, 120),
          });
          refreshProgressNote(panel, course);
        });
      });
      const note = makeEl('div', 'vjm-progress');
      if (!note) return;
      panel.insertBefore ? panel.insertBefore(note, panel.firstChild) : attach(panel, note);
      refreshProgressNote(panel, course, note);
    });
  }

  function progressNoteOf(panel) { return qs('.vjm-progress', panel); }

  function refreshProgressNote(panel, course, node) {
    const note = node || progressNoteOf(panel);
    if (!note || !canRender()) return;
    const cards = freeLessonCards(panel);
    const rec = courseRecord(course.key);
    const level = levelOf(panel);
    const done = cards.filter((c, i) => rec.lessons[lessonId(panel, i)]).length;
    const quiz = rec.quizzes[pairOf(panel) + ':' + level];
    const pct = cards.length ? Math.round((done / cards.length) * 100) : 0;
    note.innerHTML =
      `<b>Level ${esc(level)} progress</b>`
      + `<div class="vjm-meter"><i style="width:${pct}%"></i></div>`
      + `<small>${done} of ${cards.length} lessons opened`
      + (quiz ? ` · best quiz score ${esc(quiz.best)} / ${esc(quiz.total)}` : '')
      + ` · saved on this device only, not an account</small>`;
    const first = cards.findIndex((c, i) => !rec.lessons[lessonId(panel, i)]);
    if (first > -1) {
      const btn = makeEl('button', 'vjm-btn-sm', done ? 'Resume' : 'Start');
      if (btn) {
        btn.type = 'button';
        btn.addEventListener('click', () => {
          const card = cards[first];
          card.open = true;
          if (typeof card.scrollIntoView === 'function') card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
        attach(note, btn);
      }
    }
    if (done || quiz) {
      const reset = makeEl('button', 'vjm-btn-sm', 'Clear');
      if (reset) {
        reset.type = 'button';
        reset.title = 'Clear the progress saved for this course on this device';
        reset.addEventListener('click', () => {
          clearCourseRecord(course.key);
          qsa('.lesson-card.vjm-seen').forEach((c) => c.classList && c.classList.remove('vjm-seen'));
          qsa('.level-panel').forEach((p) => { if (progressNoteOf(p)) refreshProgressNote(p, course); });
        });
        attach(note, reset);
      }
    }
  }

  // ─── FREE PROGRESS: QUIZ COMPLETION, REMEDIATION, NEXT STEP ───────────
  // Called from the quiz submit handler with ORIGINAL question indices only.
  function recordQuizResult(course, panel, result) {
    if (!course) return;
    const id = (panel ? pairOf(panel) + ':' + levelOf(panel) : 'quiz') + '';
    updateCourseRecord(course.key, (rec) => {
      const prev = rec.quizzes[id] || {};
      rec.quizzes[id] = {
        last: result.correct,
        best: Math.max(Number(prev.best) || 0, result.correct),
        total: result.total,
        // Original question indices — never rendered positions.
        missed: result.missed.map((m) => m.qi),
        at: Date.now(),
      };
    });
  }

  function nextLevelInfo(panel) {
    if (!panel) return null;
    const level = Number(levelOf(panel));
    const pair = pairOf(panel);
    const next = qs(`.level-panel[data-pair="${pair}"][data-level="${level + 1}"]`);
    if (!next) return null;
    const tab = qs(`.level-tab[data-pair="${pair}"][data-level="${level + 1}"]`);
    const label = tab ? (tab.textContent || '').replace(/🔒/g, '').trim() : 'Level ' + (level + 1);
    return { panel: next, tab, label, locked: !!qs('.lock-gate', next) };
  }

  function renderCompletion(quiz, course, panel, result) {
    if (!canRender()) return null;
    const old = qs('.vjm-next', quiz);
    if (old && old.parentNode && typeof old.parentNode.removeChild === 'function') old.parentNode.removeChild(old);
    const box = makeEl('div', 'vjm-panel vjm-next');
    if (!box) return null;
    const level = levelOf(panel);
    const passed = result.total > 0 && result.correct === result.total;
    attach(box, makeEl('h4', '', passed ? `Level ${esc(level)} complete` : `Level ${esc(level)} — ${result.correct} of ${result.total}`));

    if (result.missed.length) {
      attach(box, makeEl('p', 'vjm-lead', `Review these ${result.missed.length === 1 ? 'question' : 'questions'} before moving on:`));
      result.missed.forEach((m) => {
        attach(box, makeEl('div', 'vjm-miss', `<b>${esc(m.question)}</b><span>${esc(m.explain)}</span>`));
      });
      const retry = makeEl('button', 'vjm-btn-sm', 'Retry the missed questions');
      if (retry) {
        retry.type = 'button';
        retry.addEventListener('click', () => {
          result.missed.forEach((m) => {
            const block = qs(`.quiz-q[data-qi="${m.qi}"]`, quiz);
            if (!block) return;
            qsa('input[type="radio"]', block).forEach((r) => { r.checked = false; });
            qsa('.quiz-choice', block).forEach((c) => c.classList && c.classList.remove('correct', 'incorrect'));
            const ex = qs('.quiz-explain', block);
            if (ex && ex.classList) ex.classList.remove('show');
            if (typeof block.scrollIntoView === 'function') block.scrollIntoView({ behavior: 'smooth', block: 'center' });
          });
        });
        attach(box, retry);
      }
    } else if (result.total) {
      attach(box, makeEl('p', 'vjm-lead', 'Every answer correct. Your score is saved on this device.'));
    }

    const next = nextLevelInfo(panel);
    const actions = makeEl('div', 'vjm-actions');
    if (next && !next.locked) {
      const go = makeEl('button', 'btn', `Next: ${esc(next.label)}`);
      if (go) {
        go.type = 'button';
        go.addEventListener('click', () => {
          if (next.tab && typeof next.tab.click === 'function') next.tab.click();
          if (typeof next.panel.scrollIntoView === 'function') next.panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        attach(actions, go);
      }
    } else if (next && next.locked && course) {
      // End of the free level: the honest next step is the plan that
      // actually contains the next one.
      const need = PLANS[course.plan];
      attach(box, makeEl('p', '',
        `${esc(next.label)} is part of ${esc(need.name)} (${esc(money(need.price))}/mo), which covers ${esc(need.includes)}.`));
      attach(actions, planCtaButton(course.plan, `Continue with ${need.name} — ${money(need.price)}/mo`,
        'free-level-complete-' + course.plan, 'free_level_complete'));
      const signin = makeEl('a', 'vjm-link', 'Already a member? Sign in →');
      if (signin) { signin.href = 'premium-guidance.html#signin'; attach(actions, signin); }
    }
    attach(box, actions);
    attach(quiz, box);
    return box;
  }

  function onQuizGraded(quiz, result) {
    const course = pageCourse();
    const panel = upTo(quiz, '.level-panel');
    if (inGatedRegion(quiz)) return;   // paid quiz: leave the gated region alone
    recordQuizResult(course, panel, result);
    if (course && panel) {
      track('free_level_complete', {
        course: course.key, level: levelOf(panel), pair: pairOf(panel),
        score: result.correct, total: result.total, missed: result.missed.length,
      });
    }
    if (panel && course && progressNoteOf(panel)) refreshProgressNote(panel, course);
    renderCompletion(quiz, course, panel, result);
  }

  // Test seam: the shuffle and grading rules are pure and unit-tested from
  // node (tests/quiz-integrity.test.mjs) without a browser.
  window.__quizInternals = { orderChoices, isCorrectPick };

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
    try { injectStyles(); } catch { /* ignore */ }
    try { initLessonProgress(); } catch { /* ignore */ }
    try { await initEntitlementState(); } catch { /* ignore */ }
  }

  // Decide what a visitor is actually looking at.
  //
  // The old rule was `if (await checkPremium()) unlockAll()`, which asked one
  // question — "is there a session?" — and that is not the question. Since the
  // middleware started enforcing tiers, a $100 Futures Core member opening
  // /options-lab has a perfectly valid session AND an empty .gated-content,
  // so the old rule hid the gate and revealed nothing: a blank course page.
  // The server's decision is readable here (it stamps data-locked="1" on what
  // it stripped), so the two cases are told apart instead of conflated.
  async function initEntitlementState() {
    const active = await checkPremium();
    const stripped = lockedByServer();
    if (active && !stripped) { unlockAll(); return 'entitled'; }
    const state = active ? 'under_tier' : 'signed_out';
    renderLockState(state);
    return state;
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
  const isLight = () => document.body.classList.contains('light-mode');
  // --emerald is the neutral accent; --gold is the accent red (see PALETTE).
  const NEUTRAL = () => cssVar('--emerald', isLight() ? '#26262a' : '#d9d9dd');
  const SECONDARY = () => cssVar('--muted', isLight() ? '#5f5f66' : '#9a9aa0');
  const DIM = () => (isLight() ? '#a5a5ab' : '#5a5a60');
  const RED = () => cssVar('--gold', isLight() ? '#b3251d' : '#d14343');
  const RISK_RE = /loss|risk|drawdown|draw down|alert|max ?dd|worst|stop|danger/i;
  // A series means "loss/risk" when its value is negative or its label says so.
  function isRisk(label, value) {
    return Number(value) < 0 || RISK_RE.test(String(label || ''));
  }
  // Call sites still hand us fixed hex values from the palette. Those literals
  // are dark-theme tones, so on the light page a "neutral" bar came out
  // near-white on white. Map every known palette literal back onto the live
  // token for its tier, and normalise the old blanket red so a positive,
  // non-risk series is never drawn red. Unknown colours pass through.
  const TIERS = {
    red: ['#d14343', '#e26060', '#a63333', '#b3251d', '#c9342b', '#8c1a14'],
    neutral: ['#ededee', '#d9d9dd', '#cfcfd4', '#141416', '#26262a'],
    secondary: ['#9a9aa0', '#8e8e95', '#5f5f66', '#c4c4c9'],
    dim: ['#6f6f76', '#3a3a40', '#2a2a2e', '#e3e3e6'],
  };
  function tierOf(color) {
    const c = String(color || '').trim().toLowerCase();
    if (!c) return null;
    if (TIERS.red.includes(c)) return 'red';
    if (TIERS.neutral.includes(c)) return 'neutral';
    if (TIERS.secondary.includes(c)) return 'secondary';
    if (TIERS.dim.includes(c)) return 'dim';
    return null;
  }
  function seriesColor(label, value, requested) {
    if (!requested) return isRisk(label, value) ? RED() : NEUTRAL();
    switch (tierOf(requested)) {
      // A red request is honoured only for a series that actually means
      // loss/risk; otherwise it was the old monochrome default and goes neutral.
      case 'red': return isRisk(label, value) ? RED() : NEUTRAL();
      case 'neutral': return NEUTRAL();
      case 'secondary': return SECONDARY();
      case 'dim': return DIM();
      default: return requested;
    }
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
