// Cloudflare Pages Function: POST /api/newsletter/subscribe
//
// The only endpoint on the site that stores a personal identifier from an
// anonymous visitor, which shapes every decision in it:
//
//   * It is a PUBLIC WRITE, so it is rate limited, size capped, and validates
//     rather than trusts. Turnstile is enforced the moment the owner sets
//     TURNSTILE_SECRET_KEY, and skipped cleanly until then (the same
//     soft-required pattern the rest of the site uses).
//   * A signup is an UPSERT on the address, never an append. Two rows for one
//     person means unsubscribing clears one of them and the mail keeps coming.
//   * Re-subscribing an address that previously opted out is allowed — a
//     person may come back — but it is an explicit status change with its own
//     timestamp, not a silent side effect of a duplicate submit.
//   * The response NEVER says whether an address was already on the list.
//     Doing so turns the form into an email-existence oracle for anyone with
//     a list to check. Success looks identical either way.

import { json, checkRateLimit, clientIp } from '../_lib/http.js';
import { turnstileConfigured, verifyTurnstile } from '../_lib/turnstile.js';

const MAX_EMAIL_CHARS = 254;      // RFC 5321 maximum path length
const MAX_NAME_CHARS = 60;
const MAX_SOURCE_CHARS = 60;

// Deliberately permissive-but-bounded. Address validation cannot be made
// exact with a regex, and trying produces false rejections of real addresses;
// the check here is only for shape and length. The real proof an address
// works is that mail to it is accepted.
const EMAIL_RE = /^[^\s@,;:<>()[\]\\"]+@[^\s@.,;:<>()[\]\\"]+(?:\.[^\s@.,;:<>()[\]\\"]+)+$/;

/** Trim, lowercase, and bound. Case matters to nobody and breaks dedupe. */
export function normalizeEmail(raw) {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (!email || email.length > MAX_EMAIL_CHARS) return null;
  if (!EMAIL_RE.test(email)) return null;
  return email;
}

/** A display name, not an identifier: printable, short, optional. */
export function cleanName(raw, max = MAX_NAME_CHARS) {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
  return name || null;
}

/** 32 bytes of CSPRNG as hex. Long enough that guessing is not a strategy. */
export function newUnsubToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function onRequestPost(context) {
  const { request, env } = context;

  // Tighter than the analytics bucket: a signup is a rarer action than a
  // pageview event, and this one costs the owner a row and a person an inbox.
  const rl = await checkRateLimit(env, request, 'newsletter', 10);
  if (!rl.allowed) return json({ ok: false, error: 'Too many requests. Try again in a minute.' }, 429);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid request.' }, 400);
  }
  if (!body || typeof body !== 'object') return json({ ok: false, error: 'Invalid request.' }, 400);

  // Honeypot. A field no human sees and no human fills; bots fill everything.
  // Answer 200 rather than 400 so a bot cannot learn it tripped anything.
  if (typeof body.website === 'string' && body.website.trim()) {
    return json({ ok: true, subscribed: true }, 200);
  }

  const email = normalizeEmail(body.email);
  if (!email) {
    return json({ ok: false, error: 'Enter an email address we can actually reach.' }, 400);
  }

  // Consent is explicit and checked as a precondition, not inferred from the
  // act of submitting. The form states what is being agreed to next to the
  // box; if the flag is missing the signup does not happen.
  if (body.consent !== true) {
    return json({ ok: false, error: 'Please confirm you want the newsletter.' }, 400);
  }

  if (turnstileConfigured(env)) {
    const ok = await verifyTurnstile(env, body.turnstileToken, clientIp(request));
    if (!ok) return json({ ok: false, error: 'Could not verify you are human. Reload and try again.' }, 403);
  }

  if (!env || !env.RESEARCH_DB) {
    // Never accept an address we cannot store. A form that says "you're
    // subscribed" and drops the address is worse than a form that is honest
    // about being offline.
    return json({ ok: false, error: 'The newsletter is not connected on this deployment yet.' }, 503);
  }

  const name = cleanName(body.firstName);
  const source = cleanName(body.source, MAX_SOURCE_CHARS) || 'site';
  const token = newUnsubToken();

  try {
    // The upsert: one row per address, always. On a repeat submit the name is
    // refreshed and status returns to 'subscribed' — which is the correct
    // handling of someone who opted out and has now deliberately signed up
    // again — but the ORIGINAL source and unsub_token are kept, so "where did
    // you get my address" stays answerable and unsubscribe links in mail
    // already sent keep working.
    await env.RESEARCH_DB.prepare(
      `INSERT INTO newsletter_subscribers (email, first_name, status, source, unsub_token)
       VALUES (?1, ?2, 'subscribed', ?3, ?4)
       ON CONFLICT(email) DO UPDATE SET
         first_name      = COALESCE(excluded.first_name, newsletter_subscribers.first_name),
         source          = COALESCE(newsletter_subscribers.source, excluded.source),
         status          = 'subscribed',
         unsubscribed_at = NULL,
         updated_at      = datetime('now')`
    ).bind(email, name, source, token).run();
  } catch {
    return json({ ok: false, error: 'Could not save that just now. Try again shortly.' }, 502);
  }

  // Identical for a new address and one already on the list, on purpose.
  return json({ ok: true, subscribed: true }, 200);
}

// GET /api/newsletter/subscribe — what the form needs to know before it can
// submit. Only two facts, and neither is a secret:
//
//   required  — whether this deployment enforces Turnstile at all
//   siteKey   — the Turnstile SITE key, which is public by design (it is meant
//               to be read out of page HTML; the SECRET key never leaves here)
//
// Serving these instead of hard-coding the site key in three HTML files is
// what makes turning Turnstile on a pure environment-variable change. It also
// makes the one dangerous misconfiguration visible: a deployment with the
// secret set but no site key rejects EVERY signup, and reporting
// `required: true, siteKey: null` lets the form say so on page load rather
// than letting real people discover it one failed signup at a time.
export function onRequestGet({ env }) {
  const siteKey = env && typeof env.TURNSTILE_SITE_KEY === 'string'
    ? env.TURNSTILE_SITE_KEY.trim() : '';
  return json({
    ok: true,
    required: turnstileConfigured(env || {}),
    siteKey: siteKey || null,
  }, 200);
}
