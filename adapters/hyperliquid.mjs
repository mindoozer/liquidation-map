// Hyperliquid perp DEX adapter (Phase 3). Public POST /info, no API key.
//   metaAndAssetCtxs → per-coin markPx + openInterest (in base coin)
//   candleSnapshot   → [{t,T,o,h,l,c, v(base-coin volume), n}] — oldest-first
// Note: Hyperliquid BTC caps at 40× leverage; we still apply the global tier
// distribution (a modeled assumption), same as the CEX venues.
// HIP-3 builder-deployed markets (pre-IPO equities etc.) live on separate dexs and
// are addressed as "<dex>:<COIN>" (e.g. xyz:SPCX) — meta queries need the dex param,
// candleSnapshot takes the full prefixed name. Give such tokens their own low-leverage
// tier ladder in config (asset maxLeverage is small; HL mmr = 1/(2·maxLev)).

import { num, coinOiToUsd } from '../lib/normalize.mjs';

const ENDPOINT = 'https://api.hyperliquid.xyz/info';
const MS = { '1m': 60e3, '5m': 300e3, '15m': 900e3, '30m': 1800e3, '1h': 3600e3, '4h': 14400e3, '1d': 86400e3 };

async function post(body) {
  const res = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res.json();
}

export async function fetchHyperliquid(token, config) {
  const coin = token.hyperliquid;
  if (!coin) throw new Error(`token ${token.symbol} has no 'hyperliquid' coin in config`);
  const interval = config.lookback?.interval ?? '1h';
  const want = config.lookback?.candles ?? 720;
  const ms = MS[interval] ?? 3600e3;
  const now = Date.now();

  const dex = coin.includes(':') ? coin.split(':')[0] : undefined; // HIP-3 dex prefix
  const [metaCtx, candles] = await Promise.all([
    post(dex ? { type: 'metaAndAssetCtxs', dex } : { type: 'metaAndAssetCtxs' }),
    post({ type: 'candleSnapshot', req: { coin, interval, startTime: now - want * ms, endTime: now } }),
  ]);

  const [meta, ctxs] = metaCtx;
  const i = meta.universe.findIndex((u) => u.name === coin);
  if (i < 0) throw new Error(`coin ${coin} not in Hyperliquid universe`);
  const ctx = ctxs[i] || {};
  const markPrice = num(ctx.markPx) || num(ctx.oraclePx) || num(ctx.midPx);
  const openInterestUsd = coinOiToUsd(ctx.openInterest, markPrice);

  const klines = (candles || [])
    .map((k) => {
      const h = num(k.h), l = num(k.l), c = num(k.c);
      return { t: num(k.t), o: num(k.o), h, l, c, volUsd: num(k.v) * ((h + l + c) / 3) }; // base vol → USD
    })
    .sort((a, b) => a.t - b.t)
    .slice(-want);

  return { exchange: 'hyperliquid', symbol: coin, token: token.symbol, type: 'linear', markPrice, openInterestUsd, funding8h: ctx.funding != null ? +ctx.funding * 8 : null /* HL funding is hourly */, klines };
}
