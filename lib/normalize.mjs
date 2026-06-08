// Shared unit-normalization helpers for venue adapters.
// Everything downstream is denominated in USD notional, so CEX/DEX and
// linear/inverse contracts can be mixed into one aggregate map.

export const num = (v) => {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : 0;
};

// Linear (USDT/USDC-margined) perps: open interest is reported in the base coin,
// so USD notional = coins × mark price.
export const coinOiToUsd = (oiCoins, markPrice) => num(oiCoins) * num(markPrice);

// Inverse (coin-margined) perps already report OI in USD notional (Phase 3).
export const inverseOiToUsd = (oiUsd) => num(oiUsd);
