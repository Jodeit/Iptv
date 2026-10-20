#!/usr/bin/env node
// Tuner dev server: serves the app and relays IPTV playlists/streams with CORS
// headers, so providers that don't allow browser playback (e.g. Xtream panels) still work.
//
//   node server.js                      http://0.0.0.0:8080
//   PORT=9000 node server.js
//   CERT=cert.pem KEY=key.pem node server.js   HTTPS (needed for WebXR off localhost)
//
// The proxy is open to anyone who can reach this port. Keep it on your LAN.

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { xtreamDemo } from './proxy/xtream-demo.js';
import { handleProfileApi } from './proxy/profiles-api.js';

if (!globalThis.crypto) globalThis.crypto = (await import('node:crypto')).webcrypto; // Node 18

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = +process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';
// IPTV panels often allow only known players. Try these in order when one is refused,
// and remember what worked per host.
const UAS = [
  process.env.UPSTREAM_UA || 'VLC/3.0.20 LibVLC/3.0.20',
  'okhttp/4.12.0',
  'IPTVSmartersPro',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36',
];
const uaByHost = new Map();
// 401 is left out: for Xtream it means login or connection limit, and retrying only uses up connections.
const REFUSED = new Set([403, 406, 451]);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8', '.m3u': 'audio/x-mpegurl', '.webm': 'video/webm', '.mp4': 'video/mp4',
};

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'range, content-type',
  'access-control-allow-methods': 'GET, PUT, POST, DELETE, OPTIONS',
  'access-control-expose-headers': 'content-length, content-range, content-type, x-final-url, x-proxy-kind, x-proxy-upstream, x-proxy-error',
  'x-proxy-kind': 'server',
};

async function proxy(req, res, target) {
  let url;
  try { url = new URL(target); } catch { return send(res, 400, 'Bad url'); }
  if (!/^https?:$/.test(url.protocol)) return send(res, 400, 'Only http(s) URLs');

  const ac = new AbortController();
  res.on('close', () => ac.abort());
  const base = { accept: '*/*' };
  if (req.headers.range) base.range = req.headers.range;
  const known = uaByHost.get(url.host);
  const order = known ? [known, ...UAS.filter((u) => u !== known)] : UAS;

  let up;
  for (const ua of order) {
    try {
      up = await fetch(url, { headers: { ...base, 'user-agent': ua }, redirect: 'follow', signal: ac.signal });
    } catch (err) {
      if (!ac.signal.aborted) send(res, 502, `Upstream error: ${err.cause?.code || err.message}`, { 'x-proxy-error': 'upstream-unreachable' });
      return;
    }
    if (!REFUSED.has(up.status)) { uaByHost.set(url.host, ua); break; }
    if (ua !== order.at(-1)) await up.body?.cancel().catch(() => {}); // keep the last refusal to pass on
  }

  const type = up.headers.get('content-type') || '';
  const finalUrl = up.url || url.href;
  const out = { ...CORS, 'cache-control': 'no-store', 'x-final-url': finalUrl, 'x-proxy-upstream': String(up.status) };
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
    const v = up.headers.get(h);
    if (v) out[h] = v;
  }

  // HLS media playlists reference segments/keys by (often relative) URL: rewrite them
  // to absolute proxied URLs so every request keeps flowing through here.
  const looksHls = /mpegurl/i.test(type) || /\.m3u8(\?|$)/i.test(finalUrl);
  if (looksHls && up.ok) {
    const text = await up.text();
    if (text.includes('#EXT-X-')) {
      const body = rewriteHls(text, finalUrl);
      delete out['content-length'];
      res.writeHead(up.status, { ...out, 'content-type': 'application/vnd.apple.mpegurl' });
      return res.end(body);
    }
    delete out['content-length'];
    res.writeHead(up.status, out);
    return res.end(text);
  }

  res.writeHead(up.status, out);
  if (!up.body) return res.end();
  Readable.fromWeb(up.body).on('error', () => res.destroy()).pipe(res);
}

function rewriteHls(text, base) {
  const wrap = (u) => `/proxy?url=${encodeURIComponent(new URL(u, base).href)}`;
  return text.split(/\r?\n/).map((line) => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${wrap(u)}"`);
    return wrap(t);
  }).join('\n');
}

