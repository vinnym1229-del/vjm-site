// Cloudflare Turnstile server-side verification, shared by any endpoint
// that wants a human check before an expensive or abusable action.
//
// Soft-required by design: until TURNSTILE_SECRET_KEY is set, callers should
// skip the check entirely (see turnstileConfigured) rather than fail closed —
// the same pattern as ALPACA_API_KEY, so the owner can deploy the front-end
// widget and the env var on their own schedule without an outage in between.
// Once the secret is present, verification is mandatory: a missing or
// invalid token is rejected the same as a wrong access code.

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export function turnstileConfigured(env) {
  return Boolean(env.TURNSTILE_SECRET_KEY);
}

// Returns true only on a confirmed pass. Any network failure, timeout, or
// malformed response counts as a failure — never fail open on a check whose
// entire purpose is blocking automated abuse.
export async function verifyTurnstile(env, token, ip) {
  if (!token || typeof token !== 'string') return false;
  const body = new URLSearchParams();
  body.set('secret', env.TURNSTILE_SECRET_KEY);
  body.set('response', token);
  if (ip) body.set('remoteip', ip);
  try {
    const res = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data && data.success === true;
  } catch {
    return false;
  }
}
