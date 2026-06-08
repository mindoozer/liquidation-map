#!/usr/bin/env node
// Reads config.yml + data.json, runs the liquidation model per token, and writes
// liquidation-map.html — a dark-theme page with a price-axis map whose bars are
// stacked & colored by leverage tier (Coinglass / Kingfisher style).
//
// Usage: node render.mjs

import yaml from 'js-yaml';
import { readFileSync, writeFileSync } from 'fs';
import { buildMap } from './lib/model.mjs';

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

// ===== SVG map for one token =====
function renderSvg(token, map) {
  const W = 1200, H = 560;
  const ML = 74, MR = 24, MT = 30, MB = 54;
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

  // y gridlines
  let yticks = '';
  const NY = 4;
  for (let i = 1; i <= NY; i++) {
    const v = (i / NY) * maxV;
    const yy = yBot - hOf(v);
    yticks += `<line x1="${x0}" y1="${yy.toFixed(1)}" x2="${(x0 + plotW).toFixed(1)}" y2="${yy.toFixed(1)}" stroke="#1a1f2c"/>` +
      `<text x="${(x0 - 8).toFixed(1)}" y="${(yy + 3).toFixed(1)}" fill="#6b7280" font-size="10" text-anchor="end">${escapeHtml(fmtUsd(v))}</text>`;
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

  // x ticks
  let xticks = '';
  const NX = 8;
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
    zones + yticks + bars + xticks + priceLine + `</svg>`;
}

// ===== per-token section + tooltip payload =====
function renderToken(symbol, tokenData, isFirst) {
  const cls = `board${isFirst ? ' active' : ''}`;
  const tokenCfg = (config.tokens || []).find((t) => t.symbol === symbol) || {};
  const map = buildMap(tokenData, config, tokenCfg);
  if (!map) {
    return { html: `<section class="${cls}" data-token="${escapeHtml(symbol)}"><h2>${escapeHtml(symbol)}</h2><div class="empty">No data — check fetch errors below.</div></section>`, payload: null, tab: { symbol, price: null } };
  }

  const venueBreak = map.venues.length
    ? map.venues.map((v) => `${v.exchange} ${fmtUsd(v.openInterestUsd)}`).join(' · ')
    : '—';
  const legend = map.tiers.map((t) =>
    `<span class="leg"><span class="sw" style="background:${t.color}"></span>${escapeHtml(t.label)}</span>`).join('');

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
        <span class="stat"><b>${(map.longFrac * 100).toFixed(0)}% long</b> / ${((1 - map.longFrac) * 100).toFixed(0)}% short${map.lsVenues ? '' : ' <span class="dim">(no L/S data)</span>'}</span>
        <span class="stat">${map.venues.length} venue${map.venues.length === 1 ? '' : 's'} <span class="dim">${escapeHtml(venueBreak)}</span></span>
        ${map.weighting === 'oi-delta' ? `<span class="stat"><b>OI-Δ weighted</b> <span class="dim">${map.oiVenues}/${map.venues.length} venues · rest volume</span></span>` : ''}
      </div>
    </div>
    <div class="legend">${legend}</div>
  </div>
  ${renderSvg(symbol, map)}
</section>`;

  // compact payload for hover tooltips
  const payload = {
    vbW: 1200, x0: 74, plotW: 1200 - 74 - 24, nBins: map.nBins,
    tiers: map.tiers.map((t) => ({ lev: t.lev, label: t.label, color: t.color })),
    bins: map.bins.map((b) => ({ price: b.price, total: b.total, totalLong: b.totalLong, totalShort: b.totalShort, long: b.long, short: b.short })),
  };
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
.empty { color: #6b7280; padding: 40px; text-align: center; background: #11151f; border-radius: 6px; }
.errors { color: #ffa502; font-size: 11px; background: #1a1620; border: 1px solid #3a2a1a; border-radius: 4px; padding: 8px 12px; margin: 12px 0; }
.liq-tooltip { position: fixed; z-index: 10; pointer-events: none; background: #161a25; border: 1px solid #2d3343; border-radius: 6px; padding: 8px 10px; font-size: 11px; box-shadow: 0 6px 24px rgba(0,0,0,0.5); min-width: 150px; }
.liq-tooltip .th { font-family: "SF Mono", monospace; font-weight: 700; font-size: 13px; margin-bottom: 2px; }
.liq-tooltip .sub { color: #9ca3af; margin-bottom: 6px; }
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
<div class="note">Where leveraged positions would be force-liquidated, by price &amp; leverage tier — modeled from trading activity over the <b>time window</b> shown in each map's stats. Bars left of the price line = long liquidations (falling price), right = short (rising). Hover any price for the breakdown.</div>
${errBlock}
${tabBar}
${sections.join('\n')}
<footer>
  <b>Method:</b> distribution shape from per-candle open-interest growth (OI-Δ) where the venue provides OI history, else traded volume, across enabled venues over the displayed time window; total magnitude anchored to current open interest.
  Leverage tiers applied via <code>liq ≈ entry·(1 ∓ 1/L)</code> (linear USDT perps). This is a relative-intensity model, <b>not</b> real positions —
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
      tip.innerHTML = '<div class="th">' + fmtPrice(b.price) + '</div><div class="sub">total ' + fmtUsd(b.total) + ' &middot; long ' + fmtUsd(b.totalLong) + ' &middot; short ' + fmtUsd(b.totalShort) + '</div>' + rows;
      tip.style.display = 'block';
      tip.style.left = Math.min(e.clientX + 14, window.innerWidth - 180) + 'px';
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
