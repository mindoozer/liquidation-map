# Aggregate Liquidation Map

An *"everything map, all the liquidity"* — estimates where leveraged positions across
the market would be force-liquidated, rendered as a price-axis chart with bars
**stacked & colored by leverage tier** (Coinglass / Kingfisher style). Aggregates main
CEXes and DEXes, normalized to USD notional and mixed into one map.

> **It's a model, not real data.** No exchange publishes per-trader entry price or
> leverage, so this (like Coinglass and Kingfisher) is a *relative-intensity estimate*,
> not actual positions.

## Run

```bash
npm install          # once (js-yaml)
bash refresh.sh      # fetch + render
open liquidation-map.html
```

Or step by step: `node fetch.mjs` (→ `data.json`) then `node render.mjs` (→ `liquidation-map.html`).

## How it works

- **`fetch.mjs`** runs each enabled venue adapter for each token → normalized `data.json`.
- **`lib/model.mjs`** projects an assumed leverage distribution onto recent price action
  and applies the liquidation-price formula (linear USDT perps):
  - long liq ≈ `entry · (1 − 1/L + mmr)` &nbsp; short liq ≈ `entry · (1 + 1/L − mmr)`
  - *shape* from per-candle open-interest growth (**OI-Δ** where the venue has OI history, else traded volume), weighted by **recency decay**
    `0.5^(age/half_life)` with a per-leverage half-life (100× hugs price, 10× spreads wide);
    *magnitude* anchored to current aggregate open interest; long/short split skewed by the aggregate
    long/short account ratio per token (Binance/Bybit/OKX, OI-weighted) instead of a fixed 50/50.
    Optional Gaussian smoothing de-noises. Multiple tokens render as tabbed boards (one at a time).
- **`render.mjs`** buckets by price × leverage tier and draws the SVG map. Left of the
  price line = long liquidations (falling price), right = short. Hover for the breakdown.

## Configure (`config.yml`)

Tokens, enabled venues, leverage tiers (color + weight + `half_life_days`), lookback window,
price range + per-token x-axis auto-fit (`autofit_coverage`, `price_range_min_pct`), bin size,
`smoothing_pct`. Tune tier weights for the assumed distribution and
`half_life_days` for how fast older entries fade per tier (shorter = hugs current price).

## Extend

- **Add a venue:** drop `adapters/<venue>.mjs` returning the common shape
  (`{ exchange, symbol, markPrice, openInterestUsd, klines:[{t,o,h,l,c,volUsd}] }`),
  register it in `fetch.mjs`, enable it in `config.yml`.
- **Add a token:** add an entry under `tokens:` with its per-venue symbol mapping.

## Roadmap

- **Phase 1 (done):** Binance, BTC, end-to-end leverage-colored map.
- **Phase 2 (done):** Bybit + OKX aggregation (USD-normalized, mixed); per-tier recency-decay
  distribution (volatility-adaptive); Gaussian smoothing; per-venue OI breakdown.
  *Remaining optional:* Bitget, OI-delta weighting, long/short-ratio skew.
- **Phase 3:** DEXes (Hyperliquid, dYdX v4, GMX); inverse-contract math; actual-liquidation
  overlay; optional live auto-refresh.
- **Phase 4:** more tokens (ETH, SOL, …).
