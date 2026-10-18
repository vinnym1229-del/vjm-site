// Incident: stock-lab.html's symbol-switching tools (loadNews()'s headline
// fetch and runBasicResearch()'s quote fetch) had no request-sequencing
// guard, the same bug class already fixed in index.html's checkStatus() --
// see tests/status-checker-race.test.mjs -- and its sibling ask() in
// assets/chatbot.js. A visitor can click through several "quick" ticker
// buttons, or a watchlist "Analyze" row, faster than the underlying
// /api/stock-research or /api/yahoo-news fetch resolves. With no guard,
// whichever fetch happened to land last controlled the screen, which is not
// necessarily the ticker the visitor is currently looking at: select NVDA,
// then quickly select AVGO, and if NVDA's response lands after AVGO's, the
// page shows AVGO's chart title next to NVDA's stale quote and headlines.
//
// Fixed with the same monotonically increasing per-call sequence counter:
// each function captures its own request id before the fetch and discards
// the result if a newer call has already started by the time it resolves.
// This drives the real loadNews()/runBasicResearch() (extracted verbatim
// from the shipped inline script, the same brace-depth-scan technique
// tests/stock-lab-calculators.test.mjs uses) with two fetches resolved
// deliberately out of order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const stockLab = readFileSync(join(ROOT, 'stock-lab.html'), 'utf8');

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

const elSrc = 'const el=id=>document.getElementById(id);';
const escSrc = extractFunction(stockLab, 'esc');
const tvSymbolsSrc = extractConst(stockLab, 'TV_SYMBOLS', '{', '}');
const baseTickerSrc = extractFunction(stockLab, 'baseTicker');
const normalizeSymbolSrc = extractFunction(stockLab, 'normalizeSymbol');
const tvUrlSrc = extractFunction(stockLab, 'tvUrl');
const newsUrlForSrc = extractFunction(stockLab, 'newsUrlFor');
const fmtSrc = extractFunction(stockLab, 'fmt');
const pctSrc = extractFunction(stockLab, 'pct');
const statusSrc = extractFunction(stockLab, 'status');
const relTimeSrc = extractFunction(stockLab, 'relTime');
const safeHttpUrlSrc = extractFunction(stockLab, 'safeHttpUrl');
const renderNewsItemsSrc = extractFunction(stockLab, 'renderNewsItems');
// setYahooNewsLink is a one-liner sharing its source line with several other
// declarations, so pull it out directly rather than via extractFunction.
const setYahooNewsLinkMatch = /function setYahooNewsLink\(symbol\)\{[^}]*\}/.exec(stockLab);
assert.ok(setYahooNewsLinkMatch, 'setYahooNewsLink no longer defined the expected way in stock-lab.html');
const setYahooNewsLinkSrc = setYahooNewsLinkMatch[0];
// extractFunction's marker starts at "function", so it drops the "async "
// keyword that precedes these two declarations; put it back.
const loadNewsSrc = 'async ' + extractFunction(stockLab, 'loadNews');
const runBasicResearchSrc = 'async ' + extractFunction(stockLab, 'runBasicResearch');

function makeSandbox(extraGlobals = {}) {
  const els = {};
  const el = (id) => (els[id] ||= { value: '0', innerHTML: '', href: '', textContent: '', style: {} });
  const sandbox = {
    document: { getElementById: el },
    currentSymbol: 'NASDAQ:NVDA',
    newsSeq: 0,
    basicSeq: 0,
    ...extraGlobals,
  };
  vm.createContext(sandbox);
  return { sandbox, els, el };
}

// Returns a fetch stub plus a map keyed by the request's own `symbol=` query
// param, so the test can settle each in-flight request in whatever order it
// chooses -- the exact ordering a slow backend path or a cold cache can
// produce.
function makeControllableFetch() {
  const pending = {};
  const fetch = (url) => {
    const symbol = decodeURIComponent(/symbol=([^&]+)/.exec(url)[1]);
    return new Promise((resolve) => { pending[symbol] = resolve; });
  };
  const settle = (symbol, body) => {
    pending[symbol]({ ok: true, json: async () => body });
  };
  return { fetch, settle };
}

