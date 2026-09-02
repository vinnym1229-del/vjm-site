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
 *   Schedule:      id | day | session | time_et | host | note | active
 *   Team:          id | name | role | bio | photo_url | socials | order
 *   Faqs:          id | question | answer | order
 *   Bundles:       id | name | price | period | save_badge | features |
 *                  whop_url | highlight
 *   Stats:         id | key | value | label
 *   Results:       id | image_url | caption | order
 *
 * SETUP — run setUp() once, then deploy.
 *
 *   1. Paste this file into the Apps Script editor attached to your content
 *      spreadsheet (Extensions -> Apps Script).
 *   2. Pick `setUp` in the function dropdown and press Run. Approve the
 *      permission prompt. It creates every missing tab with the correct
 *      headers, generates the shared secret, records the spreadsheet id, and
 *      prints exactly what to paste into Cloudflare. Running it again is safe:
 *      it never overwrites a tab, a row, or an existing secret.
 *   3. Deploy -> New deployment -> Web app, Execute as **Me**, access
 *      **Anyone**. (Access "Anyone" is safe here: every request still has to
 *      carry a valid HMAC, and an unsigned one gets 401.)
 *   4. Put the /exec URL into the Cloudflare variable CONTENT_BRIDGE_URL, and
 *      the secret setUp() printed into CONTENT_BRIDGE_SECRET.
 *
 * The nine tabs used to have to be created by hand, with about forty column
 * names spelled exactly right, before anything could be tested — which is the
 * step this setup has always actually failed at. setUp() does that part.
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

    var ss = openSheet_(props);
    return json_({
      ok: true,
      content: {
        announcements: readRows_(ss, 'Announcements'),
        trade_reviews: readRows_(ss, 'TradeReviews'),
        prop_firms: readRows_(ss, 'PropFirms'),
        schedule: readRows_(ss, 'Schedule'),
        team: readRows_(ss, 'Team'),
        faqs: readRows_(ss, 'Faqs'),
        bundles: readRows_(ss, 'Bundles'),
        stats: readRows_(ss, 'Stats'),
        results: readRows_(ss, 'Results'),
      },
    });
  } catch (err) {
    console.error('content bridge error class: ' + (err && err.name));
    return json_({ ok: false, error: 'internal error' }, 500);
  }
}

