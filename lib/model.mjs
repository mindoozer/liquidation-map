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
// • Path-aware survivorship (config path_survivorship): an entry is ALSO dropped if any
//   LATER candle's wick (that venue's high/low) crossed its liq level — it liquidated
//   then, even though price recovered. Kills phantom near-price walls after sweeps.
// • Survivor renormalization: current OI is measured NOW, so each tier's per-side budget
//   is distributed over SURVIVING entries only — dead entries' weight redistributes to
//   survivors rather than vanishing, preserving the OI anchor and the long/short skew.
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

  // aggregate long/short skew. In a perp every contract has one long and one short, so
  // aggregate long notional ≡ short notional — skew can only enter through asymmetric
  // LEVERAGE MIX between sides, which the public ratios proxy weakly. Cross-check vs
  // realized OI destruction (2026-06-09) found ~50/50 for BTC/ZEC while account ratios
  // said 65%/41% — so: prefer position-weighted (top-trader) ratios over account
  // headcount, then DAMP toward neutral. used = 0.5 + (raw − 0.5)·tilt.
  const lsCfg = config.long_short_skew || {};
  const lsSource = lsCfg.source ?? 'positions';
  const lsTilt = lsSource === 'neutral' ? 0 : (lsCfg.tilt ?? 0.35);
  let lfW = 0, lfOi = 0, lsVenues = 0, lsPosVenues = 0, lsAcctVenues = 0;
  for (const v of venues) {
    const val = lsSource === 'accounts'
      ? (v.longFracAccounts ?? v.longFrac)
      : (v.longFracPositions ?? v.longFracAccounts ?? v.longFrac); // 'positions' (default): positions preferred
    if (val != null && v.openInterestUsd > 0) {
      lfW += val * v.openInterestUsd; lfOi += v.openInterestUsd; lsVenues++;
      if (lsSource !== 'accounts' && v.longFracPositions != null) lsPosVenues++; else lsAcctVenues++;
    }
  }
  const longFracRaw = lfOi > 0 ? lfW / lfOi : 0.5;
  const longFrac = 0.5 + (longFracRaw - 0.5) * lsTilt;

  // aggregate funding rate (per 8h, OI-weighted over venues that report it).
  // Positive = longs pay shorts = long crowding; the price of being on the crowded side.
  let fW = 0, fOi = 0, fundingVenues = 0;
  for (const v of venues) {
    if (v.funding8h != null && v.openInterestUsd > 0) { fW += v.funding8h * v.openInterestUsd; fOi += v.openInterestUsd; fundingVenues++; }
  }
  const funding8h = fOi > 0 ? fW / fOi : null;

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
    // path extremes strictly AFTER each candle (this venue's own price path):
    // a position is dead if a later wick crossed its liq level (mla = min low after,
    // mha = max high after; entry candle itself excluded — intra-candle order unknown).
    const nK = ks.length;
    const mlaArr = new Array(nK), mhaArr = new Array(nK);
    {
      let ml = Infinity, mh = -Infinity;
      for (let i = nK - 1; i >= 0; i--) {
        mlaArr[i] = ml; mhaArr[i] = mh;
        if (ks[i].l > 0 && ks[i].l < ml) ml = ks[i].l;
        if (ks[i].h > mh) mh = ks[i].h;
      }
    }
    if (useOiDelta) {
      const deltas = ks.map((k, i) => (i > 0 && k.oiUsd != null && ks[i - 1].oiUsd != null) ? Math.max(0, k.oiUsd - ks[i - 1].oiUsd) : 0);
      const sumD = deltas.reduce((a, b) => a + b, 0);
      const useOi = sumD > 0;          // venue has usable OI history
      if (useOi) oiVenues++;
      const raws = useOi ? deltas : ks.map((k) => k.volUsd);
      const sumRaw = raws.reduce((a, b) => a + b, 0) || 1;
      const oi = v.openInterestUsd || 0;
      ks.forEach((k, i) => { const E = (k.h + k.l + k.c) / 3; const w = (raws[i] / sumRaw) * oi; if (w > 0 && E > 0) candles.push({ t: k.t, E, vol: w, mla: mlaArr[i], mha: mhaArr[i] }); });
    } else {
      ks.forEach((k, i) => { const E = (k.h + k.l + k.c) / 3; if (E > 0 && k.volUsd > 0) candles.push({ t: k.t, E, vol: k.volUsd, mla: mlaArr[i], mha: mhaArr[i] }); });
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

  // --- per-tier recency decay (half-life shrinks with leverage) ---
  const wSum = tiers.reduce((a, t) => a + (t.weight ?? 0), 0) || 1;
  const tierMeta = tiers.map((t) => ({ lev: t.lev, share: (t.weight ?? 0) / wSum, hl: t.half_life_days ?? 7 }));

  // --- allocate each tier's OI share across SURVIVING candle-entries ---
  // Survivor filters: final-state (long liq below P, short above) AND path-aware (no
  // later wick crossed the liq level — config path_survivorship). Current OI is measured
  // NOW, so it must rest on positions that survived — each tier's per-side budget is
  // normalized over surviving entries (dead entries' weight redistributes to survivors
  // instead of vanishing; the OI anchor and the long/short skew are preserved exactly).
  const pathAware = config.path_survivorship ?? true;
  let pathKilledUsd = 0; // $ the path filter moved OFF already-swept levels (vs final-state-only)
  if (totalOiUsd > 0) {
    const nC = candles.length;
    const w = new Float64Array(nC), liqLs = new Float64Array(nC), liqSs = new Float64Array(nC);
    for (const tm of tierMeta) {
      if (tm.share <= 0) continue;
      // pass 1: per-entry decayed weight, liq levels, per-side survivor sums
      let sumL = 0, sumS = 0, sumAll = 0, killL = 0, killS = 0;
      for (let i = 0; i < nC; i++) {
        const c = candles[i];
        const wi = c.vol * Math.pow(0.5, ((nowMs - c.t) / DAY) / tm.hl);
        w[i] = wi; sumAll += wi;
        const liqL = c.E * (1 - 1 / tm.lev + mmr); liqLs[i] = liqL;
        const liqS = c.E * (1 + 1 / tm.lev - mmr); liqSs[i] = liqS;
        if (liqL < P) { if (!pathAware || liqL < c.mla) sumL += wi; else killL += wi; }
        if (liqS > P) { if (!pathAware || liqS > c.mha) sumS += wi; else killS += wi; }
      }
      if (sumAll <= 0) continue;
      pathKilledUsd += tm.share * totalOiUsd * (longFrac * killL + (1 - longFrac) * killS) / sumAll;
      // pass 2: distribute each side's budget over its survivors
      const budgetL = tm.share * totalOiUsd * longFrac;
      const budgetS = tm.share * totalOiUsd * (1 - longFrac);
      for (let i = 0; i < nC; i++) {
        const c = candles[i];
        if (sumL > 0 && liqLs[i] < P && (!pathAware || liqLs[i] < c.mla)) {
          const bi = binIndex(liqLs[i]); if (bi >= 0) bins[bi].long[tm.lev] += budgetL * (w[i] / sumL);
        }
        if (sumS > 0 && liqSs[i] > P && (!pathAware || liqSs[i] > c.mha)) {
          const bi = binIndex(liqSs[i]); if (bi >= 0) bins[bi].short[tm.lev] += budgetS * (w[i] / sumS);
        }
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
    longFrac,                     // long share USED by the model (damped toward 0.5)
    longFracRaw,                  // raw OI-weighted ratio before damping
    lsTilt,                       // damping factor applied (0 = forced neutral)
    lsSource,                     // 'positions' | 'accounts' | 'neutral'
    lsPosVenues, lsAcctVenues,    // how many venues contributed each ratio type
    lsVenues,                     // # venues that supplied a long/short ratio
    funding8h, fundingVenues,     // OI-weighted funding per 8h (+ = longs pay) & contributor count
    weighting: useOiDelta ? 'oi-delta' : 'volume',
    oiVenues,                     // # venues whose shape used OI-delta (rest: volume)
    window,                       // { fromMs, toMs, nCandles } — period the model covers
    displayedUsd,                 // share of OI whose liq price is in price-range
    pathAware,                    // path-aware survivorship enabled?
    pathKilledUsd,                // modeled mass dropped because a later wick swept its liq level
    venues: venues.map((v) => ({ exchange: v.exchange, symbol: v.symbol, markPrice: v.markPrice, openInterestUsd: v.openInterestUsd })),
    tiers,
    bins: view,
    maxBinTotal,
    range: { lo, hi },
    nBins: view.length,
  };
}
