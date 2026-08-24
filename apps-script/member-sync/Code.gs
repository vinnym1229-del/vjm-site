/**
 * VJM / St Trades — Member Status Bridge (secure single-record lookup)
 * =====================================================================
 *
 * Replaces the legacy "return the whole statuses/codes map" web app.
 *
 * Protocol (server-to-server only; never call this from the browser):
 *   POST with JSON body:
 *     {
 *       timestamp: <ms since epoch>,
 *       nonce:     <random uuid string>,
 *       payload:   <JSON string, exactly: {"type":"code"|"discord","value":"..."}>
 *       mac:       <hex HMAC-SHA256 of  timestamp + "\\n" + nonce + "\\n" + payload,
 *                   keyed with BRIDGE_SECRET>
 *     }
 *
 *   Response: { ok:true, found:true|false, discord?, status? }
 *   Only ONE record is ever returned. Never return full maps.
 *
 * Setup:
 *   1. Sheet layout ("Members" tab), header row required:
 *      A: Discord   B: Code        C: Status
 *      ...one row per member. Status values: Active / Renewed / Expired...
 *   2. Script Properties (Project Settings → Script Properties):
 *      BRIDGE_SECRET = a long random value. Must match MEMBERS_BRIDGE_SECRET
 *      in Cloudflare Pages secrets.
 *      SHEET_ID      = your spreadsheet ID (or bind the script to the sheet).
 *   3. Deploy → New deployment → Web app:
 *      Execute as: Me    Who has access: Anyone
 *      (Requests are still authenticated by the HMAC — access stays locked
 *      to holders of BRIDGE_SECRET.)
 *   4. Copy the /exec URL into Cloudflare as MEMBERS_BRIDGE_URL.
 *
 * Rotation: change BRIDGE_SECRET here and in Cloudflare at the same time;
 * old requests fail closed during the gap (they do NOT fall back).
 */

var REPLAY_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

function doPost(e) {
  try {
    var body = parseBody_(e);
    if (!body) return json_({ ok: false, error: 'bad request' });

    var props = PropertiesService.getScriptProperties();
    var secret = props.getProperty('BRIDGE_SECRET');
    if (!secret) return json_({ ok: false, error: 'not configured' }, 500);

    if (!verifyMac_(secret, body)) return json_({ ok: false, error: 'unauthorized' }, 401);

    var query;
    try { query = JSON.parse(body.payload); } catch (err) { return json_({ ok: false, error: 'bad payload' }); }
    if (!query || (query.type !== 'code' && query.type !== 'discord')) {
      return json_({ ok: false, error: 'bad query type' });
    }

    var value = String(query.value || '').trim();
    if (value.length > 64) return json_({ ok: false, error: 'bad value' });

    var record = lookupOne_(value, query.type === 'code');
    if (!record) return json_({ ok: true, found: false });

    return json_({
      ok: true,
      found: true,
      discord: record.discord,
      status: record.status,
    });
  } catch (err) {
    // Never echo internal errors or secret material to callers.
    console.error('bridge error class: ' + (err && err.name));
    return json_({ ok: false, error: 'internal error' }, 500);
  }
}

/** Legacy GET returns nothing useful — explicitly disabled. */
function doGet(e) {
  return json_({ ok: false, error: 'POST only' }, 405);
}

// ─── Lookups (minimum data only) ──────────────────────────────────────────

function lookupOne_(value, byCode) {
  var ss = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('SHEET_ID'));
  var sheet = ss.getSheetByName('Members') || ss.getSheets()[0];
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return null;

  var header = values[0].map(function (h) { return String(h).toLowerCase(); });
  var colDiscord = header.indexOf('discord');
  var colCode = header.indexOf('code');
  var colStatus = header.indexOf('status');
  if (colCode === -1 || colStatus === -1) return null;

  var needle = value.toLowerCase();
  for (var i = 1; i < values.length; i++) {
    var cell = byCode ? String(values[i][colCode]) : String(values[i][colDiscord]);
    if (cell.toLowerCase() !== needle) continue;
    return {
      discord: colDiscord >= 0 ? String(values[i][colDiscord] || '') : '',
      status: String(values[i][colStatus] || ''),
    };
  }
  return null;
}

// ─── Auth (HMAC + replay protection) ─────────────────────────────────────

function verifyMac_(secret, body) {
  var ts = Number(body.timestamp);
  var now = Date.now();
  if (!isFinite(ts) || Math.abs(now - ts) > REPLAY_WINDOW_MS) return false;

  var nonce = String(body.nonce || '');
  if (!nonce || nonce.length > 64) return false;

  var cache = CacheService.getScriptCache();
  if (cache.get('nonce:' + nonce)) return false; // replay detected

  var expected = computeMac_(secret, ts, nonce, String(body.payload || ''));
  var given = String(body.mac || '');
  if (!safeEqualHex_(expected, given)) return false;

  // Nonce TTL mirrors the replay window so repeats inside the window die here.
  cache.put('nonce:' + nonce, '1', (REPLAY_WINDOW_MS / 1000) * 2);
  return true;
}

function computeMac_(secret, timestamp, nonce, payload) {
  var raw = Utilities.computeHmacSignature(
    Utilities.MacAlgorithm.HMAC_SHA_256,
    timestamp + '\n' + nonce + '\n' + payload,
    secret
  );
  return raw.map(function (b) {
    var v = (b < 0 ? b + 256 : b).toString(16);
    return v.length === 1 ? '0' + v : v;
  }).join('');
}

function safeEqualHex_(a, b) {
  if (a.length !== b.length || a.length === 0) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function parseBody_(e) {
  if (!e || !e.postData || !e.postData.contents) return null;
  var raw = e.postData.contents;
  if (raw.length > 4096) return null; // cap request size
  try { return JSON.parse(raw); } catch (err) { return null; }
}

function json_(obj, status) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
