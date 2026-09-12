---
name: liqmap
description: Liquidation-map command center — read the map, interpret squeeze/walls/magnets, run calibration & leverage-fit, refresh/publish, validate vs real liquidations
arguments: mode
user-invocable: true
argument-hint: "[read | squeeze | walls | magnets | calibrate | leverage-fit | validate | refresh | publish | health | query | mute]"
license: MIT
---

# liqmap — Router

A *thin* skill over the deterministic foundation (`*.mjs`, `./q`, flat JSONL). It carries
the **judgment** — how to read the model, which gotchas bite, what discipline gates a config
change — so a session never re-derives it from chat history. The scripts stay dumb and exact;
this file decides *when* and *how* to read their output.

> **First principle, stated once:** this is a **model, not real data**. No venue publishes
> per-trader entry/leverage, so every wall is a *relative-intensity estimate*. Never present a
> wall as a fact. The only ground truth in the repo is `liquidations/` (exchange-confirmed
> events) — that's what `validate` is for.

## Mode routing

Determine the mode from `$mode`:

| Input | Mode |
|-------|------|
| (empty) | `read` — interpret the current map |
| `read` / a token like `BTC` | `read` |
| `squeeze` | `squeeze` |
| `walls` | `walls` |
| `magnets` / `magnet` | `magnets` |
| `calibrate` | `calibrate` |
| `leverage-fit` / `levfit` | `leverage-fit` |
| `validate` / `liqs` | `validate` |
| `refresh` | `refresh` |
| `publish` | `publish` |
| `health` / `status` | `health` |
| `query <SQL>` | `query` |
| `mute …` | `mute` |
| raw SQL (`FROM …` / `SELECT …`) | `query` |

> **Routing test set:** [`EVALS.md`](EVALS.md) — eyeball it after editing this table (trigger evals).

Read `DATA.md` once at the start of any data-reading mode — it is the schema and the
gotcha list. Do not reverse-engineer fields.

> **View ≠ raw JSONL — don't mix the two field names.** The `snaps` DuckDB view *renames and
> reshapes* the raw snapshot fields and **omits some**. Verify with `./q "SELECT * FROM snaps LIMIT 0"`.
> | raw JSONL (DATA.md) | in `snaps` view |
> |---|---|
> | `f8` | `funding8h` |
> | `fuel5: [long,short]` | `fuel_long`, `fuel_short` (split into two cols) |
> | `sqz`, `top`, `cum`, `win`, `lsRaw`, `lsUsed` | same names |
> | `conc`, `etf`, `ven` | **not in the view** — read the raw line: `tail -1 snapshots/<TOK>.jsonl` |
> So query `funding8h`/`fuel_long`/`fuel_short` via `./q`; for `conc`/`etf`/`ven` read the JSONL directly.

---

## read (default) — interpret the current map

Goal: a plain-language read of where the latest snapshot says leverage is stacked, and what
that implies — *with* the model caveat.

1. Latest state per token from snapshots:
   `./q "FROM snaps WHERE tok='BTC' ORDER BY t DESC LIMIT 1"` (or loop tokens).
2. Report, in this order: **px**, **squeeze score `sqz`** (→ defer to `squeeze` for the why),
   **fuel** (`fuel_long` vs `fuel_short` in the view — $ within ±5%; the asymmetry is the story),
   **top walls** (`top`, nearest few). For **concentration `conc`** (TIGHT/MIXED/SPREAD + which
   side's fuel sits closer) read the raw line — `conc` is **not in the `snaps` view**:
   `tail -1 snapshots/<TOK>.jsonl`.
3. Then one line of *so-what*: which direction has more nearby fuel to burn, framed as a
   magnet/squeeze pull, hedged as a model estimate.

Gotchas to honor every time:
- `side` = the **liquidated** position side. `long` = a long got force-closed (forced *sell*,
  price falling). Don't flip it. (NB: `side` is a **`liqs`/`hourly_liqs` column — not in `snaps`**;
  this gotcha applies when you read real liquidations in `validate`/`query`, not the snapshot above.)
- `conc` is **diagnostic, not scored** — describe it, don't add it to the squeeze call.
- Compare only within the same `mv` (model generation). Mixed `mv` snapshots aren't comparable.

