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

// The same "$ lands before the number's own minus sign" defect class already
// fixed on stock-lab.html's fmt() and stock-breakdown.html's fmtUsd() --
// here it survived in a third spot because the breakeven output never
// called this page's own (already-correct) fmtUsd(), instead formatting
// itself inline with a bare '$'+be.toFixed(2). A put's breakeven is
// strike-premium, which goes negative whenever premium exceeds strike (no
// min/max on either input stops a member from typing that combination),
// rendering e.g. "$-15.00" instead of "-$15.00" on the tool's own output.
test('options-lab calc(): a put breakeven below zero keeps its minus sign before the $, not after', () => {
  const out = runOptionCalc({ type: 'put', side: 'long', strike: 20, premium: 35, contracts: 1 });
  assert.equal(out.be, '-$15.00');
});

// Same defect class, a fourth spot: the payoff chart's x-axis (price) labels
// built their own bare '$'+v.toFixed(0), bypassing this page's own fmtUsd()
// (already used for the y-axis and for maxProfit/maxLoss). #op-strike has no
// min, so a negative strike drives the chart's price range (strike*0.6 to
// strike*1.4) negative and the axis rendered e.g. "$-140" instead of "-$140".
function runOptionChart(inputs) {
  const { sandbox, els, el } = makeSandbox();
  let captured = null;
  sandbox.window.currDrawLine = (canvas, points, opts) => { captured = { points, opts }; };
  vm.runInContext(`${olNumSrc}\n${olFmtUsdSrc}\n${olCalcSrc}\nthis.calc = calc;`, sandbox);
  el('op-type').value = inputs.type;
  el('op-side').value = inputs.side;
  el('op-strike').value = String(inputs.strike);
  el('op-premium').value = String(inputs.premium);
  el('op-contracts').value = String(inputs.contracts);
  sandbox.calc();
  const xs = captured.points.map((p) => p.x);
  return { xFmt: captured.opts.xFmt, xMin: Math.min(...xs), xMax: Math.max(...xs) };
}

test("options-lab calc(): a negative strike's chart x-axis keeps its minus sign before the $, not after", () => {
  const out = runOptionChart({ type: 'call', side: 'long', strike: -100, premium: 3, contracts: 1 });
  assert.equal(out.xFmt(out.xMin), '-$140');
  assert.equal(out.xFmt(out.xMax), '-$60');
});

test("options-lab calc(): a real (positive) strike's chart x-axis renders unchanged", () => {
  const out = runOptionChart({ type: 'call', side: 'long', strike: 100, premium: 3, contracts: 1 });
  assert.equal(out.xFmt(out.xMin), '$60');
  assert.equal(out.xFmt(out.xMax), '$140');
});

test('options-lab calc(): contracts scale the $100 multiplier, not just the raw premium', () => {
  const out = runOptionCalc({ type: 'call', side: 'long', strike: 100, premium: 3, contracts: 2 });
  assert.equal(out.maxLoss, '-$600');
});

// A negative #op-premium (no min on that input, same reachability as the
// negative-strike/negative-contracts bugs above) used to flip the *sign* of
// maxLoss/maxProfit, not just their formatting: maxLoss=-premium*mult with
// premium=-3 computed to a positive $300, telling a long-call holder their
// worst case was a $300 *gain* -- impossible, since a long option's worst
// case is capped at the debit paid, never a profit. Floored premium at 0
// (there's no real-world negative premium; a buyer never gets paid to buy).
test('options-lab calc(): a negative premium cannot flip max loss/profit into an impossible sign', () => {
  const longCall = runOptionCalc({ type: 'call', side: 'long', strike: 100, premium: -3, contracts: 1 });
  assert.equal(longCall.maxLoss, '$0');
  assert.equal(longCall.maxProfit, 'Unlimited');
  const shortPut = runOptionCalc({ type: 'put', side: 'short', strike: 100, premium: -3, contracts: 1 });
  assert.equal(shortPut.maxProfit, '$0');
  assert.equal(shortPut.maxLoss, '-$10,000');
});

