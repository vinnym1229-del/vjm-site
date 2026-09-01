// Cloudflare Pages Function: POST /api/newsletter/unsubscribe
//
// Opting out has to be the easiest thing on the site. Two ways in, because a
// person who wants off a list should never be blocked by not having the right
// link to hand:
//
//   1. `token` — the per-subscriber value from an email footer. One click,
//      no typing, no account. This is what a List-Unsubscribe header points
//      at and what CAN-SPAM assumes exists.
//   2. `email` — typed into /unsubscribe.html by someone who deleted the mail.
//
// Both answer identically whether or not the address was ever on the list.
// An unsubscribe form that says "that address isn't subscribed" is an email
// existence oracle, and it is a worse one than the signup form because it
// takes no consent flag and no Turnstile pass to query.
//
// Unsubscribing never deletes the row. It sets status and stamps the time, so
// the address stays a suppression entry — a deleted row would be silently
// re-addable by the next import or form submit, which is exactly how opt-outs
// get quietly undone.

import { json, checkRateLimit } from '../_lib/http.js';
import { normalizeEmail } from './subscribe.js';

/** Tokens are 64 hex chars from newUnsubToken(). Anything else is not one. */
export function cleanToken(raw) {
  if (typeof raw !== 'string') return null;
  const token = raw.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(token) ? token : null;
}

async function unsubscribe(env, { token, email }) {
  const sql = token
    ? `UPDATE newsletter_subscribers
          SET status = 'unsubscribed', unsubscribed_at = datetime('now'), updated_at = datetime('now')
        WHERE unsub_token = ?1 AND status != 'unsubscribed'`
    : `UPDATE newsletter_subscribers
          SET status = 'unsubscribed', unsubscribed_at = datetime('now'), updated_at = datetime('now')
        WHERE email = ?1 AND status != 'unsubscribed'`;
  await env.RESEARCH_DB.prepare(sql).bind(token || email).run();
}

export async function onRequestPost(context) {
  const { request, env } = context;

  // Looser than signup on purpose. Rate limiting an opt-out too tightly means
  // a person on a shared or corporate IP can be stopped from getting off the
  // list, and that failure mode is worse than the abuse it would prevent.
  const rl = await checkRateLimit(env, request, 'newsletter-unsub', 30);
  if (!rl.allowed) return json({ ok: false, error: 'Too many requests. Try again in a minute.' }, 429);

  // Two shapes arrive here. The page's own form sends JSON. A mailbox
  // provider acting on List-Unsubscribe-Post sends
  // `List-Unsubscribe=One-Click` as form data with the token in the query
  // string, and never any JSON at all — so an unparseable body is not an
  // error, it is the RFC 8058 case, and the token is read from the URL.
  let body = {};
  try {
    body = (await request.json()) || {};
  } catch {
    body = {};
  }
  if (typeof body !== 'object' || Array.isArray(body)) body = {};

  const token = cleanToken(body.token) || cleanToken(new URL(request.url).searchParams.get('token'));
  const email = token ? null : normalizeEmail(body.email);
  if (!token && !email) {
    return json({ ok: false, error: 'Enter the email address you want removed.' }, 400);
  }

  if (!env || !env.RESEARCH_DB) {
    // The one place where failing loudly matters more than looking tidy: a
    // person must never be told they are unsubscribed when nothing was written.
    return json({ ok: false, error: 'The newsletter is not connected on this deployment yet.' }, 503);
  }

  try {
    await unsubscribe(env, { token, email });
  } catch {
    return json({ ok: false, error: 'Could not complete that just now. Try again shortly.' }, 502);
  }

  // Deliberately does not report whether a row matched.
  return json({ ok: true, unsubscribed: true }, 200);
}

// A GET so the link in an email footer works on its own, without JavaScript
// and without a form: /api/newsletter/unsubscribe?token=… removes the address
// and then hands the reader the confirmation page.
//
// Note this is a state change on a GET, which is normally wrong. It is right
// here for one narrow reason: the alternative is a reader clicking a link and
// landing on a page that asks them to click again to actually opt out, and
// every extra step in an unsubscribe flow is a step somebody gives up on. The
// token is single-purpose and grants nothing but its own removal, so a
// prefetch or a scanner following the link does no harm beyond opting out an
// address that asked to be opted out.
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const token = cleanToken(url.searchParams.get('token'));

  const done = (state) => Response.redirect(new URL(`/unsubscribe.html?state=${state}`, url.origin).toString(), 302);

  if (!token) return done('invalid');
  if (!env || !env.RESEARCH_DB) return done('error');

  const rl = await checkRateLimit(env, request, 'newsletter-unsub', 30);
  if (!rl.allowed) return done('error');

  try {
    await unsubscribe(env, { token });
  } catch {
    return done('error');
  }
  return done('done');
}
