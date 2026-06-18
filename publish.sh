#!/bin/bash
# Refresh the map (all 8 venues — run from a network where Binance/Bybit are reachable,
# e.g. this Mac) and publish liquidation-map.html to the gh-pages branch served by
# GitHub Pages at https://mindoozer.github.io/liquidation-map/.
#
# Force-pushes a single-commit orphan branch each time → no git-history bloat.
# Run manually: bash publish.sh   ·   or on a schedule via the LaunchAgent.

set -e
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export GIT_TERMINAL_PROMPT=0   # fail fast instead of hanging if git credentials are unavailable

ts="$(date '+%Y-%m-%d %H:%M:%S')"
echo "[$ts] fetch + render"
node fetch.mjs
node etf-flows.mjs || echo "[$ts] etf-flows failed (non-fatal)"
node snapshot.mjs || echo "[$ts] snapshot failed (non-fatal)"
node magnet-study.mjs || echo "[$ts] magnet study failed (non-fatal)"
node render.mjs
node collect-liqs.mjs || echo "[$ts] liq poll failed (non-fatal)"

echo "[$ts] publishing to gh-pages"
remote="$(git remote get-url origin)"
pub="$(mktemp -d)"
cp liquidation-map.html "$pub/index.html"
git -C "$pub" init -q
git -C "$pub" add -A
git -C "$pub" -c user.email="liqmap@local" -c user.name="liqmap-bot" commit -qm "publish $ts"
git -C "$pub" -c credential.helper='!gh auth git-credential' push -qf "$remote" HEAD:gh-pages
rm -rf "$pub"
echo "[$ts] published OK"
