# liquidation-map — session harness

Aggregate, leverage-colored liquidation map across 8 CEX/DEX venues. **It's a model, not
real data** — every wall is a relative-intensity estimate, never a fact.

## Where things live (don't re-derive)

- **`DATA.md`** — the schema. Every field, unit, and gotcha. Read it before touching data.
- **`README.md`** — how the model works and how to configure (`config.yml`).
- **`.claude/skills/liqmap/`** — the router skill. It carries the *judgment* (how to read the
  map, calibration discipline, validation). Default to working through its modes:
  `read · squeeze · walls · magnets · calibrate · leverage-fit · validate · refresh · publish · health · query · mute`.

## Deterministic entrypoints

- `./q "<SQL>"` — DuckDB over the flat files (views: `liqs · snaps · hourly_liqs · realized_skew · wall_history · klines`).
- `bash refresh.sh` — fetch + render locally. `bash publish.sh` — fetch + push to gh-pages.
- `node calibrate.mjs` · `node leverage-fit.mjs` — fits (read-only; never write `config.yml`).
- Daemons: `com.nikitiki.liqcollector` (always-on real-liq ws), `com.nikitiki.liqmap` (publish tick).
  Fleet view + snapshot-continuity check (gaps > 60m in 24h, Mac-sleep-attributed): `node ../health-all.mjs`.

## Session rules (the non-obvious ones)

- **`side` = the liquidated side.** `long` = a long was force-*sold* (price falling). Never flip it.
- **OI is recent-only.** Don't trust per-candle OI older than ~20d (only OKX/dYdX span 30d).
- **Compare within one `mv`** (model generation). Mixed-`mv` snapshots aren't comparable.
- **Config changes are reviewed by the user.** `calibrate`/`leverage-fit` propose; they never
  edit `config.yml`. Adoption is gated on forward magnet validation — show deltas, let the user call it.
- **Network gate:** Binance/Bybit fetches need a network where they're reachable (this Mac).
- **No-feed tokens:** Hyperliquid + equity perps (SPACEX, MSTR) have no real-liq feed — never
  validate those against `liqs`.
