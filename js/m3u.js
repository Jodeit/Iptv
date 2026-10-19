// M3U / M3U_PLUS playlist parser.

const ATTR_RE = /([\w-]+)="([^"]*)"/g;

export function parseM3U(text, baseUrl = location.href) {
  const lines = text.split(/\r?\n/);
  const channels = [];
  let pending = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF')) {
      const attrs = {};
      for (const m of line.matchAll(ATTR_RE)) attrs[m[1].toLowerCase()] = m[2];
      // The display name follows the first comma once the quoted attributes are removed,
      // because attribute values may contain commas themselves.
      const stripped = line.replace(ATTR_RE, '');
      const comma = stripped.indexOf(',');
      const name = comma >= 0 ? stripped.slice(comma + 1).trim() : '';
      pending = {
        name: name || attrs['tvg-name'] || '',
        logo: attrs['tvg-logo'] || '',
        group: attrs['group-title'] || '',
        tvgId: attrs['tvg-id'] || '',
        layout: guessLayout(name, attrs),
      };
    } else if (line.startsWith('#EXTGRP:')) {
      if (pending) pending.group = line.slice(8).trim();
    } else if (line.startsWith('#')) {
      continue;
    } else {
      let url = line;
      try { url = new URL(line, baseUrl).href; } catch { /* keep as-is */ }
      const ch = pending || { name: '', logo: '', group: '', tvgId: '', layout: null };
      ch.url = url;
      ch.name = ch.name || url.split('/').pop() || url;
      ch.group = ch.group || 'Uncategorized';
      channels.push(ch);
      pending = null;
    }
  }

  channels.forEach((c, i) => { c.num = i + 1; c.id = c.url; });
  return channels;
}

// Native 3D content is often tagged in the channel name, e.g. "Movie 3D SBS".
function guessLayout(name, attrs) {
  const s = `${name} ${attrs['group-title'] || ''}`.toUpperCase();
  if (/\b(H?SBS|SIDE[- ]BY[- ]SIDE)\b/.test(s)) return 'sbs';
  if (/\b(H?TAB|H?OU|TOP[- ]AND[- ]BOTTOM|OVER[- ]UNDER)\b/.test(s)) return 'tab';
  return null;
}

