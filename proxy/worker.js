// o3XR IPTV proxy for Cloudflare Workers: the same /proxy endpoint as server.js, on free HTTPS.
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

const UAS = [
  'VLC/3.0.20 LibVLC/3.0.20',
  'okhttp/4.12.0',
  'IPTVSmartersPro',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36',
];
const uaByHost = new Map();
const REFUSED = new Set([401, 403, 406, 451]);

// Ports Cloudflare Workers can fetch. Xtream stream servers often redirect to others
// (e.g. :25461), which Workers can't reach.
const HTTP_PORTS = new Set(['', '80', '8080', '8880', '2052', '2082', '2086', '2095']);
const HTTPS_PORTS = new Set(['', '443', '8443', '2053', '2083', '2087', '2096']);
const portOk = (u) => (u.protocol === 'https:' ? HTTPS_PORTS : HTTP_PORTS).has(u.port);

class PortError extends Error {}

// Follows redirects by hand so every hop's port can be checked.
async function fetchFollow(url, headers) {
  let current = url;
  for (let hop = 0; hop < 6; hop++) {
    if (!portOk(current)) throw new PortError(current.host);
    const res = await fetch(current, { headers, redirect: 'manual' });
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
  'access-control-expose-headers': 'content-length, content-range, content-type, x-final-url, x-proxy-kind, x-proxy-upstream, x-proxy-error',
  'x-proxy-kind': 'cloudflare',
};

export default {
  async fetch(request, env) {
    const { pathname, searchParams, origin } = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const caller = request.headers.get('origin');
    if (allowed.length && caller && !allowed.includes(caller)) return text('Origin not allowed', 403, { 'x-proxy-error': 'origin-not-allowed' });

    if (pathname === '/proxy/health') return text('ok');
    const demo = xtreamDemo(new URL(request.url));
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
        if (err instanceof PortError) {
          return text(`Cloudflare Workers can't connect to port ${err.message}`, 502, { 'x-proxy-error': 'port-unsupported', 'x-final-url': `http://${err.message}/` });
        }
        return text(`Upstream error: ${err.message}`, 502, { 'x-proxy-error': 'upstream-unreachable' });
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
