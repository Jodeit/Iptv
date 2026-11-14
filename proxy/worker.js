// Tuner proxy for Cloudflare Workers: the same /proxy endpoint as server.js, on free HTTPS.
// Lets the GitHub Pages build play IPTV servers that send no CORS headers or only speak http://.
//
// Deploy: dash.cloudflare.com → Workers & Pages → Create → Worker → paste this file → Deploy.
// Then in the app: Sources → Proxy URL → https://<name>.<you>.workers.dev
//
// Optional variable ALLOWED_ORIGINS (Settings → Variables), e.g. "https://jodeit.github.io",
// limits who can use the proxy. Leave unset to allow any site, which is not recommended.

// IPTV panels often allow only known players. Try these in order when one is refused,
// and remember what worked per host (for the life of this isolate).
import { xtreamDemo } from './xtream-demo.js';
import { socketFetch } from './http-socket.js';
import { handleProfileApi, kvStore, profileOp } from './profiles-api.js';

const UAS = [
  'VLC/3.0.20 LibVLC/3.0.20',
  'okhttp/4.12.0',
  'IPTVSmartersPro',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36',
];
const uaByHost = new Map();
// 401 is left out: for Xtream it means login or connection limit, and retrying only uses up connections.
const REFUSED = new Set([403, 406, 451]);

// Ports Cloudflare Workers' fetch() can reach. Xtream stream servers often redirect to
// others (e.g. :25461); those hops go over a raw TCP socket instead.
const HTTP_PORTS = new Set(['', '80', '8080', '8880', '2052', '2082', '2086', '2095']);
const HTTPS_PORTS = new Set(['', '443', '8443', '2053', '2083', '2087', '2096']);
const portOk = (u) => (u.protocol === 'https:' ? HTTPS_PORTS : HTTP_PORTS).has(u.port);

// fetch() also refuses bare IP addresses (Cloudflare error 1003), and many Xtream panels
// redirect streams to one, e.g. http://46.249.110.235/live/…?token=…
const isIp = (u) => /^\d{1,3}(\.\d{1,3}){3}$/.test(u.hostname) || u.hostname.startsWith('[');
const needsSocket = (u) => isIp(u) || !portOk(u);

// Follows redirects by hand, choosing fetch() or a TCP socket for each hop.
async function fetchFollow(url, headers) {
  let current = url;
  for (let hop = 0; hop < 6; hop++) {
    let res;
    if (needsSocket(current)) {
      try { res = await socketFetch(current, headers); }
      catch (err) { throw Object.assign(new Error(`direct connection to ${current.host} failed: ${err.message}`), { socket: true }); }
    } else {
      res = await fetch(current, { headers, redirect: 'manual' });
    }
    const location = res.headers.get('location');
    if (res.status < 300 || res.status >= 400 || !location) return { res, finalUrl: current.href };
    await res.body?.cancel().catch(() => {});
    current = new URL(location, current);
  }
  throw new Error('too many redirects');
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'range, content-type',
  'access-control-allow-methods': 'GET, PUT, POST, DELETE, OPTIONS',
  'access-control-expose-headers': 'content-length, content-range, content-type, x-final-url, x-proxy-kind, x-proxy-upstream, x-proxy-error',
  'x-proxy-kind': 'cloudflare',
};

// Profiles live in a Durable Object (one per profile), because KV is only eventually consistent: two devices
// could both be told "you're up to date" and one upload would silently replace the other. Without the binding
// (a preview, or a deployment that hasn't added it) profiles fall back to plain KV.
const profileHandler = (env) => (env.PROFILE_DO ? async (id, method, body) => {
  const stub = env.PROFILE_DO.get(env.PROFILE_DO.idFromName(id));
  const r = await stub.fetch('https://profile/op', { method: 'POST', body: JSON.stringify({ id, method, body }) });
  return r.json();
} : null);

export class ProfileDO {
  constructor(state, env) { this.state = state; this.env = env; }

  async fetch(request) {
    const { id, method, body } = await request.json();
    const { storage } = this.state;
    const cell = {
      get: async () => {
        const mine = await storage.get('v');
        if (mine !== undefined) return mine;
        if (await storage.get('gone')) return null;
        // First time this profile is opened here: pick up what plain KV held, so nobody has to re-link.
        const old = await this.env.PROFILES.get(`profile:${id}`);
        if (old) await storage.put('v', old);
        return old;
      },
      put: async (value) => { await storage.put('v', value); await storage.delete('gone'); },
      delete: async () => {
        await storage.delete('v');
        await storage.put('gone', true); // KV may still serve its copy for a while
        await this.env.PROFILES.delete(`profile:${id}`);
      },
    };
    // blockConcurrencyWhile keeps another request from slipping in between the read and the write.
    return Response.json(await this.state.blockConcurrencyWhile(() => profileOp(method, body, cell)));
  }
}

