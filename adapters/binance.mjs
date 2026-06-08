// Binance USDT-M futures adapter (Phase 1).
// Pulls public market data (no API key) and normalizes to the common shape:
//   { exchange, symbol, token, type, markPrice, openInterestUsd, openInterestCoins, klines: [{t,o,h,l,c,volUsd}] }
//
// Endpoints (all public):
//   /fapi/v1/klines         candlestick history; index 7 = quote-asset volume (USDT ≈ USD)
//   /fapi/v1/openInterest   current open interest in base coin
//   /fapi/v1/premiumIndex   current mark price

import { num, coinOiToUsd } from '../lib/normalize.mjs';

const FAPI = 'https://fapi.binance.com';

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}${body ? ` — ${body.slice(0, 160)}` : ''}`);
  }
  return res.json();
}

export async function fetchBinance(token, config) {
  const symbol = token.binance;
  if (!symbol) throw new Error(`token ${token.symbol} has no 'binance' symbol in config`);

  const interval = config.lookback?.interval ?? '1h';
  const limit = Math.min(1500, config.lookback?.candles ?? 720);

  const [klinesRaw, oi, prem] = await Promise.all([
    fetchJson(`${FAPI}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`),
    fetchJson(`${FAPI}/fapi/v1/openInterest?symbol=${symbol}`),
    fetchJson(`${FAPI}/fapi/v1/premiumIndex?symbol=${symbol}`),
  ]);

  const markPrice = num(prem.markPrice);
  const openInterestCoins = num(oi.openInterest);
  const openInterestUsd = coinOiToUsd(openInterestCoins, markPrice);

  // open-interest history (USD) for OI-delta weighting — optional, aligned to kline open time
  const oiMap = new Map();
  try {
    const oih = await fetchJson(`${FAPI}/futures/data/openInterestHist?symbol=${symbol}&period=${interval}&limit=500`);
    for (const r of oih) oiMap.set(r.timestamp, num(r.sumOpenInterestValue));
  } catch { /* OI history optional */ }

  const klines = klinesRaw.map((k) => ({
    t: k[0],
    o: num(k[1]), h: num(k[2]), l: num(k[3]), c: num(k[4]),
    volUsd: num(k[7]), // quote-asset volume, already in USDT
    oiUsd: oiMap.get(k[0]) ?? null,
  }));

  // long/short account ratio (sentiment skew) — optional, must not fail the fetch
  let longFrac = null;
  try {
    const ls = await fetchJson(`${FAPI}/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=${interval}&limit=1`);
    longFrac = num(ls[ls.length - 1]?.longAccount) || null;
  } catch { /* L/S optional */ }

  return {
    exchange: 'binance',
    symbol,
    token: token.symbol,
    type: 'linear',
    markPrice,
    openInterestUsd,
    openInterestCoins,
    longFrac,
    klines,
  };
}
