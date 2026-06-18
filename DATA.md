# Data dictionary

Storage is **flat files, no database** — append-only JSONL + JSON, transparent and
git/grep/agent-readable. The files on disk are the source of truth; **DuckDB sits on top
for querying, not storage** (`./q "SQL"`). This doc is the schema every field, unit, and
gotcha — so an agent never has to reverse-engineer the data.

## Querying (DuckDB)

One-time: `brew install duckdb`. Then from the project root:

```
./q "FROM realized_skew"
./q "SELECT tok, count(*), max(t) FROM liqs GROUP BY tok"
./q "FROM wall_history WHERE tok='BTC' ORDER BY t DESC, wall_usd DESC LIMIT 8"
```

`q` loads `sql/views.sql` (read-only, in-memory) then runs the query. Canonical views:

| view | grain | use |
|---|---|---|
| `liqs` | one real liquidation event | the raw exchange-confirmed event store |
| `snaps` | one model snapshot / token / tick | predicted state over time |
| `hourly_liqs` | token × hour × side | liquidation $ and count by hour |
| `realized_skew` | token | realized long-share (the V1 validation, $-weighted) |
| `wall_history` | one predicted wall / snapshot | how the top walls evolve |

## Cross-cutting conventions (read first)

- **Timestamp units differ.** `snapshots` `ts` is an **ISO string**; `liquidations`, klines, and `alerts` use **epoch ms**. The views normalize both to a `t` TIMESTAMP.
- **`side` = the LIQUIDATED position side.** `long` = a long got force-closed (forced *sell*); `short` = forced *buy*.
- **All `$`/`usd`/`oi` are USD notional.** Offsets are **%** from price; `funding8h` is the rate **per 8h** (+ = longs pay); prices are in quote currency.
- **`oiUsd` in klines is recent-only.** Binance gives ~500h, Bybit ~200h; only **OKX/dYdX span the full 30d**. Don't trust per-candle OI older than ~20d (this is what compromised the V4 time-split).
- **Real-liq venue coverage:** WS from **Binance/OKX/Bybit** + REST poll from **HTX/dYdX/Kraken**. Binance is **sampled** (largest liquidation per symbol per second). **Hyperliquid and equity perps (SPACEX, MSTR) have no liquidation feed** → they never appear in `liquidations/`.
- **`mv` = model generation** (currently `3`: damped position-ratio skew + path-aware survivorship). Filter by it when comparing snapshots across model changes.
- **Gitignored** (regenerated/accrued): `data.json`, `snapshots/`, `liquidations/`, `magnet.json`, `calibration.json`, `*.log`. **In git:** `config.yml`, code, `sql/`, `DATA.md`.

## Files

### `config.yml` — source of truth (in git, self-commented)
Tokens (+ per-token symbol maps, `max_leverage`, `maintenance_margin_rate`, custom `leverage_tiers`), enabled venues, global tiers, lookback, axis/smoothing params, `long_short_skew`, `path_survivorship`, `alert_linger_secs`.

### `data.json` — latest fetch (overwritten each tick)
`{ fetchedAt (ISO), tokens: { SYM: { name, venues: [...] } }, errors: [{token, venue, error}] }`

**venue:** `exchange · symbol · token · type('linear') · markPrice · openInterestUsd · openInterestCoins · longFracPositions · longFracAccounts · longFrac · funding8h · klines[]`. On a failed fetch the last-good venue is reused and tagged `stale:true, staleAsOf:<ISO>` (dropped after 6h).
**kline:** `t (epoch ms) · o · h · l · c (quote px) · volUsd · oiUsd (nullable — see recent-only note)`.

### `snapshots/<TOK>.jsonl` — one model snapshot per token per ~30-min tick (append; dedup by `ts`)
`v:1 · mv (model gen) · ts (ISO) · tok · px · oi (USD) · lsRaw (raw long frac) · lsUsed (damped) · f8 (funding/8h) · fuel5 [longUSD, shortUSD within ±5%] · sqz (squeeze score int) · etf (daily ETF net flow US$m, where tracked, else null) · ven {exchange: oiUsd} · win [loPct, hiPct display window] · cum {offsetPct: cumUSD} (keys −20/−10/−5/−2/2/5/10/20) · top [[offsetPct, wallUSD] × 10]`
Built for **forward validation** (predicted walls vs later price) and a **self-built full-window OI history** (`ven`, incl. Hyperliquid) that no free API gives.

### `liquidations/<TOK>.jsonl` — real liquidation events (append; ws + poll)
`v:1 · src ('ws'|'poll') · venue · tok · ts (epoch ms) · side ('long'|'short' = liquidated side) · px · usd (notional) · id`

### `liquidations/alerts.jsonl` — fired alerts
`ts (epoch ms) · type ('burst'|'sweep') · tok · title · body`. (Squeeze-flip notifications fire from `snapshot.mjs` and are **not** logged here — only collector burst/sweep are.)

### internal state
- `liquidations/.collector-status.json` — `startedAt · events{venue:n} · lastEventAt{venue:ISO} · lastMsgAt{venue:epoch}`. Counters **reset on daemon restart** (the JSONL files are cumulative).
- `liquidations/.poll-state.json` — REST watermarks `{venue: {tok: ts}}`.

### derived (regenerated, gitignored)
- `magnet.json` — `generatedAt · horizonH · firstSnapshot · totalWalls · tokens{SYM:{samples}} · pooled[{bucket, n, touch, base, lift}]`. Forward magnet test.
- `calibration.json` — `generatedAt · iters · adoptMargin · proxyVsReal[] · calibration[]`. From `calibrate.mjs` (on-demand).
- `etf-flows.json` — `updatedAt · flows{SYM:{usdM (daily net, US$m), date, asOf}}`. Daily ETF net flow, scraped best-effort from Farside (via the jobs-phuket Playwright, self-throttled to ≤4×/day). Feeds the 4th squeeze vote (inflow → upside/short-squeeze) only when |flow| ≥ 1% of the token's OI. Tokens opt in via `farside:` in config (currently BTC). Brittle by nature (Cloudflare) — degrades to no-vote if the scrape fails.
