// Pure helpers for Whop, Discord-safe content, and the futures-proxy lean.
// No network, no Workers APIs → unit-testable deterministically.

import { wilsonInterval } from './backtest-core.js';

// ─── Whop ──────────────────────────────────────────────────────────────────

export function timingSafeHexEqual(a, b) {
  const A = String(a || '');
  const B = String(b || '');
  if (A.length !== B.length || A.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < A.length; i++) diff |= A.charCodeAt(i) ^ B.charCodeAt(i);
  return diff === 0;
}

export const WHOP_GRANT_EVENTS = new Set([
  'membership.went_valid',
  'payment.succeeded',
]);
export const WHOP_REVOKE_EVENTS = new Set([
  'membership.went_invalid',
  'membership.renewal_went_invalid',
  'payment.failed',
]);

// Returns a normalized instruction or null when the event is ignorable.
export function normalizeWhopEvent(body) {
  if (!body || typeof body !== 'object') return null;
  const type = String(body.type || '');
  const eventId = String(body.id || body.event_id || '');
  if (!eventId) return null;

  const data = body.data || body;
  const membership = data.membership || data;
  const memberId = String(membership.user_id || membership.member_id || data.user_id || '') || null;
  const productId = String(membership.product_id || data.product_id || '') || null;
  const planId = String(membership.plan_id || data.plan_id || '') || null;

  if (WHOP_GRANT_EVENTS.has(type)) {
    return { action: 'grant', eventId, memberId, productId, planId, type };
  }
  if (WHOP_REVOKE_EVENTS.has(type)) {
    return { action: 'revoke', eventId, memberId, productId, planId, type };
  }
  return { action: 'ignore', eventId, type };
}

// VJM-XXXX-XXXX from crypto random bytes; format is validated by tests.
export function generateAccessCodeShape(randomBytes) {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I/L/O/0/1 confusion
  let out = '';
  for (let i = 0; i < 8; i++) {
    out += alphabet[randomBytes[i] % alphabet.length];
  }
  return `VJM-${out.slice(0, 4)}-${out.slice(4)}`;
}

export function isValidGeneratedCode(code) {
  return /^VJM-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(String(code || ''));
}

// ─── Futures-proxy lean (explicit heuristic, labeled LOW confidence) ───────
// score components are pre-computed percentage numbers; weights fixed and
// published. Output is a lean label only — never a prediction.

export function computeFuturesLean({ spyChangePct = 0, qqqChangePct = 0 }) {
  // QQQ (NQ proxy) counts double: tech leadership drives index futures most days.
  const raw = qqqChangePct * 2 + spyChangePct;
  let lean = 'neutral';
  if (raw >= 0.5) lean = 'long-leaning';
  else if (raw <= -0.5) lean = 'short-leaning';
  const drivers = [];
  drivers.push(`QQQ ${fmtPct(qqqChangePct)} (NQ proxy, weight ×2)`);
  drivers.push(`SPY ${fmtPct(spyChangePct)} (ES proxy, weight ×1)`);
  return {
    lean,
    score: +raw.toFixed(3),
    confidence: 'low',
    method: 'fixed-weight composite of SPY/QQQ session change vs prior close; ETF price-action proxy only — not CME futures order flow',
    drivers,
    note: 'A lean is context, not a signal. Verify against live structure before acting.',
  };
}

function fmtPct(x) {
  const n = Number(x);
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
}

// ─── Content ingest sanitization (sheet rows → safe payloads) ──────────────

const URL_RE = /^https:\/\/[\w.-]+(\/[\w\-./?%&=]*)?$/;

function cleanStr(v, max) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/@(everyone|here)/gi, '@\u200b$1')
    .trim()
    .slice(0, max);
}

function cleanUrl(v) {
  const s = cleanStr(v, 600);
  return URL_RE.test(s) ? s : '';
}