// A visitor typing 0 (or a negative) contracts must get a real $0 position,
// not a fabricated 1-contract payoff -- the same falsy-zero/forced-minimum
// bug this repo has already fixed on calcSizingSim, research-engine's
// labSpot, and index.html's own calcFutures, never checked here. The long
// call's max profit is hardcoded 'Unlimited' independent of contracts, so a
// zero-contract "position" needs its own $0 override, not just the shared
// contracts clamp.
test('options-lab calc(): 0 or negative contracts render a real $0 position, not a fabricated 1-contract payoff', () => {
  const zero = runOptionCalc({ type: 'call', side: 'long', strike: 100, premium: 3, contracts: 0 });
  assert.equal(zero.maxProfit, '$0');
  assert.equal(zero.maxLoss, '$0');
  const negative = runOptionCalc({ type: 'call', side: 'long', strike: 100, premium: 3, contracts: -2 });
  assert.equal(negative.maxProfit, '$0');
  assert.equal(negative.maxLoss, '$0');
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

// The account/risk/entry/stop/slip inputs carry min="0", but that attribute
// is not enforced by JS and calc() reruns on every input event, so a member
// can type a negative risk % (or paste one in) and reach a negative budget.
// This was first caught as a sign-placement defect (fmtUsd rendered '$-100'
// instead of '-$100', fixed on stock-lab.html's fmt() too), but the sign fix
// alone left a worse bug standing: budget negative over a positive
// risk/share still floors to a negative share count ("shares: -77"), which
// is nonsensical -- you cannot buy a negative number of shares, and cost
// (shares*entry) went negative with it. budget is now floored at $0, so a
// negative risk % can never produce anything but a real $0/0-shares result.
test('stock-breakdown calc(): a negative risk % floors at $0 budget and 0 shares, never negative', () => {
  const out = runRiskCalc({ acct: 10000, riskPct: -1, entry: 50, stop: 48.75, slip: 0.05 });
  assert.equal(out.budget, '$0');
  assert.equal(out.shares, '0 shares');
  assert.equal(out.cost, '$0');
});

// st-slip ("Slippage/gap buffer") carries the same unenforced min="0" as
// every sibling field. Unlike riskPct above, a negative slip was never
// floored: riskPerShare = |entry-stop|+slip, so slip:-5 against the page's
// own default entry/stop (50/48.75) renders "Effective risk per share:
// -$3.75" -- a nonsensical negative per-share risk figure on the one tool
// whose job is producing a dollar number to size a real position from.
test('stock-breakdown calc(): a negative slippage floors riskPerShare at the entry/stop gap, never negative', () => {
  const out = runRiskCalc({ acct: 25000, riskPct: 1, entry: 50, stop: 48.75, slip: -5 });
  assert.equal(out.riskPerShare, '$1.25');
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

// Avg win and avg loss have no min attribute and calc() re-runs on every
// input event, so a member can reach avgW+avgL === 0 just by clearing or
// zeroing both fields while typing. The undivided formula rendered "NaN%"
// (both zero) or "Infinity%" (both blank) instead of a real number -- the
// same divide-by-zero class already guarded on stock-breakdown's riskPerShare.
test('psychology-enhancer calc(): avg win and avg loss both zero must not divide by zero', () => {
  const zero = runExpectancyCalc({ winrate: 50, avgwin: 0, avgloss: 0, friction: 0.05, oner: 250 });
  assert.equal(zero.breakeven, '0.0%');
  const blank = runExpectancyCalc({ winrate: 50, avgwin: '', avgloss: '', friction: 0.05, oner: 250 });
  assert.equal(blank.breakeven, '0.0%');
});

// #py-winrate carries min="0" max="100", but like the other calculators on
// this page that attribute is not enforced by JS and calc() reruns on every
// input event, so a member can type (or fat-finger) a win rate outside
// 0-100. Unclamped, a 150% win rate produced a confident-looking 3.15R
// "edge" instead of a rejected or clamped input -- worse than a crash,
// since nothing flags the number as impossible before it's used to size a
// real position. Same defect class as stock-breakdown's negative risk %,
// just on a two-sided bound here.
test('psychology-enhancer calc(): win rate is clamped to 0-100%, not trusted past its own bounds', () => {
  const over = runExpectancyCalc({ winrate: 150, avgwin: 1.8, avgloss: 1.0, friction: 0.05, oner: 250 });
  assert.equal(over.er, '1.75R');
  assert.equal(over.breakeven, '37.5%');
  const under = runExpectancyCalc({ winrate: -20, avgwin: 1.8, avgloss: 1.0, friction: 0.05, oner: 250 });
  assert.equal(under.er, '-1.05R');
  assert.equal(under.breakeven, '37.5%');
});

// avg win/avg loss/friction carry no min attribute at all (unlike py-winrate's
// min="0" max="100", clamped above), and "avg loss" is the one field on this
// tool a member is naturally tempted to type as negative since a loss "feels"
// negative. With the page's own defaults but avg loss fat-fingered as -1
// instead of 1, the unclamped formula read 0.45*1.8 - 0.55*(-1) - 0.05 =
// 1.31R/$327.50 -- a confident, 6x-inflated edge instead of the correct
// 0.76R/$190 that flooring avg loss (and avg win/friction, same defect) at 0
// produces. Same defect class and fix as the win-rate clamp just above, just
// never applied to this calc()'s other three unbounded inputs.
test('psychology-enhancer calc(): avg win, avg loss, and friction are floored at 0, not trusted past their own sign', () => {
  const negLoss = runExpectancyCalc({ winrate: 45, avgwin: 1.8, avgloss: -1, friction: 0.05, oner: 250 });
  assert.equal(negLoss.er, '0.76R');
  assert.equal(negLoss.erDollars, '$190');
  assert.equal(negLoss.breakeven, '2.8%');
  const negFriction = runExpectancyCalc({ winrate: 45, avgwin: 1.8, avgloss: 1.0, friction: -0.05, oner: 250 });
  assert.equal(negFriction.er, '0.26R');
  const negWin = runExpectancyCalc({ winrate: 45, avgwin: -1.8, avgloss: 1.0, friction: 0.05, oner: 250 });
  assert.equal(negWin.er, '-0.60R');
});

// "1R in dollars" (py-oner) was the one input left un-floored when the test
// just above was added for its three siblings -- same line, same missing
// min attribute, same reachable-by-typing path. A $ per R conversion factor
// has no sensible negative value, and letting one through doesn't error, it
// corrupts only the dollar line: with the page's defaults the edge is a
// genuine +0.21R, but a -250 "1R in dollars" rendered "Expectancy per
// trade ($): -$52.50" right next to "Expectancy per trade: 0.21R" --
// a positive edge and a negative dollar figure on the same screen.
test('psychology-enhancer calc(): 1R in dollars is floored at 0, a negative conversion factor cannot flip the dollar sign against a positive edge', () => {
  const negOneR = runExpectancyCalc({ winrate: 45, avgwin: 1.8, avgloss: 1.0, friction: 0.05, oner: -250 });
  assert.equal(negOneR.er, '0.21R');
  assert.equal(negOneR.erDollars, '$0');
});

// --- futures-dissection.html: Tick Value & P&L Calculator (#fut-tool) ------
//
// This is the fourth of the four matched curriculum-tool pages (futures-
// dissection, stock-breakdown, options-lab, psychology-enhancer -- the same
// COURSE_PAGES grouping tests/regressions.test.mjs uses) but, unlike its
// three siblings above, its own calc() had never been executed by a test --
// only the page's surrounding markup was checked, the exact gap this test
// file's header comment exists to close for the OTHER three pages. A member
// sizes a real futures position off this tool's point/tick/P&L output, so
// the same defect classes already caught on the sibling tools (a bare
// '$'+n putting a short trade's minus sign after the dollar sign instead of
// before it, or a fabricated non-zero contract count instead of a real $0
// position) would ship here undetected too. Read calc()/fmtUsd()/specFor()
// directly first: both are already written defensively (fmtUsd already
// puts the sign before the '$', and contracts is already floored at 0 via
// Math.max(0, ...)) -- so these are pure regression tests pinning already-
// correct behavior, not bug fixes, the same role pj-futures.test.mjs plays
// for index.html's own calcFutures.
const futuresDissection = readFileSync(join(ROOT, 'futures-dissection.html'), 'utf8');
const fdSpecsSrc = futuresDissection.match(/var specs=\[[\s\S]*?\];/)[0];
const fdNumSrc = extractFunction(futuresDissection, 'num', 'futures-dissection.html');
const fdFmtUsdSrc = extractFunction(futuresDissection, 'fmtUsd', 'futures-dissection.html');
const fdSpecForSrc = extractFunction(futuresDissection, 'specFor', 'futures-dissection.html');
const fdCalcSrc = extractFunction(futuresDissection, 'calc', 'futures-dissection.html');

function runFuturesCalc(inputs) {
  const { sandbox, els, el } = makeSandbox();
  vm.runInContext(`${fdSpecsSrc}\n${fdNumSrc}\n${fdFmtUsdSrc}\n${fdSpecForSrc}\n${fdCalcSrc}\nthis.calc = calc;`, sandbox);
  el('fu-contract').value = inputs.contract;
  el('fu-entry').value = String(inputs.entry);
  el('fu-exit').value = String(inputs.exit);
  el('fu-contracts').value = inputs.contracts === undefined ? '1' : String(inputs.contracts);
  sandbox.calc();
  return {
    points: els['fu-out-points'].textContent,
    ticks: els['fu-out-ticks'].textContent,
    pnl: els['fu-out-pnl'].textContent,
  };
}

test("futures-dissection calc(): the page's own ES defaults match the worked point/tick/P&L math", () => {
  // Page defaults: ES, entry 21500, exit 21568, 1 contract.
  // points = 68, ticks = 68/0.25 = 272, P&L = 68*$50*1 = $3,400.
  const out = runFuturesCalc({ contract: 'ES', entry: 21500, exit: 21568, contracts: 1 });
  assert.equal(out.points, '68.00');
  assert.equal(out.ticks, '272');
  assert.equal(out.pnl, '$3,400');
});

test('futures-dissection calc(): a 20-point NQ move and the same move in MNQ keep exactly the 10x multiplier relationship the lesson teaches', () => {
  // Same worked numbers lesson 2's own quiz explanation states: NQ moves
  // $400 (at $20/pt) and MNQ moves $40 (at $2/pt) for an identical 20-point move.
  const nq = runFuturesCalc({ contract: 'NQ', entry: 21500, exit: 21520, contracts: 1 });
  assert.equal(nq.pnl, '$400');
  const mnq = runFuturesCalc({ contract: 'MNQ', entry: 21500, exit: 21520, contracts: 1 });
  assert.equal(mnq.pnl, '$40');
});

// Same sign-placement defect class already fixed on stock-lab.html's fmt(),
// stock-breakdown.html's fmtUsd(), and options-lab.html's breakeven/chart
// output: a losing trade (exit below entry, the normal outcome of a short
// or a failed long) must render its minus sign before the '$', not after.
// This page's own fmtUsd() already gets it right -- pinning that here so a
// future edit that reintroduces a bare '$'+n.toLocaleString() fails this
// test instead of shipping a "$-3,400" readout on a real P&L figure.
test('futures-dissection calc(): a losing trade keeps its minus sign before the $, not after', () => {
  const out = runFuturesCalc({ contract: 'ES', entry: 21568, exit: 21500, contracts: 1 });
  assert.equal(out.points, '-68.00');
  assert.equal(out.pnl, '-$3,400');
});

// #fu-contracts carries min="1" but, like every other calculator on this
// site's curriculum pages, that attribute is not enforced by JS and calc()
// reruns on every input event -- a member can type 0 or a negative contract
// count. Unclamped, this is the same "fabricated 1-contract floor" class
// fixed on options-lab.html and index.html's calcSizingSim; here calc()
// already floors contracts at 0 via Math.max(0, ...), so 0 or a negative
// value must render a real $0 position, never a nonzero P&L.
test('futures-dissection calc(): 0 or negative contracts render a real $0 position, not a fabricated nonzero P&L', () => {
  const zero = runFuturesCalc({ contract: 'ES', entry: 21500, exit: 21568, contracts: 0 });
  assert.equal(zero.pnl, '$0');
  const negative = runFuturesCalc({ contract: 'ES', entry: 21500, exit: 21568, contracts: -3 });
  assert.equal(negative.pnl, '$0');
});

// An empty #fu-contracts field (a member selecting-all-and-deleting while
// editing) is handled as its own branch, separate from the 0/negative
// floor above: fuContractsRaw==='' short-circuits to the page's real
// 1-contract default rather than falling through to Math.round('') (NaN)
// and silently zeroing the position the same way a deliberate 0 does.
test('futures-dissection calc(): an emptied contracts field defaults to a real 1-contract position, not a silent $0', () => {
  const out = runFuturesCalc({ contract: 'ES', entry: 21500, exit: 21568, contracts: '' });
  assert.equal(out.pnl, '$3,400');
});
