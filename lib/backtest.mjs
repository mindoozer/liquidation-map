// Reality-check backtest: does the model's predicted-wall structure match where
// open interest ACTUALLY got destroyed over the lookback window?
//
// No exchange exposes a usable historical liquidation feed for free (Binance's
// allForceOrders is retired, Bybit has no REST endpoint, OKX returns only the most
// recent ~1s sliver). But per-candle OPEN INTEREST is free and tells us when
// positions were destroyed: a sharp OI drop in one candle = positions closed/forced
// out. We infer the forced side from price direction (net-down candle → longs
// liquidated, net-up → shorts) and the cascade depth from the candle's wick.
//
// The comparison is done in OFFSET SPACE (% away from the contemporaneous price),
// NOT absolute price. Both the model walls and real liquidations trivially cluster
// near current price, so an absolute-price overlay would look "aligned" for no good
// reason. Offset space tests the model's actual structural claim: that liquidations
// occur at the leverage-implied distances it assumes (≈1% for 100×, ≈4% for 25×,
// ≈10% for 10×). That is the real question this backtest answers.
//
// CAVEATS (surfaced in the UI): OI also drops on voluntary closes, not only
// liquidations; side is inferred from price direction; only venues that publish
// per-candle OI history contribute (OKX/dYdX full window, Binance/Bybit partial).
// This is an INDIRECT, shape-level check — not a real-liquidation overlay (that
// needs an always-on WebSocket collector).

// 1-D Gaussian smoothing (edge-renormalized → mass-preserving), matches model.smooth.
function smooth1d(arr, sigmaBins) {
  if (!(sigmaBins > 0)) return arr.slice();
  const radius = Math.max(1, Math.ceil(sigmaBins * 3));
  const kernel = [];
  for (let d = -radius; d <= radius; d++) kernel.push(Math.exp(-(d * d) / (2 * sigmaBins * sigmaBins)));
  const n = arr.length, out = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let acc = 0, wsum = 0;
    for (let d = -radius; d <= radius; d++) {
      const j = i + d;
      if (j < 0 || j >= n) continue;
      const w = kernel[d + radius];
      acc += arr[j] * w; wsum += w;
    }
    out[i] = wsum > 0 ? acc / wsum : 0;
  }
  return out;
}

const cosine = (a, b) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
};

const peakOffset = (arr, offsets) => {
  let mi = -1, mv = 0;
  for (let i = 0; i < arr.length; i++) if (arr[i] > mv) { mv = arr[i]; mi = i; }
  return mi >= 0 ? offsets[mi] : null;
};

// Weighted-mean |offset| of a one-sided profile (how far from price the mass sits, on average).
const meanAbsOffset = (arr, offsets) => {
  let w = 0, s = 0;
  for (let i = 0; i < arr.length; i++) { w += arr[i]; s += arr[i] * Math.abs(offsets[i]); }
  return w > 0 ? s / w : null;
};

