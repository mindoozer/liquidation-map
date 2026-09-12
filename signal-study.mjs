#!/usr/bin/env node
// signal-study.mjs — does ANYTHING this tracker computes actually PREDICT forward returns?
// Reads its own snapshot history (snapshots/<TOK>.jsonl) + real liquidations and runs an
// event/bucket study per signal family. Read-only; writes nothing. Run: node signal-study.mjs
//
// Honesty rules baked in (same discipline as magnet-study/calibrate):
// • 30-min snapshots overlap heavily at 24/48h horizons → effective n ≈ unique DAYS, not ticks.
//   Every table reports both, and a non-overlapping daily-last-tick variant is the robustness check.
// • Hit rates are judged against that token's UNCONDITIONAL drift over the same period (a 60%
//   long-hit-rate in a rising tape is base rate, not signal).
// • Era boundaries: fuel/oi MAGNITUDES step up at the 2026-07-09 venue expansion → only ratios,
//   signs, and votes are compared across it. conc/ig exists only since 2026-07-04. sqz since 06-13.
// • Signal → expected direction conventions (fixed a priori, not fitted):
//     sqz ≤ −2  (short-squeeze)   → expect UP     sqz ≥ +2 → expect DOWN
//     ig.side = short (fuel closer overhead)      → expect UP   (magnet pull), long → DOWN
//     funding high (longs pay)                    → expect DOWN (crowding contrarian), low → UP
//     fuel skew long-heavy below                  → expect DOWN (price hunts fuel), short-heavy → UP
//     long-liq burst (capitulation)               → expect UP after; short-liq burst → DOWN after

import { readFileSync, readdirSync, existsSync } from 'fs';

const ROOT = new URL('./', import.meta.url);
const HORIZONS = [4, 24, 48]; // hours
const bps = (x) => (x * 1e4).toFixed(0);

function loadSnaps(tok) {
  const rows = readFileSync(new URL(`snapshots/${tok}.jsonl`, ROOT), 'utf8').trimEnd().split('\n')
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean)
    .map((j) => ({ ts: Date.parse(j.ts), px: j.px, sqz: j.sqz, f8: j.f8, fuel: j.fuel5, ig: j.conc?.ig?.side ?? null, day: j.ts.slice(0, 10) }))
    .filter((r) => r.px > 0 && Number.isFinite(r.ts))
    .sort((a, b) => a.ts - b.ts);
  return rows;
}

// forward log-return from row i to first row ≥ ts+h·3600e3 (null if gap > h+3h — sleep/outage)
function fwdRet(rows, i, hours) {
  const target = rows[i].ts + hours * 3600e3;
  let lo = i + 1, hi = rows.length - 1, j = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (rows[m].ts >= target) { j = m; hi = m - 1; } else lo = m + 1; }
  if (j < 0 || rows[j].ts > target + 3 * 3600e3) return null;
  return Math.log(rows[j].px / rows[i].px);
}

// aggregate a set of (expectUp, ret) samples → mean bps, hit rate, tick n, day n
function agg(samples) {
  if (!samples.length) return null;
  const n = samples.length;
  const mean = samples.reduce((a, s) => a + (s.expectUp ? s.r : -s.r), 0) / n; // signed: + = signal-direction profit
  const hits = samples.filter((s) => (s.r > 0) === s.expectUp).length;
  const days = new Set(samples.map((s) => s.day)).size;
  // crude t on day-level means (the honest n)
  const byDay = {};
  for (const s of samples) (byDay[s.day] ||= []).push(s.expectUp ? s.r : -s.r);
  const dm = Object.values(byDay).map((a) => a.reduce((x, y) => x + y, 0) / a.length);
  const m = dm.reduce((a, b) => a + b, 0) / dm.length;
  const sd = Math.sqrt(dm.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, dm.length - 1)) || 1e-9;
  const t = m / (sd / Math.sqrt(dm.length));
  return { meanBps: +bps(mean), hitPct: +((hits / n) * 100).toFixed(0), n, days, tDay: +t.toFixed(2) };
}

const tokens = readdirSync(new URL('snapshots/', ROOT)).filter((f) => f.endsWith('.jsonl')).map((f) => f.replace('.jsonl', ''));
const all = {}; for (const tok of tokens) all[tok] = loadSnaps(tok);

const fmt = (a) => a ? `${String(a.meanBps).padStart(6)}bps hit ${String(a.hitPct).padStart(3)}% (n=${a.n}, days=${a.days}, t≈${a.tDay})` : '        —';

