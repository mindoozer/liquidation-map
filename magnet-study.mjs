#!/usr/bin/env node
// Magnet study — forward test of the central liquidation-map trading thesis:
// "price gets pulled toward large liquidation walls" (liquidity hunting).
//
// Method: every V2 snapshot recorded the top-10 predicted walls at its timestamp.
// For each snapshot older than the horizon (24h), check whether price subsequently
// TOUCHED each wall level (hourly highs/lows from data.json), then compare against a
// MATCHED BASE RATE: the empirical probability that price moves ≥ that distance in
// that direction within the horizon anyway (excursion CDF over all hourly windows in
// the 30d klines). lift = touch − base. Positive lift across enough samples = walls
// attract; ~0 = walls are just where price was going anyway; negative = repelled.
//
// Output: magnet.json (pooled distance buckets + per-token sample counts), rendered
// as the "Magnet study" panel. Runs each publish tick (cheap); confidence accrues
// with calendar time. Honest by construction: tiny n is labeled, the matched base
// controls for distance but not regime, and walls <0.5% away are skipped (trivial).

import yaml from 'js-yaml';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const ROOT = new URL('./', import.meta.url);
const HORIZON_H = 24;
const BUCKETS = [[0.5, 1], [1, 2], [2, 3], [3, 5], [5, 10]];

const config = yaml.load(readFileSync(new URL('./config.yml', ROOT), 'utf8'));
const { tokens } = JSON.parse(readFileSync(new URL('./data.json', ROOT), 'utf8'));

// pooled accumulators per bucket: walls n, touches, summed matched base
const pooled = BUCKETS.map(([lo, hi]) => ({ bucket: `${lo}–${hi}%`, lo, hi, n: 0, hits: 0, baseSum: 0 }));
const perToken = {};
let firstSnapshot = null, totalWalls = 0;

for (const t of config.tokens || []) {
  const sym = t.symbol;
  const snapFile = new URL(`./snapshots/${sym}.jsonl`, ROOT);
  if (!existsSync(snapFile)) continue;

  // price path: venue with the longest kline history (hourly OHLC)
  const venues = tokens?.[sym]?.venues || [];
  const ks = venues.reduce((best, v) => ((v.klines || []).length > (best || []).length ? v.klines : best), null);
  if (!ks || ks.length < HORIZON_H + 2) continue;

  // excursion CDFs: for every hourly window, max up/down move (%) over the next HORIZON_H
  const upExc = [], downExc = [];
  for (let i = 0; i + HORIZON_H < ks.length; i++) {
    const ref = ks[i].c;
    if (!(ref > 0)) continue;
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

  const nowMs = Date.now();
  let samples = 0;
  for (const line of readFileSync(snapFile, 'utf8').split('\n')) {
    if (!line) continue;
    let s; try { s = JSON.parse(line); } catch { continue; }
    const ts = Date.parse(s.ts);
    if (!isFinite(ts) || nowMs - ts < HORIZON_H * 3600e3) continue; // horizon not elapsed yet
    if (!firstSnapshot || s.ts < firstSnapshot) firstSnapshot = s.ts;

    // future window: candles in (ts, ts + horizon]
    let hi = -Infinity, lo = Infinity, nWin = 0;
    for (const k of ks) if (k.t > ts && k.t <= ts + HORIZON_H * 3600e3) { nWin++; if (k.h > hi) hi = k.h; if (k.l < lo) lo = k.l; }
    if (nWin < HORIZON_H - 4) continue; // incomplete coverage (data gap)
    samples++;

    for (const [off, usd] of s.top || []) {
      const dist = Math.abs(off) / 100;
      const bucket = pooled.find((b) => Math.abs(off) >= b.lo && Math.abs(off) < b.hi);
      if (!bucket || !(usd > 0)) continue;
      const wallPx = s.px * (1 + off / 100);
      const touched = off < 0 ? lo <= wallPx : hi >= wallPx;
      const base = baseP(dist, off < 0 ? 'down' : 'up');
      if (base == null) continue;
      bucket.n++; bucket.hits += touched ? 1 : 0; bucket.baseSum += base;
      totalWalls++;
    }
  }
  if (samples) perToken[sym] = { samples };
}

const out = {
  generatedAt: new Date().toISOString(),
  horizonH: HORIZON_H,
  firstSnapshot,
  totalWalls,
  tokens: perToken,
  pooled: pooled.map((b) => ({ bucket: b.bucket, n: b.n, touch: b.n ? b.hits / b.n : 0, base: b.n ? b.baseSum / b.n : 0, lift: b.n ? b.hits / b.n - b.baseSum / b.n : 0 })),
};
writeFileSync(new URL('./magnet.json', ROOT), JSON.stringify(out, null, 1));
console.error(`magnet: ${totalWalls} wall-samples across ${Object.keys(perToken).length} tokens (${Object.entries(perToken).map(([k, v]) => `${k}:${v.samples}`).join(' ')})`);