function serveStatic(req, res, pathname) {
  const file = path.normalize(path.join(ROOT, decodeURIComponent(pathname === '/' ? '/index.html' : pathname)));
  if (!file.startsWith(ROOT + path.sep) || path.basename(file).startsWith('.')) return send(res, 403, 'Forbidden');
  // Never serve profile storage, keys or certificates.
  if (file.startsWith(path.dirname(DATA_FILE) + path.sep) || /\.(pem|key)$/i.test(file)) return send(res, 403, 'Forbidden');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found');
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'content-length': st.size });
    fs.createReadStream(file).pipe(res);
  });
}

function send(res, status, msg, extra = {}) {
  if (res.headersSent) return res.end();
  res.writeHead(status, { ...CORS, ...extra, 'content-type': 'text/plain; charset=utf-8' });
  res.end(msg);
}

const SYNC_URL = process.env.SYNC_URL || '';

// Profile storage for server.js: a JSON file next to the app (DATA_DIR to move it).
const DATA_FILE = path.join(process.env.DATA_DIR || path.join(ROOT, 'data'), 'profiles.json');
const fileStore = (() => {
  let db = {};
  try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { /* first run */ }
  const save = () => {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(db));
  };
  const live = (key) => {
    const e = db[key];
    if (e && e.exp && e.exp < Date.now()) { delete db[key]; save(); return null; }
    return e || null;
  };
  return {
    get: (key) => live(key)?.value ?? null,
    put: (key, value, ttl) => { db[key] = { value, exp: ttl ? Date.now() + ttl * 1000 : 0 }; save(); },
    delete: (key) => { delete db[key]; save(); },
  };
})();

async function api(req, res, pathname) {
  let body = null;
  if (req.method === 'POST' || req.method === 'PUT') {
    const chunks = [];
    let size = 0;
    for await (const c of req) { size += c.length; if (size > 1024 * 1024) return send(res, 413, 'Too large'); chunks.push(c); }
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
  }
  // SYNC_URL: keep profiles on another deployment (e.g. the Cloudflare Worker) instead of
  // this machine, so a local copy of the app shares the same profiles as the hosted one.
  if (SYNC_URL) {
    const up = await fetch(new URL(pathname, SYNC_URL), {
      method: req.method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    res.writeHead(up.status, { ...CORS, 'content-type': up.headers.get('content-type') || 'application/json', 'cache-control': 'no-store' });
    return res.end(Buffer.from(await up.arrayBuffer()));
  }
  const out = await handleProfileApi({ method: req.method, path: pathname, body, ip: req.socket.remoteAddress }, fileStore);
  if (out.status === 204) { res.writeHead(204, CORS); return res.end(); }
  res.writeHead(out.status, { ...CORS, 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(out.body));
}

function handler(req, res) {
  const { pathname, searchParams } = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (pathname === '/proxy/health') return send(res, 200, 'ok');
  if (pathname === '/proxy') return proxy(req, res, searchParams.get('url'));
  if (pathname.startsWith('/api/')) return api(req, res, pathname).catch(() => send(res, 500, 'API error'));
  xtreamDemo(new URL(req.url, `${tls ? 'https' : 'http'}://${req.headers.host}`)).then((demo) => {
    if (!demo) return serveStatic(req, res, pathname);
    if (res.destroyed) return; // the player gave up on a deliberately slow answer
    res.writeHead(demo.status, demo.headers);
    res.end(demo.body);
  }, () => send(res, 500, 'Demo panel error'));
}

const tls = process.env.CERT && process.env.KEY
  ? { cert: fs.readFileSync(process.env.CERT), key: fs.readFileSync(process.env.KEY) }
  : null;
const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
server.listen(PORT, HOST, () => {
  const scheme = tls ? 'https' : 'http';
  console.log(`Tuner on ${scheme}://localhost:${PORT} (proxy at /proxy)`);
  if (SYNC_URL) console.log(`  profiles sync through ${SYNC_URL}`);
  if (HOST === '0.0.0.0') {
    const lan = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal);
    for (const i of lan) console.log(`  on your network: ${scheme}://${i.address}:${PORT}`);
  }
  if (!tls) console.log('  For VR on a headset, give it HTTPS: npm run tunnel (needs cloudflared) — see README “Home proxy”.');
});
