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

# Health sentinel (workspace convention): data/health-err.txt → surfaced by health-all.mjs.
# fetch.mjs writes its own TOTAL/PARTIAL lines (and deletes the file on a clean fetch); this
# ERR trap catches every OTHER hard failure (render, git push, …) so a failing tick never
# looks green just because publish.log kept moving. It skips writing if the sentinel was
# already written during THIS tick (fetch's reason is more specific). set -e still makes the
# script exit nonzero after the trap, so launchd records the failure too.
# Every hard failure is ALSO appended to data/health-hist.txt (one timestamped line, pruned to
# 7 days by fetch.mjs): the sentinel dies with the next clean tick, the history is what
# health-all / `liqmap health` quote as the cause of a snapshot gap seen after the fact.
sentinel="data/health-err.txt"
hist="data/health-hist.txt"
mkdir -p data
tick_start="$(date +%s)"
trap 'code=$?; line="$(date -u +%Y-%m-%dT%H:%M:%SZ) liqmap publish tick failed (exit $code) at: $BASH_COMMAND"; echo "$line" >> "$hist"; if [ ! -f "$sentinel" ] || [ "$(stat -f %m "$sentinel")" -lt "$tick_start" ]; then echo "$line" > "$sentinel"; fi' ERR

ts="$(date '+%Y-%m-%d %H:%M:%S')"
echo "[$ts] fetch + render"
node fetch.mjs
node etf-flows.mjs || echo "[$ts] etf-flows failed (non-fatal)"
node snapshot.mjs || { echo "[$ts] snapshot failed (non-fatal)"; echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) liqmap snapshot.mjs failed (non-fatal) — no snapshot rows this tick" >> "$hist"; }   # the one non-fatal step that opens a continuity gap — leave a trace
node magnet-study.mjs || echo "[$ts] magnet study failed (non-fatal)"
node render.mjs
node collect-liqs.mjs || echo "[$ts] liq poll failed (non-fatal)"

echo "[$ts] publishing to gh-pages"
remote="$(git remote get-url origin)"
pub="$(mktemp -d)"
cp liquidation-map.html "$pub/index.html"
touch "$pub/.nojekyll"   # skip GitHub's legacy Jekyll build stage — it flakes ("Page build failed." waves, e.g. 2026-07-02+), and we publish pre-built static HTML anyway
git -C "$pub" init -q
git -C "$pub" add -A
git -C "$pub" -c user.email="liqmap@local" -c user.name="liqmap-bot" commit -qm "publish $ts"
git -C "$pub" -c credential.helper='!gh auth git-credential' push -qf "$remote" HEAD:gh-pages
rm -rf "$pub"
echo "[$ts] published OK"
