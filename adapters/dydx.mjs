// dYdX v4 perp DEX adapter (Phase 3). Public Indexer API, no key.
//   /v4/perpetualMarkets?ticker=BTC-USD            → oraclePrice + openInterest (base coin)
//   /v4/candles/perpetualMarkets/{ticker}          → [{startedAt, usdVolume, ...}] NEWEST-FIRST, paged (limit 100)

import { num, coinOiToUsd } from '../lib/normalize.mjs';

const BASE = 'https://indexer.dydx.trade/v4';
const RES = { '1m': '1MIN', '5m': '5MINS', '15m': '15MINS', '30m': '30MINS', '1h': '1HOUR', '4h': '4HOURS', '1d': '1DAY' };

async function j(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
  return res.json();
}

// page backwards via createdBeforeOrAt (ISO), dedupe by startedAt
async function fetchCandles(ticker, resolution, want) {
  const out = [], seen = new Set();
  let before = '', guard = 0;
  while (out.length < want && guard++ < 12) {
    const url = `${BASE}/candles/perpetualMarkets/${ticker}?resolution=${resolution}&limit=100${before ? `&toISO=${encodeURIComponent(before)}` : ''}`;
    const { candles } = await j(url);
    if (!candles?.length) break;
    let added = 0;
    for (const c of candles) if (!seen.has(c.startedAt)) { seen.add(c.startedAt); out.push(c); added++; }
    before = candles[candles.length - 1].startedAt; // oldest in batch
    if (added === 0 || candles.length < 100) break;
  }
  return out;
}

export async function fetchDydx(token, config) {
  const ticker = token.dydx;
  if (!ticker) throw new Error(`token ${token.symbol} has no 'dydx' ticker in config`);
  const resolution = RES[config.lookback?.interval ?? '1h'] ?? '1HOUR';
  const want = config.lookback?.candles ?? 720;

  const [mkts, candles] = await Promise.all([
    j(`${BASE}/perpetualMarkets?ticker=${ticker}`),
    fetchCandles(ticker, resolution, want),
  ]);

  const m = mkts.markets?.[ticker] || {};
  const markPrice = num(m.oraclePrice);
  const openInterestUsd = coinOiToUsd(m.openInterest, markPrice);

  const klines = candles
    .map((c) => ({ t: Date.parse(c.startedAt), o: num(c.open), h: num(c.high), l: num(c.low), c: num(c.close), volUsd: num(c.usdVolume), oiUsd: num(c.startingOpenInterest) * markPrice }))
    .sort((a, b) => a.t - b.t)
    .slice(-want);

  return { exchange: 'dydx', symbol: ticker, token: token.symbol, type: 'linear', markPrice, openInterestUsd, funding8h: m.nextFundingRate != null ? +m.nextFundingRate * 8 : null /* dYdX funding is hourly */, klines };
}
