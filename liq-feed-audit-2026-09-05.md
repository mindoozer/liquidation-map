# Real-liq feed & swing-gate audit — 2026-09-05

Answers the 09-04/09-05 morning-report "worth poking at": *does the real-liq feed carry signal for the
swing arm's burst gate, and do the 15-minute feed gate / 360-minute snapshot gate protect anything?*
Method: main-session replay + a 4-agent adversarial verification (independent re-implementation of the
replay, code-path audit of the gates, venue/units audit, completeness critic). Paper trading only —
nothing here is a live-config change; the two data defects below are proposals, not applied.
Scratch outputs live in the session scratchpad (`replay-indep/`, `refute2/`, `venue-audit/`), not here.

## Findings

### 1. Two data defects in the liquidation store (need a decision)

**a. Bybit liquidated-side is inverted, file-wide since 2026-06-08.** `collector.mjs:173` maps
`side = x.S === 'Sell' ? 'long' : 'short'` with the comment "S='Buy' means a SHORT was liquidated" —
that is Binance's *order-side* convention. Bybit v5 documents `S` as the **position** side: *"When you
receive a `Buy` update, this means that a long position has been liquidated."* Empirically, per-minute
dominant side vs Binance (BTC, 7d): **bybit 4.0%** agreement, gate 96.7%, okx 95.8%; vs HL 15m candle
direction with a clear $200k margin: binance/gate/okx/htx 83–88%, bybit 17.6%. During the 08-20 rally
(71.8k→75.8k) every venue printed mostly `short`; bybit printed 1,020 `long` vs 160 `short`.
Contaminates: every `burst.long10m/short10m` ever ledgered by hl-agent, `realized_skew`, the V1 real-liq
validation. **Proposed fix:** flip the mapping in `collector.mjs` (going forward) + an era note in
DATA.md; whether to rewrite the historical bybit rows (append-only store, ~6.5k events since 08-31 alone)
is the user's call. With bybit corrected, **5 of the 10 BTC burst-skips would have passed** the $2.5M gate.

**b. Gate records position size, not fill size.** `collect-liqs.mjs` gate branch: `usd = |size| ×
quanto × fill_price` where `size` is the remaining *position*; a partial-liquidation chain prints the
same position 20+ times (09-01 23:21: 24 rows in 110 s, 73.18→49.04 BTC, ≈$105M raw vs ≈$2M actually
liquidated). Gate's 21d BTC $573M is ≥1.6× overstated (chain-collapsed upper bound $344–359M; true
figure lower). Gate is **not** the #2 BTC venue as the morning report implied; it sits at or below Bybit.
Fix: store `order_size − left` (the fill) or dedupe monotone chains; the API row has both fields.

### 2. The burst gate shows no discrimination (n=20 vs 10)

Counterfactual replay of the 20 burst-skipped swing signals (entry at `entryRef`, stop-before-target,
policy-E target where the row carries `tpR`, 48h time exit, `netR = grossR − costR`), HL candles at the
finest interval that actually covers the signal time:

| set | W/L | ΣR | avgR |
|---|---|---|---|
| 20 burst skips, replayed | 5/15 | −11.75 | −0.588 |
| 10 taken trades, replayed with the same method | 3/7 | −5.62 | −0.561 |
| 10 taken trades, real closes | 3/7 | −4.13 | −0.413 |

Difference 0.03R with SE ≈ 0.5R. The main session's first pass (4W/16L, −0.713R, "the gate discarded a
worse set") was wrong: `replay-skips.mjs` took the first interval that returned *any* candles, and HL's
1m retention edge (09-01 22:57) landed 29.5h after the 08-31 17:30 ZEC signal — one fabricated stop
(true outcome: target +1.31R in 5 minutes). No bar in any of the 30 windows held both stop and target,
so the 15m-bar pessimism caveat did not bite. Method validation: the same replay reproduces all 10 real
exits (reason and hold); the flat planning `costR` 0.33 overstates realized cost (real stops −1.21R,
real targets tpR −0.04R).

**The variance is the exit-policy era, not the gate:** pre-policy-E (frozen far walls, tpR 3–8) skips
1W/14L −1.02R vs opens 0W/6L −1.22R; post-E (tpR 1.5) skips 4W/1L +0.70R vs opens 3W/1L +0.79R.
Within each era the sets are indistinguishable. Caveats: ignores slot/cooldown interaction (taking a
skip displaces later opens: 08-03 ZEC pair, 08-30 BTC pair); post-E is n=9.

### 3. The 15m feed gate and the 360m snapshot gate have never bound — because they are unreachable