console.log('════ BASELINE drift per token (mean fwd return, all ticks — the bar every signal must beat) ════');
for (const tok of tokens) {
  const rows = all[tok];
  const line = HORIZONS.map((h) => {
    const rs = rows.map((_, i) => fwdRet(rows, i, h)).filter((x) => x != null);
    return `${h}h: ${bps(rs.reduce((a, b) => a + b, 0) / (rs.length || 1))}bps`;
  }).join('  ');
  console.log(`  ${tok.padEnd(7)} ${line}  (${rows.length} ticks, ${new Set(rows.map((r) => r.day)).size} days)`);
}

// ---- 1. SQUEEZE SCORE (|sqz| ≥ 2; direction: sqz<0 → up) ----
console.log('\n════ 1. SQUEEZE SCORE — state study: all ticks with |sqz| ≥ 2 ════');
for (const h of HORIZONS) {
  const pooled = [];
  for (const tok of tokens) {
    const rows = all[tok];
    rows.forEach((r, i) => {
      if (r.sqz == null || Math.abs(r.sqz) < 2) return;
      const ret = fwdRet(rows, i, h); if (ret == null) return;
      pooled.push({ expectUp: r.sqz < 0, r: ret, day: r.day, tok });
    });
  }
  console.log(`  ${String(h).padStart(2)}h pooled  ${fmt(agg(pooled))}`);
  if (h === 24) for (const tok of tokens) { const sub = pooled.filter((s) => s.tok === tok); if (sub.length) console.log(`      ${tok.padEnd(7)}${fmt(agg(sub))}`); }
}

console.log('\n════ 1b. SQUEEZE FLIPS — event study: first tick ENTERING |sqz| ≥ 2 (the alert moments) ════');
for (const h of HORIZONS) {
  const ev = [];
  for (const tok of tokens) {
    const rows = all[tok];
    rows.forEach((r, i) => {
      if (r.sqz == null || Math.abs(r.sqz) < 2) return;
      if (i > 0 && rows[i - 1].sqz != null && Math.abs(rows[i - 1].sqz) >= 2) return; // not a flip
      const ret = fwdRet(rows, i, h); if (ret == null) return;
      ev.push({ expectUp: r.sqz < 0, r: ret, day: r.day });
    });
  }
  console.log(`  ${String(h).padStart(2)}h  ${fmt(agg(ev))}`);
}

console.log('\n════ 1c. SQUEEZE robustness — DAILY variant (last tick per day only, non-overlapping 24h) ════');
{
  const pooled = [];
  for (const tok of tokens) {
    const rows = all[tok];
    const lastOfDay = new Map(); rows.forEach((r, i) => lastOfDay.set(r.day, i));
    for (const i of lastOfDay.values()) {
      const r = rows[i];
      if (r.sqz == null || Math.abs(r.sqz) < 2) continue;
      const ret = fwdRet(rows, i, 24); if (ret == null) continue;
      pooled.push({ expectUp: r.sqz < 0, r: ret, day: r.day });
    }
  }
  console.log(`  24h  ${fmt(agg(pooled))}`);
}

// ---- 2. IGNITION SIDE (conc.ig, since 07-04; short-closer → up) ----
console.log('\n════ 2. IGNITION SIDE (concentration asymmetry; magnet-pull direction) ════');
for (const h of HORIZONS) {
  const pooled = [];
  for (const tok of tokens) {
    const rows = all[tok];
    rows.forEach((r, i) => {
      if (r.ig !== 'short' && r.ig !== 'long') return;
      const ret = fwdRet(rows, i, h); if (ret == null) return;
      pooled.push({ expectUp: r.ig === 'short', r: ret, day: r.day });
    });
  }
  console.log(`  ${String(h).padStart(2)}h  ${fmt(agg(pooled))}`);
}

// ---- 3. FUNDING extremes (per-token quintiles; high funding → down) ----
console.log('\n════ 3. FUNDING — top vs bottom per-token quintile (contrarian: longs-pay → down) ════');
for (const h of HORIZONS) {
  const pooled = [];
  for (const tok of tokens) {
    const rows = all[tok].filter((r) => r.f8 != null);
    if (rows.length < 50) continue;
    const sorted = [...rows.map((r) => r.f8)].sort((a, b) => a - b);
    const q20 = sorted[Math.floor(sorted.length * 0.2)], q80 = sorted[Math.floor(sorted.length * 0.8)];
    const idx = all[tok];
    idx.forEach((r, i) => {
      if (r.f8 == null) return;
      let expectUp = null;
      // STRICT tails: NMR's f8 is a constant modal 5e-05 on 55% of ticks, sitting exactly at
      // its q80 — inclusive tails silently made its "extreme" bucket 63% of the token (verifier
      // catch 2026-07-15). Strict comparison keeps ties out of both tails.
      if (r.f8 < q20) expectUp = true; else if (r.f8 > q80) expectUp = false;
      if (expectUp == null) return;
      const ret = fwdRet(idx, i, h); if (ret == null) return;
      pooled.push({ expectUp, r: ret, day: r.day });
    });
  }
  console.log(`  ${String(h).padStart(2)}h  ${fmt(agg(pooled))}`);
}

