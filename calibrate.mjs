#!/usr/bin/env node
// V4 calibration harness. Two parts, both honest about what the data can support:
//
// A. PROXY-VS-REAL — does the OI-drop proxy (what the reality-check/calibration fit
//    against, since it has 30d depth + Binance OI) actually track the real liquidation
//    events (V5 store, exchange-confirmed but only ~7d + sampled)? Hourly side-agreement
//    + rank-correlation. If the proxy doesn't track reality, calibrating to it is moot.
//
// B. CALIBRATE — for each token with an empirical target, TIME-SPLIT the klines (fit on
//    the older half, score on the held-out recent half), random-search tier weights +
//    half-lives REGULARIZED toward the current priors, objective = reach-weighted
//    alignment (cosAdjOverall). Report baseline vs fitted, in- and out-of-sample. Adopt
//    ONLY where fitted beats baseline out-of-sample by >= ADOPT_MARGIN. Writes
//    calibration.json; does NOT touch config.yml (that's a reviewed step).
//
// Run: node calibrate.mjs   (read-only except calibration.json)

import yaml from 'js-yaml';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { buildMap } from './lib/model.mjs';
import { buildBacktest } from './lib/backtest.mjs';

const ROOT = new URL('./', import.meta.url);
const config = yaml.load(readFileSync(new URL('config.yml', ROOT), 'utf8'));
const { tokens } = JSON.parse(readFileSync(new URL('data.json', ROOT), 'utf8'));
const ITERS = 500, ADOPT_MARGIN = 0.03, LAMBDA = 0.04;
const rd = (p) => { try { return readFileSync(new URL(p, ROOT), 'utf8').split('\n').filter(Boolean); } catch { return []; } };

// effective baseline tiers for a token (token override else global, filtered by max_leverage)
function baseTiers(tcfg) {
  let t = tcfg.leverage_tiers ?? config.leverage_tiers ?? [];
  if (tcfg.max_leverage) t = t.filter((x) => x.lev <= tcfg.max_leverage);
  return t.map((x) => ({ ...x }));
}
const mmrOf = (tcfg) => tcfg.maintenance_margin_rate ?? config.maintenance_margin_rate ?? 0.004;
const sliceData = (td, lo, hi) => ({ ...td, venues: (td.venues || []).map((v) => ({ ...v, klines: (v.klines || []).filter((k) => k.t >= lo && k.t < hi) })) });

// alignment of a tier set on a data slice (reach-weighted model-vs-empirical cosine)
function align(td, tiers, tcfg) {
  const synth = { ...tcfg, leverage_tiers: tiers };
  const m = buildMap(td, config, synth);
  if (!m) return null;
  const bt = buildBacktest(td, m, config, synth);
  return bt.insufficient ? null : bt.cosAdjOverall;
}

// ---------- A. proxy vs real ----------
function proxyVsReal(sym, td) {
  const ev = rd(`liquidations/${sym}.jsonl`).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((e) => e && e.usd > 0);
  if (ev.length < 200) return { sym, note: `thin (${ev.length} real events)` };
  // real hourly long/short $
  const realH = {};
  for (const e of ev) { const h = Math.floor(e.ts / 3600e3); (realH[h] ||= { l: 0, s: 0 }); realH[h][e.side === 'long' ? 'l' : 's'] += e.usd; }
  // proxy hourly destruction from OI drops (same inference the backtest uses)
  const proxH = {};
  for (const v of td.venues || []) {
    const ks = v.klines || [];
    for (let i = 1; i < ks.length; i++) {
      const c = ks[i], p = ks[i - 1];
      if (c.oiUsd == null || p.oiUsd == null || !(p.c > 0)) continue;
      const d = c.oiUsd - p.oiUsd; if (d >= 0) continue;
      const h = Math.floor(c.t / 3600e3); (proxH[h] ||= { l: 0, s: 0 });
      if (c.c < p.c) proxH[h].l += -d; else if (c.c > p.c) proxH[h].s += -d;
    }
  }
  // align on hours present in both
  const hrs = Object.keys(realH).filter((h) => proxH[h]);
  let sideMatch = 0, sideN = 0; const a = [], b = [];
  for (const h of hrs) {
    const r = realH[h], px = proxH[h];
    const rt = r.l + r.s, pt = px.l + px.s;
    if (rt > 0 && pt > 0) { a.push(pt); b.push(rt); }
    if (rt > 0 && pt > 0) { sideN++; if ((r.l >= r.s) === (px.l >= px.s)) sideMatch++; }
  }
  // Pearson on hourly totals (log to tame heavy tails)
  const lg = (x) => Math.log(x + 1);
  const A = a.map(lg), B = b.map(lg), n = A.length;
  let corr = null;
  if (n >= 10) {
    const ma = A.reduce((x, y) => x + y, 0) / n, mb = B.reduce((x, y) => x + y, 0) / n;
    let sab = 0, saa = 0, sbb = 0;
    for (let i = 0; i < n; i++) { sab += (A[i] - ma) * (B[i] - mb); saa += (A[i] - ma) ** 2; sbb += (B[i] - mb) ** 2; }
    corr = saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : null;
  }
  return { sym, realEvents: ev.length, sharedHours: n, sideAgreement: sideN ? sideMatch / sideN : null, corr };
}

