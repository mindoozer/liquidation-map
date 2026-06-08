// Coinbase perp adapter (Phase 3 CEX) — BTC-PERP-INTX (Coinbase International).
// Public Advanced Trade market-data API, no key.
//   /api/v3/brokerage/market/products/{id}          → price + future_product_details.perpetual_details.open_interest (base coin)
//   /api/v3/brokerage/market/products/{id}/candles  → [{start(sec),low,high,open,close,volume(base)}] NEWEST-FIRST, ≤350/req

import { num, coinOiToUsd } from '../lib/normalize.mjs';

const BASE = 'https://api.coinbase.com/api/v3/brokerage/market/products';
const GRAN = { '1m': 'ONE_MINUTE', '5m': 'FIVE_MINUTE', '15m': 'FIFTEEN_MINUTE', '30m': 'THIRTY_MINUTE', '1h': 'ONE_HOUR', '2h': 'TWO_HOUR', '6h': 'SIX_HOUR', '1d': 'ONE_DAY' };
const SEC = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '2h': 7200, '6h': 21600, '1d': 86400 };

async function j(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
  return res.json();
}

// page backwards in ≤350-candle windows
async function fetchCandles(id, gran, sec, want) {
  const out = [], seen = new Set();
  let end = Math.floor(Date.now() / 1000), guard = 0;
  while (out.length < want && guard++ < 10) {
    const start = end - 340 * sec;
    const { candles } = await j(`${BASE}/${id}/candles?granularity=${gran}&start=${start}&end=${end}`);
    if (!candles?.length) break;
    let added = 0;
    for (const c of candles) if (!seen.has(c.start)) { seen.add(c.start); out.push(c); added++; }
    end = start; // next window older
    if (added === 0) break;
  }
  return out;
}

export async function fetchCoinbase(token, config) {
  const id = token.coinbase;
  if (!id) throw new Error(`token ${token.symbol} has no 'coinbase' product in config`);
  const iv = config.lookback?.interval ?? '1h';
  const gran = GRAN[iv] ?? 'ONE_HOUR';
  const sec = SEC[iv] ?? 3600;
  const want = config.lookback?.candles ?? 720;

  const [prod, candles] = await Promise.all([
    j(`${BASE}/${id}`),
    fetchCandles(id, gran, sec, want),
  ]);

  const fpd = prod.future_product_details || {};
  const markPrice = num(prod.price) || num(fpd.index_price) || num(prod.mid_market_price);
  const oiCoins = num(fpd.perpetual_details?.open_interest ?? fpd.open_interest);
  const openInterestUsd = coinOiToUsd(oiCoins, markPrice);

  const klines = candles
    .map((k) => { const h = num(k.high), l = num(k.low), c = num(k.close); return { t: num(k.start) * 1000, o: num(k.open), h, l, c, volUsd: num(k.volume) * ((h + l + c) / 3) }; })
    .sort((a, b) => a.t - b.t)
    .slice(-want);

  return { exchange: 'coinbase', symbol: id, token: token.symbol, type: 'linear', markPrice, openInterestUsd, klines };
}
