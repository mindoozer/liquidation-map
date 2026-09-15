#!/usr/bin/env node
// Magnet study — forward test of the central liquidation-map trading thesis:
// "price gets pulled toward large liquidation walls" (liquidity hunting).
//
// Method: every V2 snapshot recorded the top-10 predicted walls at its timestamp.
// For each snapshot older than the horizon (24h), check whether price subsequently
// TOUCHED each wall level (hourly highs/lows), then compare against a MATCHED BASE
// RATE: the empirical probability that price moves ≥ that distance in that direction
// within the horizon anyway (excursion CDF over all hourly windows of the same
// series). lift = touch − base. Positive lift across enough samples = walls attract;
// ~0 = walls are just where price was going anyway; negative = repelled.
//
// Evidence is cumulative: data.json only spans ~30d of klines, so each run archives
// the hourly candles to klines/<TOK>.jsonl (append-only, dedup by open time, complete
// candles only) and scores against archive ∪ live — the window grows with calendar
// time instead of rolling. firstSnapshot/lastSnapshot are stamped only from snapshots
// that PASSED the kline-coverage gate, so they label the window actually scored.
//
// Output: magnet.json (pooled distance buckets + per-token × per-side cells + sample
// counts), rendered as the "Magnet study" panel. Runs each publish tick (cheap).
// Honest by construction: tiny n is labeled, the matched base controls for distance
// but not regime, and walls <0.5% away are skipped (trivial).

import yaml from 'js-yaml';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';

const ROOT = new URL('./', import.meta.url);
const HORIZON_H = 24;
const BUCKETS = [[0.5, 1], [1, 2], [2, 3], [3, 5], [5, 10]];

const config = yaml.load(readFileSync(new URL('./config.yml', ROOT), 'utf8'));
const { tokens } = JSON.parse(readFileSync(new URL('./data.json', ROOT), 'utf8'));

// bucket accumulators: walls n, touches, summed matched base
const mkBuckets = () => BUCKETS.map(([lo, hi]) => ({ bucket: `${lo}–${hi}%`, lo, hi, n: 0, hits: 0, baseSum: 0 }));
const emit = (b) => ({ bucket: b.bucket, n: b.n, touch: b.n ? b.hits / b.n : 0, base: b.n ? b.baseSum / b.n : 0, lift: b.n ? b.hits / b.n - b.baseSum / b.n : 0 });

const pooled = mkBuckets();
const perToken = {};
const cells = []; // per-token × per-side (above/below spot) bucket cells
let firstSnapshot = null, lastSnapshot = null, totalWalls = 0;
mkdirSync(new URL('./klines/', ROOT), { recursive: true });

