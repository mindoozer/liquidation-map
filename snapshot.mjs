#!/usr/bin/env node
// Snapshot logger — appends one compact JSONL line per token per refresh to
// snapshots/<SYMBOL>.jsonl. Runs after fetch+render on every publish tick (30 min).
//
// Why: (1) FORWARD validation — today's reality-check compares current walls against
// the past month (mildly circular). Snapshots let us later test "did destruction hit
// the walls predicted AT THE TIME" — true forward hit-rates. (2) OWN OI HISTORY —
// per-venue OI every 30 min builds the hourly-OI series that venues like Hyperliquid
// (68% of HYPE's OI) never publish, growing backtest coverage with calendar time.
//
// Designed to be non-fatal: per-token errors are logged and skipped; reruns on the
// same data.json are deduped by fetchedAt. Growth ~ a few KB/day per token.
//
// Schema v1 (one line): { v, ts, tok, px, oi, lsRaw, lsUsed, ven: {exchange: oiUsd},
//   win: [loPct, hiPct], cum: {"-20","-10","-5","-2","2","5","10","20": usd},
//   top: [[offsetPct, usd] x10] }
// cum values beyond the auto-fit window clamp to that side's window total (~98% of mass).

import yaml from 'js-yaml';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { buildMap } from './lib/model.mjs';

const dir = new URL('./snapshots/', import.meta.url);
mkdirSync(dir, { recursive: true });

const config = yaml.load(readFileSync(new URL('./config.yml', import.meta.url), 'utf8'));
const { fetchedAt, tokens } = JSON.parse(readFileSync(new URL('./data.json', import.meta.url), 'utf8'));

const CUM_OFFSETS = [-20, -10, -5, -2, 2, 5, 10, 20]; // % from price

function cumAt(map, offPct) { // cumulative liq notional from price out to offPct
  const target = map.price * (1 + offPct / 100);
  let acc = 0;
  for (const b of map.bins) {
    if (offPct < 0) { if (b.price < map.price && b.price >= target) acc += b.totalLong || 0; }
    else { if (b.price >= map.price && b.price <= target) acc += b.totalShort || 0; }
  }
  return Math.round(acc);
}

function lastLoggedTs(file) {
  if (!existsSync(file)) return null;
  const txt = readFileSync(file, 'utf8').trimEnd();
  const nl = txt.lastIndexOf('\n');
  const last = nl >= 0 ? txt.slice(nl + 1) : txt;
  try { return JSON.parse(last).ts ?? null; } catch { return null; }
}

let logged = 0, skipped = 0;
for (const [symbol, tokenData] of Object.entries(tokens || {})) {
  try {
    const tokenCfg = (config.tokens || []).find((t) => t.symbol === symbol) || {};
    const map = buildMap(tokenData, config, tokenCfg);
    if (!map) { skipped++; continue; }
    const file = new URL(`${symbol}.jsonl`, dir);
    if (lastLoggedTs(file) === fetchedAt) { skipped++; continue; } // already logged this fetch

    const ven = {};
    for (const v of tokenData.venues || []) if (v.openInterestUsd > 0) ven[v.exchange] = Math.round(v.openInterestUsd);
    const cum = {};
    for (const o of CUM_OFFSETS) cum[String(o)] = cumAt(map, o);
    const top = map.bins
      .filter((b) => b.total > 0)
      .sort((a, b) => b.total - a.total)
      .slice(0, 10)
      .map((b) => [+(((b.price - map.price) / map.price) * 100).toFixed(2), Math.round(b.total)]);

    const line = {
      v: 1, ts: fetchedAt, tok: symbol,
      px: +map.price.toFixed(map.price < 100 ? 4 : 2),
      oi: Math.round(map.totalOiUsd),
      lsRaw: +map.longFracRaw.toFixed(4), lsUsed: +map.longFrac.toFixed(4),
      ven,
      win: [+(((map.range.lo - map.price) / map.price) * 100).toFixed(1), +(((map.range.hi - map.price) / map.price) * 100).toFixed(1)],
      cum, top,
    };
    appendFileSync(file, JSON.stringify(line) + '\n');
    logged++;
  } catch (e) {
    console.error(`snapshot ${symbol} failed: ${e.message}`);
  }
}
console.error(`snapshot: ${logged} logged, ${skipped} skipped (ts ${fetchedAt})`);
