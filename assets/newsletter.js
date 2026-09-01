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

    // A one-click link from an email footer lands back here with ?state=…
    // after the GET handler has already done the removal.
    var banner = document.getElementById('nl-state');
    if (banner) {
      var state = new URLSearchParams(location.search).get('state');
      var copy = {
        done: ['ok', 'You are unsubscribed. That address will not receive any more emails from us.'],
        invalid: ['err', 'That unsubscribe link is not valid or has already been used. Enter your address below and we will remove it.'],
        error: ['err', 'Something went wrong on our side. Enter your address below and we will remove it.'],
      }[state];
      if (copy) { banner.className = 'nl-msg ' + copy[0]; banner.textContent = copy[1]; }
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
