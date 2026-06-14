import { execFile } from 'child_process';

// macOS signal popup, shared by collector.mjs (burst/sweep) and snapshot.mjs (squeeze flip).
// `display notification` gives the sound + a Notification Center history entry, but its
// banner can't be told to linger (macOS auto-hides it ~5s — no duration param exists).
// `display alert ... giving up after N` is the lever: a dialog that STAYS N seconds (or
// until clicked). We fire both — ping+history from the notification, persistence from the
// alert. Non-blocking (execFile, not awaited); strings escaped via JSON (valid AS literals).
//   lingerSecs > 0 → alert auto-dismisses after N · 0 → notification only (legacy) ·
//   <0 → alert stays until clicked (no "giving up after")
export function macNotify(title, body, lingerSecs = 30) {
  const t = JSON.stringify(String(title)), b = JSON.stringify(String(body));
  const args = ['-e', `display notification ${b} with title ${t} sound name "Submarine"`];
  if (lingerSecs !== 0) {
    args.push('-e', `display alert ${t} message ${b}${lingerSecs > 0 ? ` giving up after ${Math.round(lingerSecs)}` : ''}`);
  }
  try { execFile('osascript', args); } catch { /* headless / no GUI session — file log still records it */ }
}
