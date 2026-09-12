#!/usr/bin/env node
// Temporarily silence the macOS alert popups (collector burst/sweep + snapshot squeeze-flip).
// The switch is a single file, .notify-mute, that lib/notify.mjs checks on EVERY call — so it
// takes effect instantly for the always-on collector daemon (no restart needed). Alerts are
// still recorded to liquidations/alerts.jsonl; only the popup is suppressed.
//
//   node mute.mjs              mute until next 08:00 local ("morning")   [default]
//   node mute.mjs 2h | 90m     mute for a relative duration (bare number = hours)
//   node mute.mjs on           mute indefinitely (until you unmute)
//   node mute.mjs off          unmute now            (aliases: clear, unmute, none)
//   node mute.mjs status       show current state
import { writeFileSync, unlinkSync, readFileSync, existsSync } from 'fs';

const FILE = new URL('./.notify-mute', import.meta.url);
const arg = (process.argv[2] || 'morning').toLowerCase();
const fmt = (ms) => new Date(ms).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
const MORNING_HOUR = 8;

function nextMorning(hour = MORNING_HOUR) {
  const d = new Date(); d.setHours(hour, 0, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1); // already past → tomorrow
  return d.getTime();
}

if (['off', 'clear', 'unmute', 'none'].includes(arg)) {
  try { unlinkSync(FILE); console.log('🔔 popups ON — mute cleared'); } catch { console.log('🔔 already unmuted'); }
  process.exit(0);
}
if (arg === 'status') {
  if (!existsSync(FILE)) { console.log('🔔 not muted'); process.exit(0); }
  const raw = readFileSync(FILE, 'utf8').trim();
  if (raw === '') console.log('🔕 muted indefinitely — run: npm run unmute');
  else { const u = Number(raw); console.log(Date.now() < u ? `🔕 muted until ${fmt(u)} — run: npm run unmute` : '🔔 mute expired (clears on next alert)'); }
  process.exit(0);
}

let until;
if (arg === 'on') until = '';                       // indefinite
else if (arg === 'morning') until = nextMorning();
else {
  const m = arg.match(/^(\d+(?:\.\d+)?)(h|m)?$/);
  if (!m) { console.error(`unrecognized: "${arg}" — use: morning | <N>h | <N>m | on | off | status`); process.exit(1); }
  const n = parseFloat(m[1]);
  until = Date.now() + (m[2] === 'm' ? n * 60e3 : n * 3600e3); // bare number = hours
}
writeFileSync(FILE, until === '' ? '' : String(until));
console.log(until === ''
  ? '🔕 popups muted indefinitely — run: npm run unmute to restore'
  : `🔕 popups muted until ${fmt(until)} — run: npm run unmute to restore early`);
