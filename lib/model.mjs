// Venue-agnostic liquidation-map model.
//
// Given normalized per-venue data (klines + open interest, all USD-denominated)
// for ONE token, estimate where leveraged positions would be force-liquidated and
// bucket the modeled notional by price and leverage tier.
//
// Method (after Kingfisher's published approach): project a leverage distribution
// onto recent price action and apply the liquidation-price formula (linear USDT perps):
//     long  liq ≈ E·(1 − 1/L + mmr)      (liquidates below entry)
//     short liq ≈ E·(1 + 1/L − mmr)      (liquidates above entry)
// where E = candle typical price (proxy entry), L = leverage, mmr = maint. margin.
//
// Magnitude/shape:
// • Each leverage tier gets a fixed share of current aggregate open interest (its
//   `weight`) — that is the $ anchor, so bars read in notional terms.
// • Within a tier, that share is spread across candle-entries ∝ volume × recency decay
//   0.5^(age / half_life). The half-life SHRINKS with leverage: 100× positions liquidate
//   on a ~0.6% move and turn over in hours, so only very recent entries count; 10×
//   positions need ~10% and persist for days/weeks. This is why "just use a longer flat
//   window" doesn't help — old entries are down-weighted per tier instead.
// • Forward-looking: a position is only shown if price hasn't already crossed its liq
//   level (longs below P, shorts above P). Already-liquidated entries are dropped.
// • Optional Gaussian smoothing across price bins de-noises the spiky profile.
//
// This is a MODEL / relative-intensity estimate, not real positions — no exchange
// publishes per-trader leverage. Same category as Coinglass / Kingfisher.

const DAY = 864e5;

// Gaussian low-pass across price bins, per tier & side (edge-renormalized → mass-preserving).
function smooth(bins, tiers, sigmaBins) {
  if (!(sigmaBins > 0)) return;
  const radius = Math.max(1, Math.ceil(sigmaBins * 3));
  const kernel = [];
  for (let d = -radius; d <= radius; d++) kernel.push(Math.exp(-(d * d) / (2 * sigmaBins * sigmaBins)));
  const n = bins.length;
  for (const t of tiers) {
    for (const side of ['long', 'short']) {
      const src = bins.map((b) => b[side][t.lev]);
      for (let i = 0; i < n; i++) {
        let acc = 0, wsum = 0;
        for (let d = -radius; d <= radius; d++) {
          const j = i + d;
          if (j < 0 || j >= n) continue;
          const w = kernel[d + radius];
          acc += src[j] * w; wsum += w;
        }
        bins[i][side][t.lev] = wsum > 0 ? acc / wsum : 0;
      }
    }
  }
}

