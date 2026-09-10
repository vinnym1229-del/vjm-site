// The curriculum-page tools (options-lab.html's Option Payoff Diagram,
// stock-breakdown.html's Position-Size & Risk Calculator, and
// psychology-enhancer.html's Expectancy & R-Multiple Calculator) are real
// trader math a paying member relies on before sizing a position, yet none
// of them was ever executed by a test -- only their surrounding markup was
// checked. This is the same defect class as the stock-lab.html
// calcRisk/calcFib gap (tests/stock-lab-calculators.test.mjs) and the
// index.html FC_SPECS gap (tests/pj-futures.test.mjs): a real per-branch
// regression (a flipped long/short sign, a wrong breakeven formula) would
// ship undetected because nothing runs these functions with real inputs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// All three pages' inline scripts nest braces (a for-loop building a points
// array, an if/else assigning maxProfit/maxLoss, an object literal passed to
// window.currDrawBars) deep enough that a "match to the next bare }" regex
// would cut the function short -- scan brace depth instead, the same
// approach tests/stock-lab-calculators.test.mjs and
// tests/chatbot-lesson-picker.test.mjs already use.
function extractFunction(source, name, label) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start > -1, `${name} no longer defined in ${label}`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces extracting ${name} from ${label}`);
}

function makeSandbox() {
  const els = {};
  const el = (id) => (els[id] ||= { value: '0', textContent: '' });
  const sandbox = { document: { getElementById: el }, window: {} };
  vm.createContext(sandbox);
  return { sandbox, els, el };
}

// --- options-lab.html: Option Payoff Diagram (#opt-tool) -------------------

const optionsLab = readFileSync(join(ROOT, 'options-lab.html'), 'utf8');
const olNumSrc = extractFunction(optionsLab, 'num', 'options-lab.html');
const olFmtUsdSrc = extractFunction(optionsLab, 'fmtUsd', 'options-lab.html');
const olCalcSrc = extractFunction(optionsLab, 'calc', 'options-lab.html');

function runOptionCalc(inputs) {
  const { sandbox, els, el } = makeSandbox();
  vm.runInContext(`${olNumSrc}\n${olFmtUsdSrc}\n${olCalcSrc}\nthis.calc = calc;`, sandbox);
  el('op-type').value = inputs.type;
  el('op-side').value = inputs.side;
  el('op-strike').value = String(inputs.strike);
  el('op-premium').value = String(inputs.premium);
  el('op-contracts').value = String(inputs.contracts);
  sandbox.calc();
  return {
    be: els['op-out-be'].textContent,
    maxProfit: els['op-out-maxp'].textContent,
    maxLoss: els['op-out-maxl'].textContent,
  };
}

test('options-lab calc(): long call has unlimited upside, loss capped at the debit paid', () => {
  // Page defaults: strike $100, premium $3.00, 1 contract.
  const out = runOptionCalc({ type: 'call', side: 'long', strike: 100, premium: 3, contracts: 1 });
  assert.equal(out.be, '$103.00');
  assert.equal(out.maxProfit, 'Unlimited');
  assert.equal(out.maxLoss, '-$300');
});

test('options-lab calc(): long put profit is capped at strike-minus-premium, not unlimited', () => {
  const out = runOptionCalc({ type: 'put', side: 'long', strike: 100, premium: 3, contracts: 1 });
  assert.equal(out.be, '$97.00');
  assert.equal(out.maxProfit, '$9,700');
  assert.equal(out.maxLoss, '-$300');
});

test('options-lab calc(): short call risk is unlimited, capped only for the buyer', () => {
  const out = runOptionCalc({ type: 'call', side: 'short', strike: 100, premium: 3, contracts: 1 });
  assert.equal(out.be, '$103.00');
  assert.equal(out.maxProfit, '$300');
  assert.equal(out.maxLoss, 'Unlimited');
});

test('options-lab calc(): short put caps both sides at the premium and strike-minus-premium', () => {
  const out = runOptionCalc({ type: 'put', side: 'short', strike: 100, premium: 3, contracts: 1 });
  assert.equal(out.be, '$97.00');
  assert.equal(out.maxProfit, '$300');
  assert.equal(out.maxLoss, '-$9,700');
});

test('options-lab calc(): contracts scale the $100 multiplier, not just the raw premium', () => {
  const out = runOptionCalc({ type: 'call', side: 'long', strike: 100, premium: 3, contracts: 2 });
  assert.equal(out.maxLoss, '-$600');
});

// --- stock-breakdown.html: Position-Size & Risk Calculator (#risk-tool) ----

const stockBreakdown = readFileSync(join(ROOT, 'stock-breakdown.html'), 'utf8');
const sbNumSrc = extractFunction(stockBreakdown, 'num', 'stock-breakdown.html');
const sbFmtUsdSrc = extractFunction(stockBreakdown, 'fmtUsd', 'stock-breakdown.html');
const sbCalcSrc = extractFunction(stockBreakdown, 'calc', 'stock-breakdown.html');

function runRiskCalc(inputs) {
  const { sandbox, els, el } = makeSandbox();
  vm.runInContext(`${sbNumSrc}\n${sbFmtUsdSrc}\n${sbCalcSrc}\nthis.calc = calc;`, sandbox);
  el('st-acct').value = String(inputs.acct);
  el('st-risk').value = String(inputs.riskPct);
  el('st-entry').value = String(inputs.entry);
  el('st-stop').value = String(inputs.stop);
  el('st-slip').value = String(inputs.slip);
  sandbox.calc();
  return {
    budget: els['st-out-budget'].textContent,
    riskPerShare: els['st-out-riskps'].textContent,
    shares: els['st-out-shares'].textContent,
    cost: els['st-out-cost'].textContent,
  };
}

test('stock-breakdown calc(): the page\'s own defaults floor a non-evenly-divisible share count', () => {
  // Page defaults: $25,000 account, 1% risk, entry $50.00, stop $48.75, $0.05 slippage.
  // Budget = 25000*0.01 = $250. Risk/share = |50-48.75|+0.05 = $1.30.
  // 250/1.30 = 192.30..., must floor to 192, not round or ceil.
  const out = runRiskCalc({ acct: 25000, riskPct: 1, entry: 50, stop: 48.75, slip: 0.05 });
  assert.equal(out.budget, '$250');
  assert.equal(out.riskPerShare, '$1.3');
  assert.equal(out.shares, '192 shares');
  assert.equal(out.cost, '$9,600');
});

test('stock-breakdown calc(): entry equal to stop must not divide by zero', () => {
  const out = runRiskCalc({ acct: 10000, riskPct: 1, entry: 100, stop: 100, slip: 0 });
  assert.equal(out.riskPerShare, '$0');
  assert.equal(out.shares, '0 shares');
});

// --- psychology-enhancer.html: Expectancy & R-Multiple Calculator (#psy-tool) --

const psychologyEnhancer = readFileSync(join(ROOT, 'psychology-enhancer.html'), 'utf8');
const peNumSrc = extractFunction(psychologyEnhancer, 'num', 'psychology-enhancer.html');
const peCalcSrc = extractFunction(psychologyEnhancer, 'calc', 'psychology-enhancer.html');

function runExpectancyCalc(inputs) {
  const { sandbox, els, el } = makeSandbox();
  vm.runInContext(`${peNumSrc}\n${peCalcSrc}\nthis.calc = calc;`, sandbox);
  el('py-winrate').value = String(inputs.winrate);
  el('py-avgwin').value = String(inputs.avgwin);
  el('py-avgloss').value = String(inputs.avgloss);
  el('py-friction').value = String(inputs.friction);
  el('py-oner').value = String(inputs.oner);
  sandbox.calc();
  return {
    er: els['py-out-er'].textContent,
    erDollars: els['py-out-erd'].textContent,
    breakeven: els['py-out-be'].textContent,
  };
}

test('psychology-enhancer calc(): the page\'s own defaults match the worked expectancy formula', () => {
  // Page defaults: 45% win rate, 1.8R avg win, 1.0R avg loss, 0.05R friction, $250 per R.
  // E_R = 0.45*1.8 - 0.55*1.0 - 0.05 = 0.81 - 0.55 - 0.05 = 0.21R.
  // Breakeven win rate = (avgLoss+friction)/(avgWin+avgLoss) = 1.05/2.8 = 37.5%.
  const out = runExpectancyCalc({ winrate: 45, avgwin: 1.8, avgloss: 1.0, friction: 0.05, oner: 250 });
  assert.equal(out.er, '0.21R');
  assert.equal(out.erDollars, '$52.5');
  assert.equal(out.breakeven, '37.5%');
});

test('psychology-enhancer calc(): equal avg win/loss with zero friction crosses breakeven at exactly 50%', () => {
  const out = runExpectancyCalc({ winrate: 50, avgwin: 1, avgloss: 1, friction: 0, oner: 100 });
  assert.equal(out.breakeven, '50.0%');
  assert.equal(out.er, '0.00R');
});
