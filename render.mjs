#!/usr/bin/env node
// Reads config.yml + data.json, runs the liquidation model per token, and writes
// liquidation-map.html — a dark-theme page with a price-axis map whose bars are
// stacked & colored by leverage tier (Coinglass / Kingfisher style).
//
// Usage: node render.mjs

import yaml from 'js-yaml';
import { readFileSync, writeFileSync } from 'fs';
import { buildMap } from './lib/model.mjs';
import { buildBacktest } from './lib/backtest.mjs';
import { computeSqueeze } from './lib/squeeze.mjs';

const LIQ_DIR = new URL('./liquidations/', import.meta.url);

const config = yaml.load(readFileSync(new URL('./config.yml', import.meta.url), 'utf8'));
const { fetchedAt, tokens, errors = [] } = JSON.parse(readFileSync(new URL('./data.json', import.meta.url), 'utf8'));
const interval = config.lookback?.interval ?? '1h';

// ===== helpers =====
const fmtUsd = (n) => {
  if (n == null || !isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + n.toFixed(0);
};
const fmtPrice = (n) => n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: n < 100 ? 2 : 0 });
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtFunding = (x) => x == null ? '—' : ((x >= 0 ? '+' : '') + (x * 100).toFixed(3) + '%/8h');
const fmtAge = (ms) => { const m = Math.round(ms / 60000); return m < 60 ? m + 'm' : (m / 60).toFixed(1) + 'h'; };

// crowding strip: verdict + every component it was computed from (no black box)
function squeezeStrip(sq) {
  const head = sq.dir === 'long' ? `▼ Long-squeeze ${sq.level}` : sq.dir === 'short' ? `▲ Short-squeeze ${sq.level}` : '— crowding balanced';
  const cls = sq.dir === 'long' ? 'sq-long' : sq.dir === 'short' ? 'sq-short' : 'sq-neutral';
  const rTot = sq.realizedLong + sq.realizedShort;
  const parts = [
    `funding <b>${escapeHtml(fmtFunding(sq.funding8h))}</b>`,
    `fuel ±5%: <b>↓${escapeHtml(fmtUsd(sq.fuelL))}</b> / <b>↑${escapeHtml(fmtUsd(sq.fuelS))}</b>`,
    sq.longShare != null ? `24h real liqs <b>${Math.round(sq.longShare * 100)}% long</b> <span class="dim">of ${escapeHtml(fmtUsd(rTot))}</span>` : '24h real liqs <span class="dim">none</span>',
    sq.etfUsdM != null ? `ETF flow <b>${sq.etfUsdM >= 0 ? '+' : '−'}$${Math.abs(sq.etfUsdM).toFixed(0)}M</b> <span class="dim">${escapeHtml(sq.etfDate || '')}</span>` : '',
    sq.absorb != null && isFinite(sq.absorb) ? `top wall ≈ <b>${sq.absorb.toFixed(1)}×</b> hourly vol` : '',
  ].filter(Boolean).join(' &nbsp;·&nbsp; ');
  return `<div class="squeeze ${cls}"><span class="sqh">${head}</span><span class="sqd">${parts}</span></div>`;
}

// cumulative liquidation notional from the price line outward, per displayed bin.
// cumLong rises as price falls (longs), cumShort rises as price rises (shorts).
function cumulativeVolume(map) {
  const nB = map.bins.length;
  const cumLong = new Array(nB).fill(0), cumShort = new Array(nB).fill(0);
  let accL = 0;
  for (let i = nB - 1; i >= 0; i--) { if (map.bins[i].price < map.price) accL += map.bins[i].totalLong || 0; cumLong[i] = accL; }
  let accS = 0;
  for (let i = 0; i < nB; i++) { if (map.bins[i].price >= map.price) accS += map.bins[i].totalShort || 0; cumShort[i] = accS; }
  return { cumLong, cumShort, sumLong: accL, sumShort: accS, cumMax: Math.max(1, ...cumLong, ...cumShort) };
}