for (const t of config.tokens || []) {
  const sym = t.symbol;
  const snapFile = new URL(`./snapshots/${sym}.jsonl`, ROOT);
  if (!existsSync(snapFile)) continue;
  const nowMs = Date.now();

  // price path: archived candles ∪ this tick's longest-kline venue (archive wins on
  // overlap — scoring stays reproducible against klines/<TOK>.jsonl; live fills the
  // unarchived tail incl. the in-progress hour, and the archive alone carries a token
  // through a failed fetch)
  const venues = tokens?.[sym]?.venues || [];
  const best = venues.reduce((b, v) => ((v.klines || []).length > (b?.klines || []).length ? v : b), null);
  const arcFile = new URL(`./klines/${sym}.jsonl`, ROOT);
  const byT = new Map();
  if (existsSync(arcFile)) for (const line of readFileSync(arcFile, 'utf8').split('\n')) {
    if (!line) continue;
    try { const k = JSON.parse(line); byT.set(k.t, k); } catch { continue; }
  }
  const fresh = (best?.klines || []).filter((k) => !byT.has(k.t) && k.t + 3600e3 <= nowMs); // complete candles only
  if (fresh.length) appendFileSync(arcFile, fresh.map((k) => JSON.stringify({ tok: sym, venue: best.exchange, t: k.t, o: k.o, h: k.h, l: k.l, c: k.c }) + '\n').join(''));
  for (const k of best?.klines || []) if (!byT.has(k.t)) byT.set(k.t, k);
  const ks = [...byT.values()].sort((a, b) => a.t - b.t);
  if (ks.length < HORIZON_H + 2) continue;

  // excursion CDFs: for every hourly window, max up/down move (%) over the next HORIZON_H
  const upExc = [], downExc = [];
  for (let i = 0; i + HORIZON_H < ks.length; i++) {
    const ref = ks[i].c;
    if (!(ref > 0)) continue;
    if (Math.abs(ks[i + HORIZON_H].t - ks[i].t - HORIZON_H * 3600e3) > 300e3) continue; // archive gap — not a contiguous 24h window
    let hi = -Infinity, lo = Infinity;
    for (let j = i + 1; j <= i + HORIZON_H; j++) { if (ks[j].h > hi) hi = ks[j].h; if (ks[j].l < lo) lo = ks[j].l; }
    upExc.push(hi / ref - 1); downExc.push(1 - lo / ref);
  }
  upExc.sort((a, b) => a - b); downExc.sort((a, b) => a - b);
  const baseP = (dist, dir) => { // P(excursion ≥ dist) via sorted array
    const arr = dir === 'up' ? upExc : downExc;
    if (!arr.length) return null;
    let lo2 = 0, hi2 = arr.length;
    while (lo2 < hi2) { const m = (lo2 + hi2) >> 1; if (arr[m] < dist) lo2 = m + 1; else hi2 = m; }
    return (arr.length - lo2) / arr.length;
  };

  let samples = 0;
  const bySide = { above: mkBuckets(), below: mkBuckets() };
  for (const line of readFileSync(snapFile, 'utf8').split('\n')) {
    if (!line) continue;
    let s; try { s = JSON.parse(line); } catch { continue; }
    const ts = Date.parse(s.ts);
    if (!isFinite(ts) || nowMs - ts < HORIZON_H * 3600e3) continue; // horizon not elapsed yet

    // future window: candles in (ts, ts + horizon] (ks is sorted — binary-search the start)
    let sLo = 0, sHi = ks.length;
    while (sLo < sHi) { const m = (sLo + sHi) >> 1; if (ks[m].t <= ts) sLo = m + 1; else sHi = m; }
    let hi = -Infinity, lo = Infinity, nWin = 0;
    for (let j = sLo; j < ks.length && ks[j].t <= ts + HORIZON_H * 3600e3; j++) { nWin++; if (ks[j].h > hi) hi = ks[j].h; if (ks[j].l < lo) lo = ks[j].l; }
    if (nWin < HORIZON_H - 4) continue; // incomplete coverage (data gap)
    samples++;
    if (!firstSnapshot || s.ts < firstSnapshot) firstSnapshot = s.ts; // stamped AFTER the coverage gate
    if (!lastSnapshot || s.ts > lastSnapshot) lastSnapshot = s.ts;

    for (const [off, usd] of s.top || []) {
      const dist = Math.abs(off) / 100;
      const bi = pooled.findIndex((b) => Math.abs(off) >= b.lo && Math.abs(off) < b.hi);
      if (bi < 0 || !(usd > 0)) continue;
      const wallPx = s.px * (1 + off / 100);
      const touched = off < 0 ? lo <= wallPx : hi >= wallPx;
      const base = baseP(dist, off < 0 ? 'down' : 'up');
      if (base == null) continue;
      for (const b of [pooled[bi], bySide[off < 0 ? 'below' : 'above'][bi]]) { b.n++; b.hits += touched ? 1 : 0; b.baseSum += base; }
      totalWalls++;
    }
  }
  if (samples) {
    perToken[sym] = { samples };
    for (const side of ['above', 'below']) for (const b of bySide[side]) cells.push({ tok: sym, side, ...emit(b) });
  }
}

const out = {
  generatedAt: new Date().toISOString(),
  horizonH: HORIZON_H,
  firstSnapshot,
  lastSnapshot,
  totalWalls,
  tokens: perToken,
  pooled: pooled.map(emit),
  cells,
};
writeFileSync(new URL('./magnet.json', ROOT), JSON.stringify(out, null, 1));
console.error(`magnet: ${totalWalls} wall-samples across ${Object.keys(perToken).length} tokens (${Object.entries(perToken).map(([k, v]) => `${k}:${v.samples}`).join(' ')}) window ${(firstSnapshot || '').slice(0, 10)}→${(lastSnapshot || '').slice(0, 10)}`);
