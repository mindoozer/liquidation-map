#!/usr/bin/env node
// Run every enabled venue adapter for every configured token, normalize to a
// common USD-denominated shape, and write data.json. Joined with the model at
// render time.
//
// Usage: node fetch.mjs

import yaml from 'js-yaml';
import { readFileSync, writeFileSync } from 'fs';
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

const tokensOut = {};
const errors = [];

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
      errors.push({ token: token.symbol, venue, error: e.message });
      process.stderr.write(`✗ ${token.symbol}/${venue} `);
    }
  }
  tokensOut[token.symbol] = { name: token.name, venues };
}

const out = { fetchedAt: new Date().toISOString(), tokens: tokensOut, errors };
writeFileSync(new URL('./data.json', import.meta.url), JSON.stringify(out, null, 2));
console.error(`\nwrote data.json (${Object.keys(tokensOut).length} tokens, ${errors.length} errors)`);
if (errors.length) for (const e of errors) console.error(`  ${e.token}/${e.venue}: ${e.error}`);
