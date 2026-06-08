// HTX (Huobi) USDT-margined linear swap adapter (Phase 3 CEX). Public, no key.
//   linear-swap-ex/market/history/kline   → data[]{id(sec),open,high,low,close, trade_turnover(USD)}
//   linear-swap-api/v1/swap_open_interest → data[0].value (OI already in USD)

import { num } from '../lib/normalize.mjs';

const BASE = 'https://api.hbdm.com';
const PERIOD = { '1m': '1min', '5m': '5min', '15m': '15min', '30m': '30min', '1h': '60min', '4h': '4hour', '1d': '1day' };

async function j(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
  const d = await res.json();
  if (d.status && d.status !== 'ok') throw new Error(`htx: ${d['err-msg'] || d.status}`);
  return d;
}

export async function fetchHtx(token, config) {
  const cc = token.htx;
  if (!cc) throw new Error(`token ${token.symbol} has no 'htx' contract_code in config`);
  const period = PERIOD[config.lookback?.interval ?? '1h'] ?? '60min';
  const size = Math.min(2000, config.lookback?.candles ?? 720);

  const [kl, oi] = await Promise.all([
    j(`${BASE}/linear-swap-ex/market/history/kline?contract_code=${cc}&period=${period}&size=${size}`),
    j(`${BASE}/linear-swap-api/v1/swap_open_interest?contract_code=${cc}`),
  ]);

  const klines = (kl.data || [])
    .map((k) => ({ t: num(k.id) * 1000, o: num(k.open), h: num(k.high), l: num(k.low), c: num(k.close), volUsd: num(k.trade_turnover) }))
    .sort((a, b) => a.t - b.t)
    .slice(-size);

  const openInterestUsd = num(oi.data?.[0]?.value);                  // already USD
  const markPrice = klines.length ? klines[klines.length - 1].c : 0; // last close ≈ mark

  return { exchange: 'htx', symbol: cc, token: token.symbol, type: 'linear', markPrice, openInterestUsd, klines };
}