## squeeze — explain the squeeze score

`sqz` is an integer vote-sum. Walk the votes from the latest snapshot and config:
funding (`funding8h` in the view / `f8` raw, + = longs pay → long-squeeze pressure), long/short
skew (`lsUsed` damped, not `lsRaw`), fuel asymmetry (`fuel_long`/`fuel_short`), and the **ETF
vote** (`etf` — **raw JSONL only, not in the view** → `tail -1 snapshots/<TOK>.jsonl`; counts only
when `|flow| ≥ 1%` of token OI; null = no vote; a non-null value still abstains once the scrape
is older than `squeeze.etf_max_age_h` (30h) — say so, don't infer). Squeeze-flip
popups fire from `snapshot.mjs` and are **not** logged to `liquidations/alerts.jsonl`. State the net call
and the dominant vote; flag if ETF is abstaining.

## walls — top predicted walls

`./q "FROM wall_history WHERE tok='BTC' ORDER BY t DESC, wall_usd DESC LIMIT 8"`.
Report offset% + $ notional, nearest first. Always pair with `magnets` lift before treating a
wall as actionable — a big wall with ~0 lift is just where price already was.

## magnets — does price get pulled to walls?

The central tradable thesis. Read `magnet.json` (or the rendered panel):
`pooled[{bucket, n, touch, base, lift}]`, `lift = touch − base`.
- **lift > 0** across enough samples → walls attract (signal).
- **lift ≈ 0** → walls are just where price was going anyway (no edge).
- **lift < 0** → repelled.
**Pooled is a token-mix** — the 2026-08-15 shape review showed a pooled "distance shape" can
be an artifact of which tokens populate each bucket. Check `cells[{tok, side, bucket, …}]`
(per-token × above/below spot) before attributing anything to the pooled row.
`firstSnapshot/lastSnapshot` = the window actually scored (post kline-coverage-gate); evidence
accumulates via the `klines/` archive, so the window grows instead of rolling ~30d.
Honesty rules baked into the study: tiny `n` is **low confidence — say it out loud**; the base
rate controls for distance but **not regime**; walls <0.5% away are skipped. Confidence accrues
with calendar time — never oversell early n.

## calibrate — fit tier weights (V4 discipline)

`node calibrate.mjs` (read-only except `calibration.json`; **never touches `config.yml`**).
Two parts: **A. proxy-vs-real** (does the OI-drop proxy track real liquidations? if not,
calibrating to it is moot — report this first) and **B. time-split fit** (fit older half, score
held-out recent half, regularized toward current priors).

The discipline — state it, don't override it:
- Adopt a fitted value **only** where it beats baseline **out-of-sample** by ≥ `adoptMargin`.
- Per-candle OI is untrustworthy beyond ~20d (Binance ~500h, Bybit ~200h; only OKX/dYdX span
  30d) — this is what compromised the original V4 time-split. Treat long-horizon OI fits skeptically.
- Adopting into `config.yml` is a **separate reviewed step the user makes**, gated on forward
  magnet validation — propose, show the deltas, never auto-edit config.

## leverage-fit — measure the real leverage mix

`node leverage-fit.mjs` (read-only). Replaces the model's biggest hand-picked assumption (tier
weights) with data from real liquidations. Reports three columns per tier: **OBSERVED**,
**DE-BIASED** (observed ÷ reach-probability — liquidations massively over-sample high leverage),
**PRIOR**. The de-biased column is the one comparable to config weights. Same adoption discipline
as `calibrate`: report, don't write config; adoption needs forward magnet validation.

## validate — vs real, exchange-confirmed liquidations

The only ground truth. `liquidations/<TOK>.jsonl` (ws Binance/OKX/Bybit + REST poll
HTX/dYdX/Kraken). Useful queries:
- `./q "SELECT tok, count(*), max(t) FROM liqs GROUP BY tok"` — coverage.
- `./q "FROM realized_skew"` — realized long-share, $-weighted (the V1 validation).
- `./q "FROM hourly_liqs WHERE tok='BTC' ORDER BY t DESC LIMIT 12"`.
Coverage gaps to remember: Binance is **sampled** (largest liq per symbol per second);
**Hyperliquid + equity perps (SPACEX, MSTR) have no liq feed** → they never appear here, so
never "validate" those against `liqs`.

