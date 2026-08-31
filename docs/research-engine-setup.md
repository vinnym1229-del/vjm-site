# VJM Research Engine setup

## What ships in this repository

`research-engine.html` is a private, responsive dashboard with four separate research modules:

| Module | Current capability | Deliberately unavailable until another source is connected |
| --- | --- | --- |
| Options / Price Action | QQQ/SPY current option-chain Greeks, open-interest GEX model, gamma-flip estimate, futures-style overnight/Asia/London proxy levels, PDH/PDL, BSL/SSL, sweeps, 1m/5m/15m/1h FVG and IFVG, displacement, QQQ/SPY SMT, continuation models, timing statistics, VWAP, MFE/MAE, and interactive contract/hedge scenarios | Exact historical contract decay, observed dealer positioning, and true CME NQ/ES volume/order flow |
| Stocks | Daily, weekly, or combined Fibonacci retracement studies; fill/new-high rates; MFE/MAE; ATR; current swing map | Fundamentals and earnings-calendar causality |
| Sectors | 1/5/20-session sector ETF momentum, relative strength, ETF up-day share, ATR | Constituent-level market breadth |
| Biotech | Price, volume, gap, ATR, and mechanical volatility flags | FDA/PDUFA dates, trial milestones, cash runway, dilution risk, validated short interest |

Every module returns an `asOf` timestamp, data-source label, parameters, sample size, and null for unavailable observations. The interface separates **observed**, **modeled**, **indicative**, **cached**, and **unavailable** values.

## Cloudflare Pages environment

In the Pages project, add these encrypted production and preview secrets:

| Variable / binding | Required | Purpose |
| --- | --- | --- |
| `ALPACA_API_KEY` | Yes | Alpaca API key ID; server-side only |
| `ALPACA_SECRET_KEY` | Yes | Alpaca secret; server-side only |
| `PREMIUM_ACCESS_CODES` | Yes | HMAC signing secret already used by the premium session; use a long random value |
| `MEMBERS_STATUS_URL` | Yes | Existing member-status bridge used by the premium gate |
| `RESEARCH_CRON_SECRET` | Recommended | Long random value required by the scheduled refresh workflow |
| `RESEARCH_DB` | Recommended | D1 binding that preserves current and historical research snapshots |

Never add these values to HTML, JavaScript, workflow YAML, or git. The public health route returns only configuration booleans.

## Create persistent storage

1. Create a D1 database named `vjm-research` in Cloudflare.
2. Bind it to this Pages project with the variable name `RESEARCH_DB` in both production and preview.
3. Apply `migrations/0001_research_engine.sql` to the database. With Wrangler authenticated, the equivalent command is:

   ```bash
   npx wrangler d1 execute vjm-research --remote --file=migrations/0001_research_engine.sql
   ```

The API writes an append-only row to `research_snapshots` and upserts the current result in `research_latest`. If Alpaca is temporarily unavailable, the exact same parameter set can fall back to its most recent saved result and is labeled `cached` with the live error.

## Enable scheduled refreshes

Add these GitHub Actions repository secrets:

| GitHub secret | Value |
| --- | --- |
| `RESEARCH_REFRESH_URL` | `https://not-financial-advice-vjm.com` |
| `RESEARCH_CRON_SECRET` | The same random value configured in Cloudflare Pages |

`.github/workflows/research-refresh.yml` then refreshes QQQ/SPY option-chain snapshots every 30 minutes across the broad U.S. market-hours window and refreshes intraday studies, sectors, biotech, and the stock watchlist once after the close. The workflow can also be run manually with `options`, `daily`, or `all` scope.

## QQQ/SPY futures-style model

Each QQQ/SPY trade date is assembled from these Eastern Time windows:

| Model window | Time | Data used |
| --- | --- | --- |
| Evening | 6:00–8:00 PM on the prior calendar day | Consolidated SIP history |
| Asia proxy | 8:00 PM–12:00 AM | BOATS history |
| London proxy | 2:00–5:00 AM | BOATS through 4:00 AM, then SIP |
| Premarket | 4:00–9:30 AM | Consolidated SIP history |
| Overnight proxy | 6:00 PM–9:30 AM | Combined SIP + BOATS windows above |
| RTH | 9:30 AM–4:00 PM | Consolidated SIP history |

The scanner compares QQQ with SPY and calculates:

- prior-day, prior-week, prior-session VAH/VAL, overnight, Asia-proxy, London-proxy, premarket, opening-range, and initial-balance high/low sweeps;
- prior-session POC plus a 70% value area derived from one-minute SIP volume in 50 price bins;
- overnight buy-side/sell-side liquidity from confirmed five-minute pivot highs/lows;
- one-, five-, fifteen-, and sixty-minute three-candle FVGs, retests, full fills, continuation, and inversion into IFVG;
- five-minute displacement when both body and range are at least 1.5 times their respective prior-20-bar medians and the close lands in the candle's outer 25%;
- QQQ/SPY SMT when one ETF takes the comparable session extreme and the other remains unmatched for at least five minutes;
- sweep → same-direction FVG → retest → post-sweep extreme-break continuation models;
- conditional continuation/reversal rates, VWAP touches, time to VWAP, MFE, MAE, MFE:MAE, and before-10:00/10:30/11:00 timing splits.

The selectable sample is 5, 20, or 40 trade days. Every displayed probability includes its observation count. These are descriptive historical frequencies, not a prediction or recommendation.

## Timing convention (frozen)

Every study in the Research Engine obeys one timing convention, defined once as
`TIMING_CONVENTION` in `functions/api/_lib/backtest-core.js`, imported by
`functions/api/research-engine.js`, and stamped onto every study response under
`provenance.timingConvention`. It is versioned; a change to any clause changes
the meaning of every published statistic.

| Clause | Rule |
| --- | --- |
| Observable | A signal exists only at the close of the last bar required to define it. A pivot needs its confirmation bars. A grouped 5m/15m/60m bar needs its whole group — its opening timestamp is a drawing position, not an observation time. An indicator at index *i* may read indices ≤ *i* only. |
| Actionable | No transaction before the first bar that opens at or after that instant. |
| Fill | The entry price is one that still lay in the future when the signal completed: the close of the bar that made the signal observable, the resting fib level for a retracement touch, or the next bar's open in the daily event-study engine. |
| Outcome | MFE, MAE, continuation, reversal and fill are scanned strictly after the entry bar. Bars that printed before the entry price existed are never scored. |
| Ambiguity | Anything bar data cannot resolve is resolved against the study — same-bar target/stop is treated as stop-first, and intrabar order is never assumed favourable. |

This convention was introduced after an audit found two look-ahead defects in
the shipped studies: stock fib pivots were measured from the pivot bar (which
is not identifiable until `pivot` bars later), and multi-timeframe FVG and
displacement candles were acted on at their opening timestamp while carrying
the completed group's values. Both let a study transact on information that did
not exist yet, which inflates conditional hit rates, fill rates and
continuation rates. `tests/research-engine.test.mjs` contains adversarial
fixtures — tapes whose future is deliberately hostile to the signal — that fail
if either behaviour returns.

### What the published numbers are

Every study response also carries `provenance.results = 'hypothetical-gross'`
and a disclaimer. These are hypothetical descriptive frequencies computed from
historical bars under the convention above. They are **gross**: no commissions,
fees, financing, borrow, spread or slippage, no fill model, no queue position,
no partial fills. They are not achieved results, not live-tradable performance,
not a forecast, and not a recommendation. Any interface that displays them must
say so.

## Data definitions and guardrails