// ===== SVG map for one token =====
function renderSvg(token, map) {
  const W = 1200, H = 560;
  const ML = 74, MR = 58, MT = 30, MB = 54;   // MR holds the cumulative-volume axis gutter
  const plotW = W - ML - MR;
  const plotH = H - MT - MB;
  const x0 = ML, y0 = MT, yBot = MT + plotH;
  const { lo, hi } = map.range;
  const xOf = (p) => x0 + ((p - lo) / (hi - lo)) * plotW;
  const barW = plotW / map.nBins;
  const maxV = map.maxBinTotal || 1;
  const hOf = (v) => (v / maxV) * plotH;
  const px = xOf(map.price);

  // zone shading + side labels
  const zones =
    `<rect x="${x0}" y="${y0}" width="${(px - x0).toFixed(1)}" height="${plotH}" fill="#ff475708"/>` +
    `<rect x="${px.toFixed(1)}" y="${y0}" width="${(x0 + plotW - px).toFixed(1)}" height="${plotH}" fill="#2ed57308"/>` +
    `<text x="${(x0 + 8).toFixed(1)}" y="${(y0 + 15).toFixed(1)}" fill="#ff6b6b" font-size="11" font-weight="600">◀ longs liquidate</text>` +
    `<text x="${(x0 + plotW - 8).toFixed(1)}" y="${(y0 + 15).toFixed(1)}" fill="#51cf66" font-size="11" font-weight="600" text-anchor="end">shorts liquidate ▶</text>`;

  // sector-grid underlay — squares make long vs short magnitudes comparable by eye
  // (count cells either side of the price line). Major lines at ticks, faint minors at
  // half-steps; 8×4 ticks ≈ square cells at this aspect ratio.
  let grid = '';
  const NY = 4, NX = 8;
  for (let i = 1; i < NY * 2; i++) {           // horizontals (skip plot top/bottom edges)
    const yy = yBot - (i / (NY * 2)) * plotH;
    grid += `<line x1="${x0}" y1="${yy.toFixed(1)}" x2="${(x0 + plotW).toFixed(1)}" y2="${yy.toFixed(1)}" stroke="${i % 2 ? '#1a202e' : '#262e40'}"/>`;
  }
  for (let i = 1; i < NX * 2; i++) {           // verticals
    const xx = x0 + (i / (NX * 2)) * plotW;
    grid += `<line x1="${xx.toFixed(1)}" y1="${y0}" x2="${xx.toFixed(1)}" y2="${yBot}" stroke="${i % 2 ? '#1a202e' : '#262e40'}"/>`;
  }
  for (let i = 1; i <= NY; i++) {              // left-axis $ labels on the major rows
    const v = (i / NY) * maxV;
    const yy = yBot - hOf(v);
    grid += `<text x="${(x0 - 8).toFixed(1)}" y="${(yy + 3).toFixed(1)}" fill="#6b7280" font-size="10" text-anchor="end">${escapeHtml(fmtUsd(v))}</text>`;
  }

  // stacked bars (long + short per tier, colored by leverage)
  let bars = '';
  for (const b of map.bins) {
    if (b.total <= 0) continue;
    const cx = xOf(b.price);
    const bw = Math.max(1, barW * 0.92);
    let yTop = yBot;
    for (const t of map.tiers) {
      const v = (b.long[t.lev] || 0) + (b.short[t.lev] || 0);
      if (v <= 0) continue;
      const segH = hOf(v);
      yTop -= segH;
      bars += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${yTop.toFixed(1)}" width="${bw.toFixed(1)}" height="${segH.toFixed(1)}" fill="${t.color}"/>`;
    }
  }

  // cumulative liquidation volume vs price — running total of notional from the price line
  // outward (longs leftward as price falls, shorts rightward as price rises). Own right axis.
  const { cumLong, cumShort, cumMax } = cumulativeVolume(map);
  const nB = map.bins.length;
  const yOfCum = (v) => yBot - (v / cumMax) * plotH;
  let longPts = '';
  for (let i = 0; i < nB; i++) if (map.bins[i].price < map.price) longPts += `${xOf(map.bins[i].price).toFixed(1)},${yOfCum(cumLong[i]).toFixed(1)} `;
  longPts += `${px.toFixed(1)},${yBot.toFixed(1)}`;
  let shortPts = `${px.toFixed(1)},${yBot.toFixed(1)} `;
  for (let i = 0; i < nB; i++) if (map.bins[i].price >= map.price) shortPts += `${xOf(map.bins[i].price).toFixed(1)},${yOfCum(cumShort[i]).toFixed(1)} `;
  const cumLine =
    `<polyline points="${longPts}" fill="none" stroke="#0e1118" stroke-width="3.6" stroke-linejoin="round" opacity="0.55"/>` +
    `<polyline points="${shortPts.trim()}" fill="none" stroke="#0e1118" stroke-width="3.6" stroke-linejoin="round" opacity="0.55"/>` +
    `<polyline points="${longPts}" fill="none" stroke="#f0f3f8" stroke-width="2" stroke-linejoin="round"/>` +
    `<polyline points="${shortPts.trim()}" fill="none" stroke="#f0f3f8" stroke-width="2" stroke-linejoin="round"/>`;
  // right axis for the cumulative curve ("cumul." header sits above the plot to avoid the top tick)
  let rAxis = `<text x="${(x0 + plotW + 6).toFixed(1)}" y="${(y0 - 6).toFixed(1)}" fill="#aeb4c0" font-size="9" font-weight="600">cumul.</text>`;
  const NRY = 4;
  for (let i = 1; i < NRY; i++) {   // skip the top tick (i=NRY) — it sits under the "cumul." header; max shown in stats
    const v = (i / NRY) * cumMax, yy = yOfCum(v);
    rAxis += `<line x1="${(x0 + plotW).toFixed(1)}" y1="${yy.toFixed(1)}" x2="${(x0 + plotW + 4).toFixed(1)}" y2="${yy.toFixed(1)}" stroke="#3a4152"/>` +
      `<text x="${(x0 + plotW + 7).toFixed(1)}" y="${(yy + 3).toFixed(1)}" fill="#aeb4c0" font-size="9" text-anchor="start">${escapeHtml(fmtUsd(v))}</text>`;
  }

  // x ticks
  let xticks = '';
  for (let i = 0; i <= NX; i++) {
    const p = lo + (i / NX) * (hi - lo);
    const xx = xOf(p);
    xticks += `<line x1="${xx.toFixed(1)}" y1="${yBot}" x2="${xx.toFixed(1)}" y2="${(yBot + 5).toFixed(1)}" stroke="#3a4152"/>` +
      `<text x="${xx.toFixed(1)}" y="${(yBot + 18).toFixed(1)}" fill="#9ca3af" font-size="10" text-anchor="middle">${escapeHtml(fmtPrice(p))}</text>`;
  }

  // current price line
  const priceLine =
    `<line x1="${px.toFixed(1)}" y1="${y0 - 2}" x2="${px.toFixed(1)}" y2="${yBot}" stroke="#e6e9ef" stroke-width="1.5" stroke-dasharray="4 3"/>` +
    `<text x="${px.toFixed(1)}" y="${(y0 - 6).toFixed(1)}" fill="#e6e9ef" font-size="12" font-weight="700" text-anchor="middle">${escapeHtml(fmtPrice(map.price))}</text>`;

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" class="liqmap" data-token="${escapeHtml(token)}">` +
    zones + grid + bars + cumLine + xticks + priceLine + rAxis + `</svg>`;
}