// Opening the /exec URL in a browser answers this. It exists so the owner can
// confirm they copied the right URL — the single most common setup mistake —
// without needing to sign a request. Deliberately says NOTHING about the
// spreadsheet: no tab names, no row counts, no content. Anyone can reach it.
function doGet() {
  return json_({ ok: true, service: 'content-bridge', method: 'POST' });
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

// ─── Tab definitions ───────────────────────────────────────────────────────
// The single source of truth for what a tab is called and what its columns
// are. doPost reads whatever headers it finds, so this drives setUp() only —
// but keeping it beside the reader is what stops the two drifting.

var TABS = [
  ['Announcements', ['id', 'title', 'body', 'link', 'pinned', 'created_at']],
  ['TradeReviews', ['id', 'ticker', 'direction', 'result', 'r_multiple', 'notes', 'image_url', 'traded_at']],
  ['PropFirms', ['id', 'name', 'url', 'code', 'discount', 'image_url', 'notes', 'active']],
  ['Schedule', ['id', 'day', 'session', 'time_et', 'host', 'note', 'active']],
  ['Team', ['id', 'name', 'role', 'bio', 'photo_url', 'socials', 'order']],
  ['Faqs', ['id', 'question', 'answer', 'order']],
  ['Bundles', ['id', 'name', 'price', 'period', 'save_badge', 'features', 'whop_url', 'highlight']],
  ['Stats', ['id', 'key', 'value', 'label']],
  ['Results', ['id', 'image_url', 'caption', 'order']]
];

// The schedule the website currently ships hard-coded, so the first sync does
// not blank the page or quietly disagree with it. Copied from index.html's
// week grid; a blank host is how an off slot is expressed (Monday 2:30), and
// it renders struck through rather than disappearing.
var SCHEDULE_SEED = [
    ['s1', 'Mon', 'NYAM', '9:30 AM ET', 'Live trading with Caleb & Fin', ''],
    ['s2', 'Mon', 'NYPM', '2:30 PM ET', '', 'No live trading'],
    ['s3', 'Mon', 'ASIA', '8:00 PM ET', 'Live trading with Caleb & Fin', ''],
    ['s4', 'Tue', 'NYAM', '9:30 AM ET', 'Live trading with PJTrades', ''],
    ['s5', 'Tue', 'NYPM', '2:30 PM ET', 'Order flow session with Gainz', ''],
    ['s6', 'Tue', 'CLASS', '5:30 PM ET', 'Night class with Caleb', ''],
    ['s7', 'Tue', 'ASIA', '8:00 PM ET', 'Live trading with Caleb & Fin', ''],
    ['s8', 'Wed', 'NYAM', '9:30 AM ET', 'Live trading with PJTrades', ''],
    ['s9', 'Wed', 'NYPM', '2:30 PM ET', 'Live trading with KWT & Gainz', ''],
    ['s10', 'Wed', 'ASIA', '8:00 PM ET', 'Live trading with Caleb & Fin', ''],
    ['s11', 'Thu', 'NYAM', '9:30 AM ET', 'Live trading with PJTrades', ''],
    ['s12', 'Thu', 'NYPM', '2:30 PM ET', 'Live trading with KWT', ''],
    ['s13', 'Thu', 'CLASS', '5:30 PM ET', 'Night class with Caleb', ''],
    ['s14', 'Thu', 'ASIA', '8:00 PM ET', 'Live trading with Caleb & Fin', ''],
    ['s15', 'Fri', 'NYAM', '9:30 AM ET', 'Live trading with PJTrades', ''],
    ['s16', 'Fri', 'NYPM', '2:30 PM ET', 'Live trading with KWT & Gainz', ''],
];

/**
 * Run this once from the editor. Safe to re-run: it never overwrites a tab
 * that exists, a row that has content, or a secret that is already set.
 */
function setUp() {
  var props = PropertiesService.getScriptProperties();
  var ss = openSheet_(props);
  var log = [];

  // Record which spreadsheet this is, so doPost works whether the script is
  // bound to the sheet or standalone.
  if (!props.getProperty('SHEET_ID')) {
    props.setProperty('SHEET_ID', ss.getId());
    log.push('Recorded SHEET_ID = ' + ss.getId());
  }

  for (var i = 0; i < TABS.length; i++) {
    var name = TABS[i][0];
    var headers = TABS[i][1];
    var sheet = ss.getSheetByName(name);

    // A sheet imported from CSV is named after the FILE, not the tab, so a
    // correctly-filled Schedule can sit there under the wrong name and the
    // bridge will never find it. If some sheet's header row is an exact match
    // for a tab we are about to create, adopt it instead of creating an empty
    // duplicate beside it. Exact-match only, and only when the target name is
    // free, so this can never rename a sheet out from under real content.
    if (!sheet) {
      var adopted = findSheetByHeaders_(ss, headers);
      if (adopted) {
        log.push('Renamed "' + adopted.getName() + '" to "' + name + '" (its columns already matched)');
        adopted.setName(name);
        sheet = adopted;
      }
    }

    if (!sheet) {
      sheet = ss.insertSheet(name);
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
      sheet.setFrozenRows(1);
      log.push('Created tab "' + name + '" with headers: ' + headers.join(', '));
    } else if (sheet.getLastRow() === 0) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
      sheet.setFrozenRows(1);
      log.push('Added headers to empty tab "' + name + '"');
    } else {
      // Never rewrite a header row that already exists — the owner may have
      // added columns, and doPost reads by header name so extras are harmless.
      log.push('Tab "' + name + '" already exists, left untouched');
    }
  }

  // Seed the schedule only when it is empty, so re-running never clobbers an
  // edit and turning the sync on does not change what the page shows.
  var sched = ss.getSheetByName('Schedule');
  if (sched && sched.getLastRow() <= 1) {
    sched.getRange(2, 1, SCHEDULE_SEED.length, SCHEDULE_SEED[0].length).setValues(SCHEDULE_SEED);
    log.push('Seeded Schedule with the ' + SCHEDULE_SEED.length + ' rows the site currently shows');
  }

  var secret = props.getProperty('CONTENT_BRIDGE_SECRET');
  if (!secret) {
    secret = randomSecret_();
    props.setProperty('CONTENT_BRIDGE_SECRET', secret);
    log.push('Generated a new CONTENT_BRIDGE_SECRET');
  } else {
    log.push('CONTENT_BRIDGE_SECRET already set, kept as is');
  }

  var out = log.join('\n')
    + '\n\nNEXT — Deploy > New deployment > Web app'
    + '\n  Execute as: Me      Who has access: Anyone'
    + '\n(An unsigned request still gets 401; the HMAC is the real gate.)'
    + '\n\nTHEN in Cloudflare Pages > Settings > Variables:'
    + '\n  CONTENT_BRIDGE_URL    = the /exec URL from that deployment'
    + '\n  CONTENT_BRIDGE_SECRET = ' + secret
    + '\n\nKeep that secret out of screenshots and chat. To rotate it, clear the'
    + '\nscript property, run setUp() again, and update Cloudflare in the same'
    + '\nsitting — the sync fails closed while the two disagree.';
  Logger.log(out);
  return out;
}

