// VJM floating assistant widget — drop-in on any page:
//   <script src="/assets/chatbot.js" defer></script>
// Talks to POST /api/assistant. Renders only via textContent (XSS-safe).
// Respects reduced motion; keyboard operable; aria-live announcements.
(() => {
  'use strict';

  const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  let panel = null;
  let log = null;
  let input = null;
  let sendBtn = null;
  let busy = false;

  // Lesson mode. The widget never holds lesson TEXT: it holds the id +
  // immutable version the server handed it, and the server does the lookup,
  // the entitlement check and the grounding. `null` = normal market mode.
  let lesson = null;
  let lessonsForPage = null; // null = not fetched yet, [] = none for this page

  function pagePaths() {
    const p = location.pathname.replace(/\/index\.html$/, '/');
    const set = [p];
    if (p.endsWith('.html')) set.push(p.slice(0, -5));
    else if (p !== '/') set.push(p + '.html');
    return set;
  }

  // Lessons this member is entitled to AND that belong to the page being read.
  // A 401 (not signed in) or an empty list simply means no lesson lane — the
  // widget must not advertise a companion it cannot ground.
  async function fetchLessonsForPage() {
    if (lessonsForPage) return lessonsForPage;
    try {
      const res = await fetch('/api/assistant', { credentials: 'same-origin' });
      const data = await res.json().catch(() => ({ ok: false }));
      const here = pagePaths();
      lessonsForPage = (res.ok && data.ok && Array.isArray(data.lessons))
        ? data.lessons.filter((l) => here.includes(l.resource))
        : [];
    } catch {
      lessonsForPage = [];
    }
    return lessonsForPage;
  }

  function ensurePanel() {
    if (panel) return;
    panel = el('div', 'vjm-chat-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'VJM Market Assistant');

    const head = el('div', 'vjm-chat-head');
    head.append(el('strong', null, 'Market Assistant'));
    const close = el('button', 'vjm-chat-close', '×');
    close.setAttribute('aria-label', 'Close assistant');
    close.addEventListener('click', () => toggle(false));
    head.append(close);

    log = el('div', 'vjm-chat-log');
    log.setAttribute('role', 'log');
    log.setAttribute('aria-live', 'polite');
    greet();

    const form = el('form', 'vjm-chat-form');
    input = el('input', 'vjm-chat-input');
    input.type = 'text';
    input.placeholder = 'Ask about the market…';
    input.maxLength = 500;
    input.setAttribute('aria-label', 'Your question');
    sendBtn = el('button', 'vjm-chat-send', 'Send');
    sendBtn.type = 'submit';
    form.append(input, sendBtn);
    form.addEventListener('submit', (e) => { e.preventDefault(); ask(); });

    const foot = el('div', 'vjm-chat-foot', 'Educational info only — not financial advice.');
    panel.append(head, log, form, foot);
    document.body.append(panel);
  }

  function greet() {
    addMsg("Hi! I'm the PJ Trades assistant. What can I help with?", 'bot');
    addTopicPicker();
  }

  // Two clear lanes: live market/trading questions go to the AI (grounded on
  // real data); support/account questions get instant, reliable links to the
  // right page instead of waiting on a model that might guess wrong.
  function addTopicPicker() {
    const row = el('div', 'vjm-topic-row');
    const marketBtn = el('button', 'vjm-topic-btn', '📈 Market / Trading Question');
    const supportBtn = el('button', 'vjm-topic-btn', '🛟 Support / Account');
    marketBtn.type = 'button';
    supportBtn.type = 'button';
    marketBtn.addEventListener('click', () => {
      row.remove();
      addMsg('Ask away — prices, movers, what\'s happening in the market right now.', 'bot');
      input.placeholder = 'Ask about the market…';
      input.focus();
    });
    supportBtn.addEventListener('click', () => {
      row.remove();
      addSupportLinks();
    });
    row.append(marketBtn, supportBtn);
    log.append(row);
    log.scrollTop = log.scrollHeight;

    // Third lane, offered only when the server confirms this member may ask
    // about lessons on THIS page. Nothing here is decided client-side.
    fetchLessonsForPage().then((lessons) => {
      if (!lessons.length || !row.isConnected) return;
      const lessonBtn = el('button', 'vjm-topic-btn', '\uD83D\uDCDA Ask about a lesson on this page');
      lessonBtn.type = 'button';
      lessonBtn.addEventListener('click', () => {
        row.remove();
        addLessonPicker(lessons);
      });
      row.append(lessonBtn);
    });
  }

  function addLessonPicker(lessons) {
    addMsg('Pick the lesson you are reading. Answers come only from that lesson\u2019s text, and name the section they came from.', 'bot');
    const wrap = el('div', 'vjm-topic-row');
    for (const l of lessons) {
      const b = el('button', 'vjm-topic-btn', l.title);
      b.type = 'button';
      b.addEventListener('click', () => {
        lesson = l;
        wrap.remove();
        addMsg('Lesson set: ' + l.title + '. Ask away \u2014 if the lesson does not cover it, I will say so.', 'bot');
        input.placeholder = 'Ask about this lesson\u2026';
        input.focus();
      });
      wrap.append(b);
    }
    log.append(wrap);
    log.scrollTop = log.scrollHeight;
  }

  function addCitation(heading) {
    const d = el('div', 'vjm-cite', 'From this lesson\u2019s section: ' + heading);
    log.append(d);
    log.scrollTop = log.scrollHeight;
  }

  function addSupportLinks() {
    addMsg('Here\'s where to go for the common stuff — or just type your question and I\'ll do my best to point you the right way.', 'bot');
    const links = [
      ['Sign in to your account', 'premium-guidance.html#signin'],
      ['Buy / see pricing', 'index.html#premium'],
      ['Check if my membership is active', 'index.html#premium'],
      ['Join the free Discord', 'https://discord.gg/pjtrades'],
      ['Contact support in Discord', 'https://discord.gg/pjtrades'],
    ];
    const wrap = el('div', 'vjm-msg vjm-msg-bot vjm-support-links');
    for (const [label, href] of links) {
      const a = document.createElement('a');
      a.href = href;
      a.textContent = label;
      if (/^https?:\/\//.test(href)) { a.target = '_blank'; a.rel = 'noopener'; }
      wrap.append(a);
    }
    log.append(wrap);
    log.scrollTop = log.scrollHeight;
    input.placeholder = 'Or type your question…';
  }

  function addMsg(text, who) {
    const row = el('div', 'vjm-msg vjm-msg-' + who);
    row.textContent = text;
    log.append(row);
    log.scrollTop = log.scrollHeight;
    return row;
  }

  async function ask() {
    const q = input.value.trim();
    if (!q || busy) return;
    busy = true;
    sendBtn.disabled = true;
    input.value = '';
    addMsg(q, 'user');
    const thinking = addMsg(lesson ? 'Checking the lesson\u2026' : 'Checking live data\u2026', 'bot thinking');

    try {
      const payload = lesson
        ? { question: q, lessonId: lesson.id, lessonVersion: lesson.version }
        : { question: q };
      const res = await fetch('/api/assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({ ok: false }));
      thinking.remove();
      if (res.status === 409 && lesson) {
        // The lesson text changed under us; drop the stale copy and re-fetch.
        lesson = null;
        lessonsForPage = null;
        addMsg('That lesson was updated \u2014 reopen the lesson list and ask again.', 'bot');
      } else if (!res.ok || !data.ok) {
        addMsg(data.error || 'The assistant is unavailable right now.', 'bot');
      } else if (data.narrative) {
        addMsg(data.narrative, 'bot');
        if (data.citation && data.citation.heading) addCitation(data.citation.heading);
      } else if (data.dataBlock) {
        addMsg(data.message || 'Narrative engine is offline — live data:', 'bot');
        addMsg(data.dataBlock.trim(), 'bot data');
      } else if (data.message) {
        // Lesson mode refusal: the lesson does not support the question.
        addMsg(data.message, 'bot');
      }
    } catch {
      thinking.remove();
      addMsg('Network hiccup — try again in a moment.', 'bot');
    } finally {
      busy = false;
      sendBtn.disabled = false;
      input.focus();
    }
  }

  function toggle(open) {
    ensurePanel();
    panel.classList.toggle('open', open);
    if (open) {
      input.focus();
    }
  }

  function init() {
    const btn = el('button', 'vjm-chat-fab');
    btn.type = 'button';
    btn.innerHTML = '<span aria-hidden="true">💬</span>';
    btn.setAttribute('aria-label', 'Open market assistant');
    btn.addEventListener('click', () => toggle(!panel || !panel.classList.contains('open')));
    document.body.append(btn);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && panel && panel.classList.contains('open')) {
        toggle(false);
        btn.focus();
      }
    });
  }

  // Inject styles once (kept tiny; tokens.css covers the design language).
  function injectStyles() {
    const css = `
.vjm-chat-fab{position:fixed;right:18px;bottom:2px;z-index:9990;width:54px;height:54px;border-radius:50%;
 border:none;background:linear-gradient(135deg,var(--vjm-red,#d14343),var(--vjm-red-deep,#a63333));color:#fff;font-size:1.3rem;cursor:pointer;
 box-shadow:0 10px 30px rgba(0,0,0,.5);transition:transform ${REDUCED ? '0s' : '.15s'} ease;}
.vjm-chat-fab:hover{transform:translateY(-2px);}
.vjm-chat-fab:focus-visible{outline:2px solid #d9d9dd;outline-offset:2px;}
.vjm-chat-panel{position:fixed;right:18px;bottom:68px;z-index:9991;width:min(380px,calc(100vw - 24px));
 height:min(540px,70vh);display:none;flex-direction:column;background:#161618;border:1px solid #2a2a2e;
 border-radius:16px;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,.6);}
.vjm-chat-panel.open{display:flex;}
.vjm-chat-head{display:flex;justify-content:space-between;align-items:center;padding:12px 16px;
 background:rgba(255,255,255,.03);border-bottom:1px solid #2a2a2e;color:#ededee;font-family:'DM Sans',sans-serif;}
.vjm-chat-close{background:none;border:none;color:#9a9aa0;font-size:1.2rem;cursor:pointer;line-height:1;}
.vjm-chat-log{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;}
.vjm-msg{max-width:88%;padding:9px 13px;border-radius:14px;font-size:.86rem;line-height:1.45;white-space:pre-wrap;
 font-family:'DM Sans',sans-serif;}
.vjm-msg-user{align-self:flex-end;background:var(--vjm-red,#d14343);color:#fff;border-bottom-right-radius:4px;}
.vjm-msg-bot{align-self:flex-start;background:#1d1d2033;border:1px solid #2a2a2e;color:#ededee;border-bottom-left-radius:4px;}
.vjm-msg-bot.thinking{opacity:.65;}
.vjm-msg-bot.data{font-family:monospace;font-size:.78rem;color:#9a9aa0;}
.vjm-topic-row{display:flex;flex-direction:column;gap:8px;align-self:stretch;}
.vjm-topic-btn{background:#1d1d2033;border:1px solid #2a2a2e;color:#ededee;border-radius:12px;padding:10px 13px;
 font-size:.85rem;font-family:'DM Sans',sans-serif;text-align:left;cursor:pointer;transition:border-color .15s ease;}
.vjm-topic-btn:hover,.vjm-topic-btn:focus-visible{border-color:var(--vjm-red,#d14343);outline:none;}
.vjm-cite{align-self:flex-start;font-size:.7rem;color:#8a8a91;padding:0 4px;max-width:88%;font-family:'DM Sans',sans-serif;}
.vjm-support-links{display:flex;flex-direction:column;gap:6px;padding:8px 13px;}
.vjm-support-links a{color:#d9d9dd;text-decoration:none;font-size:.84rem;font-weight:700;}
.vjm-support-links a:hover,.vjm-support-links a:focus-visible{text-decoration:underline;}
.vjm-chat-form{display:flex;gap:8px;padding:10px;border-top:1px solid #2a2a2e;background:rgba(255,255,255,.02);}
.vjm-chat-input{flex:1;background:#131315;border:1px solid #2a2a2e;border-radius:10px;padding:10px 12px;
 color:#ededee;font-size:.9rem;min-height:44px;}
.vjm-chat-input:focus{outline:none;border-color:var(--vjm-red,#d14343);}
.vjm-chat-send{background:var(--vjm-red,#d14343);border:none;color:#fff;font-weight:800;border-radius:10px;padding:0 16px;
 cursor:pointer;min-height:44px;}
.vjm-chat-send:disabled{opacity:.5;cursor:wait;}
.vjm-chat-foot{padding:7px 12px;text-align:center;font-size:.68rem;color:#6f6f76;border-top:1px solid #2a2a2e;}
@media (prefers-reduced-motion:reduce){.vjm-chat-fab{transition:none;}}
`;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
  }

  injectStyles();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
