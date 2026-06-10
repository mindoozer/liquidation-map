// OKX v5 swap adapter (Phase 2). Public, no API key.
//   /api/v5/market/candles       [ts,o,h,l,c, vol(contracts), volCcy(base), volCcyQuote(USD), confirm] — NEWEST-FIRST, max 300/req
//   /api/v5/public/open-interest  oiUsd (already USD)
//   /api/v5/public/mark-price     markPx

import { num } from '../lib/normalize.mjs';

const BASE = 'https://www.okx.com';
const BAR = { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1H', '2h': '2H', '4h': '4H', '1d': '1D' };

async function j(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
  const d = await res.json();
  if (d.code !== '0') throw new Error(`okx code ${d.code}: ${d.msg}`);
  return d.data;
}

// page backwards (300/req) until we have `want` candles
async function fetchCandles(instId, bar, want) {
  const out = [];
  let after = '', guard = 0;
  while (out.length < want && guard++ < 12) {
    const batch = await j(`${BASE}/api/v5/market/candles?instId=${instId}&bar=${bar}&limit=300${after ? `&after=${after}` : ''}`);
    if (!batch.length) break;
    out.push(...batch);
    after = batch[batch.length - 1][0]; // oldest ts in batch → next page is older
    if (batch.length < 300) break;
  }
  return out;
}

export async function fetchOkx(token, config) {
  const instId = token.okx;
  if (!instId) throw new Error(`token ${token.symbol} has no 'okx' symbol in config`);
  const bar = BAR[config.lookback?.interval ?? '1h'] ?? '1H';
  const want = config.lookback?.candles ?? 720;

  const [candles, oi, mp] = await Promise.all([
    fetchCandles(instId, bar, want),
    j(`${BASE}/api/v5/public/open-interest?instId=${instId}`),
    j(`${BASE}/api/v5/public/mark-price?instId=${instId}`),
  ]);

  const markPrice = num(mp?.[0]?.markPx);
  const oi0 = oi?.[0] || {};
  const openInterestUsd = num(oi0.oiUsd) || num(oi0.oiCcy) * markPrice;

  // OI history (USD, ccy-aggregate) for OI-delta weighting — optional
  const oiMap = new Map();
  try {
    const oih = await j(`${BASE}/api/v5/rubik/stat/contracts/open-interest-volume?ccy=${token.symbol}&period=1H`);
    for (const r of oih || []) oiMap.set(num(r[0]), num(r[1]));
  } catch { /* OI history optional */ }

  const klines = candles
    .map((k) => ({ t: num(k[0]), o: num(k[1]), h: num(k[2]), l: num(k[3]), c: num(k[4]), volUsd: num(k[7]), oiUsd: oiMap.get(num(k[0])) ?? null }))
    .sort((a, b) => a.t - b.t) // → oldest-first
    .slice(-want);             // trim paging overshoot to the configured window

  // long/short skew inputs — optional. positions = top-trader position ratio (dollar-weighted).
  let longFracPositions = null, longFracAccounts = null;
  try {
    const r = await j(`${BASE}/api/v5/rubik/stat/contracts/long-short-position-ratio-contract-top-trader?instId=${instId}&period=1H&limit=1`);
    const ratio = num(r?.[0]?.[1]); // newest-first [[ts, ratio]]
    if (ratio > 0) longFracPositions = ratio / (1 + ratio);
  } catch { /* optional */ }
  try {
    const r = await j(`${BASE}/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=${token.symbol}&period=1H`);
    const ratio = num(r?.[0]?.[1]); // long/short account ratio
    if (ratio > 0) longFracAccounts = ratio / (1 + ratio);
  } catch { /* optional */ }

  return { exchange: 'okx', symbol: instId, token: token.symbol, type: 'linear', markPrice, openInterestUsd, longFracPositions, longFracAccounts, longFrac: longFracPositions ?? longFracAccounts, klines };
}