export async function fetchPlaylist(url, { proxify = (u) => u, onProgress = () => {} } = {}) {
  let res;
  try {
    res = await fetch(proxify(url));
  } catch (err) {
    // fetch() rejects with a bare TypeError for CORS and mixed-content blocks.
    const e = new Error(blockedReason(url));
    e.blocked = true;
    throw e;
  }
  if (!res.ok) throw new Error(httpReason(res, url));
  const text = await readText(res, onProgress);
  onProgress({ phase: 'parse', received: text.length });
  await new Promise((r) => setTimeout(r, 30)); // let the status paint before parsing blocks
  if (!text.includes('#EXTINF') && !text.trim().startsWith('#EXTM3U')) {
    // A bare stream manifest rather than a channel list: treat it as one channel.
    if (text.includes('#EXT-X-')) return [{ num: 1, id: url, url, name: url.split('/').pop(), logo: '', group: 'Direct', layout: null }];
    if (/^\s*[{[]/.test(text)) throw new Error('The server sent JSON, not an M3U playlist. Check the link and credentials.');
    throw new Error('The server didn’t send an M3U playlist. The account may be expired or the link wrong.');
  }
  const channels = parseM3U(text, res.headers.get('x-final-url') || url);
  const xt = parseXtream(url);
  if (xt) for (const ch of channels) ch.alts = xtreamAlternates(ch.url, xt);
  return channels;
}

// Streams the body so big playlists can report progress (size, speed).
async function readText(res, onProgress) {
  const total = +res.headers.get('content-length') || 0;
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parts = [];
  const start = performance.now();
  let received = 0;
  let last = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    received += value.length;
    parts.push(decoder.decode(value, { stream: true }));
    const now = performance.now();
    if (now - last > 200) {
      last = now;
      onProgress({ phase: 'download', received, total, rate: received / Math.max(0.001, (now - start) / 1000) });
    }
  }
  parts.push(decoder.decode());
  return parts.join('');
}

function blockedReason(url) {
  if (location.protocol === 'https:' && url.startsWith('http:')) {
    return 'The browser blocked an http:// playlist on this https:// page. Run server.js to route it through the proxy.';
  }
  return 'The browser blocked the request, most likely because the server doesn’t allow cross-origin (CORS) access. Run server.js to route it through the proxy.';
}

// Proxies tag their responses, so we can tell who refused: the proxy itself, or the
// provider answering the proxy (and from which kind of network).
function httpReason(res, url) {
  const status = res.status;
  const proxyError = res.headers.get('x-proxy-error');
  const kind = res.headers.get('x-proxy-kind');
  const upstream = res.headers.get('x-proxy-upstream');
  if (proxyError === 'origin-not-allowed') {
    return 'The proxy refused this page. Add this site’s address to the Worker’s ALLOWED_ORIGINS variable.';
  }
  if (proxyError === 'socket-failed') {
    return 'Cloudflare couldn’t open a direct connection to the provider. Use server.js at home as the proxy.';
  }
  if (proxyError === 'ip-unsupported') {
    return 'The provider redirects to a bare IP address, which Cloudflare can’t connect to. Use server.js at home as the proxy.';
  }
  if (proxyError === 'port-unsupported') {
    return 'The provider redirects to a port Cloudflare can’t connect to. Use server.js at home as the proxy (Sources → Proxy URL).';
  }
  if (proxyError === 'upstream-unreachable') {
    return 'The proxy couldn’t connect to the provider. The server may be down, or the address or port wrong.';
  }
  const refused = [401, 403, 406, 451, 512, 884].includes(status);
  if (refused && upstream && kind === 'cloudflare') {
    return `The provider refused the Cloudflare proxy (HTTP ${status}), even when it identified as VLC and other IPTV players. `
      + 'Most IPTV providers block cloud servers. Run “node server.js” on your home network and point Sources → Proxy URL at it. '
      + 'If it still fails from home, the login or account is the problem.';
  }
  if (refused && parseXtream(url)) {
    return `The Xtream server refused the request (HTTP ${status}). Check the username and password, whether the account is active, `
      + 'and whether it’s locked to another IP address or device.';
  }
  return `HTTP ${status} loading playlist`;
}

// ---------- Xtream Codes ----------

// Recognises Xtream panel links such as http://host:port/get.php?username=…&password=…&type=m3u_plus
export function parseXtream(link) {
  let u;
  try { u = new URL(link); } catch { return null; }
  const username = u.searchParams.get('username');
  const password = u.searchParams.get('password');
  if (!/\/(get|player_api)\.php$/i.test(u.pathname) || !username || password == null) return null;
  const server = `${u.origin}${u.pathname.replace(/\/(get|player_api)\.php$/i, '')}`;
  return { server, username, password, type: u.searchParams.get('type') || 'm3u_plus', output: u.searchParams.get('output') || '' };
}

export function xtreamUrl(server, user, pass, output = '') {
  const base = server.replace(/\/+$/, '');
  const q = new URLSearchParams({ username: user, password: pass, type: 'm3u_plus' });
  if (output) q.set('output', output);
  return `${base}/get.php?${q}`;
}

// Live channels on Xtream panels are served as raw MPEG-TS and as HLS at predictable
// paths. Trying both makes playback work across more browsers and headsets.
export function xtreamAlternates(streamUrl, { username, password }) {
  let u;
  try { u = new URL(streamUrl); } catch { return []; }
  const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const i = parts.indexOf(username);
  if (i < 0 || parts[i + 1] !== password || !parts[i + 2]) return [];
  const kind = i > 0 ? parts[i - 1] : 'live';
  if (kind !== 'live') return []; // movie/series files have one fixed URL
  const id = parts[i + 2].replace(/\.(ts|m3u8)$/i, '');
  const base = `${u.origin}/live/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${id}`;
  return [`${base}.m3u8`, `${base}.ts`].filter((x) => x !== streamUrl);
}

// Account status from the panel's API: { status, expires, active, max }. Not a stream, so it
// doesn't count against the connection limit.
export async function xtreamAccount(xt, proxify = (u) => u) {
  const q = new URLSearchParams({ username: xt.username, password: xt.password });
  const res = await fetch(proxify(`${xt.server}/player_api.php?${q}`));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const info = (await res.json())?.user_info;
  if (!info) throw new Error('no account info');
  return {
    status: info.status || '?',
    expires: info.exp_date ? new Date(info.exp_date * 1000) : null,
    active: info.active_cons != null ? +info.active_cons : null,
    max: info.max_connections != null ? +info.max_connections : null,
  };
}

// Identity of a playlist source: one entry per Xtream account however its link is written
// (output=, parameter order, http:// or not); otherwise the normalised URL.
export function playlistKey(link) {
  const xt = parseXtream(link);
  if (xt) return `xtream:${xt.server.toLowerCase()}|${xt.username}`;
  try { return new URL(link).href; } catch { return link; }
}

// Display-safe version of a link: hides Xtream credentials.
export function maskUrl(link) {
  const xt = parseXtream(link);
  if (!xt) return link;
  return `${xt.server}/get.php?username=${xt.username}&password=••••`;
}