test('loadNews() ignores a stale headline response that resolves after a newer symbol has been requested', async () => {
  const { sandbox, els } = makeSandbox();
  const { fetch, settle } = makeControllableFetch();
  sandbox.fetch = fetch;
  vm.runInContext(
    [elSrc, escSrc, tvSymbolsSrc, baseTickerSrc, normalizeSymbolSrc, newsUrlForSrc, relTimeSrc,
      safeHttpUrlSrc, renderNewsItemsSrc, statusSrc, setYahooNewsLinkSrc, loadNewsSrc,
      'this.loadNews = loadNews;'].join('\n'),
    sandbox
  );

  const firstCall = sandbox.loadNews('NVDA'); // request for NVDA in flight
  const secondCall = sandbox.loadNews('AVGO'); // AVGO requested before NVDA resolves

  // Resolve the OLDER request (NVDA) after the newer one (AVGO) -- the stale
  // response must lose even though it lands last.
  settle('AVGO', { ok: true, items: [{ title: 'AVGO headline' }] });
  await secondCall;
  settle('NVDA', { ok: true, items: [{ title: 'NVDA headline' }] });
  await firstCall;

  assert.match(els.marketNewsReel.innerHTML, /AVGO headline/,
    'the stale NVDA response must not overwrite the newer AVGO headlines');
  assert.doesNotMatch(els.marketNewsReel.innerHTML, /NVDA headline/);
});

test('loadNews() still renders a response that resolves in request order', async () => {
  const { sandbox, els } = makeSandbox();
  const { fetch, settle } = makeControllableFetch();
  sandbox.fetch = fetch;
  vm.runInContext(
    [elSrc, escSrc, tvSymbolsSrc, baseTickerSrc, normalizeSymbolSrc, newsUrlForSrc, relTimeSrc,
      safeHttpUrlSrc, renderNewsItemsSrc, statusSrc, setYahooNewsLinkSrc, loadNewsSrc,
      'this.loadNews = loadNews;'].join('\n'),
    sandbox
  );

  const call = sandbox.loadNews('TSM');
  settle('TSM', { ok: true, items: [{ title: 'TSM headline' }] });
  await call;

  assert.match(els.marketNewsReel.innerHTML, /TSM headline/);
});

test('runBasicResearch() ignores a stale quote response that resolves after a newer symbol has been requested', async () => {
  const { sandbox, els, el } = makeSandbox({
    loadTradingView() {},
    buildSourceLinks() {},
    loadNews() {},
  });
  const { fetch, settle } = makeControllableFetch();
  sandbox.fetch = fetch;
  vm.runInContext(
    [elSrc, escSrc, tvSymbolsSrc, baseTickerSrc, normalizeSymbolSrc, tvUrlSrc, fmtSrc, pctSrc,
      statusSrc, runBasicResearchSrc, 'this.runBasicResearch = runBasicResearch;'].join('\n'),
    sandbox
  );

  el('symbolInput').value = 'NVDA';
  const firstCall = sandbox.runBasicResearch(); // NVDA's quote fetch in flight

  el('symbolInput').value = 'AVGO';
  const secondCall = sandbox.runBasicResearch(); // AVGO requested before NVDA resolves

  settle('AVGO', { quote: { price: 200, change: 1, changePercent: 0.5, marketCap: 1, volume: 1 } });
  await secondCall;
  settle('NVDA', { quote: { price: 900, change: -1, changePercent: -0.1, marketCap: 1, volume: 1 } });
  await firstCall;

  assert.match(els.basicReport.innerHTML, /\$200/,
    'the stale NVDA response must not overwrite the newer AVGO quote');
  assert.doesNotMatch(els.basicReport.innerHTML, /\$900/);
});

test('runBasicResearch() still renders a response that resolves in request order', async () => {
  const { sandbox, els, el } = makeSandbox({
    loadTradingView() {},
    buildSourceLinks() {},
    loadNews() {},
  });
  const { fetch, settle } = makeControllableFetch();
  sandbox.fetch = fetch;
  vm.runInContext(
    [elSrc, escSrc, tvSymbolsSrc, baseTickerSrc, normalizeSymbolSrc, tvUrlSrc, fmtSrc, pctSrc,
      statusSrc, runBasicResearchSrc, 'this.runBasicResearch = runBasicResearch;'].join('\n'),
    sandbox
  );

  el('symbolInput').value = 'TSM';
  const call = sandbox.runBasicResearch();
  settle('TSM', { quote: { price: 150, change: 1, changePercent: 1, marketCap: 1, volume: 1 } });
  await call;

  assert.match(els.basicReport.innerHTML, /\$150/);
});
