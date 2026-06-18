#!/usr/bin/env node
// Best-effort daily ETF net-flow scrape (Farside Investors, no API key) → etf-flows.json,
// consumed as a directional vote in the squeeze score (inflow = spot buying = upside bias).
//
// Farside is Cloudflare + JS-walled, so we reuse the jobs-phuket Playwright scraper as a
// SUBPROCESS — no new dependency in this repo, and if it's absent/blocked this no-ops and
// the squeeze layer simply skips the ETF vote. Daily data, so it self-throttles: skips
// unless etf-flows.json is older than MAX_AGE_H. Last-good values are preserved on failure.
//
// Token → Farside slug via the `farside:` field in config.yml. Run: node etf-flows.mjs

import yaml from 'js-yaml';
import { readFileSync, writeFileSync, existsSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const ROOT = new URL('./', import.meta.url);
const OUT = new URL('etf-flows.json', ROOT);
const SCRAPER = fileURLToPath(new URL('../jobs-phuket/scan-browser.mjs', ROOT));
const MAX_AGE_H = 6;

const config = yaml.load(readFileSync(new URL('config.yml', ROOT), 'utf8'));
const slugs = (config.tokens || []).filter((t) => t.farside).map((t) => [t.symbol, t.farside]);
if (!slugs.length) { console.error('etf-flows: no tokens with a farside slug — nothing to do'); process.exit(0); }

const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { flows: {} };
if (existsSync(OUT) && (Date.now() - statSync(OUT).mtimeMs) < MAX_AGE_H * 3600e3) {
  console.error(`etf-flows: fresh (<${MAX_AGE_H}h) — skipping scrape`); process.exit(0);
}

// last dated row's final number = that day's Total net flow (US$m); parentheses = negative.
function latestFlow(text) {
  const t = String(text).replace(/\s+/g, ' ');
  const rows = [...t.matchAll(/(\d{1,2} [A-Z][a-z]{2} 20\d{2})([\s\S]*?)(?=\d{1,2} [A-Z][a-z]{2} 20\d{2}|Total|Average|$)/g)];
  if (!rows.length) return null;
  const last = rows[rows.length - 1];
  const nums = [...last[2].matchAll(/\(?-?\d+(?:\.\d+)?\)?/g)].map((m) => {
    const neg = m[0].includes('('); return (neg ? -1 : 1) * parseFloat(m[0].replace(/[()]/g, ''));
  });
  return nums.length ? { usdM: nums[nums.length - 1], date: last[1] } : null;
}

const flows = { ...(prev.flows || {}) };
for (const [sym, slug] of slugs) {
  try {
    const raw = execFileSync('node', [SCRAPER, `https://farside.co.uk/${slug}/`], { timeout: 70000, maxBuffer: 8e6 });
    const j = JSON.parse(raw.toString());
    const f = latestFlow(j.text || '');
    if (f && isFinite(f.usdM)) { flows[sym] = { usdM: f.usdM, date: f.date, asOf: new Date().toISOString() }; console.error(`etf-flows: ${sym} ${f.usdM >= 0 ? '+' : ''}$${f.usdM}m (${f.date})`); }
    else console.error(`etf-flows: ${sym} — parse failed, keeping prior`);
  } catch (e) { console.error(`etf-flows: ${sym} scrape failed (${e.message.slice(0, 60)}) — keeping prior`); }
}
writeFileSync(OUT, JSON.stringify({ updatedAt: new Date().toISOString(), flows }, null, 1));
console.error('etf-flows: wrote etf-flows.json');