// ===== reality-check panel: model walls vs ACTUAL OI destruction, in offset space (% from price) =====
function renderBacktestSvg(bt, token) {
  const W = 1200, H = 300;
  const ML = 74, MR = 24, MT = 24, MB = 40;
  const plotW = W - ML - MR, plotH = H - MT - MB;
  const x0 = ML, y0 = MT, yBot = MT + plotH;
  const lo = -bt.downSpan, hi = bt.upSpan;
  const xOf = (off) => x0 + ((off - lo) / (hi - lo)) * plotW;
  const px = xOf(0);
  const yOf = (v, max) => yBot - (max > 0 ? Math.max(0, v) / max : 0) * plotH;

  // light display smoothing so the gray "resting" silhouette reads as a soft mountain, not jagged noise
  const smoothDisp = (arr, sig) => {
    const r = Math.max(1, Math.ceil(sig * 3)), k = [];
    for (let d = -r; d <= r; d++) k.push(Math.exp(-(d * d) / (2 * sig * sig)));
    return arr.map((_, i) => { let a = 0, w = 0; for (let d = -r; d <= r; d++) { const j = i + d; if (j < 0 || j >= arr.length) continue; a += arr[j] * k[d + r]; w += k[d + r]; } return w > 0 ? a / w : 0; });
  };
  const sumArr = (a, b) => a.map((x, i) => x + b[i]);
  const adjL = bt.adjLong, adjS = bt.adjShort;
  const resting = smoothDisp(sumArr(bt.modelLong, bt.modelShort), 4);
  const restingMax = Math.max(1e-9, ...resting);
  const real = sumArr(bt.empLong, bt.empShort);

  const linePathRange = (arr, max, i0, i1) => { let s = ''; for (let i = i0; i <= i1; i++) s += `${i === i0 ? 'M' : 'L'}${xOf(bt.offsets[i]).toFixed(1)} ${yOf(arr[i], max).toFixed(1)} `; return s.trim(); };
  const areaPath = (arr, max, i0, i1) => {
    let d = `M${xOf(bt.offsets[i0]).toFixed(1)} ${yBot.toFixed(1)}`;
    for (let i = i0; i <= i1; i++) d += ` L${xOf(bt.offsets[i]).toFixed(1)} ${yOf(arr[i], max).toFixed(1)}`;
    return d + ` L${xOf(bt.offsets[i1]).toFixed(1)} ${yBot.toFixed(1)} Z`;
  };

  const zones =
    `<rect x="${x0}" y="${y0}" width="${(px - x0).toFixed(1)}" height="${plotH}" fill="#ff47570a"/>` +
    `<rect x="${px.toFixed(1)}" y="${y0}" width="${(x0 + plotW - px).toFixed(1)}" height="${plotH}" fill="#2ed5730a"/>`;

  // vertical sector lines only — each curve here is normalized to its own max, so
  // horizontal cells would invite false cross-curve height comparisons
  let grid = '';
  for (let i = 1; i < 16; i++) {
    const xx = x0 + (i / 16) * plotW;
    grid += `<line x1="${xx.toFixed(1)}" y1="${y0}" x2="${xx.toFixed(1)}" y2="${yBot}" stroke="${i % 2 ? '#1a202e' : '#262e40'}"/>`;
  }

  // resting walls (raw model) — soft gray silhouette in the back ("where the fuel sits")
  const restingArea = `<path d="${areaPath(resting, restingMax, 0, bt.n - 1)}" fill="#8b93a7" fill-opacity="0.12"/>`;
  // reach-weighted expected liquidations — clean side-colored lines (red longs / green shorts)
  const adjLines =
    `<path d="${linePathRange(adjL, bt.adjMax, 0, bt.nDown - 1)}" fill="none" stroke="#ff6b81" stroke-width="1.6" opacity="0.95"/>` +
    `<path d="${linePathRange(adjS, bt.adjMax, bt.nDown, bt.n - 1)}" fill="none" stroke="#51cf66" stroke-width="1.6" opacity="0.95"/>`;
  // real OI destroyed — bright cyan line (the ground truth)
  const realLine = `<path d="${linePathRange(real, bt.empMax, 0, bt.n - 1)}" fill="none" stroke="#22d3ee" stroke-width="2.2"/>`;

  // x ticks in % from price
  let xticks = '';
  const NX = 8;
  for (let i = 0; i <= NX; i++) {
    const off = lo + (i / NX) * (hi - lo);
    const xx = xOf(off);
    const lbl = (off >= 0 ? '+' : '') + (off * 100).toFixed(0) + '%';
    xticks += `<line x1="${xx.toFixed(1)}" y1="${yBot}" x2="${xx.toFixed(1)}" y2="${(yBot + 5).toFixed(1)}" stroke="#3a4152"/>` +
      `<text x="${xx.toFixed(1)}" y="${(yBot + 17).toFixed(1)}" fill="#9ca3af" font-size="10" text-anchor="middle">${escapeHtml(lbl)}</text>`;
  }
  const priceLine =
    `<line x1="${px.toFixed(1)}" y1="${y0 - 2}" x2="${px.toFixed(1)}" y2="${yBot}" stroke="#e6e9ef" stroke-width="1.3" stroke-dasharray="4 3"/>` +
    `<text x="${px.toFixed(1)}" y="${(y0 - 5).toFixed(1)}" fill="#e6e9ef" font-size="10" font-weight="700" text-anchor="middle">price</text>` +
    `<text x="${(x0 + 6).toFixed(1)}" y="${(y0 + 13).toFixed(1)}" fill="#ff6b6b" font-size="10" font-weight="600">◀ longs liquidate</text>` +
    `<text x="${(x0 + plotW - 6).toFixed(1)}" y="${(y0 + 13).toFixed(1)}" fill="#51cf66" font-size="10" font-weight="600" text-anchor="end">shorts liquidate ▶</text>`;

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" class="btmap" data-token="${escapeHtml(token)}">` +
    zones + grid + restingArea + adjLines + realLine + xticks + priceLine + `</svg>`;
}

