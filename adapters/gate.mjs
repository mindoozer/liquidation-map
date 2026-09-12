// Gate.io USDT-futures adapter (scouted + field-verified 2026-07-09). Public, no key.
//   /api/v4/futures/usdt/contracts/{c}  → quanto_multiplier, position_size (ONE-SIDED, in
//                                         contracts), mark_price, funding_rate + funding_interval(s)
//   /api/v4/futures/usdt/candlesticks   → {t(SECONDS), o,h,l,c, v(contracts), sum(quote USD)}
//   /api/v4/futures/usdt/contract_stats → hourly history ≤180d: open_interest_usd, lsr_account,
//                                         top_lsr_size (top-trader position ratio)
//
// OI CONVENTION (the trap): Gate's ticker `total_size` and stats `open_interest{,_usd}` count
// BOTH sides of every contract — verified live: total_size ≈ 2 × contracts.position_size.
// Every other venue here reports one-sided OI, so: current OI = position_size × multiplier ×
// mark; historical oiUsd = open_interest_usd / 2. Do NOT use total_size.
//
// Funding interval varies per contract (most 8h; HYPE 4h) → normalize ×(28800 / interval).

import { num, coinOiToUsd } from '../lib/normalize.mjs';

const BASE = 'https://api.gateio.ws/api/v4/futures/usdt';
const SEC = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400 };

async function j(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
  return res.json();
}

export async function fetchGate(token, config) {
  const symbol = token.gate;
  if (!symbol) throw new Error(`token ${token.symbol} has no 'gate' symbol in config`);
  const iv = config.lookback?.interval ?? '1h';
  const want = Math.min(2000, config.lookback?.candles ?? 720);

  const [det, kl] = await Promise.all([
    j(`${BASE}/contracts/${symbol}`),
    j(`${BASE}/candlesticks?contract=${symbol}&interval=${iv}&limit=${want}`),
  ]);

  const mult = num(det.quanto_multiplier) || 1;
  const markPrice = num(det.mark_price);
  const openInterestCoins = num(det.position_size) * mult; // position_size is one-sided
  const openInterestUsd = coinOiToUsd(openInterestCoins, markPrice);

  // hourly OI history + L/S ratios from contract_stats — optional, never fatal
  const oiMap = new Map();
  let longFracPositions = null, longFracAccounts = null;
  try {
    const stats = await j(`${BASE}/contract_stats?contract=${symbol}&interval=1h&limit=${Math.min(1000, want)}`);
    let latest = null;
    for (const r of stats || []) {
      oiMap.set(num(r.time) * 1000, num(r.open_interest_usd) / 2); // both-sides → one-sided
      if (!latest || num(r.time) > num(latest.time)) latest = r;
    }
    if (latest) {
      const rp = num(latest.top_lsr_size), ra = num(latest.lsr_account); // long/short ratios
      if (rp > 0) longFracPositions = rp / (1 + rp);
      if (ra > 0) longFracAccounts = ra / (1 + ra);
    }
  } catch { /* stats optional */ }

  const klines = (kl || [])
    .map((k) => { const t = num(k.t) * 1000; return { t, o: num(k.o), h: num(k.h), l: num(k.l), c: num(k.c), volUsd: num(k.sum), oiUsd: oiMap.get(t) ?? null }; })
    .sort((a, b) => a.t - b.t);

  const interval = num(det.funding_interval) || 28800; // seconds; HYPE = 14400
  const funding8h = det.funding_rate != null ? num(det.funding_rate) * (28800 / interval) : null;

  return { exchange: 'gate', symbol, token: token.symbol, type: 'linear', markPrice, openInterestUsd, openInterestCoins, longFracPositions, longFracAccounts, longFrac: longFracPositions ?? longFracAccounts, funding8h, klines };
}
