# VJM / St Trades website

Static site deployed on Cloudflare Pages with Pages Functions under `functions/api`.

- Public site: `index.html`
- Options education: `options-lab.html`
- Stock tools: `stock-lab.html`
- Private market research: `research-engine.html`
- Research API: `functions/api/research-engine.js`
- Research setup and data definitions: `docs/research-engine-setup.md`

The research engine keeps Alpaca credentials server-side, reuses the existing premium session, optionally archives snapshots in Cloudflare D1, and refreshes the same dashboard instead of generating a new file for every run. Its Options / Price Action module studies QQQ and SPY as an explicitly labeled futures-style ETF proxy using SIP + BOATS history, with overnight/session sweeps, QQQ/SPY SMT, FVG/IFVG, displacement, liquidity pivots, VWAP, MFE/MAE, and timing statistics.
