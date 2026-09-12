// Bitget v2 mix (USDT-futures) adapter (scouted + field-verified 2026-07-09). Public, no key.
//   /api/v2/mix/market/ticker              → markPrice, holdingAmount (OI in base coin), fundingRate (per 8h)
//   /api/v2/mix/market/candles             → [ts(ms), o, h, l, c, baseVol, quoteVol(USD)] ≤1000, ascending
//   /api/v2/mix/market/position-long-short → longPositionRatio (FRACTION) — ~24 hourly pts, ts lags ~1h
//   /api/v2/mix/market/account-long-short  → longAccountRatio (FRACTION)
// Symbol trap: HYPEUSDT vs HYPERUSDT are different tokens — the ?symbol= filter is exact-match,
// but never fuzzy-match Bitget symbols upstream. No historical-OI endpoint exists.

import { num, coinOiToUsd } from '../lib/normalize.mjs';

const BASE = 'https://api.bitget.com/api/v2/mix/market';
const GRAN = { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1H', '4h': '4H', '1d': '1D' };

async function j(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
  const d = await res.json();
  if (d.code !== '00000') throw new Error(`bitget code ${d.code}: ${d.msg}`);
  return d.data;
}

export async function fetchBitget(token, config) {
  const symbol = token.bitget;
  if (!symbol) throw new Error(`token ${token.symbol} has no 'bitget' symbol in config`);
  const gran = GRAN[config.lookback?.interval ?? '1h'] ?? '1H';
  const limit = Math.min(1000, config.lookback?.candles ?? 720);

  const [tk, kl, ct] = await Promise.all([
    j(`${BASE}/ticker?productType=USDT-FUTURES&symbol=${symbol}`),
    j(`${BASE}/candles?symbol=${symbol}&productType=USDT-FUTURES&granularity=${gran}&limit=${limit}`),
    j(`${BASE}/contracts?productType=USDT-FUTURES&symbol=${symbol}`).catch(() => null), // for fundInterval
  ]);

  const t = tk?.[0] || {};
  const markPrice = num(t.markPrice) || num(t.lastPr);
  const openInterestUsd = coinOiToUsd(t.holdingAmount, markPrice);
  // funding interval varies per contract (HYPE/NMR fund every 4h; most 8h) — ticker
  // fundingRate is per-settlement, so normalize to /8h like the Gate/KuCoin adapters
  const fundHours = num(ct?.[0]?.fundInterval) || 8;

  const klines = (kl || [])
    .map((k) => ({ t: num(k[0]), o: num(k[1]), h: num(k[2]), l: num(k[3]), c: num(k[4]), volUsd: num(k[6]), oiUsd: null }))
    .sort((a, b) => a.t - b.t);

  // both ratio flavors exist; rows are a short hourly series — use the newest row
  const latestRow = (rows) => (rows || []).reduce((a, r) => (!a || num(r.ts) > num(a.ts) ? r : a), null);
  let longFracPositions = null, longFracAccounts = null;
  try {
    const r = latestRow(await j(`${BASE}/position-long-short?symbol=${symbol}&period=1h`));
    if (r) longFracPositions = num(r.longPositionRatio) || null;
  } catch { /* optional */ }
  try {
    const r = latestRow(await j(`${BASE}/account-long-short?symbol=${symbol}&period=1h`));
    if (r) longFracAccounts = num(r.longAccountRatio) || null;
  } catch { /* optional */ }

  return { exchange: 'bitget', symbol, token: token.symbol, type: 'linear', markPrice, openInterestUsd, longFracPositions, longFracAccounts, longFrac: longFracPositions ?? longFracAccounts, funding8h: t.fundingRate != null && t.fundingRate !== '' ? +t.fundingRate * (8 / fundHours) : null, klines };
}
