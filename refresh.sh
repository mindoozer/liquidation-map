#!/bin/bash
# Refresh wrapper: fetch venue data, then re-render liquidation-map.html.
# Runnable manually: bash refresh.sh   (later: wire to launchd like the dashboard)

set -e

cd "$(dirname "$0")"

# Make sure node is on PATH (launchd doesn't inherit shell PATH)
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

ts="$(date '+%Y-%m-%d %H:%M:%S')"
echo "[$ts] refresh starting"

if node fetch.mjs 2>&1; then
  node snapshot.mjs 2>&1 || echo "[$ts] snapshot failed (non-fatal)"
  node magnet-study.mjs 2>&1 || echo "[$ts] magnet study failed (non-fatal)"
  node render.mjs 2>&1
  node collect-liqs.mjs 2>&1 || echo "[$ts] liq poll failed (non-fatal)"
  echo "[$ts] refresh OK"
else
  echo "[$ts] fetch failed — keeping previous liquidation-map.html"
  exit 1
fi
