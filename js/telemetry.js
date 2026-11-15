// Sends playback problems to the server's log (POST /api/log, read back at /logs), so a failure on the TV can be read
// without a photo of the screen. Stream addresses are reduced to "<url .mkv>" (they carry logins), and at most a few
// dozen distinct events are sent per session.
import { VERSION } from './version.js';

const SEEN = new Set();
let queue = [], timer = 0, sent = 0;
const device = (() => {
  try { let d = localStorage.getItem('tuner.device'); if (!d) { d = Math.random().toString(36).slice(2, 8); localStorage.setItem('tuner.device', d); } return d; } catch { return 'nostore'; }
})();

export const redact = (s) => String(s ?? '')
  .replace(/https?:\/\/[^\s)'"”]+/g, (u) => { try { const ext = new URL(u).pathname.match(/\.(\w{2,5})$/)?.[1]; return `<url${ext ? ` .${ext}` : ''}>`; } catch { return '<url>'; } })
  .replace(/\b(token|password|pass|key|apikey|api_key)=[^&\s]+/gi, '$1=…')
  .slice(0, 700);

function flush() {
  timer = 0;
  const entries = queue.splice(0);
  if (!entries.length) return;
  try {
    fetch('/api/log', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entries }), keepalive: true }).catch(() => {});
  } catch { /* logging must never get in the way */ }
}

// kind: 'player' | 'audio' | 'silent' | 'error' | …; extra: a small object of facts (codecs, engine…)
export function logEvent(kind, message, extra, { dedupe = true } = {}) {
  try {
    const m = redact(message);
    const key = `${kind}|${m}`;
    if ((dedupe && SEEN.has(key)) || sent >= 40) return;
    if (dedupe) SEEN.add(key);
    sent++;
    queue.push({ t: Date.now(), v: VERSION, d: device, k: String(kind).slice(0, 20), m, x: extra ? redact(JSON.stringify(extra)).slice(0, 500) : '', ua: navigator.userAgent.replace(/\s+/g, ' ').slice(0, 160) });
    if (!timer) timer = setTimeout(flush, 2500);
  } catch { /* ignore */ }
}

addEventListener('error', (e) => logEvent('error', `${e.message} @ ${String(e.filename || '').split('/').pop()}:${e.lineno}`));
addEventListener('unhandledrejection', (e) => logEvent('error', `unhandled: ${(e.reason && e.reason.message) || e.reason}`));
addEventListener('pagehide', flush);