// ---------- B. calibrate ----------
function calibrate(sym, td, tcfg) {
  const ts = (td.venues || []).flatMap((v) => (v.klines || []).map((k) => k.t));
  if (!ts.length) return { sym, note: 'no klines' };
  const lo = Math.min(...ts), hi = Math.max(...ts), mid = lo + (hi - lo) / 2;
  const train = sliceData(td, lo, mid), test = sliceData(td, mid, hi + 1);
  const base = baseTiers(tcfg), mmr = mmrOf(tcfg);

  const bTrain = align(train, base, tcfg), bTest = align(test, base, tcfg);
  if (bTrain == null || bTest == null) return { sym, note: 'backtest insufficient (no hourly OI or too thin) — cannot calibrate' };

  const w0 = base.map((t) => t.weight), hl0 = base.map((t) => t.half_life_days);
  const penalty = (w, hl) => LAMBDA * base.reduce((a, _, i) => a + Math.log(w[i] / w0[i]) ** 2 + Math.log(hl[i] / hl0[i]) ** 2, 0);
  const ln = (sig) => Math.exp((Math.random() * 2 - 1) * sig); // ~lognormal-ish multiplier

  let best = { score: bTrain - 0, tiers: base, w: w0, hl: hl0, trainAlign: bTrain };
  for (let it = 0; it < ITERS; it++) {
    const w = w0.map((x) => x * ln(0.6)); const sw = w.reduce((a, b) => a + b, 0); for (let i = 0; i < w.length; i++) w[i] /= sw;
    const hl = hl0.map((x) => Math.min(20, Math.max(0.25, x * ln(0.7))));
    const tiers = base.map((t, i) => ({ ...t, weight: w[i], half_life_days: hl[i] }));
    const al = align(train, tiers, tcfg);
    if (al == null) continue;
    const score = al - penalty(w, hl);
    if (score > best.score) best = { score, tiers, w, hl, trainAlign: al };
  }
  const fTest = align(test, best.tiers, tcfg);
  const adopt = fTest != null && (fTest - bTest) >= ADOPT_MARGIN;
  return {
    sym, mmr,
    baseline: { weights: w0.map((x) => +x.toFixed(2)), halflives: hl0, trainAlign: +bTrain.toFixed(3), testAlign: +bTest.toFixed(3) },
    fitted: { weights: best.w.map((x) => +x.toFixed(3)), halflives: best.hl.map((x) => +x.toFixed(2)), trainAlign: +best.trainAlign.toFixed(3), testAlign: fTest != null ? +fTest.toFixed(3) : null },
    levs: base.map((t) => t.lev),
    testGain: fTest != null ? +(fTest - bTest).toFixed(3) : null,
    adopt,
  };
}

const out = { generatedAt: new Date().toISOString(), iters: ITERS, adoptMargin: ADOPT_MARGIN, proxyVsReal: [], calibration: [] };
console.log('===== A. PROXY vs REAL (does the OI-drop proxy track real liquidations?) =====');
for (const sym of Object.keys(tokens)) {
  const r = proxyVsReal(sym, tokens[sym]); out.proxyVsReal.push(r);
  if (r.note) { console.log(`  ${sym.padEnd(7)} ${r.note}`); continue; }
  console.log(`  ${sym.padEnd(7)} events=${String(r.realEvents).padStart(5)}  sharedHrs=${String(r.sharedHours).padStart(4)}  side-agreement=${r.sideAgreement != null ? (r.sideAgreement * 100).toFixed(0) + '%' : '—'}  hourly-corr=${r.corr != null ? r.corr.toFixed(2) : '—'}`);
}
console.log('\n===== B. CALIBRATION (time-split, fit older half → score held-out recent half) =====');
for (const sym of Object.keys(tokens)) {
  const tcfg = (config.tokens || []).find((t) => t.symbol === sym) || {};
  const r = calibrate(sym, tokens[sym], tcfg); out.calibration.push(r);
  if (r.note) { console.log(`  ${sym.padEnd(7)} ${r.note}`); continue; }
  console.log(`  ${sym.padEnd(7)} levs ${r.levs.join('/')}`);
  console.log(`           baseline  train ${r.baseline.trainAlign}  test ${r.baseline.testAlign}   weights ${r.baseline.weights.join('/')} hl ${r.baseline.halflives.join('/')}`);
  console.log(`           fitted    train ${r.fitted.trainAlign}  test ${r.fitted.testAlign}   weights ${r.fitted.weights.join('/')} hl ${r.fitted.halflives.join('/')}`);
  console.log(`           → out-of-sample test gain ${r.testGain >= 0 ? '+' : ''}${r.testGain}  ⇒  ${r.adopt ? 'ADOPT' : 'KEEP PRIORS (gain < ' + ADOPT_MARGIN + ')'}`);
}
writeFileSync(new URL('calibration.json', ROOT), JSON.stringify(out, null, 1));
console.log('\nwrote calibration.json');
