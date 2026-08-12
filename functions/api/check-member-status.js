// Cloudflare Pages Function: GET /api/check-member-status?discord=<username>
//
// Looks up live status from the Google Apps Script member-status bridge
// (see St Trades Automation/member-status-bridge/Code.gs). Requires the
// MEMBERS_STATUS_URL environment variable to be set in the Pages project
// (Settings > Environment variables) to the Apps Script Web App URL.

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const raw = (url.searchParams.get('discord') || '').trim().toLowerCase();
  const username = raw.replace(/^@+/, '');

  if (!username) {
    return jsonResponse({ ok: false, error: 'Missing discord query param' }, 400);
  }

  const sourceUrl = env.MEMBERS_STATUS_URL;
  if (!sourceUrl) {
    return jsonResponse({ ok: false, error: 'MEMBERS_STATUS_URL is not configured' }, 500);
  }

  let data;
  try {
    const res = await fetch(sourceUrl, { cf: { cacheTtl: 15, cacheEverything: true } });
    data = await res.json();
  } catch (err) {
    return jsonResponse({ ok: false, error: 'Could not reach the member status sheet' }, 502);
  }

  if (!data || data.ok !== true) {
    return jsonResponse({ ok: false, error: (data && data.error) || 'Sheet bridge returned an error' }, 502);
  }

  const status = String(data.statuses[username] || '').trim();
  const normalized = status.toLowerCase();
  const active = normalized === 'active' || normalized === 'renewed';

  return jsonResponse({
    ok: true,
    discord: username,
    status: status || 'Not Found',
    active,
    updatedAt: data.updatedAt || null,
  });
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
