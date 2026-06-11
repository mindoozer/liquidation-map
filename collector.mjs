#!/usr/bin/env node
// Always-on WebSocket liquidation collector — OKX + Bybit, the venues that stream
// liquidations but keep no REST history (Phase A probe, 2026-06-09). Runs as a
// KeepAlive LaunchAgent (com.nikitiki.liqcollector); REST-pollable venues
// (HTX/dYdX/Kraken) are handled by collect-liqs.mjs on the publish tick instead.
//
// Purpose: REAL liquidation events (exchange-confirmed side/price/size) to validate
// the OI-drop proxy on the overlap venues and, over time, calibrate the model.
//
// Normalized event line (same schema as collect-liqs.mjs), one file per token:
//   liquidations/<TOK>.jsonl ← {v, src:'ws', venue, tok, ts, side, px, usd, id}
//   side = the LIQUIDATED position side ('long' | 'short')
//
// Zero deps beyond js-yaml (global WebSocket, Node ≥22). Reconnect with backoff,
// ping keepalive, 75s-silence watchdog, status in liquidations/.collector-status.json.
// Foreground test: COLLECTOR_TEST_SECS=90 node collector.mjs

import yaml from 'js-yaml';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'fs';

const ROOT = new URL('./', import.meta.url);
const DIR = new URL('./liquidations/', ROOT);
mkdirSync(DIR, { recursive: true });
const config = yaml.load(readFileSync(new URL('./config.yml', ROOT), 'utf8'));

// venue symbol → canonical token, from config (new tokens auto-subscribe)
const okxIds = new Map(), bybitSyms = new Map();
for (const t of config.tokens || []) {
  if (t.okx) okxIds.set(t.okx, t.symbol);
  if (t.bybit) bybitSyms.set(t.bybit, t.symbol);
}

const status = { startedAt: new Date().toISOString(), events: { okx: 0, bybit: 0 }, lastEventAt: {}, lastMsgAt: {} };
const writeStatus = () => { try { writeFileSync(new URL('.collector-status.json', DIR), JSON.stringify(status, null, 1)); } catch {} };
const touch = (name) => { status.lastMsgAt[name] = Date.now(); };

function record(venue, tok, ev) {
  appendFileSync(new URL(`${tok}.jsonl`, DIR), JSON.stringify({ v: 1, src: 'ws', venue, tok, ...ev }) + '\n');
  status.events[venue]++; status.lastEventAt[venue] = new Date().toISOString(); writeStatus();
  console.log(`${new Date().toISOString()} ${venue} ${tok} ${ev.side} liq ${ev.usd != null ? '$' + Math.round(ev.usd).toLocaleString() : '(no ctVal yet)'} @ ${ev.px}`);
}

// OKX sizes are in CONTRACTS — need ctVal (base units per contract) to get USD.
const ctVal = {};
async function loadOkxInstruments() {
  try {
    const r = await fetch('https://www.okx.com/api/v5/public/instruments?instType=SWAP');
    const d = await r.json();
    for (const it of d.data || []) if (okxIds.has(it.instId)) ctVal[it.instId] = +it.ctVal;
    console.log('okx ctVal map:', JSON.stringify(ctVal));
  } catch (e) {
    console.error(`okx instruments fetch failed (${e.message}) — retrying in 60s`);
    setTimeout(loadOkxInstruments, 60000);
  }
}

const WATCHDOGS = [];
function connect({ name, url, ping, onOpen, onMsg }) {
  let ws = null, pingTimer = null, backoff = 2000;
  const retry = () => { console.log(`${name}: reconnect in ${Math.round(backoff / 1000)}s`); setTimeout(dial, backoff); backoff = Math.min(backoff * 2, 60000); };
  const dial = () => {
    touch(name);
    try { ws = new WebSocket(url); } catch (e) { console.error(`${name}: dial failed ${e.message}`); return retry(); }
    ws.onopen = () => { console.log(`${name}: connected`); backoff = 2000; touch(name); try { onOpen(ws); } catch (e) { console.error(`${name}: onOpen ${e.message}`); } pingTimer = setInterval(() => { try { ping(ws); } catch {} }, 20000); };
    ws.onmessage = (m) => { touch(name); try { onMsg(m.data); } catch (e) { console.error(`${name}: msg error ${e.message}`); } };
    ws.onerror = (e) => console.error(`${name}: error ${e?.message || e?.type || 'unknown'}`);
    ws.onclose = () => { clearInterval(pingTimer); retry(); };
  };
  WATCHDOGS.push(() => { if (Date.now() - (status.lastMsgAt[name] || 0) > 75000) { console.log(`${name}: silent >75s — cycling socket`); try { ws?.close(); } catch {} } });
  dial();
}