const fmtPct1 = (frac) => frac == null ? '—' : ((frac >= 0 ? '+' : '') + (frac * 100).toFixed(1) + '%');

// reality-check block (panel + verdict) for one token, or a short note if data is too thin.
function renderBacktest(bt, symbol) {
  if (!bt) return '';
  if (bt.insufficient) {
    const covNote = bt.topMissing && bt.topMissing.frac >= 0.3
      ? ` Most of ${escapeHtml(symbol || 'its')} OI sits on ${escapeHtml(bt.topMissing.exchange)} (${(bt.topMissing.frac * 100).toFixed(0)}%), which publishes no hourly OI.`
      : '';
    return `<div class="backtest"><div class="bt-head"><b>Reality check</b> <span class="dim">model walls vs actual OI destruction</span></div>
      <div class="bt-note">Not enough observable open-interest history to validate this token${bt.oiVenues?.length ? ` (only ${escapeHtml(bt.oiVenues.join(', '))})` : ''}.${covNote} Needs venues that publish hourly OI (OKX/dYdX do for majors).</div></div>`;
  }
  const ev = bt.events.long + bt.events.short;
  const cov = bt.coverageFrac ?? 1;
  const covPct = (cov * 100).toFixed(0);
  // confidence = the WEAKER of event-count and OI-coverage; both must be strong for "high"
  const evScore = ev >= 150 ? 2 : ev >= 50 ? 1 : 0;
  const covScore = cov >= 0.7 ? 2 : cov >= 0.4 ? 1 : 0;   // ~0.73 is the practical ceiling (HL/HTX/Kraken/Coinbase publish no hourly OI)
  const confN = Math.min(evScore, covScore);
  const conf = confN === 2 ? 'high' : confN === 1 ? 'moderate' : 'low';
  const avg = (a, b) => (Math.abs(a || 0) + Math.abs(b || 0)) / 2;
  const realAvg = avg(bt.empMeanAbs.long, bt.empMeanAbs.short) * 100;
  const wallAvg = avg(bt.modelMeanAbs.long, bt.modelMeanAbs.short) * 100;
  const adjPct = (bt.cosAdjOverall * 100).toFixed(0);
  const rawPct = (bt.cosOverall * 100).toFixed(0);
  const word = bt.cosAdjOverall >= 0.6 ? 'strong' : bt.cosAdjOverall >= 0.4 ? 'moderate' : 'weak';
  const confColor = conf === 'high' ? '#51cf66' : conf === 'moderate' ? '#ffd43b' : '#ff922b';

  const covSentence = cov >= 0.7
    ? ` These venues cover <b>${covPct}%</b> of ${escapeHtml(symbol)}'s open interest — representative.`
    : ` But they see only <b>${covPct}%</b> of open interest${bt.topMissing ? ` (most sits on ${escapeHtml(bt.topMissing.exchange)} — ${(bt.topMissing.frac * 100).toFixed(0)}% — which has no hourly OI feed)` : ''}, so this validates just that slice.`;
  const verdict = ev < 50
    ? `Only <b>${ev}</b> liquidation-scale moves in the window — too thin to validate; treat as indicative, not calibrated.${cov < 0.7 ? covSentence : ''}`
    : `Real liquidations sit <b>~${realAvg.toFixed(1)}%</b> from price on average vs the model's <b>~${wallAvg.toFixed(1)}%</b> resting walls — destruction clusters nearer because shallow sweeps are constant and deep ones rare. Weighting the walls by how often price actually reaches each level lifts alignment to <b style="color:${bt.cosAdjOverall >= 0.6 ? '#51cf66' : '#ffd43b'}">${adjPct}%</b> (raw ${rawPct}%) — the model's wall <b>placement is ${word}</b>.${covSentence}`;

  return `<div class="backtest">
    <div class="bt-head">
      <div><b>Reality check</b> <span class="dim">— where the model predicts walls vs where OI actually got destroyed, last ~${Math.round(bt.days)}d, by % from price · hover for values</span></div>
      <div class="bt-legend">
        <span class="leg"><span class="sw" style="background:#22d3ee"></span>real OI destroyed</span>
        <span class="leg"><span class="sw" style="background:linear-gradient(90deg,#ff6b81,#51cf66)"></span>reach-weighted expected</span>
        <span class="leg"><span class="sw" style="background:#8b93a7;opacity:.5"></span>resting walls</span>
      </div>
    </div>
    ${renderBacktestSvg(bt, symbol)}
    <div class="bt-stats">
      <span class="stat">align <b style="color:${bt.cosAdjOverall >= 0.6 ? '#51cf66' : '#ffd43b'}">${adjPct}%</b> <span class="dim">reach-weighted · longs ${(bt.cosAdjLong * 100).toFixed(0)}% / shorts ${(bt.cosAdjShort * 100).toFixed(0)}%</span></span>
      <span class="stat"><b style="color:${confColor}">${conf}</b> confidence <span class="dim">${ev} moves · <b style="color:${cov >= 0.7 ? '#9ca3af' : '#ff922b'}">${covPct}%</b> of OI seen · ${escapeHtml((bt.oiVenues || []).join(', '))}</span></span>
      <span class="stat">real peak <b>${fmtPct1(bt.empPeak.long)}</b>/<b>${fmtPct1(bt.empPeak.short)}</b> <span class="dim">vs walls ${fmtPct1(bt.modelPeak.long)}/${fmtPct1(bt.modelPeak.short)}</span></span>
    </div>
    <div class="bt-verdict">${verdict}</div>
    <div class="bt-caveat">Indirect proxy: OI also drops on voluntary closes; side inferred from price direction; only venues publishing hourly OI contribute. Not a real-liquidation feed (that needs an always-on WebSocket collector).</div>
  </div>`;
}

