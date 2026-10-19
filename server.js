#!/usr/bin/env node
// o3XR IPTV dev server: serves the app and relays IPTV playlists/streams with CORS
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
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { xtreamDemo } from './proxy/xtream-demo.js';

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
const REFUSED = new Set([401, 403, 406, 451]);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8', '.m3u': 'audio/x-mpegurl', '.webm': 'video/webm', '.mp4': 'video/mp4',
};

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'range, content-type',
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

function handler(req, res) {
  const { pathname, searchParams } = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (pathname === '/proxy/health') return send(res, 200, 'ok');
  if (pathname === '/proxy') return proxy(req, res, searchParams.get('url'));
  const demo = xtreamDemo(new URL(req.url, `${tls ? 'https' : 'http'}://${req.headers.host}`));
  if (demo) { res.writeHead(demo.status, demo.headers); return res.end(demo.body); }
  serveStatic(req, res, pathname);
}

const tls = process.env.CERT && process.env.KEY
  ? { cert: fs.readFileSync(process.env.CERT), key: fs.readFileSync(process.env.KEY) }
  : null;
const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
server.listen(PORT, HOST, () => {
  console.log(`o3XR IPTV on ${tls ? 'https' : 'http'}://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT} (proxy at /proxy)`);
});
