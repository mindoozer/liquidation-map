// Bybit v5 linear-perp adapter (Phase 2). Public, no API key.
//   /v5/market/kline    [start, o, h, l, c, volume(base), turnover(USD)] — NEWEST-FIRST
//   /v5/market/tickers  markPrice + openInterestValue (already USD)

import { num } from '../lib/normalize.mjs';

const BASE = 'https://api.bybit.com';
const INTERVAL = { '1m': '1', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '2h': '120', '4h': '240', '1d': 'D' };

async function j(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
  const d = await res.json();
  if (d.retCode !== 0) throw new Error(`bybit retCode ${d.retCode}: ${d.retMsg}`);
  return d.result;
}

export async function fetchBybit(token, config) {
  const symbol = token.bybit;
  if (!symbol) throw new Error(`token ${token.symbol} has no 'bybit' symbol in config`);
  const iv = INTERVAL[config.lookback?.interval ?? '1h'] ?? '60';
  const limit = Math.min(1000, config.lookback?.candles ?? 720);

  const [kl, tk] = await Promise.all([
    j(`${BASE}/v5/market/kline?category=linear&symbol=${symbol}&interval=${iv}&limit=${limit}`),
    j(`${BASE}/v5/market/tickers?category=linear&symbol=${symbol}`),
  ]);

  const t = tk.list?.[0] || {};
  const markPrice = num(t.markPrice) || num(t.lastPrice);
  const openInterestUsd = num(t.openInterestValue) || num(t.openInterest) * markPrice;

  // OI history (coin → USD via mark) for OI-delta weighting — optional
  const oiMap = new Map();
  try {
    const oih = await j(`${BASE}/v5/market/open-interest?category=linear&symbol=${symbol}&intervalTime=1h&limit=200`);
    for (const r of oih.list || []) oiMap.set(num(r.timestamp), num(r.openInterest) * markPrice);
  } catch { /* OI history optional */ }

  const klines = (kl.list || [])
    .map((k) => ({ t: num(k[0]), o: num(k[1]), h: num(k[2]), l: num(k[3]), c: num(k[4]), volUsd: num(k[6]), oiUsd: oiMap.get(num(k[0])) ?? null }))
    .sort((a, b) => a.t - b.t); // → oldest-first

  // Bybit exposes no public position-weighted ratio — account ratio only.
  let longFracAccounts = null;
  try {
    const r = await j(`${BASE}/v5/market/account-ratio?category=linear&symbol=${symbol}&period=1h&limit=1`);
    longFracAccounts = num(r.list?.[0]?.buyRatio) || null;
  } catch { /* L/S optional */ }

  return { exchange: 'bybit', symbol, token: token.symbol, type: 'linear', markPrice, openInterestUsd, longFracPositions: null, longFracAccounts, longFrac: longFracAccounts, funding8h: t.fundingRate != null && t.fundingRate !== '' ? +t.fundingRate : null, klines };
}
