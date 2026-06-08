// Kraken Futures linear perp adapter (Phase 3 CEX). Public, no key.
// Use PF_XBTUSD (linear "flexible_futures", multi-collateral) — the active BTC perp.
// (PI_XBTUSD is inverse/coin-margined and now low-volume → skipped: needs non-linear math.)
//   /derivatives/api/v3/tickers          → markPrice + openInterest (in base coin)
//   /api/charts/v1/trade/{sym}/{res}      → [{time(ms),open,high,low,close, volume(base coin)}]

import { num, coinOiToUsd } from '../lib/normalize.mjs';

const DERIV = 'https://futures.kraken.com/derivatives/api/v3';
const CHARTS = 'https://futures.kraken.com/api/charts/v1';
const RES = { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '4h': '4h', '1d': '1d' };
const SEC = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400 };

async function j(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
  return res.json();
}

export async function fetchKraken(token, config) {
  const symbol = token.kraken;
  if (!symbol) throw new Error(`token ${token.symbol} has no 'kraken' symbol in config`);
  const iv = config.lookback?.interval ?? '1h';
  const res = RES[iv] ?? '1h';
  const sec = SEC[iv] ?? 3600;
  const want = config.lookback?.candles ?? 720;
  const now = Math.floor(Date.now() / 1000);

  const [tk, ch] = await Promise.all([
    j(`${DERIV}/tickers`),
    j(`${CHARTS}/trade/${symbol}/${res}?from=${now - want * sec}&to=${now}`),
  ]);

  const t = (tk.tickers || []).find((x) => x.symbol === symbol) || {};
  const markPrice = num(t.markPrice) || num(t.last);
  const openInterestUsd = coinOiToUsd(t.openInterest, markPrice); // PF OI is in base coin

  const klines = (ch.candles || [])
    .map((k) => { const h = num(k.high), l = num(k.low), c = num(k.close); return { t: num(k.time), o: num(k.open), h, l, c, volUsd: num(k.volume) * ((h + l + c) / 3) }; })
    .sort((a, b) => a.t - b.t)
    .slice(-want);

  return { exchange: 'kraken', symbol, token: token.symbol, type: 'linear', markPrice, openInterestUsd, klines };
}