// ===== per-token section + tooltip payload =====
function renderToken(symbol, tokenData, isFirst) {
  const cls = `board${isFirst ? ' active' : ''}`;
  const tokenCfg = (config.tokens || []).find((t) => t.symbol === symbol) || {};
  const map = buildMap(tokenData, config, tokenCfg);
  // backtest is a secondary panel — never let it break the main map / the auto-publish
  let bt = null;
  try { bt = map ? buildBacktest(tokenData, map, config, tokenCfg) : null; }
  catch (e) { console.error(`backtest failed for ${symbol}: ${e.message}`); }
  if (!map) {
    return { html: `<section class="${cls}" data-token="${escapeHtml(symbol)}"><h2>${escapeHtml(symbol)}</h2><div class="empty">No data — check fetch errors below.</div></section>`, payload: null, tab: { symbol, price: null } };
  }

  const nowMs = Date.now();
  const venueBreak = map.venues.length
    ? map.venues.map((v) => `${v.exchange} ${fmtUsd(v.openInterestUsd)}${v.stale && v.staleAsOf ? ` ⏱${fmtAge(nowMs - Date.parse(v.staleAsOf))}` : ''}`).join(' · ')
    : '—';
  const cum = cumulativeVolume(map);
  // crowding/squeeze read — never let it break the board
  let sq = null;
  try { sq = computeSqueeze(map, tokenData, LIQ_DIR, symbol); } catch (e) { console.error(`squeeze failed for ${symbol}: ${e.message}`); }
  const legend = map.tiers.map((t) =>
    `<span class="leg"><span class="sw" style="background:${t.color}"></span>${escapeHtml(t.label)}</span>`).join('') +
    `<span class="leg"><span class="sw" style="background:#f0f3f8;height:3px"></span>cumulative</span>`;

  // time window the map is modeled over (computed from actual kline timestamps)
  const w = map.window;
  const winStat = w ? (() => {
    const ms = w.toMs - w.fromMs;
    const span = ms >= 864e5 ? `${ms / 864e5 < 10 ? (ms / 864e5).toFixed(1) : Math.round(ms / 864e5)}d` : `${Math.round(ms / 36e5)}h`;
    const fd = (t) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return `<span class="stat"><b>${escapeHtml(span)} window</b> <span class="dim">${escapeHtml(`${fd(w.fromMs)} – ${fd(w.toMs)} · ${w.nCandles}×${interval}`)}</span></span>`;
  })() : '';

  const html = `<section class="${cls}" data-token="${escapeHtml(symbol)}">
  <div class="maphead">
    <div>
      <h2>${escapeHtml(tokenData.name || symbol)} <span class="tk">${escapeHtml(symbol)}</span></h2>
      <div class="stats">
        <span class="stat"><b>${escapeHtml(fmtPrice(map.price))}</b> price</span>
        ${winStat}
        <span class="stat"><b>${escapeHtml(fmtUsd(map.totalOiUsd))}</b> open interest</span>
        <span class="stat"><b>${escapeHtml(fmtUsd(map.displayedUsd))}</b> modeled in price range</span>
        ${map.pathAware && map.pathKilledUsd > 0 ? `<span class="stat"><b>${escapeHtml(fmtUsd(map.pathKilledUsd))}</b> wick-swept <span class="dim">liq level already hit since entry — re-rested on survivors</span></span>` : ''}
        <span class="stat"><b>${escapeHtml(fmtUsd(cum.sumLong))}</b> long / <b>${escapeHtml(fmtUsd(cum.sumShort))}</b> short <span class="dim">cumulative liq to window edge</span></span>
        ${map.funding8h != null ? `<span class="stat"><b>${escapeHtml(fmtFunding(map.funding8h))}</b> funding <span class="dim">${map.fundingVenues} venue${map.fundingVenues === 1 ? '' : 's'}, OI-wtd</span></span>` : ''}
        <span class="stat"><b>${(map.longFrac * 100).toFixed(0)}% long</b> / ${((1 - map.longFrac) * 100).toFixed(0)}% short${map.lsVenues
          ? ` <span class="dim">${map.lsSource === 'neutral' ? 'neutral' : `damped from ${(map.longFracRaw * 100).toFixed(0)}% ${map.lsPosVenues ? `pos-ratio×${map.lsPosVenues}` : ''}${map.lsPosVenues && map.lsAcctVenues ? '+' : ''}${map.lsAcctVenues ? `acct×${map.lsAcctVenues}` : ''}`}</span>`
          : ' <span class="dim">(no L/S data)</span>'}</span>
        <span class="stat">${map.venues.length} venue${map.venues.length === 1 ? '' : 's'} <span class="dim">${escapeHtml(venueBreak)}</span></span>
        ${map.staleVenues?.length ? `<span class="stat" style="color:#ffd43b">⏱ <b>${escapeHtml(map.staleVenues.join(', '))}</b> stale <span class="dim">last-good data — venue fetch currently failing</span></span>` : ''}
        ${map.weighting === 'oi-delta' ? `<span class="stat"><b>OI-Δ weighted</b> <span class="dim">${map.oiVenues}/${map.venues.length} venues · rest volume</span></span>` : ''}
      </div>
    </div>
    <div class="legend">${legend}</div>
  </div>
  ${sq ? squeezeStrip(sq) : ''}
  ${renderSvg(symbol, map)}
  ${renderBacktest(bt, symbol)}
</section>`;

  // compact payload for hover tooltips
  const payload = {
    vbW: 1200, x0: 74, plotW: 1200 - 74 - 58, nBins: map.nBins, price: map.price,
    tiers: map.tiers.map((t) => ({ lev: t.lev, label: t.label, color: t.color })),
    bins: map.bins.map((b, i) => ({ price: b.price, total: b.total, totalLong: b.totalLong, totalShort: b.totalShort, long: b.long, short: b.short, cumLong: cum.cumLong[i], cumShort: cum.cumShort[i] })),
  };
  // reality-check hover payload — .btmap uses its own geometry (MR=24 → plotW=1102)
  if (bt && !bt.insufficient) {
    payload.bt = {
      x0: 74, plotW: 1200 - 74 - 24, n: bt.n, P: bt.P,
      offsets: bt.offsets.map((o) => +o.toFixed(5)),
      real: bt.empLong.map((v, i) => Math.round(v + bt.empShort[i])),
      adj: bt.adjLong.map((v, i) => Math.round(v + bt.adjShort[i])),
      resting: bt.modelLong.map((v, i) => Math.round(v + bt.modelShort[i])),
    };
  }
  return { html, payload, tab: { symbol, price: map.price } };
}

