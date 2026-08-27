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
  }

  function addSupportLinks() {
    addMsg('Here\'s where to go for the common stuff — or just type your question and I\'ll do my best to point you the right way.', 'bot');
    const links = [
      ['Sign in to your account', 'premium-guidance.html#signin'],
      ['Buy / see pricing', 'index.html#premium'],
      ['Check if my membership is active', 'index.html#premium'],
      ['Join the free Discord', 'https://discord.gg/pjtrades'],
      ['DM support directly', 'https://discord.com/users/St1101'],
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
    const thinking = addMsg('Checking live data…', 'bot thinking');

    try {
      const res = await fetch('/api/assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ question: q }),
      });
      const data = await res.json().catch(() => ({ ok: false }));
      thinking.remove();
      if (!res.ok || !data.ok) {
        addMsg(data.error || 'The assistant is unavailable right now.', 'bot');
      } else if (data.narrative) {
        addMsg(data.narrative, 'bot');
      } else if (data.dataBlock) {
        addMsg(data.message || 'Narrative engine is offline — live data:', 'bot');
        addMsg(data.dataBlock.trim(), 'bot data');
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
.vjm-chat-fab{position:fixed;right:18px;bottom:18px;z-index:9990;width:54px;height:54px;border-radius:50%;
 border:none;background:linear-gradient(135deg,#ef4444,#b91c1c);color:#fff;font-size:1.3rem;cursor:pointer;
 box-shadow:0 10px 30px rgba(220,38,38,.4);transition:transform ${REDUCED ? '0s' : '.15s'} ease;}
.vjm-chat-fab:hover{transform:translateY(-2px);}
.vjm-chat-fab:focus-visible{outline:2px solid #f0b429;outline-offset:2px;}
.vjm-chat-panel{position:fixed;right:18px;bottom:84px;z-index:9991;width:min(380px,calc(100vw - 24px));
 height:min(540px,70vh);display:none;flex-direction:column;background:#0c1220;border:1px solid #22314a;
 border-radius:16px;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,.6);}
.vjm-chat-panel.open{display:flex;}
.vjm-chat-head{display:flex;justify-content:space-between;align-items:center;padding:12px 16px;
 background:rgba(255,255,255,.03);border-bottom:1px solid #22314a;color:#e8eef7;font-family:'DM Sans',sans-serif;}
.vjm-chat-close{background:none;border:none;color:#8ea1b8;font-size:1.2rem;cursor:pointer;line-height:1;}
.vjm-chat-log{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;}
.vjm-msg{max-width:88%;padding:9px 13px;border-radius:14px;font-size:.86rem;line-height:1.45;white-space:pre-wrap;
 font-family:'DM Sans',sans-serif;}
.vjm-msg-user{align-self:flex-end;background:#dc2626;color:#fff;border-bottom-right-radius:4px;}
.vjm-msg-bot{align-self:flex-start;background:#16203233;border:1px solid #22314a;color:#dbe6f3;border-bottom-left-radius:4px;}
.vjm-msg-bot.thinking{opacity:.65;}
.vjm-msg-bot.data{font-family:monospace;font-size:.78rem;color:#9fb3cc;}
.vjm-topic-row{display:flex;flex-direction:column;gap:8px;align-self:stretch;}
.vjm-topic-btn{background:#16203233;border:1px solid #22314a;color:#e8eef7;border-radius:12px;padding:10px 13px;
 font-size:.85rem;font-family:'DM Sans',sans-serif;text-align:left;cursor:pointer;transition:border-color .15s ease;}
.vjm-topic-btn:hover,.vjm-topic-btn:focus-visible{border-color:#dc2626;outline:none;}
.vjm-support-links{display:flex;flex-direction:column;gap:6px;padding:8px 13px;}
.vjm-support-links a{color:#ff9a9a;text-decoration:none;font-size:.84rem;font-weight:700;}
.vjm-support-links a:hover,.vjm-support-links a:focus-visible{text-decoration:underline;}
.vjm-chat-form{display:flex;gap:8px;padding:10px;border-top:1px solid #22314a;background:rgba(255,255,255,.02);}
.vjm-chat-input{flex:1;background:#0a0f1a;border:1px solid #22314a;border-radius:10px;padding:10px 12px;
 color:#e8eef7;font-size:.9rem;min-height:44px;}
.vjm-chat-input:focus{outline:none;border-color:#dc2626;}
.vjm-chat-send{background:#dc2626;border:none;color:#fff;font-weight:800;border-radius:10px;padding:0 16px;
 cursor:pointer;min-height:44px;}
.vjm-chat-send:disabled{opacity:.5;cursor:wait;}
.vjm-chat-foot{padding:7px 12px;text-align:center;font-size:.68rem;color:#66799a;border-top:1px solid #182236;}
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
