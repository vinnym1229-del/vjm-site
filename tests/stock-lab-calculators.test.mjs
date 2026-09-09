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