Ledger: 0 `feed-stale` skips, 0 `blockedWhy=snapshot-stale`, max `ctx.snapAgeMin` 43 across 213 skip
rows — and this is **not** signal suppression: `armWhileBlocked: true` means a blocked sweep still lands
as a ledger row; the liq feed is not an input to `Strategy.step`; 224/225 rows had newest-print age
≤ 15 m at signal time (all 20 burst rows 0.2–2.7 m). A sweep through a liq cluster *generates* prints,
so feed-stale needs a dead collector *during* a sweep — 0 coincidences in 7 weeks. The 360m gate engaged
only in post-wake IDLE tails (~185 functional minutes total, 7 windows). The 4,300 "liq feed stale"
WARNs are sleep tails, TICK-ERROR storms, or market quiet (ZEC 08-13 07:07–09:11 UTC: BTC printed 24
times, ZEC ranged 0.67%).

**The staleness that costs signals sits below both thresholds and nothing measures it.** One awake
publisher hole: **2026-08-30 18:19→23:54 UTC (336 m)** — `publish.log` `[2026-08-31 01:16:39] published
OK` then nothing until `06:52:04`; `pmset -g log` shows no sleep; swing heartbeat 49× in the window;
collector alive ($20.2M BTC prints in the 23:00 hour). `com.nikitiki.liqmap` simply did not fire for
5.6 h; the continuity check that would catch it dates from 09-04. Snapshot age peaked 332 m < 360, so
the hard gate stayed open and the agent ran on a 5.5-h-old map through BTC 78,830→76,971 (−2.4%) and
ZEC 870→817 (−6.2%). The stale map's nearest BTC down-wall (76,736) was ~1.3 ATR below the low; the
fresh 23:54 map put its densest walls at 76,556–77,253 — the band price had just flushed through and
bounced from (+1.1% by 00:15). Plausibly the only credible missed sweep-fade in 7 weeks, missed by
**cadence**, not by the gate. Unprovable (wall offsets depend on px at snapshot time).

Larger silent-suppression channel than either gate: **TICK ERROR storms** — 2,242 lines, 1,132
storm-minutes, 11 storms ≥ 10 min; `allMids` throws before `Strategy.step` runs (e.g. 08-09 13:18 wake +
93-min "fetch failed" storm = the `stale 1640m` WARN).

### 4. What the burst gate actually eats

At signal time `liquidations/<TOK>.jsonl` holds only WS rows for the trailing 10 minutes — gate/htx/
dydx/kraken land on the 30-min publish tick. Recomputed same-side 10m by venue at all 30 signal
timestamps: the ledgered `burst` equals binance + okx (+ bybit as-labelled) in 27/30; gate present in
only 2. So the gate is fed by **Binance (sampled) + OKX, with Bybit silently on the wrong side**. Across
21d BTC windows passing $2.5M (bybit corrected, 108 windows): binance median share 69%, bybit 23%, okx
4%; binance alone clears $2.5M in 81 of 108. `minBurstUsd` ("p50 of 180 signals", recomputed 07-16 from
raw files) was calibrated on the inverted feed, and the 07-16 open ledgered $6.72M where today's file
yields $2.98M — the store was rewritten after 07-16, so pre-07-16 partitions are not re-verifiable.

Coverage (14d, sleep windows excluded): BTC 85.9% of 10-min windows have a print, ZEC 86.0%, HYPE
70.7%; longest zero run on a non-sleep day 20–60 min (BTC). Collector reconnect storms (08-18: 238 okx /
233 bybit; 09-03: ~80 each, lockstep = network) did not produce >60 m BTC holes — REST poll + partial WS
kept `newestTs` fresh.

## What is safe to conclude

- The feed is not "one venue plus noise": Binance + OKX carry it; Bybit is present but mislabelled;
  the REST tail (htx/dydx/kraken) is <3% of USD and the `liq poll: htx=0 dydx=0 …` line is not a health
  signal for the feed.
- The burst gate neither protects nor harms on the evidence available (n=20/10; era-confounded).
- Neither staleness gate has ever done anything; the exposure is sub-threshold cadence holes while awake
  (one found) and TICK-ERROR storms (many) — an *alarm* on publisher cadence would protect more than a
  tighter hard gate.

## Open (ranked by how much it could flip a conclusion — from the critic)

1. Burst-vs-outcome over the full population (~225 signal rows with synthetic stop `extreme ± 0.75·ATR`,
   policy-E target): the only test that can say whether the feed carries signal at all.
2. Recompute the split with bybit corrected **and** corrected candles; check whether any of the 10 opens
   would have been skipped (09-03 passed at $2.53M — coin-flip margin).
3. Recompute `minBurstUsd` p50 on the corrected feed before touching the threshold.
4. Sequential-book counterfactual (cooldown 30 m, one position per token).
5. Count awake publisher holes ≥ 45 m (publish.log gaps minus `pmset` sleep minus storms) and magnet
   drift vs snapshot age — decides whether any hard gate protects anything or only a cadence alarm does.
6. TICK-ERROR storms: would-be signals lost (price through a magnet ±0.25 ATR during blind windows).