export function sanitizeContentRow(type, row) {
  if (!row || typeof row !== 'object') return null;
  const id = cleanStr(row.id, 80);
  if (!id) return null;

  if (type === 'announcements') {
    const title = cleanStr(row.title, 160);
    const body = cleanStr(row.body, 3000);
    if (!title && !body) return null;
    return {
      id,
      title,
      body,
      link: cleanUrl(row.link),
      pinned: /^(true|yes|1)$/i.test(String(row.pinned)) ? 1 : 0,
      createdAt: cleanStr(row.created_at, 32),
    };
  }
  if (type === 'trade_reviews') {
    const ticker = cleanStr(row.ticker, 12).toUpperCase().replace(/[^A-Z0-9.^-]/g, '');
    if (!ticker) return null;
    const rm = Number(row.r_multiple);
    return {
      id,
      ticker,
      direction: /short/i.test(String(row.direction)) ? 'short' : 'long',
      result: ['win', 'loss', 'scratch', 'be'].includes(String(row.result).toLowerCase())
        ? String(row.result).toLowerCase()
        : 'unclassified',
      rMultiple: Number.isFinite(rm) ? +rm.toFixed(2) : null,
      notes: cleanStr(row.notes, 1200),
      imageUrl: cleanUrl(row.image_url),
      tradedAt: cleanStr(row.traded_at, 32),
    };
  }
  if (type === 'prop_firms') {
    const name = cleanStr(row.name, 80);
    const url = cleanUrl(row.url);
    if (!name || !url) return null;
    return {
      id,
      name,
      url,
      code: cleanStr(row.code, 40),
      discount: cleanStr(row.discount, 80),
      imageUrl: cleanUrl(row.image_url),
      notes: cleanStr(row.notes, 400),
      active: !/^(false|no|0)$/i.test(String(row.active ?? 'true')) ? 1 : 0,
    };
  }
  if (type === 'schedule') {
    const day = cleanStr(row.day, 3);
    const session = cleanStr(row.session, 10).toUpperCase();
    if (!['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(day)) return null;
    if (!['NYAM', 'NYPM', 'CLASS', 'ASIA'].includes(session)) return null;
    return {
      id,
      day,
      session,
      timeET: cleanStr(row.time_et, 20),
      host: cleanStr(row.host, 80),
      note: cleanStr(row.note, 160),
      active: !/^(false|no|0)$/i.test(String(row.active ?? 'true')) ? 1 : 0,
    };
  }
  if (type === 'team') {
    const name = cleanStr(row.name, 80);
    if (!name) return null;
    const ord = Number(row.order);
    return {
      id,
      name,
      role: cleanStr(row.role, 100),
      bio: cleanStr(row.bio, 600),
      photoUrl: cleanUrl(row.photo_url),
      socials: cleanStr(row.socials, 300),
      order: Number.isFinite(ord) ? ord : 0,
    };
  }
  if (type === 'faqs') {
    const question = cleanStr(row.question, 200);
    if (!question) return null;
    const ord = Number(row.order);
    return {
      id,
      question,
      answer: cleanStr(row.answer, 1000),
      order: Number.isFinite(ord) ? ord : 0,
    };
  }
  if (type === 'bundles') {
    const name = cleanStr(row.name, 60);
    if (!name) return null;
    return {
      id,
      name,
      price: cleanStr(row.price, 20),
      period: cleanStr(row.period, 20),
      saveBadge: cleanStr(row.save_badge, 20),
      features: cleanStr(row.features, 1200)
        .split('|')
        .map((f) => f.trim().slice(0, 120))
        .filter(Boolean),
      whopUrl: cleanUrl(row.whop_url),
      highlight: /^(true|yes|1)$/i.test(String(row.highlight)),
    };
  }
  if (type === 'stats') {
    const key = cleanStr(row.key, 30);
    if (!key) return null;
    return {
      id,
      key,
      value: cleanStr(row.value, 20),
      label: cleanStr(row.label, 60),
    };
  }
  if (type === 'results') {
    const imageUrl = cleanUrl(row.image_url);
    if (!imageUrl) return null;
    const ord = Number(row.order);
    return {
      id,
      imageUrl,
      caption: cleanStr(row.caption, 120),
      order: Number.isFinite(ord) ? ord : 0,
    };
  }
  return null;
}

export const CONTENT_TYPES = [
  'announcements', 'trade_reviews', 'prop_firms',
  'schedule', 'team', 'faqs', 'bundles', 'stats', 'results',
];

// Small helper reused by the brief: attach Wilson CI to any rate we publish.
export { wilsonInterval };