// map = output of buildMap (gives price P, display window, and predicted-wall bins).
export function buildBacktest(tokenData, map, config, tokenCfg = {}) {
  if (!map || !(map.price > 0)) return null;
  const P = map.price;
  const venues = tokenData?.venues || [];
  const binPct = (config.bin_pct ?? 0.1) / 100;
  const step = binPct;

  // Principled churn filter: a move can only liquidate positions whose leverage puts
  // their liq price within the sweep. The HIGHEST tier liquidates closest to entry, at
  // `nearEdge = 1/maxLev − mmr`. A candle whose sweep is shallower than nearEdge cannot
  // have liquidated ANY modeled position → its OI drop is voluntary churn, excluded.
  // Destroyed OI on a qualifying candle is spread across [sweep extreme, nearEdge], the
  // band of liq prices the move actually crossed (= the leverage tiers it wiped).
  const mmr = tokenCfg.maintenance_margin_rate ?? config.maintenance_margin_rate ?? 0.004;
  const maxLev = Math.max(...(map.tiers || []).map((t) => t.lev), 1);
  const nearEdge = Math.max(1e-4, 1 / maxLev - mmr); // closest any modeled position liquidates

  // offset grid spanning the model's display window: [-downSpan, +upSpan]
  const downSpan = (P - map.range.lo) / P;
  const upSpan = (map.range.hi - P) / P;
  const nDown = Math.max(1, Math.round(downSpan / step));
  const nUp = Math.max(1, Math.round(upSpan / step));
  const n = nDown + nUp;
  const offsets = [];
  for (let i = 0; i < n; i++) offsets.push(-downSpan + (i + 0.5) * step); // signed fraction from price
  const idxOf = (off) => Math.floor((off + downSpan) / step);

  // --- model profile in offset space (sum predicted long/short notional per offset bin) ---
  let modelLong = new Array(n).fill(0), modelShort = new Array(n).fill(0);
  for (const b of map.bins) {
    const i = idxOf((b.price - P) / P);
    if (i < 0 || i >= n) continue;
    modelLong[i] += b.totalLong || 0;
    modelShort[i] += b.totalShort || 0;
  }

  // --- empirical OI-destruction profile in offset space ---
  // reachLong/reachShort: how often price's hourly sweep REACHED each offset (over all
  // candles, OI or not). This is the missing factor between resting walls and realized
  // liquidations — near levels get swept far more often than far ones.
  const empLong = new Array(n).fill(0), empShort = new Array(n).fill(0);
  const reachLong = new Array(n).fill(0), reachShort = new Array(n).fill(0);
  let totalDestroyed = 0, oiVenues = [], maxOiCandles = 0, reachCandles = 0;
  let evLong = 0, evShort = 0;          // # qualifying liquidation-like candle-events
  for (const v of venues) {
    const ks = v.klines || [];
    // reach frequency from this venue's full price path (independent of OI availability)
    for (let i = 1; i < ks.length; i++) {
      const cur = ks[i], prev = ks[i - 1];
      if (!(prev.c > 0)) continue;
      reachCandles++;
      const downTo = Math.max((cur.l - prev.c) / prev.c, -downSpan); // negative
      const upTo = Math.min((cur.h - prev.c) / prev.c, upSpan);      // positive
      for (let j = 0; j < nDown; j++) if (offsets[j] >= downTo) reachLong[j]++;   // bin reached if sweep went at least this deep
      for (let j = nDown; j < n; j++) if (offsets[j] <= upTo) reachShort[j]++;
    }
    const withOi = ks.filter((k) => k.oiUsd != null).length;
    if (withOi < 2) continue;
    oiVenues.push(v.exchange);
    if (withOi > maxOiCandles) maxOiCandles = withOi;
    for (let i = 1; i < ks.length; i++) {
      const cur = ks[i], prev = ks[i - 1];
      if (cur.oiUsd == null || prev.oiUsd == null) continue;
      const dOi = cur.oiUsd - prev.oiUsd;
      if (dOi >= 0) continue;            // only OI destruction = positions closed/forced out
      const destroyed = -dOi;
      const ref = prev.c;
      if (!(ref > 0)) continue;
      if (cur.c < prev.c) {              // net-down candle → longs forced out, on the way to the low
        const lowOff = (cur.l - ref) / ref;            // negative; deepest sweep
        if (lowOff > -nearEdge) continue;              // too shallow to liquidate even the top tier → churn
        const a = Math.max(lowOff, -downSpan);         // deep edge (clamped to window)
        const iFrom = Math.max(0, idxOf(a));
        const iTo = Math.min(nDown - 1, idxOf(-nearEdge)); // near edge = highest-tier liq distance
        const cnt = iTo - iFrom + 1;
        if (cnt >= 1) { for (let j = iFrom; j <= iTo; j++) empLong[j] += destroyed / cnt; totalDestroyed += destroyed; evLong++; }
      } else if (cur.c > prev.c) {        // net-up candle → shorts forced out, on the way to the high
        const hiOff = (cur.h - ref) / ref;             // positive; highest sweep
        if (hiOff < nearEdge) continue;                // too shallow → churn
        const b = Math.min(hiOff, upSpan);
        const iFrom = Math.max(nDown, idxOf(nearEdge));
        const iTo = Math.min(n - 1, idxOf(b));
        const cnt = iTo - iFrom + 1;
        if (cnt >= 1) { for (let j = iFrom; j <= iTo; j++) empShort[j] += destroyed / cnt; totalDestroyed += destroyed; evShort++; }
      }
    }
  }

  // coverage: what fraction of this token's open interest do the backtest venues (those
  // with hourly OI history) actually see? A token whose OI lives mostly on a venue without
  // hourly OI (e.g. HYPE on Hyperliquid) is only partially observable → lower confidence.
  const totalOi = venues.reduce((s, v) => s + (v.openInterestUsd || 0), 0) || 1;
  const covOi = venues.reduce((s, v) => s + (oiVenues.includes(v.exchange) ? (v.openInterestUsd || 0) : 0), 0);
  const coverageFrac = covOi / totalOi;
  const missing = venues
    .filter((v) => !oiVenues.includes(v.exchange) && (v.openInterestUsd || 0) > 0)
    .sort((a, b) => b.openInterestUsd - a.openInterestUsd);
  const topMissing = missing.length ? { exchange: missing[0].exchange, frac: (missing[0].openInterestUsd || 0) / totalOi } : null;

  if (totalDestroyed <= 0 || !oiVenues.length || (evLong + evShort) < 3) {
    return { insufficient: true, oiVenues, P, nearEdge, events: evLong + evShort, coverageFrac, topMissing };
  }

  const sigmaBins = (config.smoothing_pct ?? 0) / 100 / binPct;
  // Re-binning the model into offset space aliases into a comb (every ~3rd bin 0) when the
  // auto-fit window edge isn't grid-aligned. Smooth it back to a continuous profile — this
  // also stops the comb from artificially deflating the model-vs-real cosine.
  modelLong = smooth1d(modelLong, Math.max(sigmaBins, 1));
  modelShort = smooth1d(modelShort, Math.max(sigmaBins, 1));
  // smooth empirical with the same Gaussian sigma so the two sides are comparable
  const empLongS = smooth1d(empLong, sigmaBins);
  const empShortS = smooth1d(empShort, sigmaBins);

  // sweep-reach-adjusted model = resting walls × how often price reaches each level.
  // This converts the "potential" wall map into "expected realized" liquidations,
  // directly comparable to the empirical destruction profile.
  const reachFreqLong = reachLong.map((c) => reachCandles > 0 ? c / reachCandles : 0);
  const reachFreqShort = reachShort.map((c) => reachCandles > 0 ? c / reachCandles : 0);
  const adjLong = smooth1d(modelLong.map((m, i) => m * reachFreqLong[i]), sigmaBins);
  const adjShort = smooth1d(modelShort.map((m, i) => m * reachFreqShort[i]), sigmaBins);

  // alignment: cosine similarity of model vs empirical shape, per side (non-negative → 0..1)
  const longSlice = (arr) => arr.slice(0, nDown);
  const shortSlice = (arr) => arr.slice(nDown);
  const cosLong = cosine(longSlice(modelLong), longSlice(empLongS));
  const cosShort = cosine(shortSlice(modelShort), shortSlice(empShortS));
  const cosOverall = cosine(modelLong.map((x, i) => x + modelShort[i]), empLongS.map((x, i) => x + empShortS[i]));
  // reach-adjusted alignment (the real validation: is wall PLACEMENT right once reach-weighted?)
  const cosAdjLong = cosine(longSlice(adjLong), longSlice(empLongS));
  const cosAdjShort = cosine(shortSlice(adjShort), shortSlice(empShortS));
  const cosAdjOverall = cosine(adjLong.map((x, i) => x + adjShort[i]), empLongS.map((x, i) => x + empShortS[i]));

  // normalized profiles for plotting (each to its own max → shape comparison)
  const maxOf = (...arrs) => Math.max(1e-9, ...arrs.map((a) => Math.max(...a)));
  const modelMax = maxOf(modelLong, modelShort);
  const empMax = maxOf(empLongS, empShortS);
  const adjMax = maxOf(adjLong, adjShort);

  const interval = config.lookback?.interval ?? '1h';
  const hoursPer = interval.endsWith('h') ? parseInt(interval) : interval.endsWith('d') ? parseInt(interval) * 24 : 1;
  const days = (maxOiCandles * hoursPer) / 24;

  return {
    insufficient: false,
    P, step, downSpan, upSpan, nDown, nUp, n, offsets, nearEdge,
    events: { long: evLong, short: evShort },
    coverageFrac, coverageOi: covOi, totalOi, topMissing,
    modelLong, modelShort, empLong: empLongS, empShort: empShortS, adjLong, adjShort,
    modelMax, empMax, adjMax,
    cosLong, cosShort, cosOverall,
    cosAdjLong, cosAdjShort, cosAdjOverall,
    modelPeak: { long: peakOffset(longSlice(modelLong), longSlice(offsets)), short: peakOffset(shortSlice(modelShort), shortSlice(offsets)) },
    empPeak: { long: peakOffset(longSlice(empLongS), longSlice(offsets)), short: peakOffset(shortSlice(empShortS), shortSlice(offsets)) },
    modelMeanAbs: { long: meanAbsOffset(longSlice(modelLong), longSlice(offsets)), short: meanAbsOffset(shortSlice(modelShort), shortSlice(offsets)) },
    empMeanAbs: { long: meanAbsOffset(longSlice(empLongS), longSlice(offsets)), short: meanAbsOffset(shortSlice(empShortS), shortSlice(offsets)) },
    totalDestroyed, oiVenues, days,
  };
}