/**
 * Run from the editor to see what the bridge would actually read. Reports
 * counts only, never content, and never leaves the editor log.
 */
function healthCheck() {
  var ss = openSheet_(PropertiesService.getScriptProperties());
  var lines = ['Spreadsheet: ' + ss.getName()];
  for (var i = 0; i < TABS.length; i++) {
    var name = TABS[i][0];
    var rows = readRows_(ss, name);
    var sheet = ss.getSheetByName(name);
    lines.push(
      name + ': ' + (sheet ? rows.length + ' usable row(s)' : 'TAB MISSING — run setUp()')
      + (sheet && sheet.getLastRow() > 1 && rows.length === 0
        ? '  (rows present but none has an id — the id column cannot be blank)' : '')
    );
  }
  var out = lines.join('\n');
  Logger.log(out);
  return out;
}

// The sheet whose first row is exactly these headers, if there is one and only
// one. Returns null on no match or on ambiguity — renaming the wrong sheet is
// far worse than making the owner rename one by hand.
function findSheetByHeaders_(ss, headers) {
  var sheets = ss.getSheets();
  var found = null;
  for (var i = 0; i < sheets.length; i++) {
    if (sheets[i].getLastRow() < 1 || sheets[i].getLastColumn() < headers.length) continue;
    var row = sheets[i].getRange(1, 1, 1, headers.length).getValues()[0];
    var same = true;
    for (var c = 0; c < headers.length; c++) {
      if (String(row[c]).trim().toLowerCase().replace(/\s+/g, '_') !== headers[c]) { same = false; break; }
    }
    if (!same) continue;
    if (found) return null;                    // ambiguous: leave both alone
    found = sheets[i];
  }
  return found;
}

// Bound scripts can find their own spreadsheet; standalone ones need SHEET_ID.
// Trying the binding first is what lets setUp() run before anything is set.
function openSheet_(props) {
  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;
  var id = props.getProperty('SHEET_ID');
  if (!id) throw new Error('SHEET_ID is not set and this script is not bound to a spreadsheet.');
  return SpreadsheetApp.openById(id);
}

// Apps Script has no crypto.getRandomValues, and Math.random() is NOT a
// cryptographic source — it is seeded and predictable, which for the one value
// standing between a public /exec URL and the sheet is not good enough.
// Utilities.getUuid() is a v4 UUID from a secure source: ~122 random bits
// each. Three of them, hashed together, give a 256-bit key from ~366 bits of
// real entropy, and the hash means no structural UUID bits survive into the
// output.
function randomSecret_() {
  var material = Utilities.getUuid() + Utilities.getUuid() + Utilities.getUuid();
  var raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, material);
  var out = '';
  for (var i = 0; i < raw.length; i++) {
    var v = (raw[i] < 0 ? raw[i] + 256 : raw[i]).toString(16);
    out += v.length === 1 ? '0' + v : v;
  }
  return out;
}
