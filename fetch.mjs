#!/usr/bin/env node
// Run every enabled venue adapter for every configured token, normalize to a
// common USD-denominated shape, and write data.json. Joined with the model at
// render time.
//
// Usage: node fetch.mjs

import yaml from 'js-yaml';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { fetchBinance } from './adapters/binance.mjs';
import { fetchBybit } from './adapters/bybit.mjs';
import { fetchOkx } from './adapters/okx.mjs';
import { fetchHyperliquid } from './adapters/hyperliquid.mjs';
import { fetchDydx } from './adapters/dydx.mjs';
import { fetchHtx } from './adapters/htx.mjs';
import { fetchKraken } from './adapters/kraken.mjs';
import { fetchCoinbase } from './adapters/coinbase.mjs';
import { fetchGate } from './adapters/gate.mjs';
import { fetchBitget } from './adapters/bitget.mjs';
import { fetchKucoin } from './adapters/kucoin.mjs';

// venue name (as in config.yml) → adapter fn. Add new venues here.
const ADAPTERS = {
  binance: fetchBinance,
  bybit: fetchBybit,
  okx: fetchOkx,
  hyperliquid: fetchHyperliquid,
  dydx: fetchDydx,
  htx: fetchHtx,
  kraken: fetchKraken,
  coinbase: fetchCoinbase,
  gate: fetchGate,
  bitget: fetchBitget,
  kucoin: fetchKucoin,
};

const config = yaml.load(readFileSync(new URL('./config.yml', import.meta.url), 'utf8'));

const enabledVenues = Object.entries(config.venues || {})
  .filter(([, v]) => v && v.enabled)
  .map(([name]) => name);

console.error(`venues: ${enabledVenues.join(', ') || '(none enabled)'}`);

// previous data.json → last-good fallback when a venue fails this tick (e.g. CDN/WAF
// flaps on a VPN exit). A stale venue is reused (so the map keeps its walls) but tagged
// with staleAsOf = the tick it was last FRESH, and dropped once older than STALE_MAX_MS.
const DATA_URL = new URL('./data.json', import.meta.url);
const STALE_MAX_MS = 6 * 3600e3;
const NOW = Date.now();
let prevByKey = new Map();
let prevFetchedAt = null;
try {
  if (existsSync(DATA_URL)) {
    const prev = JSON.parse(readFileSync(DATA_URL, 'utf8'));
    prevFetchedAt = prev.fetchedAt;
    for (const [sym, td] of Object.entries(prev.tokens || {}))
      for (const v of td.venues || []) prevByKey.set(`${sym}/${v.exchange}`, v);
  }
} catch { /* no/corrupt prev — fallback simply unavailable */ }

const tokensOut = {};
const errors = [];
let staleCount = 0;

for (const token of config.tokens || []) {
  const venues = [];
  for (const venue of enabledVenues) {
    const adapter = ADAPTERS[venue];
    if (!adapter) { errors.push({ token: token.symbol, venue, error: 'no adapter registered' }); continue; }
    if (token[venue] == null) continue; // token not listed on this venue — skip silently
    try {
      venues.push(await adapter(token, config));
      process.stderr.write(`✓ ${token.symbol}/${venue} `);
    } catch (e) {
      const cause = e.cause?.code || e.cause?.message || e.message; // surface real reason, not generic "fetch failed"
      errors.push({ token: token.symbol, venue, error: cause });
      // reuse last-good if recent enough; preserve original staleAsOf so age reflects true last-fresh time
      const prev = prevByKey.get(`${token.symbol}/${venue}`);
      const staleAsOf = prev?.staleAsOf ?? prevFetchedAt;
      if (prev && prev.openInterestUsd > 0 && staleAsOf && NOW - Date.parse(staleAsOf) <= STALE_MAX_MS) {
        venues.push({ ...prev, stale: true, staleAsOf });
        staleCount++;
        process.stderr.write(`◷ ${token.symbol}/${venue}(stale) `);
        continue;
      }
      process.stderr.write(`✗ ${token.symbol}/${venue} `);
    }
  }
  tokensOut[token.symbol] = { name: token.name, venues };
}

