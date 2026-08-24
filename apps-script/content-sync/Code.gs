/**
 * VJM / St Trades — Content Bridge (owner-editable website content)
 * ==================================================================
 *
 * Lets the owner edit announcements, trade reviews, and prop-firm promos in
 * Google Sheets and have them flow to the website + Discord automatically.
 * Same HMAC protocol as member-sync (timestamp\nnonce\npayload, 5-min replay
 * window, nonce dedupe).
 *
 * Sheet tabs required (header row, case-insensitive):
 *
 *   Announcements: id | title | body | link | pinned | created_at
 *   TradeReviews:  id | ticker | direction | result | r_multiple | notes |
 *                  image_url | traded_at
 *   PropFirms:     id | name | url | code | discount | image_url | notes |
 *                  active
 *
 * Setup:
 *   1. Script Properties: CONTENT_BRIDGE_SECRET (= Cloudflare's
 *      CONTENT_BRIDGE_SECRET) and SHEET_ID.
 *   2. Deploy as web app (Execute as Me, access Anyone — requests are still
 *      authenticated by the HMAC).
 *   3. Put the /exec URL into Cloudflare secret CONTENT_BRIDGE_URL.
 */

var REPLAY_WINDOW_MS = 5 * 60 * 1000;
var MAX_ROWS = 200;

function doPost(e) {
  try {
    var body = parseBody_(e);
    if (!body) return json_({ ok: false, error: 'bad request' });

    var props = PropertiesService.getScriptProperties();
    var secret = props.getProperty('CONTENT_BRIDGE_SECRET');
    if (!secret) return json_({ ok: false, error: 'not configured' }, 500);

    if (!verifyMac_(secret, body)) return json_({ ok: false, error: 'unauthorized' }, 401);

    var query;
    try { query = JSON.parse(body.payload); } catch (err2) { return json_({ ok: false, error: 'bad payload' }); }
    if (!query || query.action !== 'all') return json_({ ok: false, error: 'unsupported action' });

    var ss = SpreadsheetApp.openById(props.getProperty('SHEET_ID'));
    return json_({
      ok: true,
      content: {
        announcements: readRows_(ss, 'Announcements'),
        trade_reviews: readRows_(ss, 'TradeReviews'),
        prop_firms: readRows_(ss, 'PropFirms'),
      },
    });
  } catch (err) {
    console.error('content bridge error class: ' + (err && err.name));
    return json_({ ok: false, error: 'internal error' }, 500);
  }
}

function doGet() {
  return json_({ ok: false, error: 'POST only' });
}

// Reads one tab into array of objects keyed by header names. Empty rows and
// rows without an id are dropped; hard cap protects against runaway sheets.
function readRows_(ss, tabName) {
  var sheet = ss.getSheetByName(tabName);
  if (!sheet) return [];
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  var header = values[0].map(function (h) {
    return String(h).trim().toLowerCase().replace(/\s+/g, '_');
  });
  var rows = [];
  for (var i = 1; i < values.length && rows.length < MAX_ROWS; i++) {
    var obj = {};
    var hasId = false;
    for (var c = 0; c < header.length; c++) {
      if (!header[c]) continue;
      var val = values[i][c];
      if (val instanceof Date) {
        val = Utilities.formatDate(val, 'America/New_York', 'yyyy-MM-dd');
      }
      obj[header[c]] = val === null || val === undefined ? '' : String(val);
      if (header[c] === 'id' && obj.id) hasId = true;
    }
    if (hasId) rows.push(obj);
  }
  return rows;
}

// ─── Auth (identical scheme to member-sync) ────────────────────────────────

function verifyMac_(secret, body) {
  var ts = Number(body.timestamp);
  if (!isFinite(ts) || Math.abs(Date.now() - ts) > REPLAY_WINDOW_MS) return false;

  var nonce = String(body.nonce || '');
  if (!nonce || nonce.length > 64) return false;

  var cache = CacheService.getScriptCache();
  if (cache.get('nonce:' + nonce)) return false;

  var expected = computeMac_(secret, ts, nonce, String(body.payload || ''));
  if (!safeEqualHex_(expected, String(body.mac || ''))) return false;

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
  if (raw.length > 65536) return null;
  try { return JSON.parse(raw); } catch (err) { return null; }
}

function json_(obj, status) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
