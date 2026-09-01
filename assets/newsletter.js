/* Newsletter signup + unsubscribe behaviour.
 *
 * Progressive enhancement, not a widget: the markup for both forms is real
 * HTML in the page, so a visitor with JavaScript off still sees the offer and
 * the unsubscribe instructions rather than an empty box. This file only takes
 * over the submit so the page does not navigate.
 *
 * Deliberately not a third-party embed. Every hosted signup form (Mailchimp,
 * ConvertKit, beehiiv) is an external script plus a CSP hole plus a copy of
 * the address list in someone else's account. This posts to the site's own
 * endpoint and the list stays in the owner's D1.
 */
(function () {
  'use strict';

  var track = function (name, props) {
    try { if (typeof window.vjmTrack === 'function') window.vjmTrack(name, props); } catch (e) { /* analytics is never load-bearing */ }
  };

  function setMsg(form, text, kind) {
    var msg = form.querySelector('.nl-msg');
    if (!msg) return;
    msg.textContent = text || '';
    msg.className = 'nl-msg' + (kind ? ' ' + kind : '');
  }

  async function postJson(url, payload) {
    var res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    return { res: res, data: data };
  }

  /* ── Turnstile ──────────────────────────────────────────────────────────
   * Off until the owner sets TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY in
   * Cloudflare. The site key is fetched from the endpoint rather than baked
   * into three HTML files, so turning the bot check on is an environment
   * change and not a code change — and so the key cannot drift between the
   * page that renders the widget and the server that verifies it.
   *
   * The dangerous configuration is "secret set, site key not": the server then
   * rejects every signup and the form has nothing to send. That is reported as
   * required-without-a-key and the form says so on load, instead of letting
   * real people find out one failed submit at a time.
   */
  var turnstile = { required: false, siteKey: null, ready: false };

  function loadTurnstileScript() {
    if (document.getElementById('cf-turnstile-script')) return;
    var s = document.createElement('script');
    s.id = 'cf-turnstile-script';
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.defer = true;
    s.onload = function () { turnstile.ready = true; renderWidgets(); };
    document.head.appendChild(s);
  }

  function renderWidgets() {
    if (!turnstile.ready || !turnstile.siteKey || !window.turnstile) return;
    document.querySelectorAll('form.nl-signup').forEach(function (form) {
      var slot = form.querySelector('.nl-turnstile');
      if (!slot || slot.dataset.rendered) return;
      slot.dataset.rendered = '1';
      try {
        window.turnstile.render(slot, {
          sitekey: turnstile.siteKey,
          callback: function (token) { form.dataset.turnstileToken = token; },
          'expired-callback': function () { delete form.dataset.turnstileToken; },
          'error-callback': function () { delete form.dataset.turnstileToken; }
        });
      } catch (e) { /* a failed widget must not take the form down with it */ }
    });
  }

  async function initTurnstile() {
    var forms = document.querySelectorAll('form.nl-signup');
    if (!forms.length) return;
    try {
      var res = await fetch('/api/newsletter/subscribe', { headers: { Accept: 'application/json' } });
      if (!res.ok) return;
      var cfg = await res.json();
      turnstile.required = !!(cfg && cfg.required);
      turnstile.siteKey = (cfg && cfg.siteKey) || null;
    } catch (e) {
      return;                       // unreachable config: leave the form as-is
    }
    if (turnstile.siteKey) { loadTurnstileScript(); return; }
    if (turnstile.required) {
      // Secret set, site key missing. Every submit would 403. Say so now.
      forms.forEach(function (form) {
        setMsg(form, 'Signups are temporarily unavailable — the bot check on this '
          + 'site is misconfigured. Please try again later.', 'err');
        var btn = form.querySelector('.nl-submit');
        if (btn) btn.disabled = true;
      });
    }
  }

  /* ── Signup ─────────────────────────────────────────────────────────── */
  function initSignup(form) {
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var btn = form.querySelector('.nl-submit');
      var consent = form.querySelector('input[name="consent"]');
      var email = (form.querySelector('input[name="email"]') || {}).value || '';

      if (consent && !consent.checked) {
        setMsg(form, 'Tick the box so we know you want the emails.', 'err');
        consent.focus();
        return;
      }

      if (turnstile.required && !form.dataset.turnstileToken) {
        setMsg(form, 'Just a moment — finishing the bot check. Try again in a second.', 'err');
        return;
      }

      var label = btn ? btn.textContent : '';
      if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
      setMsg(form, '', '');

      try {
        var out = await postJson('/api/newsletter/subscribe', {
          email: email,
          firstName: (form.querySelector('input[name="firstName"]') || {}).value || '',
          consent: true,
          website: (form.querySelector('input[name="website"]') || {}).value || '',
          source: form.getAttribute('data-source') || 'site',
          turnstileToken: form.dataset.turnstileToken || '',
        });
        if (out.res.ok && out.data && out.data.ok) {
          // Replace the form rather than leaving a filled-in one on screen: a
          // form that still looks submittable after a success is the reason
          // people submit twice.
          form.innerHTML = '<p class="nl-kicker">You’re on the list</p>'
            + '<p class="nl-sub" style="margin:0">Check your inbox for the guides. Every email has an '
            + 'unsubscribe link at the bottom, and you can also '
            + '<a href="/unsubscribe.html">unsubscribe here</a> any time.</p>';
          track('lead_submit', { form: 'newsletter', source: form.getAttribute('data-source') || 'site' });
          return;
        }
        // A Turnstile token is single-use, so a failed submit must not be
        // retried with the same one — reset the widget and drop the stale token.
        delete form.dataset.turnstileToken;
        if (window.turnstile && turnstile.siteKey) { try { window.turnstile.reset(); } catch (e) { /* nothing to reset */ } }
        setMsg(form, (out.data && out.data.error) || 'Could not sign you up just now. Try again shortly.', 'err');
      } catch (err) {
        setMsg(form, 'Could not reach the server. Check your connection and try again.', 'err');
      } finally {
        if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = label; }
      }
    });
  }

  /* ── Unsubscribe ────────────────────────────────────────────────────── */
  function initUnsub(form) {
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var btn = form.querySelector('.nl-submit');
      var label = btn ? btn.textContent : '';
      if (btn) { btn.disabled = true; btn.textContent = 'Removing…'; }
      setMsg(form, '', '');

      try {
        var out = await postJson('/api/newsletter/unsubscribe', {
          email: (form.querySelector('input[name="email"]') || {}).value || '',
        });
        if (out.res.ok && out.data && out.data.ok) {
          // Worded so it is true whether or not the address was on the list —
          // the endpoint deliberately does not say, because answering would
          // turn this form into an email-existence check for anybody.
          setMsg(form, 'Done. That address will not receive any more emails from us.', 'ok');
          form.reset();
          return;
        }
        setMsg(form, (out.data && out.data.error) || 'Could not complete that just now. Try again shortly.', 'err');
      } catch (err) {
        setMsg(form, 'Could not reach the server. Check your connection and try again.', 'err');
      } finally {
        if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = label; }
      }
    });
  }

  function init() {
    document.querySelectorAll('form.nl-signup').forEach(initSignup);
    document.querySelectorAll('form.nl-unsub').forEach(initUnsub);
    // Signup only. An unsubscribe must never be gated behind a bot check:
    // making it harder to leave a list than to join one is the thing the whole
    // opt-out design is against.
    initTurnstile();

    // A one-click link from an email footer lands back here with ?state=…
    // after the GET handler has already done the removal.
    var banner = document.getElementById('nl-state');
    if (banner) {
      var state = new URLSearchParams(location.search).get('state');
      var copy = {
        done: ['ok', 'You are unsubscribed. That address will not receive any more emails from us.'],
        // Re-clicking a link whose token has already done its job still redirects
        // here as 'done', not 'invalid' — the GET handler reports success whether
        // or not a row actually matched, same as the POST form does. 'invalid' only
        // ever fires for a malformed or missing token, so the copy must not imply a
        // used-once model the tokens don't have.
        invalid: ['err', 'That unsubscribe link is not valid. Enter your address below and we will remove it.'],
        error: ['err', 'Something went wrong on our side. Enter your address below and we will remove it.'],
      }[state];
      if (copy) { banner.className = 'nl-msg ' + copy[0]; banner.textContent = copy[1]; }
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
