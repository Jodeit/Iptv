// M3U / M3U_PLUS playlist parser.

const ATTR_RE = /([\w-]+)="([^"]*)"/g;

// Incremental parser: feed text as it downloads, so a large playlist never has to sit in
// memory whole (and then again as an array of lines). Repeated group names share one string.
export function createM3UParser(baseUrl = location.href) {
  const channels = [];
  const groups = new Map();
  const intern = (g) => { let v = groups.get(g); if (v === undefined) { v = g; groups.set(g, g); } return v; };
  let pending = null;
  let tvgUrl = '';
  let carry = '';

  const line = (raw) => {
    const l = raw.trim();
    if (!l) return;
    if (l.startsWith('#EXTM3U')) {
      // The header may name an XMLTV guide: url-tvg="…" or x-tvg-url="…" (comma-separated list).
      const m = l.match(/(?:url-tvg|x-tvg-url)="([^"]+)"/i);
      if (m) tvgUrl = m[1].split(',')[0].trim();
    } else if (l.startsWith('#EXTINF')) {
      const attrs = {};
      for (const m of l.matchAll(ATTR_RE)) attrs[m[1].toLowerCase()] = m[2];
      // The display name follows the first comma once the quoted attributes are removed,
      // because attribute values may contain commas themselves.
      const stripped = l.replace(ATTR_RE, '');
      const comma = stripped.indexOf(',');
      const name = comma >= 0 ? stripped.slice(comma + 1).trim() : '';
      pending = {
        name: name || attrs['tvg-name'] || '',
        logo: attrs['tvg-logo'] || '',
        group: attrs['group-title'] || '',
        tvgId: attrs['tvg-id'] || '',
        layout: guessLayout(name, attrs),
      };
    } else if (l.startsWith('#EXTGRP:')) {
      if (pending) pending.group = l.slice(8).trim();
    } else if (!l.startsWith('#')) {
      let url = l;
      if (!/^[a-z][a-z0-9+.-]*:/i.test(l)) { try { url = new URL(l, baseUrl).href; } catch { /* keep as-is */ } }
      const ch = pending || { name: '', logo: '', group: '', tvgId: '', layout: null };
      ch.url = url;
      ch.id = url;
      ch.num = channels.length + 1;
      ch.name = ch.name || url.split('/').pop() || url;
      ch.group = intern(ch.group || 'Uncategorized');
      channels.push(ch);
      pending = null;
    }
  };

  return {
    push(text) {
      const parts = (carry + text).split(/\r?\n/);
      carry = parts.pop();
      for (const p of parts) line(p);
    },
    end() {
      if (carry) line(carry);
      carry = '';
      channels.tvgUrl = tvgUrl; // read by the guide; not part of each channel
      return channels;
    },
    get count() { return channels.length; },
  };
}

export function parseM3U(text, baseUrl = location.href) {
  const parser = createM3UParser(baseUrl);
  parser.push(text);
  return parser.end();
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
    if (err?.name === 'AbortError') throw err;
    // Browsers hide the exact network failure, but offline state and mixed content are identifiable.
    const offline = typeof navigator !== 'undefined' && !navigator.onLine;
    const e = new Error(offline
      ? 'This device appears to be offline. Check its internet connection and try again.'
      : blockedReason(url));
    e.blocked = !offline;
    throw e;
  }
  if (!res.ok) throw new Error(httpReason(res, url));
  const parser = createM3UParser(res.headers.get('x-final-url') || url);
  let head = '';
  let received = 0;
  try {
    received = await readBody(res, (text) => {
      if (head.length < 4096) head += text.slice(0, 4096);
      parser.push(text);
    }, (p) => {
      received = p.received;
      onProgress({ ...p, channels: parser.count });
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    const size = received ? ` after ${(received / 1048576).toFixed(1)} MB` : '';
    throw new Error(`The playlist download was interrupted${size}. Check the connection and try again.`);
  }
  const body = head.replace(/^\uFEFF/, '').trimStart();
  if (!head.includes('#EXT-X-') && body && /^[{[]/.test(body)) {
    if (/"(?:auth|authenticated)"\s*:\s*0/i.test(body) || /"error"\s*:\s*"[^"]*(?:auth|login|password|credential)/i.test(body)) {
      throw new Error('The server returned an authentication error. Check the username, password, and account status.');
    }
    throw new Error('The server sent JSON, not an M3U playlist. Check that you copied the playlist link, not an API URL.');
  }
  if (!head.includes('#EXT-X-') && body
      && (/^<(?:!doctype\s+html|html\b)/i.test(body)
        || (/text\/html/i.test(res.headers.get('content-type') || '') && !/^#EXTM3U\b/i.test(body)))) {
    throw new Error('The server returned a web page instead of an M3U playlist. The link may open a login page or an access-denied page.');
  }
  if (!head.includes('#EXT-X-') && body && !/#EXT(?:M3U|INF)\b/i.test(body)) {
    const entries = body.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
    if (entries.some((line) => !/^(?:[a-z][a-z\d+.-]*:|\/|\.\/|\.\.\/)/i.test(line))) {
      if (/^\s*(?:error\b|invalid\b|unauthori[sz]ed\b|forbidden\b|access denied\b)/i.test(body)
          && /(?:auth|login|user(?:name)?|password|credential)/i.test(body)) {
        throw new Error('The server returned an authentication error. Check the username, password, and account status.');
      }
      throw new Error('The server returned plain text instead of an M3U playlist. Check the URL and the provider’s playlist settings.');
    }
  }
  const channels = parser.end();
  if (!channels.length) {
    // A bare stream manifest rather than a channel list: treat it as one channel.
    if (head.includes('#EXT-X-')) return [{ num: 1, id: url, url, name: url.split('/').pop(), logo: '', group: 'Direct', layout: null }];
    if (!body) throw new Error('The server returned an empty response. Check the playlist link and account status.');
    if (/^#EXTM3U(?:\s|$)/m.test(body)) {
      throw new Error('The playlist has an M3U header but no channel entries. Check whether the account has content or has expired.');
    }
    throw new Error('The server response is not a recognizable M3U playlist. Check the link and the provider’s playlist format.');
  }
  return channels;
}

// Streams a response body as text chunks, reporting size and speed.
export async function readBody(res, onText, onProgress = () => {}) {
  const total = +res.headers.get('content-length') || 0;
  if (!res.body) { const t = await res.text(); onText(t); return t.length; }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const start = performance.now();
  let received = 0;
  let last = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    received += value.length;
    onText(decoder.decode(value, { stream: true }));
    const now = performance.now();
    if (now - last > 200) {
      last = now;
      onProgress({ phase: 'download', received, total, rate: received / Math.max(0.001, (now - start) / 1000) });
    }
  }
  onText(decoder.decode());
  return received;
}

function blockedReason(url) {
  if (location.protocol === 'https:' && url.startsWith('http:')) {
    return 'The browser blocked an http:// playlist on this https:// page. Run server.js to route it through the proxy.';
  }
  return 'The browser couldn’t fetch the playlist. The provider may be offline, the link may be wrong, or browser security (CORS) may be blocking access. Try routing it through the proxy.';
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
  if (status === 404) return 'The playlist URL was not found (HTTP 404). Check the server address and playlist path.';
  if (status === 429) return 'The provider is rate-limiting playlist requests (HTTP 429). Wait a little and try again.';
  if (status === 401 || status === 403) return `The provider refused the playlist request (HTTP ${status}). Check the link, account status, and provider access restrictions.`;
  if (status >= 500) return `The provider returned a server error (HTTP ${status}). Try again later or check with the provider.`;
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
