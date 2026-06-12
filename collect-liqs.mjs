#!/usr/bin/env node
// REST liquidation poller — venues whose liquidation history is QUERYABLE, so no
// always-on daemon is needed (probed 2026-06-11): HTX (v3 swap_liquidation_orders,
// rich history), dYdX v4 (Indexer trades, type=LIQUIDATED), Kraken Futures (public
// history, type=liquidation). Runs on the 30-min publish tick after snapshot.mjs.
//
// Appends the SAME normalized schema as collector.mjs to liquidations/<TOK>.jsonl:
//   {v, src:'poll', venue, tok, ts, side, px, usd, id}   side = liquidated position side
// Watermark dedup via liquidations/.poll-state.json (first run backfills 24h).
// Per-venue failures are logged and skipped — never fails the tick.

import yaml from 'js-yaml';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';

const ROOT = new URL('./', import.meta.url);
const DIR = new URL('./liquidations/', ROOT);
mkdirSync(DIR, { recursive: true });
const config = yaml.load(readFileSync(new URL('./config.yml', ROOT), 'utf8'));
const STATE_URL = new URL('.poll-state.json', DIR);
const state = existsSync(STATE_URL) ? JSON.parse(readFileSync(STATE_URL, 'utf8')) : {};
const NOW = Date.now();
const since = (venue, tok) => state?.[venue]?.[tok] ?? (NOW - 24 * 3600e3);

async function j(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  return res.json();
}

// append events (already filtered > watermark), then advance the watermark to
// max(last event, NOW − 20min): an empty poll still proves we observed the query
// window, so quiet periods must not age the watermark (that caused false gap
// warnings and ever-deeper dYdX/Kraken paging). The 20-min overlap absorbs venue
// reporting lag; at the 30-min cadence staleness stays ≤50min < the 1h HTX window.
function commit(venue, tok, events) {
  events.sort((a, b) => a.ts - b.ts);
  for (const ev of events) appendFileSync(new URL(`${tok}.jsonl`, DIR), JSON.stringify({ v: 1, src: 'poll', venue, tok, ...ev }) + '\n');
  const prev = state?.[venue]?.[tok] ?? (NOW - 24 * 3600e3);
  const maxTs = events.length ? events[events.length - 1].ts : 0;
  (state[venue] ||= {})[tok] = Math.max(prev, maxTs, NOW - 20 * 60e3);
  return events.length;
}

const counts = {};
const log = (venue, tok, n, note = '') => { counts[venue] = (counts[venue] || 0) + n; if (n || note) console.error(`  ${venue}/${tok}: ${n} liq events${note}`); };

for (const t of config.tokens || []) {
  const tok = t.symbol;

  // ---- HTX: v3 liquidation-order history (USD turnover included) ----
  // The endpoint rejects long ranges (code 1347; 24h fails, 1h works) and returns
  // errors with HTTP 200 + body code — so query a fixed 1h window each tick (the
  // 30-min cadence double-covers it; the watermark dedups the overlap) and check
  // the body code explicitly.
  if (t.htx) {
    try {
      const from = since('htx', tok);
      const winStart = NOW - 3600e3;
      if (from < winStart - 60e3) console.error(`  htx/${tok}: watermark ${Math.round((NOW - from) / 60e3)}min old > 1h lookback — gap possible`);
      const d = await j(`https://api.hbdm.com/linear-swap-api/v3/swap_liquidation_orders?contract=${t.htx}&trade_type=0&start_time=${winStart}&end_time=${NOW}`);
      if (d?.code !== 200) throw new Error(`htx body code ${d?.code}: ${d?.msg}`);
      const rows = d?.data || [];
      const events = rows
        .filter((r) => +r.created_at > from)
        .map((r) => ({ ts: +r.created_at, side: r.direction === 'sell' ? 'long' : 'short', px: +r.price, usd: +r.trade_turnover, id: `htx-${r.query_id}` }));
      log('htx', tok, commit('htx', tok, events), rows.length >= 45 ? ' (page cap? possible truncation)' : '');
    } catch (e) { console.error(`  htx/${tok} FAILED: ${e.message}`); }
  }

  // ---- dYdX v4: Indexer trades, type=LIQUIDATED (page back to watermark) ----
  if (t.dydx) {
    try {
      const from = since('dydx', tok);
      const events = [];
      let before = '', oldest = Infinity;
      for (let page = 0; page < 10 && oldest > from; page++) {
        const d = await j(`https://indexer.dydx.trade/v4/trades/perpetualMarket/${t.dydx}?limit=100${before ? `&createdBeforeOrAt=${encodeURIComponent(before)}` : ''}`);
        const trades = d?.trades || [];
        if (!trades.length) break;
        for (const tr of trades) {
          const ts = Date.parse(tr.createdAt);
          if (ts < oldest) { oldest = ts; before = tr.createdAt; }
          if (ts > from && tr.type === 'LIQUIDATED') {
            events.push({ ts, side: tr.side === 'SELL' ? 'long' : 'short', px: +tr.price, usd: +tr.size * +tr.price, id: `dydx-${tr.id}` });
          }
        }
        if (trades.length < 100) break;
      }
      log('dydx', tok, commit('dydx', tok, events));
    } catch (e) { console.error(`  dydx/${tok} FAILED: ${e.message}`); }
  }

  // ---- Kraken Futures: public history, type=liquidation (page back to watermark) ----
  if (t.kraken) {
    try {
      const from = since('kraken', tok);
      const events = [];
      let lastTime = '', oldest = Infinity;
      for (let page = 0; page < 5 && oldest > from; page++) {
        const d = await j(`https://futures.kraken.com/derivatives/api/v3/history?symbol=${t.kraken}${lastTime ? `&lastTime=${encodeURIComponent(lastTime)}` : ''}`);
        const rows = d?.history || [];
        if (!rows.length) break;
        for (const r of rows) {
          const ts = Date.parse(r.time) || +r.time;
          if (ts < oldest) { oldest = ts; lastTime = r.time; }
          if (ts > from && r.type === 'liquidation') {
            events.push({ ts, side: r.side === 'sell' ? 'long' : 'short', px: +r.price, usd: +r.size * +r.price, id: `kraken-${r.trade_id ?? r.uid ?? ts}` });
          }
        }
        if (rows.length < 100) break;
      }
      log('kraken', tok, commit('kraken', tok, events));
    } catch (e) { console.error(`  kraken/${tok} FAILED: ${e.message}`); }
  }
}

writeFileSync(STATE_URL, JSON.stringify(state, null, 1));
console.error(`liq poll: ${Object.entries(counts).map(([v, n]) => `${v}=${n}`).join(' ') || 'no venues'} (watermarks advanced)`);