export default {
  async fetch(request, env) {
    const { pathname, searchParams, origin } = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const caller = request.headers.get('origin');
    if (allowed.length && caller && !allowed.includes(caller)) return text('Origin not allowed', 403, { 'x-proxy-error': 'origin-not-allowed' });

    if (pathname === '/proxy/health') return text('ok');
    // A plain-text view of the problems the apps reported (newest first). Set LOG_READ_KEY to require ?key=...
    if (pathname === '/logs') {
      if (env.LOG_READ_KEY && searchParams.get('key') !== env.LOG_READ_KEY) return text('Not found', 404);
      if (!env.PROFILES) return text('No log storage (KV binding PROFILES) is set up', 503);
      let all = [];
      try { all = JSON.parse((await env.PROFILES.get('log:recent')) || '[]'); } catch { all = []; }
      const lines = all.map((e) => `${new Date(e.t).toISOString().replace('T', ' ').slice(0, 19)}Z  v${e.v}  ${e.d}  ${e.k}  ${e.m}${e.x ? `  ${e.x}` : ''}${/^(player|audio|silent)$/.test(e.k) ? '' : `  [${e.ua}]`}`);
      return text(lines.length ? lines.join('\n') : 'No problems reported yet.', 200, { 'cache-control': 'no-store' });
    }
    if (pathname.startsWith('/api/')) {
      if (!env.PROFILES) return Response.json({ error: 'Profile storage (KV binding PROFILES) is not set up' }, { status: 503, headers: CORS });
      let body = null;
      if (request.method === 'POST' || request.method === 'PUT') { try { body = await request.json(); } catch { body = null; } }
      const res = await handleProfileApi(
        { method: request.method, path: pathname, body, ip: request.headers.get('cf-connecting-ip') },
        kvStore(env.PROFILES),
        { profileHandler: profileHandler(env) },
      );
      return res.status === 204
        ? new Response(null, { status: 204, headers: CORS })
        : Response.json(res.body, { status: res.status, headers: { ...CORS, 'cache-control': 'no-store' } });
    }
    const demo = await xtreamDemo(new URL(request.url));
    if (demo) return new Response(demo.body || null, { status: demo.status, headers: demo.headers });
    if (pathname !== '/proxy') return text('Not found', 404);

    let target;
    try { target = new URL(searchParams.get('url')); } catch { return text('Bad url', 400); }
    if (!/^https?:$/.test(target.protocol)) return text('Only http(s) URLs', 400);

    const base = { accept: '*/*' };
    const range = request.headers.get('range');
    if (range) base.range = range;
    const known = uaByHost.get(target.host);
    const order = known ? [known, ...UAS.filter((u) => u !== known)] : UAS;

    let up;
    let finalUrl;
    for (const ua of order) {
      try {
        ({ res: up, finalUrl } = await fetchFollow(target, { ...base, 'user-agent': ua }));
      } catch (err) {
        return text(`Upstream error: ${err.message}`, 502, { 'x-proxy-error': err.socket ? 'socket-failed' : 'upstream-unreachable' });
      }
      if (!REFUSED.has(up.status)) { uaByHost.set(target.host, ua); break; }
      if (ua !== order.at(-1)) await up.body?.cancel().catch(() => {}); // keep the last refusal to pass on
    }

    const out = new Headers({ ...CORS, 'cache-control': 'no-store', 'x-final-url': finalUrl, 'x-proxy-upstream': String(up.status) });
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const v = up.headers.get(h);
      if (v) out.set(h, v);
    }

    // Rewrite HLS manifests so segment, variant and key requests come back through the proxy.
    const type = up.headers.get('content-type') || '';
    if (up.ok && (/mpegurl/i.test(type) || /\.m3u8(\?|$)/i.test(finalUrl))) {
      const body = await up.text();
      out.delete('content-length');
      if (body.includes('#EXT-X-')) {
        out.set('content-type', 'application/vnd.apple.mpegurl');
        return new Response(rewriteHls(body, finalUrl, `${origin}/proxy`), { status: up.status, headers: out });
      }
      return new Response(body, { status: up.status, headers: out });
    }

    return new Response(up.body, { status: up.status, headers: out });
  },
};

function rewriteHls(text, base, proxyBase) {
  const wrap = (u) => `${proxyBase}?url=${encodeURIComponent(new URL(u, base).href)}`;
  return text.split(/\r?\n/).map((line) => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${wrap(u)}"`);
    return wrap(t);
  }).join('\n');
}

function text(body, status = 200, extra = {}) {
  return new Response(body, { status, headers: { ...CORS, ...extra, 'content-type': 'text/plain; charset=utf-8' } });
}