// ---- 4. FUEL SKEW (ln(L/S) per-token quintiles; long-heavy → down) ----
console.log('\n════ 4. FUEL SKEW ±5% — top vs bottom per-token quintile (price hunts the bigger side) ════');
for (const h of HORIZONS) {
  const pooled = [];
  for (const tok of tokens) {
    const rows = all[tok].filter((r) => Array.isArray(r.fuel) && (r.fuel[0] > 0 || r.fuel[1] > 0));
    if (rows.length < 50) continue;
    const skew = (r) => Math.log((r.fuel[0] + 1) / (r.fuel[1] + 1));
    const sorted = rows.map(skew).sort((a, b) => a - b);
    const q20 = sorted[Math.floor(sorted.length * 0.2)], q80 = sorted[Math.floor(sorted.length * 0.8)];
    const idx = all[tok];
    idx.forEach((r, i) => {
      if (!Array.isArray(r.fuel) || (r.fuel[0] <= 0 && r.fuel[1] <= 0)) return;
      const s = skew(r);
      let expectUp = null;
      if (s <= q20) expectUp = true; else if (s >= q80) expectUp = false; // long-heavy below → down
      if (expectUp == null) return;
      const ret = fwdRet(idx, i, h); if (ret == null) return;
      pooled.push({ expectUp, r: ret, day: r.day });
    });
  }
  console.log(`  ${String(h).padStart(2)}h  ${fmt(agg(pooled))}`);
}

// ---- 5. LIQUIDATION BURSTS (capitulation: hourly long-liq z>2 → up; short z>2 → down) ----
console.log('\n════ 5. REAL-LIQ BURSTS — hourly z>2 vs trailing 7d (capitulation-reversal hypothesis) ════');
for (const h of HORIZONS) {
  const pooled = [];
  for (const tok of tokens) {
    const f = new URL(`liquidations/${tok}.jsonl`, ROOT);
    if (!existsSync(f)) continue;
    const hours = {};
    for (const line of readFileSync(f, 'utf8').trimEnd().split('\n')) {
      let e; try { e = JSON.parse(line); } catch { continue; }
      const hr = Math.floor(e.ts / 3600e3);
      (hours[hr] ||= { l: 0, s: 0 });
      hours[hr][e.side === 'long' ? 'l' : 's'] += e.usd;
    }
    const keys = Object.keys(hours).map(Number).sort((a, b) => a - b);
    const rows = all[tok];
    for (const hr of keys) {
      const trail = []; for (let k = hr - 168; k < hr; k++) if (hours[k]) trail.push(hours[k]);
      if (trail.length < 48) continue;
      for (const side of ['l', 's']) {
        const m = trail.reduce((a, b) => a + b[side], 0) / trail.length;
        const sd = Math.sqrt(trail.reduce((a, b) => a + (b[side] - m) ** 2, 0) / trail.length) || 1e-9;
        const z = (hours[hr][side] - m) / sd;
        if (z < 2 || hours[hr][side] < 50000) continue;
        const ts = (hr + 1) * 3600e3; // enter AFTER the burst hour closes
        let lo2 = 0, hi2 = rows.length - 1, i = -1;
        while (lo2 <= hi2) { const mm = (lo2 + hi2) >> 1; if (rows[mm].ts >= ts) { i = mm; hi2 = mm - 1; } else lo2 = mm + 1; }
        if (i < 0 || rows[i].ts > ts + 2 * 3600e3) continue;
        const ret = fwdRet(rows, i, h); if (ret == null) continue;
        pooled.push({ expectUp: side === 'l', r: ret, day: rows[i].day });
      }
    }
  }
  console.log(`  ${String(h).padStart(2)}h  ${fmt(agg(pooled))}`);
}

console.log('\ncaveats: overlapping ticks (trust t≈ on DAYS, not n); one regime (~5wk, broadly risk-on then chop);');
console.log('multiple comparisons across 5 families × 3 horizons — a lone |t|<2 is noise, not edge.');
