#!/usr/bin/env node
// Measure the effective leverage mix from REAL liquidations — the model's single biggest
// assumption (hand-picked tier weights), replaced with data where we can.
//
// Per liquidation: implied liq-distance = move from the trailing price extreme (entry
// proxy) to the fill, so implied leverage L ≈ 1/(dist + mmr); bucket to the token's tiers,
// weight by $ notional → OBSERVED liquidation-leverage distribution.
//
// CRITICAL de-bias: liquidations massively over-sample high leverage (100× liquidates on a
// ~1% move, 10× needs ~10%). So observed-share ÷ reach-probability(at that distance) =
// DE-BIASED resting mix, comparable to the model's tier weights. reach-prob is the empirical
// W-window excursion CDF from klines (both directions pooled).
//
// Two honest assumptions, both stated, both sensitivity-checked over the lookback W:
//   (1) trailing extreme ≈ entry price   (2) a fixed holding window W for reach-prob.
// Reports OBSERVED, DE-BIASED, and PRIOR per tier. Does NOT touch config (adoption needs
// forward magnet validation — V4 discipline). Read-only.  Run: node leverage-fit.mjs

import yaml from 'js-yaml';
import { readFileSync } from 'fs';

const ROOT = new URL('./', import.meta.url);
const config = yaml.load(readFileSync(new URL('config.yml', ROOT), 'utf8'));
const { tokens } = JSON.parse(readFileSync(new URL('data.json', ROOT), 'utf8'));
const WINDOWS_D = [2, 5, 10];
const rd = (p) => { try { return readFileSync(new URL(p, ROOT), 'utf8').split('\n').filter(Boolean); } catch { return []; } };

function effTiers(tcfg) {                       // effective tiers + NORMALIZED prior weights
  let t = (tcfg.leverage_tiers ?? config.leverage_tiers ?? []).map((x) => ({ ...x }));
  if (tcfg.max_leverage) t = t.filter((x) => x.lev <= tcfg.max_leverage);
  const s = t.reduce((a, x) => a + x.weight, 0) || 1;
  return t.map((x) => ({ lev: x.lev, prior: x.weight / s }));
}

function analyze(sym, td) {
  const tcfg = (config.tokens || []).find((t) => t.symbol === sym) || {};
  const tiers = effTiers(tcfg), mmr = tcfg.maintenance_margin_rate ?? config.maintenance_margin_rate ?? 0.004;
  const levs = tiers.map((t) => t.lev);
  // price path = longest kline series
  const ks = (td.venues || []).reduce((b, v) => ((v.klines || []).length > (b || []).length ? v.klines : b), null);
  const ev = rd(`liquidations/${sym}.jsonl`).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((e) => e && e.usd > 0);
  if (!ks || ks.length < 50 || ev.length < 300) return { sym, note: `insufficient (klines ${ks?.length || 0}, events ${ev.length})` };

  const T = ks.map((k) => k.t), H = ks.map((k) => k.h), L = ks.map((k) => k.l), C = ks.map((k) => k.c);
  const liqDist = (lev) => 1 / lev - mmr;        // price distance at which tier `lev` liquidates
  // nearest tier (in log-leverage) for an implied L
  const toTier = (impL) => { let bi = 0, bd = Infinity; for (let i = 0; i < levs.length; i++) { const d = Math.abs(Math.log(levs[i]) - Math.log(impL)); if (d < bd) { bd = d; bi = i; } } return bi; };

  const rows = [];
  for (const Wd of WINDOWS_D) {
    const Wms = Wd * 864e5, win = Wd * 24;
    // reach-prob: pooled up/down W-window excursions from the path
    const exc = [];
    for (let i = 0; i + win < C.length; i++) {
      let hi = -Infinity, lo = Infinity; for (let j = i + 1; j <= i + win; j++) { if (H[j] > hi) hi = H[j]; if (L[j] < lo) lo = L[j]; }
      exc.push(hi / C[i] - 1, 1 - lo / C[i]);
    }
    exc.sort((a, b) => a - b);
    const reachP = (d) => { let l = 0, h = exc.length; while (l < h) { const m = (l + h) >> 1; if (exc[m] < d) l = m + 1; else h = m; } return exc.length ? (exc.length - l) / exc.length : 0; };

    const obs = new Array(levs.length).fill(0); let used = 0;
    for (const e of ev) {
      // trailing extreme over [ts-W, ts]
      let lo = Infinity, hi = -Infinity, any = false;
      for (let i = 0; i < T.length; i++) { if (T[i] >= e.ts - Wms && T[i] <= e.ts) { any = true; if (H[i] > hi) hi = H[i]; if (L[i] < lo) lo = L[i]; } }
      if (!any) continue;
      const dist = e.side === 'long' ? (hi - e.px) / hi : (e.px - lo) / lo;
      if (!(dist > 0)) continue;
      const impL = 1 / (dist + mmr);
      obs[toTier(impL)] += e.usd; used++;
    }
    const obsSum = obs.reduce((a, b) => a + b, 0) || 1;
    const obsShare = obs.map((x) => x / obsSum);
    const deb = obsShare.map((s, i) => s / Math.max(1e-4, reachP(liqDist(levs[i]))));
    const debSum = deb.reduce((a, b) => a + b, 0) || 1;
    const debShare = deb.map((x) => x / debSum);
    rows.push({ Wd, used, obsShare, debShare });
  }
  return { sym, levs, priors: tiers.map((t) => t.prior), events: ev.length, rows };
}

const pc = (x) => (x * 100).toFixed(0).padStart(3) + '%';
for (const sym of Object.keys(tokens)) {
  const r = analyze(sym, tokens[sym]);
  if (r.note) { console.log(`\n${sym}: ${r.note}`); continue; }
  console.log(`\n=== ${sym}  (levs ${r.levs.join('/')}, ${r.events} real liquidations) ===`);
  console.log(`  PRIOR (hand-picked):      ${r.priors.map(pc).join(' ')}`);
  for (const w of r.rows) {
    console.log(`  W=${w.Wd}d  observed(raw):    ${w.obsShare.map(pc).join(' ')}   ← over-samples high lev`);
    console.log(`  W=${w.Wd}d  DE-BIASED resting: ${w.debShare.map(pc).join(' ')}   (${w.used} events used)`);
  }
}
console.log('\n(tiers left→right = ' + 'low→high leverage; de-biased = observed ÷ reach-probability)');
