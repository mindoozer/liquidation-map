import { execFile } from 'child_process';
import { readFileSync, unlinkSync } from 'fs';

const MUTE_FILE = new URL('../.notify-mute', import.meta.url);

// Popups can be silenced temporarily via the .notify-mute file (see mute.mjs / `npm run mute`).
// Checked PER CALL so writing/removing the file takes effect instantly for the always-on
// collector daemon — no restart. Contents: empty = muted until cleared; an epoch-ms number =
// muted until that instant (auto-cleaned on the first call after it lapses). Alerts are still
// recorded (alerts.jsonl / console) — only the popup is suppressed.
function isMuted() {
  let raw;
  try { raw = readFileSync(MUTE_FILE, 'utf8').trim(); } catch { return false; } // no file → not muted
  if (raw === '') return true;                          // indefinite
  const until = Number(raw);
  if (!Number.isFinite(until)) return true;             // unparseable → fail safe to muted
  if (Date.now() < until) return true;                  // still inside the window
  try { unlinkSync(MUTE_FILE); } catch { /* ignore */ } // expired → clean up + unmute
  return false;
}

// macOS signal popup, shared by collector.mjs (burst/sweep) and snapshot.mjs (squeeze flip).
// `display notification` gives the sound + a Notification Center history entry, but its
// banner can't be told to linger (macOS auto-hides it ~5s — no duration param exists).
// `display alert ... giving up after N` is the lever: a dialog that STAYS N seconds (or
// until clicked). We fire both — ping+history from the notification, persistence from the
// alert. Non-blocking (execFile, not awaited); strings escaped via JSON (valid AS literals).
//   lingerSecs > 0 → alert auto-dismisses after N · 0 → notification only (legacy) ·
//   <0 → alert stays until clicked (no "giving up after")
export function macNotify(title, body, lingerSecs = 30) {
  if (isMuted()) { console.error(`[notify muted] ${title} — ${body}`); return; }
  const t = JSON.stringify(String(title)), b = JSON.stringify(String(body));
  const args = ['-e', `display notification ${b} with title ${t} sound name "Submarine"`];
  if (lingerSecs !== 0) {
    args.push('-e', `display alert ${t} message ${b}${lingerSecs > 0 ? ` giving up after ${Math.round(lingerSecs)}` : ''}`);
  }
  try { execFile('osascript', args); } catch { /* headless / no GUI session — file log still records it */ }
}