## refresh — local fetch + render

`bash refresh.sh` → fetch all venues, etf-flows, snapshot, magnet-study, re-render the HTML.
**Network-gated:** Binance/Bybit must be reachable — run only from a network where they are
(this Mac). On a blocked network expect venue errors; check `data.json.errors` and the stale tags.

## publish — push to GitHub Pages

`bash publish.sh` → fetch + render, then **force-push an orphan commit** to `gh-pages`
(https://mindoozer.github.io/liquidation-map/). Outward-facing and destructive to that branch's
history (single-commit by design). Confirm intent before running; same network gate as `refresh`.

## health — is the pipeline alive?

- Collector: `liquidations/.collector-status.json` (`events`/`lastEventAt` per venue; counters
  **reset on daemon restart** — the JSONL is cumulative, the counters aren't).
- Daemon: `launchctl list | grep com.nikitiki.liq` (`liqcollector` always-on ws, `liqmap` publish tick).
- Staleness: `data.json.fetchedAt` and any venue tagged `stale:true` (last-good reused; dropped after 6h).
- **Continuity — did the rows actually land?** Log age and the sentinel only show the *current*
  tick; a hole in the past 24h is invisible to both (2026-09-03: 05:07→16:10Z missed, the whole
  ZEC +17% move, squeeze re-rated only after the fact). `node ../health-all.mjs` — the liqmap row
  lists every snapshot gap > 2× the 30-min tick in the last 24h (all tokens share one fetch, so a
  gap is reported once with a token count), plus a trailing "rows stopped while the log keeps
  moving" case (= `snapshot.mjs` failing non-fatally). Same question in SQL:
  `./q "SELECT tok, lag(t) OVER w AS from_t, t AS to_t, round(epoch(t - lag(t) OVER w)/60) AS gap_min FROM snaps WINDOW w AS (PARTITION BY tok ORDER BY t) QUALIFY gap_min > 60 AND t > now() - INTERVAL 24 HOUR ORDER BY t, tok"`.
- **Sleep is not an outage.** health-all lines each gap up against `pmset -g log` sleep→wake spans:
  a gap the Mac slept through (≥80% covered) reads "Mac asleep HH:MM→HH:MM local; not a failure" and
  stays OK — a closed lid pauses the whole fleet (user ruling 2026-09-04: report it in one line,
  never as a finding). Only an UNEXPLAINED gap → WARN. Before alleging a silent failure by hand,
  confirm the hole is unique to this daemon (`hl-agent/agent*.log` ticks through it, or not).
- **Failure history:** `cat data/health-hist.txt` — append-only, timestamped, 7-day retention
  (fetch TOTAL/PARTIAL lines + publish.sh ERR-trap lines such as a failed gh-pages push). The
  sentinel `data/health-err.txt` is deleted by the next clean fetch, so it never explains a gap
  seen the morning after; the history does, and health-all quotes the entry at a gap's start.

## query — arbitrary DuckDB

`./q "<SQL>"` with canonical views preloaded: `liqs` · `snaps` · `hourly_liqs` ·
`realized_skew` · `wall_history` · `klines`. Read-only, in-memory. Timestamps normalized to `t` TIMESTAMP
(raw `snapshots.ts` is ISO, `liquidations`/klines/`alerts` are epoch ms). Reach for the views
before parsing JSONL by hand.

## mute — silence alert popups

`node mute.mjs` (until 08:00) · `2h`/`90m` · `on` · `off` · `status`. Toggles `.notify-mute`
(checked per-call, no daemon restart). Alerts still log to `liquidations/alerts.jsonl`; only the popup is
suppressed.

---

## What is latent vs deterministic here (the split)

- **Deterministic → stays code:** the model math (`lib/model.mjs`), fetch/render, calibration
  search, magnet/leverage fits, DuckDB views. Same input → same output. Never reimplement these
  in prose.
- **Latent → lives in this skill:** which gotcha applies, when a wall is actionable, how to read
  a squeeze, the adoption discipline, the model-not-data framing. That's the judgment the scripts
  can't encode.