// health sentinel (workspace convention): data/health-err.txt, surfaced by the root
// health-all.mjs. TOTAL (no usable venue data) → sentinel + exit 1; PARTIAL (some venue
// errors but the map is still usable) → sentinel summary, exit 0; clean fetch → delete it.
const SENTINEL = new URL('./data/health-err.txt', import.meta.url);
// Append-only failure history beside the sentinel. The sentinel is deleted by the next clean fetch,
// so by the time anyone looks (morning health-all, `liqmap health`) yesterday's cause is gone — on
// 2026-09-03 two all-ENOTFOUND ticks + a failed push left no trace by morning. The history keeps one
// timestamped line per failed tick (publish.sh's ERR trap appends its own), pruned to HISTORY_KEEP_DAYS
// on every run, and is what health-all quotes as the likely cause of a snapshot gap.
const HISTORY = new URL('./data/health-hist.txt', import.meta.url);
const HISTORY_KEEP_DAYS = 7;
mkdirSync(new URL('./data/', import.meta.url), { recursive: true });

function pruneHistory() { // drop lines older than HISTORY_KEEP_DAYS (and unparseable ones); no-op when nothing to drop
  let lines;
  try { lines = readFileSync(HISTORY, 'utf8').split('\n').filter(Boolean); } catch { return; }
  const cutoff = Date.now() - HISTORY_KEEP_DAYS * 86400e3;
  const kept = lines.filter((l) => Date.parse(l.split(' ', 1)[0]) >= cutoff);
  if (kept.length !== lines.length) writeFileSync(HISTORY, kept.map((l) => `${l}\n`).join(''));
}
function recordFailure(sentinelText, historyLine) {
  writeFileSync(SENTINEL, sentinelText);
  appendFileSync(HISTORY, `${historyLine}\n`);
}

pruneHistory();
const usable = Object.values(tokensOut).reduce((n, t) => n + t.venues.length, 0);
const sample = errors.length ? ` — e.g. ${errors[0].token}/${errors[0].venue}: ${errors[0].error}` : '';

if (usable === 0) {
  // every venue errored with nothing reusable — keep the previous data.json intact (it is
  // the stale-reuse fallback) and fail the tick so launchd records a nonzero exit.
  const stamp = new Date().toISOString();
  const msg = `liqmap fetch TOTAL: 0 usable venue feeds (${errors.length} errors) — data.json not rewritten`;
  recordFailure(`${stamp} ${msg}\n`, `${stamp} ${msg}${sample}`);
  console.error(`\nFATAL: no usable venue data (${errors.length} errors) — keeping previous data.json`);
  for (const e of errors) console.error(`  ${e.token}/${e.venue}: ${e.error}`);
  process.exit(1);
}

const out = { fetchedAt: new Date().toISOString(), tokens: tokensOut, errors };
writeFileSync(DATA_URL, JSON.stringify(out, null, 2));
console.error(`\nwrote data.json (${Object.keys(tokensOut).length} tokens, ${errors.length} errors, ${staleCount} stale-reused)`);
if (errors.length) {
  for (const e of errors) console.error(`  ${e.token}/${e.venue}: ${e.error}`);
  const stamp = new Date().toISOString();
  const msg = `liqmap fetch PARTIAL: ${errors.length} venue errors (${staleCount} stale-reused, ${usable} venue feeds usable)`;
  recordFailure(`${stamp} ${msg}\n` + errors.slice(0, 2).map((e) => `  ${e.token}/${e.venue}: ${e.error}\n`).join(''),
    `${stamp} ${msg}${sample}`);
} else if (existsSync(SENTINEL)) {
  unlinkSync(SENTINEL);
}
