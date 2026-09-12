# Magnet-table shape review — 2026-08-15

Six-agent deep dive (4 analysts + 2 adversarial verifiers) into the pooled magnet table's
W-shape (+2.4pp at 0.5–1% · trough at 1–2%/3–5% · +5.1pp at 5–10%) and the hypothesis that
the trough explains the fade arms' losses. **Both headline claims failed verification.**
Method: exact replication of `magnet-study.mjs` (pooled table matched to 4 decimals), per-token
and per-side recompute, cluster bootstrap on calendar-day blocks, and a full join of all five
hl-agent arms' ledgers by `ctx.magnet.offPct`.

## How a cell is built (mechanics recap)

- One "wall sample" = one (snapshot line, top-10 wall) pair, every ~30 min. **No wall identity,
  no dedup** — a wall that persists 3 days is counted ~144×, its single touch outcome re-counted
  each time.
- Touch = hourly wicks of the longest-kline venue reach the wall price within `(ts, ts+24h]`.
- Base = empirical P(same-distance, same-direction excursion in 24h) from **all overlapping**
  hourly windows of the same 720×1h series — matched for distance/direction, *not* for regime.
- Lift = touch − base; per-wall weight 1 (a $5M wall counts the same as a $500M wall); all
  6 tokens pooled into one bucket row.

## Finding 1 — the evidence base is ~29 days, not 66, and n=56k is a mirage

- The 720×1h klines only span **2026-07-16 → 08-15**; older snapshots silently fail the
  coverage gate, but `firstSnapshot` is stamped *before* the gate — so the "since 06-10" label
  overstates the window. `magnet.json` is overwritten every tick and klines aren't archived:
  **the study is a rolling ~29-day window that cannot accumulate evidence.**
- Effective independent sample ≈ 29 non-overlapping 24h windows × 6 tokens. Cluster bootstrap
  (day blocks, 2,000 reps): 0.5–1% lift z≈0.6, CI [−0.05, +0.10]; 5–10% z≈1.5–1.7,
  CI [−0.004, +0.12]. **Both headline edges' CIs cross zero.**

## Finding 2 — the W-shape is a token-mix artifact

No single token reproduces the pooled shape. Bucket composition shifts from 56% BTC at 0.5–1%
to 0% BTC / 78% HYPE+MSTR+SPACEX at 5–10%, so the pooled "distance shape" is largely a shape
across token mixes and regimes.

| pooled cell | what actually drives it |
|---|---|
| +2.6pp @ 0.5–1% | BTC (56% of bucket, **+6.1pp**, positive both sides, touches on 19 distinct days — the one defensible cell). NMR/ZEC are *negative* there. Refuted as noise pooled: flips to −3.6pp under equal-per-episode weighting. |
| trough 1–2% / 3–5% | ZEC repelled in every bucket ≤5% (worst −16.5pp above spot), plus MSTR-below. |
| +5.2pp @ 5–10% | HYPE-down (+14.9pp) + MSTR-up (+11.0pp) = 88% of the lift mass, concentrated in ~3 calendar days (07-16, 07-27, 07-31). **Excluding those 3 days: +0.2pp.** NMR contradicts: 0 touches in 1,860 tail walls. |

Verdicts: **0.5–1% edge = autocorrelation noise** (pooled). **5–10% edge = unresolved** —
two regime probes (trailing-vol-matched and momentum-matched bases) *failed* to absorb it, and
it concentrates in against-drift walls (+7.0pp vs 0.0pp with-drift), so it's unproven rather
than disproven. It resolves only with an independent month of data — which requires archiving
(see Actions).

## Finding 3 — the trough does NOT explain the fade arms' losses (hypothesis refuted)

Joined all arms' ledgers by `|ctx.magnet.offPct|`:

| bucket | pooled lift | control n / avgR / net$ | gated n / avgR / net$ |
|---|---|---|---|
| 0–0.5% | (not measured by study) | 43 / −0.55 / **−$980** | 6 / +0.80 / +$252 |
| 0.5–1% | **+2.4pp** | 93 / −0.44 / **−$1,575** | 21 / +0.26 / +$287 |
| 1–2% | −1.9pp | 73 / **−0.20** (least bad) / −$775 | 30 / −0.18 / **−$298** (gated's worst) |
| 2–3% | ≈0 | 9 / −0.53 / −$217 | 4 / −0.59 / −$123 |
| 3–5%, 5–10% | −2.3pp / +5.1pp | **unreachable — `maxOffsetPct: 3.0`** | unreachable |

- Losses concentrate **nearest the wall**, in the positive-lift and unmeasured (<0.5%) buckets;
  the negative-lift trough is the arms' *least-bad* bucket per trade (best win rates).
- The loss gradient tracks **implied costR** (0.48 → 0.20 falling with distance) — stop width
  vs the fixed 15bps round trip — not magnet lift. Cost remains the confirmed root problem.
- Gated's gap vs control (−$3,547 → +$119, ≈$3,666) decomposes: **~54% window artifact**
  (gated started 06-28, after control's worst stretch), **~37% the costR≤0.4 filter**
  (in-window control −$1,558 → −$212 pass-only counterfactual), **~9% sequencing luck**.
  The gate is also a two-treatment arm (plist sets `HL_MAX_COST_R=0.4` *and*
  `HL_STOP_MODEL=candle1m`) and a de-facto **BTC filter** (50/52 control BTC trades fail it).
- Direction of mechanism is *opposite* the hypothesis: corr(|offPct|, costR) ≈ −0.46, so the
  gate prunes near-wall trades hardest and **concentrates gated INTO the trough** (49% of its
  trades; its worst bucket). Within 1–2% the excluded trades were *better* than the kept ones.

## Irony worth recording

The one statistically defensible magnet cell (BTC 0.5–1%) is exactly the population the cost
gate excludes — BTC's tight stops make near-wall BTC untradeable at 15bps taker cost. If that
cell matters anywhere, it's under maker execution, which is what the maker arm exists to measure.

## Actions

1. **Fix the window mislabel + make evidence cumulative** — archive klines (or score snapshots
   against archived candles) so independent months accumulate; stamp `firstSnapshot` *after* the
   coverage gate; consider persisting per-window results instead of overwriting `magnet.json`.
   Until then, treat the pooled table as "last ~29 days" and expect sign flips as the window rolls.
2. **Publish per-token × per-side cells in `magnet.json`** (they're computed internally) so
   pooled-mix illusions like this can't recur; render should keep the n≥20 color gate per cell.
3. Re-run this review after one genuinely independent month: if 5–10% lift reappears with new
   touch events from different tokens, the far edge upgrades toward real.

*Full agent outputs: workflow wf_def84f37-6c6 journal (session transcript dir). The morning
report's 08-15 "Worth poking at" paragraph is retracted by Finding 3.*
