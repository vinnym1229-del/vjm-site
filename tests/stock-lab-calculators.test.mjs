// stock-lab.html's free-tier risk/Fib calculators — real trader math, never
// executed by any test until now. The site's other math tools (index.html's
// calcFutures/calcPropRisk/calcSizingSim in tests/pj-futures.test.mjs) each
// got dedicated executed-math tests after a real per-point regression shipped
// undetected on YM; these two calculators sit in the exact same spot (a free
// tool, real money math, only grepped for static markup) and were missed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const stockLab = readFileSync(join(ROOT, 'stock-lab.html'), 'utf8');

// stock-lab.html's inline script is minified onto a handful of long lines, so
// a function body can't be pulled out with a "up to the next }" regex the way
// tests/pj-futures.test.mjs does for index.html's spaced-out script — nested
// braces (calcFib's levels.map(l=>{...}) callback, fmt's toLocaleString
// options object) would cut it short. Scan brace depth instead, the same
// approach tests/chatbot-lesson-picker.test.mjs uses to pull chatbot.js's IIFE
// out of its own single-line source.
function extractFunction(source, name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start > -1, `${name} no longer defined in stock-lab.html`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces extracting ${name} from stock-lab.html`);
}

const safeSrc = extractFunction(stockLab, 'safe');
const fmtSrc = extractFunction(stockLab, 'fmt');
const calcRiskSrc = extractFunction(stockLab, 'calcRisk');
const calcFibSrc = extractFunction(stockLab, 'calcFib');
// calcRisk/calcFib both call the page's `el` shorthand for
// document.getElementById, not the DOM method directly.
const elAlias = /const el=id=>document\.getElementById\(id\);/.exec(stockLab);
assert.ok(elAlias, 'el shorthand no longer defined the expected way in stock-lab.html');
const elSrc = elAlias[0];

// Same brace-depth scan, but for a `const NAME=[...]`/`const NAME={...}`
// literal rather than a function body.
function extractConst(source, name, open, close) {
  const marker = `const ${name}=${open}`;
  const start = source.indexOf(marker);
  assert.ok(start > -1, `${name} no longer defined in stock-lab.html`);
  let depth = 0;
  for (let i = start + marker.length - 1; i < source.length; i++) {
    if (source[i] === open) depth++;
    else if (source[i] === close) {
      depth--;
      if (depth === 0) return source.slice(start, i + 1) + ';';
    }
  }
  throw new Error(`unbalanced braces extracting ${name} from stock-lab.html`);
}

const escSrc = extractFunction(stockLab, 'esc');
const pctSrc = extractFunction(stockLab, 'pct');
const baseTickerSrc = extractFunction(stockLab, 'baseTicker');
const normalizeSymbolSrc = extractFunction(stockLab, 'normalizeSymbol');
const findStockSrc = extractFunction(stockLab, 'findStock');
// extractFunction's marker starts at "function", so it drops the "async "
// keyword that precedes runPremiumResearch's own declaration; put it back.
const runPremiumResearchSrc = 'async ' + extractFunction(stockLab, 'runPremiumResearch');
const tvSymbolsSrc = extractConst(stockLab, 'TV_SYMBOLS', '{', '}');
const watchlistSrc = extractConst(stockLab, 'WATCHLIST', '[', ']');

// Sandbox with everything runPremiumResearch actually touches: the DOM via
// `el`, a mocked `fetch`, and its own call chain (normalizeSymbol ->
// baseTicker -> TV_SYMBOLS, findStock -> WATCHLIST, esc/fmt/pct). buildSourceLinks
// is stubbed out -- it only populates a separate "more sources" link list,
// unrelated to the premiumReport panel this test is checking.
function makePremiumResearchSandbox(fetchImpl) {
  const els = {};
  const el = (id) => (els[id] ||= { value: '0', innerHTML: '' });
  const sandbox = {
    document: { getElementById: el },
    fetch: fetchImpl,
    buildSourceLinks() {},
    premiumSeq: 0,
  };
  vm.createContext(sandbox);
  vm.runInContext(
    [elSrc, escSrc, fmtSrc, pctSrc, tvSymbolsSrc, baseTickerSrc, normalizeSymbolSrc,
      watchlistSrc, findStockSrc, runPremiumResearchSrc,
      'this.runPremiumResearch = runPremiumResearch;'].join('\n'),
    sandbox
  );
  return { sandbox, els, el };
}

function makeSandbox() {
  const els = {};
  const el = (id) => (els[id] ||= { value: '0', innerHTML: '' });
  const sandbox = { document: { getElementById: el } };
  vm.createContext(sandbox);
  return { sandbox, els, el };
}

test('calcRisk: max risk, risk/share, and share count from the page\'s own defaults', () => {
  const { sandbox, els, el } = makeSandbox();
  vm.runInContext(
    safeSrc + '\n' + elSrc + '\n' + fmtSrc + '\n' + calcRiskSrc + '\nthis.calcRisk = calcRisk;',
    sandbox
  );

  // Page defaults: $10,000 account, 1% risk, entry $100, stop $95.
  // Max risk = 10000*0.01 = $100. Risk/share = |100-95| = $5.
  // Shares = floor(100/5) = 20, not ceil'd or left fractional.
  el('accountSize').value = '10000';
  el('riskPct').value = '1';
  el('entryPrice').value = '100';
  el('stopPrice').value = '95';
  sandbox.calcRisk();
  assert.equal(els.riskResult.innerHTML, 'Max risk: $100 · Risk/share: $5 · Approx shares: 20');
});

test('calcRisk: an entry equal to the stop must not divide by zero', () => {
  const { sandbox, els, el } = makeSandbox();
  vm.runInContext(
    safeSrc + '\n' + elSrc + '\n' + fmtSrc + '\n' + calcRiskSrc + '\nthis.calcRisk = calcRisk;',
    sandbox
  );

  // A trader who hasn't set a stop yet (entry === stop) must see 0 shares,
  // not Infinity/NaN from a riskDollars/0 division.
  el('accountSize').value = '10000';
  el('riskPct').value = '1';
  el('entryPrice').value = '100';
  el('stopPrice').value = '100';
  sandbox.calcRisk();
  assert.equal(els.riskResult.innerHTML, 'Max risk: $100 · Risk/share: $0 · Approx shares: 0');
});

test('calcRisk: a budget that does not divide evenly floors the share count, never rounds up', () => {
  const { sandbox, els, el } = makeSandbox();
  vm.runInContext(
    safeSrc + '\n' + elSrc + '\n' + fmtSrc + '\n' + calcRiskSrc + '\nthis.calcRisk = calcRisk;',
    sandbox
  );

  // $100 max risk, $6/share (entry $100, stop $94): 100/6 = 16.67, which
  // must floor to 16 shares. A Math.ceil() here would tell a trader to buy
  // one more share than their risk budget actually allows.
  el('accountSize').value = '10000';
  el('riskPct').value = '1';
  el('entryPrice').value = '100';
  el('stopPrice').value = '94';
  sandbox.calcRisk();
  assert.equal(els.riskResult.innerHTML, 'Max risk: $100 · Risk/share: $6 · Approx shares: 16');
});

// #riskPct carries no min attribute and calcRisk() reruns on every input
// event, so nothing stops a directly typed negative risk % from reaching the
// math -- the same "no guard on a directly-typed value" pattern already
// fixed on stock-breakdown.html's Position-Size & Risk Calculator. Before
// this fix, a negative risk % drove riskDollars negative and Math.floor of a
// negative budget over a positive risk/share produced a negative share
// count ("Approx shares: -20"), which is nonsensical -- you cannot buy a
// negative number of shares. riskDollars is floored at 0 so the correct
// result is 0 shares, not a fabricated or negative one.
test('calcRisk: a negative risk % floors at $0 risk and 0 shares, never negative', () => {
  const { sandbox, els, el } = makeSandbox();
  vm.runInContext(
    safeSrc + '\n' + elSrc + '\n' + fmtSrc + '\n' + calcRiskSrc + '\nthis.calcRisk = calcRisk;',
    sandbox
  );

  el('accountSize').value = '10000';
  el('riskPct').value = '-1';
  el('entryPrice').value = '100';
  el('stopPrice').value = '95';
  sandbox.calcRisk();
  assert.equal(els.riskResult.innerHTML, 'Max risk: $0 · Risk/share: $5 · Approx shares: 0');
});

test('calcFib: retracement runs from the swing high down to the swing low, not inverted', () => {
  const { sandbox, els, el } = makeSandbox();
  sandbox.selectedFibZone = '0.382-0.618';
  vm.runInContext(
    safeSrc + '\n' + elSrc + '\n' + fmtSrc + '\n' + calcFibSrc + '\nthis.calcFib = calcFib;',
    sandbox
  );

  // Page defaults: swing high $150, swing low $100. The 0% level is the
  // swing high and 100% is the swing low — a top/bottom swap here would
  // run every level backwards without changing any test that only checks
  // the levels array length or percentage labels.
  el('fibHigh').value = '150';
  el('fibLow').value = '100';
  sandbox.calcFib();
  const html = els.fibLevels.innerHTML;
  assert.match(html, /0%<\/strong><div class="bar"><\/div><span>\$150<\/span>/, '0% level must sit at the swing high');
  assert.match(html, /100%<\/strong><div class="bar"><\/div><span>\$100<\/span>/, '100% level must sit at the swing low');
  // 50% is inside the selected 38.2-61.8 zone and must render at $125 with
  // the in-zone (red) border, while 0% is outside the zone.
  assert.match(html, /border-color:rgba\(209,67,67,\.45\)"><strong style="color:var\(--red\)">50\.0%<\/strong><div class="bar"><\/div><span>\$125<\/span>/);
  assert.match(html, /border-color:rgba\(255,255,255,\.07\)"><strong style="color:var\(--muted\)">0%/);
});

test('fmt: a negative value puts the minus sign before the currency prefix, not after it', () => {
  const { sandbox } = makeSandbox();
  vm.runInContext(fmtSrc + '\nthis.fmt = fmt;', sandbox);
  const fmt = sandbox.fmt;

  // runBasicResearch()/runPremiumResearch() both render a stock's dollar
  // change as `fmt(q.change,'$')`, and `change` is `price - prevClose` from
  // the API (functions/api/stock-research.js / premium-stock-research.js) --
  // a perfectly ordinary negative number on any down day. The old
  // `prefix+n.toLocaleString(...)` put the prefix before the number's own
  // sign, rendering a stock down $2.50 as "$-2.5" instead of "-$2.5" --
  // every member checking any declining ticker, on the free tier or the
  // premium one, saw the malformed sign on the single most-read number on
  // the page. options-lab.html's and futures-dissection.html's own
  // `fmtUsd(n)` already special-case `n<0` for exactly this reason; this
  // file's shared `fmt()` had silently drifted out of sync with that fix.
  assert.equal(fmt(-2.5, '$'), '-$2.5', 'a negative dollar amount must read "-$2.5", not "$-2.5"');
  assert.equal(fmt(2.5, '$'), '$2.5', 'a positive amount must be unaffected');
  assert.equal(fmt(0, '$'), '$0', 'zero must be unaffected');
  assert.equal(fmt(-50), '-50', 'a negative value with no prefix must be unaffected');
});

test('calcFib: swing high/low entered backwards still runs high-to-low, not negative', () => {
  const { sandbox, els, el } = makeSandbox();
  sandbox.selectedFibZone = '0.382-0.618';
  vm.runInContext(
    safeSrc + '\n' + elSrc + '\n' + fmtSrc + '\n' + calcFibSrc + '\nthis.calcFib = calcFib;',
    sandbox
  );

  // A trader can type the low into the "Swing high" field and vice versa;
  // the function's own Math.max/Math.min must normalize it back to the same
  // result as entering them the right way round, not run range negative.
  el('fibHigh').value = '100';
  el('fibLow').value = '150';
  sandbox.calcFib();
  const html = els.fibLevels.innerHTML;
  assert.match(html, /0%<\/strong><div class="bar"><\/div><span>\$150<\/span>/, 'swapped inputs must still put 0% at the higher price');
  assert.match(html, /100%<\/strong><div class="bar"><\/div><span>\$100<\/span>/, 'swapped inputs must still put 100% at the lower price');
});

// functions/api/premium-stock-research.js's own success response (pinned by
// tests/premium-stock-research-api.test.mjs) never sends a `memo` field --
// its handler comment says so explicitly: "Owner memos stay client-side;
// this endpoint only serves sourced market data." It also sends `source` as
// an OBJECT ({name,feed}), not a string. Before this fix, runPremiumResearch
// rendered every ticker's "premium checklist" with the exact same generic
// placeholder text ("Research required"/"Verify"/"Manual verification
// first") and stringified the whole source object into the literal text
// "[object Object]" -- a paying Trifecta member analyzing any stock on this
// page never saw the stock-specific research (why/catalyst/avoid/status)
// that was sitting right there in the page's own WATCHLIST data the whole
// time, because selectStock() never passed it through.
test('runPremiumResearch: a watchlist symbol renders its own why/catalyst/avoid/status, not generic placeholder text', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      ok: true,
      quote: { price: 180.5, change: 2.1, changePercent: 1.18, marketCap: null },
      source: { name: 'Alpaca Market Data (IEX)', feed: 'IEX' },
    }),
  });
  const { sandbox, els } = makePremiumResearchSandbox(fetchImpl);

  await sandbox.runPremiumResearch('NVDA');
  const html = els.premiumReport.innerHTML;

  // Real per-stock copy from WATCHLIST, not the generic fallback strings.
  assert.match(html, /AI chip leader with massive institutional attention\./, 'Theme must use the watchlist record\'s own "why", not "Research required"');
  assert.match(html, /Avoid chasing after vertical moves/, 'Risk must surface the watchlist record\'s own "avoid" note, not "Verify"');
  assert.match(html, /Wait for Pullback/, 'Status must match the same status shown in the free watchlist table, not "Manual verification first"');
  assert.doesNotMatch(html, /Research required|Manual verification first/, 'must not fall back to generic placeholder text when a watchlist record exists');

  // The source line must read the API's real source name, never stringify
  // the whole {name,feed} object.
  assert.match(html, /Source: Alpaca Market Data \(IEX\)/, 'source must render its "name" field');
  assert.doesNotMatch(html, /\[object Object\]/, 'must never render a stringified source object');
});

// A manually-typed ticker with no WATCHLIST entry has no real per-stock
// research to show, so the generic placeholder text is the correct,
// non-fabricated fallback here -- this must keep working exactly as before.
// Incident: runPremiumResearch had the same stale-response race already
// fixed in index.html's checkStatus() (tests/status-checker-race.test.mjs)
// and in this page's own loadNews()/runBasicResearch() (tests/stock-lab-
// symbol-race.test.mjs) -- selectStock() fires it on every watchlist
// "Analyze" click, so clicking a second row before the first row's
// /api/premium-stock-research fetch resolves could let the first (now
// stale) response land after the second's and overwrite a paying Trifecta
// member's premiumReport panel with the wrong stock's research. Fixed with
// the same per-call sequence counter: discard a response once a newer call
// has started.
test('runPremiumResearch: ignores a stale response that resolves after a newer symbol has been requested', async () => {
  const pending = {};
  const fetchImpl = (url) => {
    const symbol = decodeURIComponent(/symbol=([^&]+)/.exec(url)[1]);
    return new Promise((resolve) => { pending[symbol] = resolve; });
  };
  const settle = (symbol, quote) => pending[symbol]({
    ok: true,
    json: async () => ({ ok: true, quote, source: { name: 'Alpaca Market Data (IEX)' } }),
  });
  const { sandbox, els } = makePremiumResearchSandbox(fetchImpl);

  const firstCall = sandbox.runPremiumResearch('NVDA'); // NVDA in flight
  const secondCall = sandbox.runPremiumResearch('AVGO'); // AVGO requested before NVDA resolves

  // Resolve the OLDER request (NVDA) after the newer one (AVGO).
  settle('AVGO', { price: 200, change: 1, changePercent: 0.5, marketCap: null });
  await secondCall;
  settle('NVDA', { price: 900, change: -1, changePercent: -0.1, marketCap: null });
  await firstCall;

  assert.match(els.premiumReport.innerHTML, /\$200/, 'the stale NVDA response must not overwrite the newer AVGO quote');
  assert.doesNotMatch(els.premiumReport.innerHTML, /\$900/);
});

test('runPremiumResearch: a ticker with no watchlist record still falls back to the generic placeholder text', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      ok: true,
      quote: { price: 10, change: 0.1, changePercent: 1, marketCap: null },
      source: { name: 'Alpaca Market Data (IEX)', feed: 'IEX' },
    }),
  });
  const { sandbox, els } = makePremiumResearchSandbox(fetchImpl);

  await sandbox.runPremiumResearch('ZZZZ');
  const html = els.premiumReport.innerHTML;
  assert.match(html, /Research required/);
  assert.match(html, /Manual verification first/);
  assert.match(html, /Verify trend, earnings, news, fundamentals, and invalidation\./);
});