// ===== assemble =====
const sections = [];
const tabs = [];
const payloads = {};
Object.entries(tokens || {}).forEach(([symbol, tokenData], i) => {
  const { html, payload, tab } = renderToken(symbol, tokenData, i === 0);
  sections.push(html);
  tabs.push(tab);
  if (payload) payloads[symbol] = payload;
});
const tabBar = tabs.length > 1
  ? `<div class="tabs">${tabs.map((t, i) => `<button class="tab${i === 0 ? ' active' : ''}" data-token="${escapeHtml(t.symbol)}">${escapeHtml(t.symbol)}${t.price != null ? `<span class="tprice">${escapeHtml(fmtPrice(t.price))}</span>` : ''}</button>`).join('')}</div>`
  : '';

const errBlock = errors.length
  ? `<div class="errors"><b>fetch errors:</b> ${errors.map((e) => escapeHtml(`${e.token}/${e.venue}: ${e.error}`)).join(' · ')}</div>`
  : '';

// magnet study (magnet-study.mjs writes magnet.json on each tick; absent on first runs)
let magnetBlock = '';
try {
  const mg = JSON.parse(readFileSync(new URL('./magnet.json', import.meta.url), 'utf8'));
  const rows = (mg.pooled || []).map((b) =>
    `<tr><td>${escapeHtml(b.bucket)}</td><td>${b.n}</td><td>${b.n ? (b.touch * 100).toFixed(0) + '%' : '—'}</td><td>${b.n ? (b.base * 100).toFixed(0) + '%' : '—'}</td><td class="${b.n >= 20 ? (b.lift > 0 ? 'lift-pos' : 'lift-neg') : ''}">${b.n ? ((b.lift >= 0 ? '+' : '') + (b.lift * 100).toFixed(0) + 'pts') : '—'}</td></tr>`).join('');
  const perTok = Object.entries(mg.tokens || {}).map(([t, v]) => `${t} ${v.samples}`).join(' · ');
  magnetBlock = `<div class="magnet">
  <h3>Magnet study <span style="color:#6b7280;font-weight:400">— do predicted walls attract price? (forward test on wall snapshots, ${mg.horizonH}h horizon)</span></h3>
  <div class="sub">touch = price reached the wall level within ${mg.horizonH}h of the snapshot · base = probability of reaching that distance anyway (matched excursion CDF) · lift = touch − base</div>
  <table><tr><th>wall distance</th><th>walls</th><th>touched</th><th>base</th><th>lift</th></tr>${rows}</table>
  <div class="note">⚠ read direction, not magnitude: 30-min snapshots with a ${mg.horizonH}h horizon overlap heavily, so the effective sample is far smaller than n. snapshots per token: ${escapeHtml(perTok)} · since ${escapeHtml((mg.firstSnapshot || '').slice(0, 10))} · the matched base rate controls for distance, not for regime — confidence accrues with calendar time.</div>
</div>`;
} catch { /* no magnet.json yet */ }

