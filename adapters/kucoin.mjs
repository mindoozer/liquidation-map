// KuCoin Futures adapter (scouted + field-verified 2026-07-09). Public, no key.
//   /api/v1/contracts/{sym}  → multiplier (coins per lot), openInterest (LOTS), markPrice,
//                              fundingFeeRate + fundingRateGranularity (ms)
//   /api/v1/kline/query      → [t(ms), o, h, l, c, vol(lots), turnover(USD)]; granularity in
//                              MINUTES; ≤200 rows per call → windowed pagination for 720
// BTC is XBTUSDTM (XBT, not BTC). No historical-OI or L/S endpoints.

import { num, coinOiToUsd } from '../lib/normalize.mjs';

const BASE = 'https://api-futures.kucoin.com/api/v1';
const MIN = { '1m': 1, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '4h': 240, '1d': 1440 };
const PAGE = 200; // observed per-request row cap

async function j(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
  const d = await res.json();
  if (d.code !== '200000') throw new Error(`kucoin code ${d.code}: ${d.msg}`);
  return d.data;
}

export async function fetchKucoin(token, config) {
  const symbol = token.kucoin;
  if (!symbol) throw new Error(`token ${token.symbol} has no 'kucoin' symbol in config`);
  const mins = MIN[config.lookback?.interval ?? '1h'] ?? 60;
  const want = config.lookback?.candles ?? 720;
  const stepMs = mins * 60e3;
  const now = Date.now();

  const det = await j(`${BASE}/contracts/${symbol}`);
  const mult = num(det.multiplier) || 1;
  const markPrice = num(det.markPrice) || num(det.lastTradePrice);
  const openInterestUsd = coinOiToUsd(num(det.openInterest) * mult, markPrice);

  // windowed pagination, oldest window first (PAGE rows per call)
  const windows = [];
  for (let end = now; windows.length * PAGE < want; end -= PAGE * stepMs) windows.push([end - PAGE * stepMs, end]);
  const rows = [];
  for (const [from, to] of windows.reverse()) {
    rows.push(...(await j(`${BASE}/kline/query?symbol=${symbol}&granularity=${mins}&from=${from}&to=${to}`) || []));
  }
  const seen = new Set();
  const klines = rows
    .filter((k) => { const t = num(k[0]); if (seen.has(t)) return false; seen.add(t); return true; })
    .map((k) => ({ t: num(k[0]), o: num(k[1]), h: num(k[2]), l: num(k[3]), c: num(k[4]), volUsd: num(k[6]), oiUsd: null }))
    .sort((a, b) => a.t - b.t)
    .slice(-want);

  const granMs = num(det.fundingRateGranularity) || 28800000;
  const funding8h = det.fundingFeeRate != null ? num(det.fundingFeeRate) * (28800000 / granMs) : null;

  return { exchange: 'kucoin', symbol, token: token.symbol, type: 'linear', markPrice, openInterestUsd, longFracPositions: null, longFracAccounts: null, longFrac: null, funding8h, klines };
}