// ---- OKX: all-SWAP liquidation-orders, filtered to our instIds ----
connect({
  name: 'okx',
  url: 'wss://ws.okx.com:8443/ws/v5/public',
  ping: (ws) => ws.send('ping'),
  onOpen: (ws) => ws.send(JSON.stringify({ op: 'subscribe', args: [{ channel: 'liquidation-orders', instType: 'SWAP' }] })),
  onMsg: (data) => {
    if (data === 'pong') return;
    const d = JSON.parse(data);
    if (d.event === 'subscribe') return console.log('okx: subscribed', JSON.stringify(d.arg || {}));
    if (d.event === 'error') return console.error(`okx: sub error ${d.code} ${d.msg}`);
    if (d.arg?.channel !== 'liquidation-orders' || !Array.isArray(d.data)) return;
    for (const it of d.data) {
      const tok = okxIds.get(it.instId);
      if (!tok) continue; // not one of our tokens
      for (const det of it.details || []) {
        const side = det.posSide === 'long' ? 'long' : det.posSide === 'short' ? 'short' : (det.side === 'sell' ? 'long' : 'short');
        const px = +det.bkPx, sz = +det.sz, cv = ctVal[it.instId];
        record('okx', tok, { ts: +det.ts, side, px, usd: cv > 0 ? sz * cv * px : null, id: `okx-${det.ts}-${px}-${sz}` });
      }
    }
  },
});

// ---- Bybit: allLiquidation per symbol ----
connect({
  name: 'bybit',
  url: 'wss://stream.bybit.com/v5/public/linear',
  ping: (ws) => ws.send(JSON.stringify({ op: 'ping' })),
  onOpen: (ws) => ws.send(JSON.stringify({ op: 'subscribe', args: [...bybitSyms.keys()].map((s) => `allLiquidation.${s}`) })),
  onMsg: (data) => {
    const d = JSON.parse(data);
    if (d.op === 'subscribe') return console.log(`bybit: subscribed success=${d.success}`);
    if (d.op === 'ping' || d.op === 'pong' || d.ret_msg === 'pong') return;
    if (!d.topic?.startsWith('allLiquidation') || !Array.isArray(d.data)) return;
    for (const x of d.data) {
      const tok = bybitSyms.get(x.s);
      if (!tok) continue;
      // Bybit semantics: S='Buy' means a SHORT was liquidated (forced buy-to-close)
      const side = x.S === 'Sell' ? 'long' : 'short';
      const px = +x.p, sz = +x.v;
      record('bybit', tok, { ts: +x.T, side, px, usd: sz * px, id: `bybit-${x.T}-${x.p}-${x.v}` });
    }
  },
});

loadOkxInstruments();
setInterval(() => WATCHDOGS.forEach((f) => f()), 30000);
setInterval(() => { console.log(`heartbeat: okx=${status.events.okx} bybit=${status.events.bybit} events since ${status.startedAt}`); writeStatus(); }, 30 * 60000);
writeStatus();
console.log(`collector up — okx[${[...okxIds.keys()].join(',')}] bybit[${[...bybitSyms.keys()].join(',')}]`);

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { console.log(`${sig} — flushing status, exiting`); writeStatus(); process.exit(0); });
if (process.env.COLLECTOR_TEST_SECS) setTimeout(() => { console.log(`test window (${process.env.COLLECTOR_TEST_SECS}s) done`); writeStatus(); process.exit(0); }, +process.env.COLLECTOR_TEST_SECS * 1000);