const payloadScripts = Object.entries(payloads)
  .map(([sym, p]) => `<script type="application/json" id="liqdata-${escapeHtml(sym)}">${JSON.stringify(p)}</script>`)
  .join('\n');

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Aggregate Liquidation Map</title>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, "SF Pro Text", system-ui, sans-serif; background: #0e1118; color: #e6e9ef; font-size: 13px; line-height: 1.4; }
.wrap { max-width: 1280px; margin: 0 auto; padding: 24px; }
header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; padding-bottom: 12px; border-bottom: 1px solid #232838; }
header h1 { font-size: 18px; font-weight: 600; letter-spacing: -0.01em; }
header .meta { color: #6b7280; font-size: 11px; text-align: right; }
.pill { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 10px; font-weight: 600; background: #5352ed; color: #fff; }
.note { color: #6b7280; font-size: 11px; margin: 10px 0 18px; }
section { margin: 28px 0 34px; }
.maphead { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 8px; gap: 16px; flex-wrap: wrap; }
.maphead h2 { font-size: 15px; font-weight: 600; }
.maphead h2 .tk { color: #6b7280; font-family: "SF Mono", monospace; font-size: 12px; margin-left: 4px; }
.stats { display: flex; gap: 16px; flex-wrap: wrap; margin-top: 6px; color: #9ca3af; font-size: 11px; }
.stats .stat b { color: #e6e9ef; font-family: "SF Mono", monospace; font-weight: 600; }
.stats .dim { color: #6b7280; font-family: "SF Mono", monospace; }
.legend { display: flex; gap: 12px; align-items: center; }
.squeeze { display: flex; gap: 14px; align-items: baseline; flex-wrap: wrap; margin: 0 0 8px; padding: 7px 12px; border-radius: 5px; font-size: 12px; border: 1px solid #232838; background: #141823; }
.squeeze .sqh { font-weight: 700; white-space: nowrap; }
.squeeze .sqd { color: #9ca3af; }
.squeeze .sqd b { color: #e6e9ef; font-family: "SF Mono", monospace; font-weight: 600; }
.squeeze.sq-long { border-color: #3a2027; background: #ff47570d; } .squeeze.sq-long .sqh { color: #ff8787; }
.squeeze.sq-short { border-color: #1f3a28; background: #2ed5730d; } .squeeze.sq-short .sqh { color: #69db7c; }
.squeeze.sq-neutral .sqh { color: #9ca3af; }
.magnet { margin: 30px 0 0; background: #0d1019; border: 1px solid #1f2533; border-radius: 6px; padding: 14px 16px; }
.magnet h3 { font-size: 13px; margin-bottom: 4px; }
.magnet .sub { color: #6b7280; font-size: 11px; margin-bottom: 10px; }
.magnet table { border-collapse: collapse; font-size: 12px; }
.magnet th, .magnet td { padding: 4px 14px 4px 0; text-align: right; color: #c7ccd6; }
.magnet th { color: #6b7280; font-weight: 600; font-size: 11px; }
.magnet td:first-child, .magnet th:first-child { text-align: left; }
.magnet .lift-pos { color: #69db7c; font-weight: 700; } .magnet .lift-neg { color: #ff8787; font-weight: 700; }
.magnet .note { color: #6b7280; font-size: 10.5px; margin-top: 8px; line-height: 1.5; }
.leg { font-size: 11px; color: #9ca3af; display: inline-flex; align-items: center; gap: 5px; }
.sw { width: 11px; height: 11px; border-radius: 2px; display: inline-block; }
.tabs { display: flex; gap: 6px; flex-wrap: wrap; margin: 18px 0 4px; }
.tab { background: #161a25; border: 1px solid #232838; color: #9ca3af; border-radius: 6px; padding: 7px 12px; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; display: inline-flex; gap: 7px; align-items: baseline; }
.tab:hover { background: #1a2030; color: #e6e9ef; }
.tab.active { background: #5352ed; border-color: #5352ed; color: #fff; }
.tab .tprice { font-family: "SF Mono", monospace; font-size: 11px; font-weight: 400; opacity: 0.85; }
.board { display: none; }
.board.active { display: block; }
.liqmap { display: block; background: #11151f; border: 1px solid #1f2533; border-radius: 6px; }
.backtest { margin-top: 14px; background: #0d1019; border: 1px solid #1f2533; border-radius: 6px; padding: 12px 14px; }
.bt-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 6px; }
.bt-head b { font-size: 13px; }
.bt-head .dim { color: #6b7280; font-size: 11px; }
.bt-legend { display: flex; gap: 12px; align-items: center; }
.btmap { display: block; background: #11151f; border: 1px solid #1f2533; border-radius: 5px; margin-bottom: 8px; }
.bt-stats { display: flex; gap: 18px; flex-wrap: wrap; color: #9ca3af; font-size: 11px; margin-bottom: 7px; }
.bt-stats .stat b { color: #e6e9ef; font-family: "SF Mono", monospace; }
.bt-stats .dim { color: #6b7280; font-family: "SF Mono", monospace; }
.bt-verdict { font-size: 12px; color: #c7ccd6; line-height: 1.5; margin-bottom: 6px; }
.bt-verdict b { color: #e6e9ef; }
.bt-caveat { font-size: 10.5px; color: #6b7280; line-height: 1.45; }
.bt-note { font-size: 11.5px; color: #9ca3af; padding: 6px 0; }
.empty { color: #6b7280; padding: 40px; text-align: center; background: #11151f; border-radius: 6px; }
.errors { color: #ffa502; font-size: 11px; background: #1a1620; border: 1px solid #3a2a1a; border-radius: 4px; padding: 8px 12px; margin: 12px 0; }
.liq-tooltip { position: fixed; z-index: 10; pointer-events: none; background: #161a25; border: 1px solid #2d3343; border-radius: 6px; padding: 8px 10px; font-size: 11px; box-shadow: 0 6px 24px rgba(0,0,0,0.5); min-width: 150px; }
.liq-tooltip .th { font-family: "SF Mono", monospace; font-weight: 700; font-size: 13px; margin-bottom: 2px; }
.liq-tooltip .sub { color: #9ca3af; margin-bottom: 6px; }
.liq-tooltip .cum { color: #c7ccd6; margin-bottom: 6px; padding-bottom: 5px; border-bottom: 1px solid #2d3343; }
.liq-tooltip .cum b { color: #f0f3f8; font-family: "SF Mono", monospace; }
.liq-tooltip .tr { display: flex; align-items: center; gap: 6px; }
.liq-tooltip .tr .v { margin-left: auto; font-family: "SF Mono", monospace; color: #e6e9ef; }
footer { margin-top: 36px; padding-top: 16px; border-top: 1px solid #232838; color: #6b7280; font-size: 11px; line-height: 1.6; }
footer code { color: #9ca3af; }
</style>
</head>
<body>
<div class="wrap">
<header>
  <div>
    <h1>Aggregate Liquidation Map <span class="pill">MODELED ESTIMATE</span></h1>
  </div>
  <div class="meta">Refreshed ${escapeHtml(new Date(fetchedAt).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' }))}</div>
</header>
<div class="note">Where leveraged positions would be force-liquidated, by price &amp; leverage tier — modeled from trading activity over the <b>time window</b> shown in each map's stats. Bars left of the price line = long liquidations (falling price), right = short (rising). The <b>white curve</b> is <b>cumulative liquidation volume</b> (right axis) — the running total wiped out if price sweeps from here to that level. Hover any price for the breakdown.</div>
${errBlock}
${tabBar}
${sections.join('\n')}
${magnetBlock}
<footer>
  <b>Method:</b> distribution shape from per-candle open-interest growth (OI-Δ) where the venue provides OI history, else traded volume, across enabled venues over the displayed time window; total magnitude anchored to current open interest.
  Leverage tiers applied via <code>liq ≈ entry·(1 ∓ 1/L)</code> (linear USDT perps); entries whose liq level was already swept by the later price path (wicks included) are dropped, their share re-rested on surviving entries. This is a relative-intensity model, <b>not</b> real positions —
  no exchange publishes per-trader leverage (same category as Coinglass / Kingfisher). Built by <code>fetch.mjs</code> + <code>render.mjs</code>.
</footer>
</div>
${payloadScripts}
<div id="liq-tooltip" class="liq-tooltip" style="display:none"></div>
<script>
(function () {
  const tip = document.getElementById('liq-tooltip');
  const fmtUsd = (n) => { const a = Math.abs(n); if (a >= 1e9) return '$' + (n/1e9).toFixed(2) + 'B'; if (a >= 1e6) return '$' + (n/1e6).toFixed(1) + 'M'; if (a >= 1e3) return '$' + (n/1e3).toFixed(1) + 'K'; return '$' + n.toFixed(0); };
  const fmtPrice = (n) => '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: n < 100 ? 2 : 0 });
  document.querySelectorAll('svg.liqmap').forEach((svg) => {
    const el = document.getElementById('liqdata-' + svg.dataset.token);
    if (!el) return;
    const d = JSON.parse(el.textContent);
    svg.addEventListener('mousemove', (e) => {
      const rect = svg.getBoundingClientRect();
      const vbX = (e.clientX - rect.left) / rect.width * d.vbW;
      const idx = Math.floor((vbX - d.x0) / d.plotW * d.nBins);
      const b = d.bins[idx];
      if (idx < 0 || idx >= d.nBins || !b || b.total <= 0) { tip.style.display = 'none'; return; }
      const rows = d.tiers.map((t) => {
        const v = (b.long[t.lev] || 0) + (b.short[t.lev] || 0);
        return v > 0 ? '<div class="tr"><span class="sw" style="background:' + t.color + '"></span>' + t.label + '<span class="v">' + fmtUsd(v) + '</span></div>' : '';
      }).join('');
      const isLong = b.price < d.price;
      const cumV = isLong ? b.cumLong : b.cumShort;
      const movePct = d.price > 0 ? Math.abs(b.price - d.price) / d.price * 100 : 0;
      const cumStr = cumV > 0 ? '<div class="cum">↳ if price ' + (isLong ? 'falls' : 'rises') + ' to here (' + (isLong ? '−' : '+') + movePct.toFixed(1) + '%): <b>' + fmtUsd(cumV) + '</b> ' + (isLong ? 'longs' : 'shorts') + ' liquidated cumulatively</div>' : '';
      tip.innerHTML = '<div class="th">' + fmtPrice(b.price) + '</div><div class="sub">at this price: total ' + fmtUsd(b.total) + ' &middot; long ' + fmtUsd(b.totalLong) + ' &middot; short ' + fmtUsd(b.totalShort) + '</div>' + cumStr + rows;
      tip.style.display = 'block';
      tip.style.left = Math.min(e.clientX + 14, window.innerWidth - 180) + 'px';
      tip.style.top = (e.clientY + 14) + 'px';
    });
    svg.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
  });
  // reality-check chart hover — real vs reach-weighted vs resting at each % offset
  document.querySelectorAll('svg.btmap').forEach((svg) => {
    const el = document.getElementById('liqdata-' + svg.dataset.token);
    if (!el) return;
    const d = JSON.parse(el.textContent).bt;
    if (!d) return;
    svg.addEventListener('mousemove', (e) => {
      const rect = svg.getBoundingClientRect();
      const vbX = (e.clientX - rect.left) / rect.width * 1200;
      const idx = Math.floor((vbX - d.x0) / d.plotW * d.n);
      if (idx < 0 || idx >= d.n) { tip.style.display = 'none'; return; }
      const real = d.real[idx], adj = d.adj[idx], resting = d.resting[idx];
      if (real <= 0 && adj <= 0 && resting <= 0) { tip.style.display = 'none'; return; }
      const off = d.offsets[idx], isLong = off < 0, price = d.P * (1 + off);
      const row = (color, label, val) => '<div class="tr"><span class="sw" style="background:' + color + '"></span>' + label + '<span class="v">' + fmtUsd(val) + '</span></div>';
      tip.innerHTML = '<div class="th">' + (off >= 0 ? '+' : '') + (off * 100).toFixed(1) + '% &middot; ' + fmtPrice(price) + '</div>'
        + '<div class="sub">' + (isLong ? 'long' : 'short') + ' side &middot; per ' + (d.n ? (((d.offsets[1] - d.offsets[0]) * 100).toFixed(1)) : '0.1') + '% band</div>'
        + row('#22d3ee', 'real destroyed', real)
        + row(isLong ? '#ff6b81' : '#51cf66', 'expected (reach-wtd)', adj)
        + row('#8b93a7', 'resting wall', resting);
      tip.style.display = 'block';
      tip.style.left = Math.min(e.clientX + 14, window.innerWidth - 200) + 'px';
      tip.style.top = (e.clientY + 14) + 'px';
    });
    svg.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
  });
  // tab switching — one board visible at a time
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const tok = tab.dataset.token;
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.board').forEach((b) => b.classList.toggle('active', b.dataset.token === tok));
    });
  });
})();
</script>
</body>
</html>
`;

writeFileSync(new URL('./liquidation-map.html', import.meta.url), html);
console.error(`wrote liquidation-map.html (${Object.keys(payloads).length} token maps, ${errors.length} fetch errors)`);
