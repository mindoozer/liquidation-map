// Squeeze-risk score — "which side is crowded, and is the exit door small?"
// Combines three independent crowding reads per token (each votes −1/0/+1 toward
// long-squeeze (+) = downside flush, or short-squeeze (−) = upside rip):
//   1. funding (per 8h, OI-weighted):  positive = longs pay = long crowding
//   2. fuel asymmetry within ±5%:      more long fuel below than short fuel above
//   3. realized 24h liq pressure:      whose positions have already been burning
// Plus a context stat (not scored): absorbability = top wall $ ÷ avg hourly volume —
// can this market actually absorb the forced flow, or does it cascade?
// |score| ≥ 3 → HIGH, = 2 → ELEVATED, ≤ 1 → balanced. Transparent by construction —
// every component is shown next to the verdict.

import { readFileSync, existsSync } from 'fs';

// cumulative fuel resting within ±pct of price (from the display bins)
export function fuelWithin(map, pct) {
  const lo = map.price * (1 - pct / 100), hi = map.price * (1 + pct / 100);
  let L = 0, S = 0;
  for (const b of map.bins) {
    if (b.price < map.price && b.price >= lo) L += b.totalLong || 0;
    else if (b.price >= map.price && b.price <= hi) S += b.totalShort || 0;
  }
  return { L, S };
}

export function computeSqueeze(map, tokenData, liqDir, symbol, nowMs = Date.now()) {
  const f = map.funding8h; // per 8h, + = longs pay

  const { L: fuelL, S: fuelS } = fuelWithin(map, 5);
  const ratio = fuelS > 0 ? fuelL / fuelS : (fuelL > 0 ? Infinity : 1);

  // realized liquidation pressure, last 24h, from the real-event store
  let realizedLong = 0, realizedShort = 0;
  try {
    const file = new URL(`${symbol}.jsonl`, liqDir);
    if (existsSync(file)) {
      const cutoff = nowMs - 24 * 3600e3;
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.ts > cutoff && ev.usd > 0) { if (ev.side === 'long') realizedLong += ev.usd; else if (ev.side === 'short') realizedShort += ev.usd; }
        } catch {}
      }
    }
  } catch {}
  const rTot = realizedLong + realizedShort;
  const longShare = rTot > 0 ? realizedLong / rTot : null;

  // absorbability: biggest single wall vs average hourly traded volume (last 24h, all venues)
  let vol24 = 0;
  for (const v of tokenData?.venues || []) {
    const ks = v.klines || [];
    for (let i = Math.max(0, ks.length - 24); i < ks.length; i++) vol24 += ks[i].volUsd || 0;
  }
  const hourlyVol = vol24 / 24;
  const absorb = hourlyVol > 0 ? map.maxBinTotal / hourlyVol : null;

  let score = 0;
  if (f != null) score += f > 0.0001 ? 1 : f < -0.0001 ? -1 : 0;             // ±0.01%/8h
  if (isFinite(ratio)) score += ratio > 1.5 ? 1 : ratio < 1 / 1.5 ? -1 : 0;
  if (longShare != null && rTot >= 100000) score += longShare > 0.6 ? 1 : longShare < 0.4 ? -1 : 0;

  const dir = score >= 2 ? 'long' : score <= -2 ? 'short' : null;            // long = downside flush risk
  const level = Math.abs(score) >= 3 ? 'high' : Math.abs(score) === 2 ? 'elevated' : 'balanced';

  return { funding8h: f, fundingVenues: map.fundingVenues, fuelL, fuelS, ratio, realizedLong, realizedShort, longShare, hourlyVol, absorb, score, dir, level };
}
