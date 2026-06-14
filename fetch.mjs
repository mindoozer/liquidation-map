#!/usr/bin/env node
// Run every enabled venue adapter for every configured token, normalize to a
// common USD-denominated shape, and write data.json. Joined with the model at
// render time.
//
// Usage: node fetch.mjs

import yaml from 'js-yaml';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fetchBinance } from './adapters/binance.mjs';
import { fetchBybit } from './adapters/bybit.mjs';
import { fetchOkx } from './adapters/okx.mjs';
import { fetchHyperliquid } from './adapters/hyperliquid.mjs';
import { fetchDydx } from './adapters/dydx.mjs';
import { fetchHtx } from './adapters/htx.mjs';
import { fetchKraken } from './adapters/kraken.mjs';
import { fetchCoinbase } from './adapters/coinbase.mjs';

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

const out = { fetchedAt: new Date().toISOString(), tokens: tokensOut, errors };
writeFileSync(DATA_URL, JSON.stringify(out, null, 2));
console.error(`\nwrote data.json (${Object.keys(tokensOut).length} tokens, ${errors.length} errors, ${staleCount} stale-reused)`);
if (errors.length) for (const e of errors) console.error(`  ${e.token}/${e.venue}: ${e.error}`);
