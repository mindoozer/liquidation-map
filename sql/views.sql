-- Canonical DuckDB views over the liquidation-map flat files. Loaded by ./q before each
-- query. Read-only, in-memory; the JSONL files on disk are the source of truth.
-- The [A-Z]*.jsonl glob matches per-token files and excludes alerts.jsonl / dotfiles.

-- liqs — every real, exchange-confirmed liquidation event (ws + REST poll).
--   ts = epoch ms; t = UTC timestamp; side = the LIQUIDATED position side; usd = notional.
CREATE OR REPLACE VIEW liqs AS
SELECT v, src, venue, tok, ts,
       to_timestamp(ts / 1000.0) AS t,
       side, px, usd, id
FROM read_json_auto('liquidations/[A-Z]*.jsonl',
                    format='newline_delimited', union_by_name=true, sample_size=-1);

-- snaps — one model snapshot per token per ~30-min tick (ts here is an ISO string).
--   fuel_long/short = cumulative resting fuel within ±5% of price; sqz = squeeze score.
CREATE OR REPLACE VIEW snaps AS
SELECT v, mv, tok,
       ts::TIMESTAMP AS t,
       px, oi, lsRaw, lsUsed, f8 AS funding8h, sqz,
       fuel5[1] AS fuel_long, fuel5[2] AS fuel_short,
       win, cum, top
FROM read_json_auto('snapshots/[A-Z]*.jsonl',
                    format='newline_delimited', union_by_name=true, sample_size=-1);

-- hourly_liqs — real liquidation $ and event count per token / hour / side.
CREATE OR REPLACE VIEW hourly_liqs AS
SELECT tok, date_trunc('hour', t) AS hour, side,
       count(*) AS n, round(sum(usd)) AS usd
FROM liqs GROUP BY 1, 2, 3;

-- realized_skew — realized long-share by token (the V1 validation: real events, $-weighted).
CREATE OR REPLACE VIEW realized_skew AS
SELECT tok,
       count(*) AS events,
       round(sum(usd)) AS usd_total,
       round(sum(usd) FILTER (WHERE side = 'long'))  AS usd_long,
       round(sum(usd) FILTER (WHERE side = 'short')) AS usd_short,
       round(sum(usd) FILTER (WHERE side = 'long') / nullif(sum(usd), 0), 3) AS long_share,
       min(t) AS since, max(t) AS until
FROM liqs GROUP BY tok ORDER BY usd_total DESC NULLS LAST;

-- wall_history — the top predicted walls over time, one row per wall per snapshot.
--   offset_pct = % from price (neg = below/long side); wall_px = the absolute price level.
CREATE OR REPLACE VIEW wall_history AS
SELECT tok, t, px,
       round(w[1], 2)        AS offset_pct,
       round(w[2])           AS wall_usd,
       round(px * (1 + w[1] / 100.0), 4) AS wall_px
FROM snaps, UNNEST(top) AS u(w);