- Current spot snapshots use Alpaca IEX. The intraday model requests consolidated SIP history for 6:00–8:00 PM, 4:00 AM–4:00 PM and BOATS history for 8:00 PM–4:00 AM. The request ends 16 minutes before the current time so it stays inside the Free plan's historical-data delay.
- Basic-plan options use Alpaca's indicative feed. The options panel never labels it OPRA-precise.
- Historical option data begins in February 2024. Exact historical contract-path/decay studies require bid/ask-aware OPRA data and are disabled here.
- Current GEX is modeled as `gamma × open interest × 100 × spot² × 1%`, expressed in millions of dollars. Calls-positive/puts-negative is a declared sign convention, not observed dealer inventory.
- The overnight, Asia, and London labels are QQQ/SPY ETF price-action proxies. They do not contain CME NQ/ES volume, order flow, futures-only prints, or the futures maintenance break. The interface labels this limitation everywhere the proxy is shown.
- A sweep must cross the stored level from the expected side. An opening gap entirely beyond the level is not counted. Continuation means a 0.15% extension occurs before a 0.15% reversal. The continuation model is sweep → same-direction FVG → retest → post-sweep extreme break.
- QQQ/SPY SMT requires one ETF to take its prior-day extreme while the paired ETF remains unmatched for at least five minutes. Outcomes begin at that confirmation time, preventing end-of-day look-ahead from qualifying the setup.
- Five, fifteen and sixty-minute bars are drawn at the group's opening timestamp but are defined by the group's completed high/low/close, so no study may react to one before the group has ended. Every grouped bar carries the instant it became observable, and multi-timeframe FVG, IFVG and displacement events are timed from that instant (records publish both `formedAt` and `observableAt`). Time-to-retest is measured from the observation instant, not from the candle's opening timestamp.
- Fibonacci studies use the exact selected calendar lookback (one, three, or six years), visible pivot windows, and an explicit post-touch outcome horizon. A swing high is only a swing high once `pivot` further bars have closed without exceeding it, so every retracement measurement starts at that **confirmation** bar, never at the high itself, and each event publishes both `highDate` and `confirmDate`. Daily and weekly rows remain separate in the interface. Daily bars cannot establish the intrabar order when a retracement touch and fill happen in the same session, so a fill printed on the touch bar itself is not counted. Rates with fewer than five observations remain visible but do not qualify as the “best” level.
- The option slope lab uses synthetic fixed-Greek profiles. Vega is applied per IV percentage point, theta is scaled across a 390-minute session, and the page labels the result modeled rather than observed.
- Biotech catalyst cells stay blank until a specialized catalyst/fundamental source is connected.

## Verification before deployment

Run from the repository root:

```bash
npm test
git diff --check
```

After deployment:

1. Open `/api/research-engine?module=health`; confirm `configured.alpaca`, `premiumSecret`, and (if enabled) `database` are true.
2. Open `/research-engine.html`, unlock with a valid premium code, choose QQQ or SPY, and run the full scan for 5, 20, and 40 days.
3. Confirm the browser network inspector never receives Alpaca credentials.
4. Confirm the current-level table identifies SIP, BOATS, or the combined source; confirm every conditional row has `N`.
5. Confirm unavailable observations render as `—`, never `0` or `0%`.
6. Confirm each result shows an as-of time and correct source/precision label.
7. Run the GitHub workflow manually with `all`, then confirm D1 contains rows in both tables.

## Primary documentation

- Alpaca market-data plans: https://docs.alpaca.markets/us/docs/about-market-data-api
- Alpaca 24/5 and BOATS trading/data windows: https://docs.alpaca.markets/us/docs/245-trading-for-trading-api
- Alpaca historical stock bars and feed selection: https://docs.alpaca.markets/us/reference/stockbars
- Alpaca historical options: https://docs.alpaca.markets/us/docs/historical-option-data
- Alpaca option-chain snapshots: https://docs.alpaca.markets/us/reference/optionchain
- Cloudflare Pages Functions: https://developers.cloudflare.com/pages/functions/
- Cloudflare Pages bindings: https://developers.cloudflare.com/pages/functions/bindings/
- Cloudflare D1: https://developers.cloudflare.com/d1/get-started/