export function buildMap(tokenData, config, tokenCfg = {}) {
  const venues = tokenData?.venues || [];
  // per-token tuning overrides global defaults (alts: higher mmr, lower max leverage)
  const mmr = tokenCfg.maintenance_margin_rate ?? config.maintenance_margin_rate ?? 0.004;
  let tiers = tokenCfg.leverage_tiers ?? config.leverage_tiers ?? [];
  if (tokenCfg.max_leverage) tiers = tiers.filter((t) => t.lev <= tokenCfg.max_leverage);
  const rangePct = (config.price_range_pct ?? 18) / 100;
  const binPct = (config.bin_pct ?? 0.1) / 100;

  // --- aggregate current price (OI-weighted) + total OI across venues ---
  let oiSum = 0, pxOiSum = 0, pxFallback = 0, nPx = 0;
  for (const v of venues) {
    if (v.markPrice > 0) { pxFallback += v.markPrice; nPx++; }
    if (v.openInterestUsd > 0 && v.markPrice > 0) { oiSum += v.openInterestUsd; pxOiSum += v.markPrice * v.openInterestUsd; }
  }
  const P = oiSum > 0 ? pxOiSum / oiSum : (nPx > 0 ? pxFallback / nPx : 0);
  if (!(P > 0)) return null;
  const totalOiUsd = oiSum;

  // aggregate long/short skew — OI-weighted over venues that report it (else 50/50)
  let lfW = 0, lfOi = 0, lsVenues = 0;
  for (const v of venues) {
    if (v.longFrac != null && v.openInterestUsd > 0) { lfW += v.longFrac * v.openInterestUsd; lfOi += v.openInterestUsd; lsVenues++; }
  }
  const longFrac = lfOi > 0 ? lfW / lfOi : 0.5;

  // --- flatten candles across venues (entry proxy + shape weight + time window) ---
  // Shape weight = per-candle "new positions opened here". With OI-delta weighting, that's
  // the RISE in open interest (rising OI = new positions); else traded volume. Each venue is
  // normalized then scaled by its own OI, so a venue contributes shape ∝ its open interest
  // (not its raw volume), and OI-Δ / volume venues are put on a comparable footing.
  const useOiDelta = config.oi_delta_weighting ?? false;
  const candles = [];
  let fromMs = Infinity, toMs = -Infinity, nCandles = 0, oiVenues = 0;
  for (const v of venues) {
    const ks = v.klines || [];
    if (ks.length) {
      if (ks[0].t < fromMs) fromMs = ks[0].t;
      if (ks[ks.length - 1].t > toMs) toMs = ks[ks.length - 1].t;
      if (ks.length > nCandles) nCandles = ks.length;
    }
    if (useOiDelta) {
      const deltas = ks.map((k, i) => (i > 0 && k.oiUsd != null && ks[i - 1].oiUsd != null) ? Math.max(0, k.oiUsd - ks[i - 1].oiUsd) : 0);
      const sumD = deltas.reduce((a, b) => a + b, 0);
      const useOi = sumD > 0;          // venue has usable OI history
      if (useOi) oiVenues++;
      const raws = useOi ? deltas : ks.map((k) => k.volUsd);
      const sumRaw = raws.reduce((a, b) => a + b, 0) || 1;
      const oi = v.openInterestUsd || 0;
      ks.forEach((k, i) => { const E = (k.h + k.l + k.c) / 3; const w = (raws[i] / sumRaw) * oi; if (w > 0 && E > 0) candles.push({ t: k.t, E, vol: w }); });
    } else {
      for (const k of ks) { const E = (k.h + k.l + k.c) / 3; if (E > 0 && k.volUsd > 0) candles.push({ t: k.t, E, vol: k.volUsd }); }
    }
  }
  const window = nCandles ? { fromMs, toMs, nCandles } : null;
  const nowMs = toMs > 0 ? toMs : 0; // decay reference = freshest candle

  // --- price bins across the WIDE compute range (display window is auto-fit below) ---
  const rangeLo = P * (1 - rangePct);
  const rangeHi = P * (1 + rangePct);
  const step = P * binPct;
  const nBinsFull = Math.max(1, Math.round((rangeHi - rangeLo) / step));
  const bins = [];
  for (let i = 0; i < nBinsFull; i++) {
    const long = {}, short = {};
    for (const t of tiers) { long[t.lev] = 0; short[t.lev] = 0; }
    bins.push({ price: rangeLo + (i + 0.5) * step, long, short, totalLong: 0, totalShort: 0, total: 0 });
  }
  const binIndex = (price) => (price < rangeLo || price >= rangeHi) ? -1 : Math.min(nBinsFull - 1, Math.floor((price - rangeLo) / step));

  // --- per-tier recency-decay normalization (half-life shrinks with leverage) ---
  const wSum = tiers.reduce((a, t) => a + (t.weight ?? 0), 0) || 1;
  const tierMeta = tiers.map((t) => {
    const hl = t.half_life_days ?? 7;
    let sum = 0;
    for (const c of candles) sum += c.vol * Math.pow(0.5, ((nowMs - c.t) / DAY) / hl);
    return { lev: t.lev, share: (t.weight ?? 0) / wSum, hl, sum };
  });

  // --- allocate each tier's OI share across candle-entries, apply liq formula + survivor filter ---
  if (totalOiUsd > 0) {
    for (const c of candles) {
      for (const tm of tierMeta) {
        if (tm.sum <= 0 || tm.share <= 0) continue;
        const decay = Math.pow(0.5, ((nowMs - c.t) / DAY) / tm.hl);
        const p = (c.vol * decay) / tm.sum;            // candle's share within this tier
        const base = tm.share * totalOiUsd * p;        // split long/short by sentiment skew
        const liqL = c.E * (1 - 1 / tm.lev + mmr);
        if (liqL < P) { const i = binIndex(liqL); if (i >= 0) bins[i].long[tm.lev] += longFrac * base; }
        const liqS = c.E * (1 + 1 / tm.lev - mmr);
        if (liqS > P) { const i = binIndex(liqS); if (i >= 0) bins[i].short[tm.lev] += (1 - longFrac) * base; }
      }
    }
  }

  // --- optional smoothing across price bins ---
  const sigmaBins = (config.smoothing_pct ?? 0) / 100 / binPct;
  smooth(bins, tiers, sigmaBins);

  // --- finalize per-bin totals (over full compute range) ---
  for (const b of bins) {
    for (const t of tiers) { b.totalLong += b.long[t.lev]; b.totalShort += b.short[t.lev]; }
    b.total = b.totalLong + b.totalShort;
  }

  // --- auto-fit display window per token: frame each side to cover `autofit_coverage` of its mass ---
  let lo = rangeLo, hi = rangeHi;
  const coverage = config.autofit_coverage ?? 0;
  if (coverage > 0 && coverage < 1) {
    const minHalf = (config.price_range_min_pct ?? 8) / 100;
    const fitEdge = (side) => { // side: bins on one side, ordered nearest-to-P first
      const mass = side.reduce((a, b) => a + b.total, 0);
      if (mass <= 0) return null;
      let acc = 0, edge = P;
      for (const b of side) { acc += b.total; edge = b.price; if (acc >= coverage * mass) break; }
      return edge;
    };
    const downEdge = fitEdge(bins.filter((b) => b.price < P).sort((a, b) => b.price - a.price));
    const upEdge = fitEdge(bins.filter((b) => b.price >= P).sort((a, b) => a.price - b.price));
    lo = Math.max(rangeLo, Math.min(P * (1 - minHalf), downEdge ?? P * (1 - minHalf)));
    hi = Math.min(rangeHi, Math.max(P * (1 + minHalf), upEdge ?? P * (1 + minHalf)));
  }

  // --- trim to display window + view metrics ---
  const view = bins.filter((b) => b.price >= lo && b.price <= hi);
  let maxBinTotal = 0, displayedUsd = 0;
  for (const b of view) { displayedUsd += b.total; if (b.total > maxBinTotal) maxBinTotal = b.total; }

  return {
    price: P,
    totalOiUsd,
    longFrac,                     // aggregate long share (sentiment skew)
    lsVenues,                     // # venues that supplied a long/short ratio
    weighting: useOiDelta ? 'oi-delta' : 'volume',
    oiVenues,                     // # venues whose shape used OI-delta (rest: volume)
    window,                       // { fromMs, toMs, nCandles } — period the model covers
    displayedUsd,                 // share of OI whose liq price is in price-range
    venues: venues.map((v) => ({ exchange: v.exchange, symbol: v.symbol, markPrice: v.markPrice, openInterestUsd: v.openInterestUsd })),
    tiers,
    bins: view,
    maxBinTotal,
    range: { lo, hi },
    nBins: view.length,
  };
}
