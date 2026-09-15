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
| `klines` | one archived hourly candle | the cumulative price-path archive behind the magnet study |

## Cross-cutting conventions (read first)

- **Timestamp units differ.** `snapshots` `ts` is an **ISO string**; `liquidations`, klines, and `alerts` use **epoch ms**. The views normalize both to a `t` TIMESTAMP.
- **`side` = the LIQUIDATED position side.** `long` = a long got force-closed (forced *sell*); `short` = forced *buy*.
- **All `$`/`usd`/`oi` are USD notional.** Offsets are **%** from price; `funding8h` is the rate **per 8h** (+ = longs pay); prices are in quote currency.
- **`oiUsd` in klines is recent-only on most venues.** Binance gives ~500h, Bybit ~200h; **OKX/dYdX span the full 30d**, and **Gate spans 180d** (from `contract_stats`, halved to one-sided — see below). Don't trust other venues' per-candle OI older than ~20d (this is what compromised the V4 time-split).
- **Gate reports BOTH-SIDES OI** (ticker `total_size`, stats `open_interest_usd` ≈ 2× everyone else's convention). The adapter converts to one-sided (`position_size`, or `open_interest_usd / 2`) — if you query Gate's API directly, halve before comparing.
- **Real-liq venue coverage:** WS from **Binance/OKX/Bybit** + REST poll from **HTX/dYdX/Kraken/Gate**. Binance is **sampled** (largest liquidation per symbol per second). **Hyperliquid has no liquidation feed**; SPACEX/MSTR events exist only where a venue with a feed lists them (Gate/Kraken since 2026-07-09).
- **⚠ Known defects (audit 2026-09-05, `liq-feed-audit-2026-09-05.md`; fixes proposed, NOT applied):** (1) **`venue='bybit'` `side` is INVERTED for the whole file** — Bybit's `S` is the *position* side (`Buy` = a long was liquidated) and `collector.mjs` maps it with Binance's order-side convention; per-minute agreement with Binance 4% (gate/okx ~96%). Flip `side` for bybit in any side-split query until fixed; `realized_skew` and hl-agent's ledgered `burst.long10m/short10m` are contaminated. (2) **`venue='gate'` `usd` is position size, not fill size** — partial-liquidation chains re-print the same position (≈50× overcount on a chain); gate's USD is ≥1.6× overstated, treat its totals as an upper bound. (3) At any instant the file holds only WS rows for the trailing ~30 min — REST venues land on the publish tick — so a "last 10 minutes" read is Binance+OKX(+Bybit) only.
- **Era boundary 2026-07-09 ~08:40 UTC:** venue expansion **8 → 11** (added Gate, Bitget, KuCoin; SPACEX gained Coinbase INTX + Kraken; MSTR gained Kraken). Snapshot `oi`/`ven` and cumulative fuel step up discontinuously — never compare raw magnitudes across this boundary (like the Binance-WS 2026-06-12 era note for liqs).
- **`mv` = model generation** (currently `3`: damped position-ratio skew + path-aware survivorship). Filter by it when comparing snapshots across model changes.
- **Gitignored** (regenerated/accrued): `data.json`, `snapshots/`, `liquidations/`, `klines/`, `magnet.json`, `calibration.json`, `*.log`, `data/` (health sentinel `health-err.txt` — current tick only, deleted by the next clean fetch — plus `health-hist.txt`, append-only timestamped failure lines, 7-day retention). **In git:** `config.yml`, code, `sql/`, `DATA.md`.

## Files

### `config.yml` — source of truth (in git, self-commented)
Tokens (+ per-token symbol maps, `max_leverage`, `maintenance_margin_rate`, custom `leverage_tiers`), enabled venues, global tiers, lookback, axis/smoothing params, `long_short_skew`, `path_survivorship`, `alert_linger_secs`.

### `data.json` — latest fetch (overwritten each tick)
`{ fetchedAt (ISO), tokens: { SYM: { name, venues: [...] } }, errors: [{token, venue, error}] }`

**venue:** `exchange · symbol · token · type('linear') · markPrice · openInterestUsd · openInterestCoins · longFracPositions · longFracAccounts · longFrac · funding8h · klines[]`. On a failed fetch the last-good venue is reused and tagged `stale:true, staleAsOf:<ISO>` (dropped after 6h).
**kline:** `t (epoch ms) · o · h · l · c (quote px) · volUsd · oiUsd (nullable — see recent-only note)`.

### `snapshots/<TOK>.jsonl` — one model snapshot per token per ~30-min tick (append; dedup by `ts`)
`v:1 · mv (model gen) · ts (ISO) · tok · px · oi (USD) · lsRaw (raw long frac) · lsUsed (damped) · f8 (funding/8h) · fuel5 [longUSD, shortUSD within ±5%] · sqz (squeeze score int) · etf (daily ETF net flow US$m, where tracked, else null) · ven {exchange: oiUsd} · win [loPct, hiPct display window] · cum {offsetPct: cumUSD} (keys −20/−10/−5/−2/2/5/10/20) · top [[offsetPct, wallUSD] × 10] · conc {l, s: {hm (half-mass |Δ%| holding the nearer 50% of that side), n2 (frac of side mass within 2%), pk (peak-bin offset %), ps (peak share), lab TIGHT|MIXED|SPREAD}, ig: {side (which side's fuel sits closer — 'long'|'short'|'symmetric'), gap (half-mass gap, pp)}} — per-side spatial concentration, diagnostic (NOT scored)`
Built for **forward validation** (predicted walls vs later price) and a **self-built full-window OI history** (`ven`, incl. Hyperliquid) that no free API gives.

### `klines/<TOK>.jsonl` — hourly-candle archive (append by `magnet-study.mjs`; dedup by `t`)
`tok · venue (the longest-kline venue that tick) · t (epoch ms, candle open) · o · h · l · c`
`data.json` only spans ~30d of klines; this archive is what lets the magnet study score an
ever-growing window instead of a rolling one. Complete candles only (open + 1h ≤ now), so a
candle is never frozen mid-hour. Venue may change across runs (longest wins per tick) —
acceptable for touch/base granularity, and the recorded `venue` keeps it auditable.

### `liquidations/<TOK>.jsonl` — real liquidation events (append; ws + poll)
`v:1 · src ('ws'|'poll') · venue · tok · ts (epoch ms) · side ('long'|'short' = liquidated side) · px · usd (notional) · id`

### `liquidations/alerts.jsonl` — fired alerts
`ts (epoch ms) · type ('burst'|'sweep') · tok · title · body`. (Squeeze-flip notifications fire from `snapshot.mjs` and are **not** logged here — only collector burst/sweep are.)

### internal state
- `liquidations/.collector-status.json` — `startedAt · events{venue:n} · lastEventAt{venue:ISO} · lastMsgAt{venue:epoch}`. Counters **reset on daemon restart** (the JSONL files are cumulative).
- `liquidations/.poll-state.json` — REST watermarks `{venue: {tok: ts}}`.

### derived (regenerated, gitignored)
- `magnet.json` — `generatedAt · horizonH · firstSnapshot/lastSnapshot (stamped only from snapshots that passed the kline-coverage gate — the window actually scored, NOT the oldest snapshot on disk) · totalWalls · tokens{SYM:{samples}} · pooled[{bucket, n, touch, base, lift}] · cells[{tok, side ('above'|'below' spot), bucket, n, touch, base, lift}]`. Forward magnet test; `pooled` is a token-mix — read `cells` before trusting a pooled shape.
- `calibration.json` — `generatedAt · iters · adoptMargin · proxyVsReal[] · calibration[]`. From `calibrate.mjs` (on-demand).
- `etf-flows.json` — `updatedAt · flows{SYM:{usdM (daily net, US$m), date, asOf}}`. Daily ETF net flow, scraped best-effort from Farside (via the jobs-phuket Playwright, self-throttled to ≤4×/day). Feeds the 4th squeeze vote (inflow → upside/short-squeeze) only when |flow| ≥ 1% of the token's OI. Tokens opt in via `farside:` in config (currently BTC). Brittle by nature (Cloudflare) — last-good values are kept for display, but the vote degrades to no-vote (and the page marks the flow "⏱ stale — not voting") once the value's `asOf` is older than `squeeze.etf_max_age_h` (30h) in config.
