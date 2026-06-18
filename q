#!/bin/bash
# q "<SQL>" — run a read-only DuckDB query against the liquidation-map flat files,
# with the canonical views (liqs · snaps · hourly_liqs · realized_skew · wall_history)
# preloaded from sql/views.sql. Examples:
#   ./q "FROM realized_skew"
#   ./q "SELECT tok, count(*), max(t) FROM liqs GROUP BY tok"
#   ./q "FROM wall_history WHERE tok='BTC' ORDER BY t DESC, wall_usd DESC LIMIT 8"
cd "$(dirname "$0")"
exec duckdb -init sql/views.sql -c "$*"
