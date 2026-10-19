import { Theater } from './theater.js';
import { LAYOUT } from './xr3d.js';
import { StreamPlayer } from './stream.js';
import { parseM3U, fetchPlaylist, xtreamUrl, parseXtream, maskUrl, playlistKey, xtreamAccount } from './m3u.js';
import { cacheGet, cachePut, cacheDelete } from './cache.js';
import { FILTER_DEFAULTS, makeFilter, kindOf } from './filter.js';
import { VRPanel } from './vr-panel.js';

const $ = (id) => document.getElementById(id);

// ---------- Persistence ----------
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(`o3xr.${key}`); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`o3xr.${key}`, JSON.stringify(value)); } catch { /* storage full or blocked */ }
  },
};

const DEFAULTS = {
  mode: 'xr3d', relief: 0.18, parallax: 0.8, convergence: 0.5, contrast: 1.4, smooth: 0.006,
  invert: false, showDepth: false, swap: false, view: 'mono',
  size: 6, distance: 5, height: 1.8, curve: 0.15, bright: 1, env: 'cinema', ambient: true,
  volume: 1, muted: false, proxy: 'auto', proxyUrl: '',
};
const settings = { ...DEFAULTS, ...store.get('settings', {}) };
settings.contentFilter = { ...FILTER_DEFAULTS, ...settings.contentFilter };
const saveSettings = () => store.set('settings', settings);

const DEMO_M3U = `#EXTM3U
#EXTINF:-1 tvg-logo="" group-title="Demo",Big Buck Bunny (HLS)
https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8
#EXTINF:-1 group-title="Demo",Tears of Steel (HLS)
https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.m3u8
#EXTINF:-1 group-title="Demo",Sintel (HLS)
https://bitdash-a.akamaihd.net/content/sintel/hls/playlist.m3u8
#EXTINF:-1 group-title="Demo",Apple fMP4 Bipbop (HLS)
https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8
#EXTINF:-1 group-title="Demo",Elephants Dream (MP4)
https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4
`;

const PRESETS = [
  { name: 'Demo streams', builtin: true },
  { name: 'iptv-org · News', url: 'https://iptv-org.github.io/iptv/categories/news.m3u' },
  { name: 'iptv-org · Movies', url: 'https://iptv-org.github.io/iptv/categories/movies.m3u' },
  { name: 'iptv-org · Music', url: 'https://iptv-org.github.io/iptv/categories/music.m3u' },
  { name: 'iptv-org · Sports', url: 'https://iptv-org.github.io/iptv/categories/sports.m3u' },
  { name: 'iptv-org · Documentary', url: 'https://iptv-org.github.io/iptv/categories/documentary.m3u' },
  { name: 'iptv-org · Everything', url: 'https://iptv-org.github.io/iptv/index.m3u' },
];

// ---------- State ----------
const state = {
  channels: [],
  library: [], // channels after the content filter
  filtered: [],
  kind: '',
  current: null,
  group: '',
  query: '',
  favOnly: false,
  favs: new Set(store.get('favs', [])),
  status: 'Pick a channel to start',
  activeMode: settings.mode,
};

let vrPanel = null;
const video = $('video');
const theater = new Theater($('stage'), video);
const player = new StreamPlayer(video, {
  onStatus: (s, { loading = false, frac = null } = {}) => (loading ? showLoading(s, frac) : (hideLoading(), setStatus(s))),
  onError: (e, report, { refused = false } = {}) => {
    hideLoading();
    setStatus(e);
    toast(e, true);
    theater.setVideoActive(false);
    theater.setPlaceholder('Stream unavailable', state.current?.name || '');
    if (report) renderPlaybackLog(report);
    if (refused) explainRefusal(report);
  },
});

// ---------- Helpers ----------
let toastTimer;
function toast(msg, error = false) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('error', error);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
}

// Progress bar + elapsed time for anything slow (playlist downloads, tuning a channel).
const loading = { active: false, start: 0, text: '', timer: 0 };

function showLoading(text, frac = null) {
  if (!loading.active) {
    loading.active = true;
    loading.start = performance.now();
    loading.timer = setInterval(renderLoading, 1000);
    $('progress').classList.remove('hidden');
  }
  loading.text = text;
  const bar = $('progress');
  bar.classList.toggle('indeterminate', frac == null);
  bar.firstElementChild.style.width = frac == null ? '' : `${Math.round(Math.min(1, frac) * 100)}%`;
  renderLoading();
}

function renderLoading() {
  const s = Math.floor((performance.now() - loading.start) / 1000);
  setStatus(s >= 2 ? `${loading.text} · ${s}s` : loading.text);
}

function hideLoading() {
  if (!loading.active) return;
  loading.active = false;
  clearInterval(loading.timer);
  $('progress').classList.add('hidden');
}

const mb = (n) => `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;

function setStatus(s) {
  state.status = s;
  $('npStatus').textContent = s;
  vrPanel?.draw();
}

// ---------- Playback log ----------
// Every failed attempt and stream probe, with Xtream passwords masked so it's safe to share.
const secrets = new Set();

function mask(text) {
  let out = text;
  for (const s of secrets) if (s.length >= 3) out = out.split(s).join('••••').split(encodeURIComponent(s)).join('••••');
  return out;
}

function renderPlaybackLog(report) {
  const lines = [
    `Channel: ${state.current?.name || '?'}`,
    `App: ${location.origin} · proxy ${proxy.available ? proxy.base : 'none'} (${settings.proxy})`,
    `Browser: ${navigator.userAgent}`,
    '',
    ...report,
  ];
  $('playbackLog').textContent = mask(lines.join('\n'));
  $('playbackLogBox').classList.remove('hidden');
}

// After a refused stream, ask the Xtream panel why: expired account, or connections in use.
async function explainRefusal(report) {
  const xt = state.source?.url && parseXtream(state.source.url);
  if (!xt) return;
  const channel = state.current;
  try {
    const acct = await xtreamAccount(xt, proxyPlan(xt.server) === 'direct' ? undefined : proxied);
    if (state.current !== channel) return;
    const exp = acct.expires ? acct.expires.toLocaleDateString() : 'unknown';
    report.push(`ℹ account: status ${acct.status}, connections ${acct.active ?? '?'} of ${acct.max ?? '?'}, expires ${exp}`);
    renderPlaybackLog(report);
    let msg;
    if (!/^active$/i.test(acct.status)) msg = `The provider says this account is “${acct.status}” (expires ${exp}).`;
    else if (acct.max != null && acct.active >= acct.max) {
      msg = `Your account is using ${acct.active} of ${acct.max} allowed connection${acct.max === 1 ? '' : 's'}. `
        + 'Close other players or wait a minute for the last stream to be released, then retry.';
    } else {
      msg = `The provider refused the stream although the account is active (${acct.active ?? '?'} of ${acct.max ?? '?'} connections in use). `
        + 'It may be temporarily blocking this connection; wait a minute and retry.';
    }
    setStatus(msg);
    toast(msg, true);
  } catch (err) {
    report.push(`ℹ account check failed: ${err.message}`);
    renderPlaybackLog(report);
  }
}

// ---------- CORS proxy ----------
// server.js (same origin) or a remote proxy (server.js elsewhere, proxy/worker.js on
// Cloudflare) exposes <base>?url=…. When one is reachable, sources the
// browser can't reach directly (no CORS headers, or http:// on an https:// page) go through it.
const proxy = { available: false, base: 'proxy', blockedHosts: new Set(store.get('blockedHosts', [])) };

// A configured proxy URL wins; otherwise look for server.js on this origin.
function proxyBase() {
  const u = (settings.proxyUrl || '').trim().replace(/\/+$/, '');
  if (!u) return 'proxy';
  return /\/proxy$/.test(u) ? u : `${u}/proxy`;
}

async function detectProxy() {
  proxy.base = proxyBase();
  try {
    const r = await fetch(`${proxy.base}/health`, { cache: 'no-store' });
    proxy.available = r.ok && (await r.text()) === 'ok';
  } catch { proxy.available = false; }
  renderProxyStatus();
}

const hostOf = (u) => { try { return new URL(u, location.href).host; } catch { return ''; } };
const isCrossOrigin = (u) => { try { return new URL(u, location.href).origin !== location.origin; } catch { return false; } };
const isMixed = (u) => location.protocol === 'https:' && /^http:/i.test(u);
const isHls = (u) => /\.m3u8(\?|$)/i.test(u);
// Absolute, because mpegts.js fetches from a Web Worker where relative URLs don't resolve.
const proxied = (u) => new URL(`${proxy.base}?url=${encodeURIComponent(u)}`, location.href).href;

// 'direct' | 'proxy-first' | 'proxy-fallback'
function proxyPlan(url) {
  if (!proxy.available || settings.proxy === 'off' || !isCrossOrigin(url)) return 'direct';
  if (settings.proxy === 'always' || isMixed(url) || proxy.blockedHosts.has(hostOf(url))) return 'proxy-first';
  return 'proxy-fallback';
}

function markBlocked(url) {
  proxy.blockedHosts.add(hostOf(url));
  store.set('blockedHosts', [...proxy.blockedHosts].slice(-50));
}

// Every way to reach a channel, in the order worth trying.
function streamCandidates(ch) {
  // HLS first: it's what Xtream web players use, works with hls.js everywhere, and uses
  // short requests instead of one long TS connection that counts against account limits.
  const urls = [ch.url, ...(ch.alts || [])].sort((a, b) => isHls(b) - isHls(a));
  const direct = urls.filter((u) => !isMixed(u)).map((u) => ({ src: u, hint: u }));
  const via = urls.map((u) => ({ src: proxied(u), hint: u, label: 'proxy' }));
  switch (proxyPlan(ch.url)) {
    case 'proxy-first': return via;
    case 'proxy-fallback': return [...direct, ...via];
    default: return direct;
  }
}

function renderProxyStatus() {
  const el = $('proxyStatus');
  if (!el) return;
  const remote = !!settings.proxyUrl;
  el.textContent = proxy.available
    ? `Proxy online${remote ? ` at ${new URL(proxy.base, location.href).host}` : ''}: sources that block browsers get routed through it.`
    : remote
      ? 'Can’t reach that proxy. Check the URL, and that it uses https:// if this page does.'
      : 'No proxy. Run “node server.js”, or enter the URL of your own proxy above, to play IPTV servers that block browsers (most Xtream panels).';
  el.classList.toggle('ok', proxy.available);
  for (const b of $('proxySeg').children) {
    b.classList.toggle('active', b.dataset.proxy === settings.proxy);
    b.disabled = !proxy.available;
  }
}

// ---------- Playlists ----------
function setChannels(channels, label, source = null) {
  state.source = source;
  $('refreshList').classList.toggle('hidden', !source?.url);
  state.channels = channels;
  state.group = '';
  rebuildLibrary();
  toast(`${label}: ${state.library.length.toLocaleString()} channels${state.library.length < channels.length ? ' after filter' : ''}`);
  setTab('channels');
}

const ago = (t) => {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

// fresh=false opens the saved copy when there is one (app start, saved-list clicks);
// fresh=true always downloads (Load button, ↻ refresh).
async function loadPlaylistUrl(url, name, { fresh = true } = {}) {
  const xt = parseXtream(url);
  if (xt) {
    secrets.add(xt.password);
    name = name || `Xtream · ${xt.username}@${hostOf(xt.server)}`;
    $('xtServer').value = xt.server;
    $('xtUser').value = xt.username;
    $('xtPass').value = xt.password;
  }
  name = name || hostOf(url) || 'Playlist';
  const key = playlistKey(url);
  if (!fresh) {
    const cached = await cacheGet(key);
    if (cached?.channels?.length) {
      setChannels(cached.channels, name, { url, name, savedAt: cached.savedAt });
      store.set('last', { url, name });
      rememberPlaylist(name, url);
      setStatus(`Saved copy from ${ago(cached.savedAt)} · ↻ to update`);
      return;
    }
  }
  showLoading(`Connecting to ${name}…`);
  const plan = proxyPlan(url);
  const onProgress = ({ phase, received = 0, total = 0, rate = 0 }) => {
    if (phase === 'parse') return showLoading(`Reading channels from ${mb(received)}…`);
    const size = total ? `${mb(received)} of ${mb(total)}` : mb(received);
    showLoading(`Downloading playlist · ${size}${rate ? ` · ${mb(rate)}/s` : ''}`, total ? received / total : null);
  };
  const viaProxy = { proxify: proxied, onProgress };
  try {
    let channels;
    if (plan === 'proxy-first') {
      channels = await fetchPlaylist(url, viaProxy);
    } else {
      try {
        channels = await fetchPlaylist(url, { onProgress });
      } catch (err) {
        if (!err.blocked || plan !== 'proxy-fallback') throw err;
        showLoading('Direct access blocked, retrying through the proxy…');
        channels = await fetchPlaylist(url, viaProxy);
        markBlocked(url);
      }
    }
    // Streams almost always live on the same blocked host as their playlist.
    if (plan !== 'direct' && proxy.blockedHosts.has(hostOf(url))) {
      for (const h of new Set(channels.map((c) => hostOf(c.url)))) proxy.blockedHosts.add(h);
      store.set('blockedHosts', [...proxy.blockedHosts].slice(-50));
    }
    const savedAt = Date.now();
    setChannels(channels, name, { url, name, savedAt });
    cachePut(key, { url, name, savedAt, channels });
    store.set('last', { url, name });
    rememberPlaylist(name, url);
    hideLoading();
    setStatus(state.current ? state.status : 'Pick a channel to start');
  } catch (err) {
    hideLoading();
    const msg = `Couldn’t load playlist: ${err.message}`;
    setStatus(msg);
    toast(msg, true);
  }
}

function loadBuiltinDemo() {
  setChannels(parseM3U(DEMO_M3U), 'Demo streams');
  store.set('last', { builtin: true });
}

// Saved playlists are unique per playlistKey, so re-adding an account replaces its entry.
function savedPlaylists() {
  const seen = new Set();
  return store.get('playlists', []).filter((p) => {
    const k = playlistKey(p.url);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function rememberPlaylist(name, url) {
  const key = playlistKey(url);
  const saved = savedPlaylists().filter((p) => playlistKey(p.url) !== key);
  saved.unshift({ name, url });
  store.set('playlists', saved.slice(0, 12));
  renderSaved();
}

function renderSaved() {
  const ul = $('savedList');
  ul.innerHTML = '';
  const saved = savedPlaylists();
  store.set('playlists', saved); // clears duplicates saved by older versions
  if (!saved.length) { ul.innerHTML = '<li class="muted small">None yet</li>'; return; }
  for (const p of saved) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = p.name;
    span.title = maskUrl(p.url);
    span.onclick = () => loadPlaylistUrl(p.url, p.name, { fresh: false });
    const del = document.createElement('button');
    del.className = 'icon-btn';
    del.textContent = '✕';
    del.title = 'Forget';
    del.onclick = () => {
      const key = playlistKey(p.url);
      store.set('playlists', savedPlaylists().filter((x) => playlistKey(x.url) !== key));
      cacheDelete(key);
      renderSaved();
    };
    li.append(span, del);
    ul.append(li);
  }
}

// ---------- Channel list ----------
const LIST_LIMIT = 400;

// Applies the content filter (region/language) and rebuilds groups and type tabs.
function rebuildLibrary() {
  const cf = settings.contentFilter;
  const all = state.channels;
  state.filterNote = '';
  let lib = all;
  if (cf.on && all.length) {
    const kept = all.filter(makeFilter(cf));
    if (kept.length) {
      lib = kept;
      if (kept.length < all.length) state.filterNote = ` · filter: ${kept.length.toLocaleString()} of ${all.length.toLocaleString()}`;
    } else {
      state.filterNote = ' · filter matched nothing, showing all';
    }
  }
  state.library = lib;
  $('cfToggle').classList.toggle('on', cf.on);

  const hasVod = lib.some((c) => kindOf(c) !== 'live');
  $('kindSeg').classList.toggle('hidden', !hasVod);
  if (!hasVod) state.kind = '';
  for (const b of $('kindSeg').children) b.classList.toggle('active', b.dataset.kind === state.kind);
  rebuildGroups();
}

function rebuildGroups() {
  const inKind = state.kind ? state.library.filter((c) => kindOf(c) === state.kind) : state.library;
  const groups = [...new Set(inKind.map((c) => c.group))].sort((a, b) => a.localeCompare(b));
  state.groups = groups;
  if (!groups.includes(state.group)) state.group = '';
  const sel = $('groupFilter');
  sel.innerHTML = '<option value="">All groups</option>';
  for (const g of groups) sel.add(new Option(g, g));
  sel.value = state.group;
  applyFilter();
}

function applyFilter() {
  const q = state.query.toLowerCase();
  state.filtered = state.library.filter((c) =>
    (!state.kind || kindOf(c) === state.kind) &&
    (!state.group || c.group === state.group) &&
    (!state.favOnly || state.favs.has(c.id)) &&
    (!q || c.name.toLowerCase().includes(q) || c.group.toLowerCase().includes(q)));
  renderList();
  vrPanel?.draw();
}

function renderList() {
  const ul = $('channelList');
  ul.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const ch of state.filtered.slice(0, LIST_LIMIT)) {
    const li = document.createElement('li');
    li.dataset.id = ch.id;
    if (ch === state.current) li.classList.add('playing');
    const num = document.createElement('span');
    num.className = 'ch-num';
    num.textContent = ch.num;
    const img = document.createElement('img');
    img.className = 'ch-logo';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.alt = '';
    if (ch.logo) img.src = ch.logo; else img.style.visibility = 'hidden';
    img.onerror = () => { img.style.visibility = 'hidden'; };
    const text = document.createElement('div');
    text.className = 'ch-text';
    text.innerHTML = '<div class="ch-name"></div><div class="ch-group"></div>';
    text.firstChild.textContent = ch.name;
    text.lastChild.textContent = ch.group + (ch.layout ? ` · 3D ${ch.layout.toUpperCase()}` : '');
    const fav = document.createElement('button');
    fav.className = 'fav' + (state.favs.has(ch.id) ? ' on' : '');
    fav.textContent = '★';
    fav.title = 'Favorite';
    fav.onclick = (e) => { e.stopPropagation(); toggleFav(ch, fav); };
    li.append(num, img, text, fav);
    li.onclick = () => play(ch);
    frag.append(li);
  }
  ul.append(frag);
  const n = state.filtered.length;
  const updated = state.source?.savedAt ? ` · updated ${ago(state.source.savedAt)}` : '';
  $('listInfo').textContent = (n > LIST_LIMIT
    ? `Showing ${LIST_LIMIT} of ${n} channels. Search to narrow down.`
    : `${n.toLocaleString()} channel${n === 1 ? '' : 's'}`) + updated + (state.filterNote || '');
}

function toggleFav(ch, btn) {
  if (state.favs.has(ch.id)) state.favs.delete(ch.id); else state.favs.add(ch.id);
  store.set('favs', [...state.favs]);
  btn?.classList.toggle('on', state.favs.has(ch.id));
  if (state.favOnly) applyFilter();
}

function markPlaying() {
  for (const li of $('channelList').children) li.classList.toggle('playing', li.dataset.id === state.current?.id);
}

// ---------- Playback ----------
async function play(ch) {
  state.current = ch;
  $('npName').textContent = ch.name;
  const logo = $('npLogo');
  logo.referrerPolicy = 'no-referrer';
  if (ch.logo) logo.src = ch.logo; else logo.removeAttribute('src');
  markPlaying();
  theater.setVideoActive(false);
  theater.setPlaceholder(ch.name, 'Tuning…');
  // Channels tagged as native 3D switch the screen to that layout automatically.
  applyMode(ch.layout || settings.mode, false);
  vrPanel?.draw();
  const sources = streamCandidates(ch);
  if (!sources.length) {
    const msg = 'This http:// stream can’t play on an https:// page without a proxy. Set one under Sources → Proxy.';
    setStatus(msg); toast(msg, true);
    theater.setPlaceholder('Stream blocked', ch.name);
    return;
  }
  const ok = await player.load(sources);
  if (ok && state.current === ch) {
    theater.setVideoActive(true);
    updateAspect();
    syncPlayButton();
  }
}

function playDirect(url) {
  if (!url) return;
  play({ id: url, url, name: url.split('/').pop().split('?')[0] || url, group: 'Direct', logo: '', num: 0, layout: null });
}

function step(dir) {
  const list = state.filtered.length ? state.filtered : state.channels;
  if (!list.length) return;
  const i = list.indexOf(state.current);
  play(list[(i + dir + list.length) % list.length]);
}

function togglePlay() {
  if (!state.current) { if (state.filtered[0]) play(state.filtered[0]); return; }
  if (video.paused) video.play().catch(() => {}); else video.pause();
}

function syncPlayButton() {
  $('playPause').textContent = video.paused ? '▶' : '⏸';
  vrPanel?.draw();
}

function updateAspect() {
  const w = video.videoWidth, h = video.videoHeight;
  if (!w || !h) return;
  let aspect = w / h;
  const layout = theater.screen.get('uLayout');
  // Full-width SBS (e.g. 3840x1080) halves per eye; half-SBS is already squeezed to 16:9.
  if (layout === LAYOUT.sbs && aspect > 2.5) aspect /= 2;
  if (layout === LAYOUT.tab && aspect < 1.2) aspect *= 2;
  theater.setAspect(aspect);
}

video.addEventListener('play', syncPlayButton);
video.addEventListener('pause', syncPlayButton);
video.addEventListener('resize', updateAspect);
video.addEventListener('waiting', () => setStatus('Buffering…'));
function liveStatus() {
  const q = video.videoHeight ? `${video.videoHeight}p` : '';
  const ahead = player.bufferedAhead();
  const buf = ahead >= 1 ? `${Math.round(ahead)}s buffered` : '';
  return ['Live', q, buf, video.muted ? 'muted (tap 🔊)' : ''].filter(Boolean).join(' · ');
}
video.addEventListener('playing', () => { setStatus(liveStatus()); syncMute(); });
// Keep the buffer readout fresh while playing, so you can see whether the cushion holds.
setInterval(() => {
  if (!video.paused && !loading.active && state.status.startsWith('Live')) setStatus(liveStatus());
}, 2000);

// ---------- 3D mode + settings ----------
const MODES = ['2d', 'xr3d', 'sbs', 'tab'];
const MODE_HELP = {
  '2d': 'Flat screen, no depth processing.',
  xr3d: 'Simulated 3D: estimates depth from every frame, sculpts the screen into relief and renders separate left and right eye views.',
  sbs: 'Native side-by-side 3D source: each eye sees its own half of the frame.',
  tab: 'Native top-and-bottom 3D source: top half to the left eye, bottom to the right.',
};

function applyMode(mode, persist = true) {
  const s = theater.screen;
  s.set('uLayout', mode === 'sbs' ? LAYOUT.sbs : mode === 'tab' ? LAYOUT.tab : LAYOUT.mono);
  s.set('uDepthOn', mode === 'xr3d' ? 1 : 0);
  if (persist) { settings.mode = mode; saveSettings(); }
  state.activeMode = mode;
  for (const b of $('modeSeg').children) b.classList.toggle('active', b.dataset.mode === mode);
  $('modeHelp').textContent = MODE_HELP[mode];
  $('xr3dControls').style.opacity = mode === 'xr3d' ? 1 : 0.4;
  updateAspect();
  vrPanel?.draw();
}

const SLIDERS = {
  relief: { uniform: 'uRelief', fmt: (v) => v.toFixed(2) },
  parallax: { uniform: 'uParallax', fmt: (v) => v.toFixed(2) },
  convergence: { uniform: 'uConvergence', fmt: (v) => v.toFixed(2) },
  contrast: { uniform: 'uContrast', fmt: (v) => v.toFixed(2) },
  smooth: { uniform: 'uBlur', fmt: (v) => v.toFixed(3) },
  bright: { uniform: 'uBrightness', fmt: (v) => `${Math.round(v * 100)}%` },
  size: { screen: 'width', fmt: (v) => `${v.toFixed(1)} m` },
  distance: { screen: 'distance', fmt: (v) => `${v.toFixed(1)} m` },
  height: { screen: 'height', fmt: (v) => `${v.toFixed(2)} m` },
  curve: { screen: 'curve', fmt: (v) => `${Math.round(v * 120)}°` },
};

function applySetting(key, value) {
  settings[key] = value;
  const def = SLIDERS[key];
  if (def.uniform) theater.screen.set(def.uniform, value);
  if (def.screen) theater.setScreen({ [def.screen]: value });
  $(`${key}Out`).textContent = def.fmt(value);
  $(key).value = value;
}

function adjust(key, delta) {
  const el = $(key);
  const v = Math.min(+el.max, Math.max(+el.min, settings[key] + delta));
  applySetting(key, +v.toFixed(3));
  saveSettings();
  toast(`${key === 'relief' ? 'Depth' : 'Pop'}: ${SLIDERS[key].fmt(v)}`);
}

function applyAll() {
  for (const key of Object.keys(SLIDERS)) applySetting(key, settings[key]);
  theater.screen.set('uInvert', settings.invert ? 1 : 0);
  theater.screen.set('uShowDepth', settings.showDepth ? 1 : 0);
  theater.screen.set('uSwap', settings.swap ? 1 : 0);
  $('invertDepth').checked = settings.invert;
  $('showDepth').checked = settings.showDepth;
  $('swapEyes').checked = settings.swap;
  $('ambient').checked = settings.ambient;
  theater.ambientOn = settings.ambient;
  setView(settings.view);
  setEnv(settings.env);
  applyMode(state.current?.layout || settings.mode, false);
  for (const b of $('modeSeg').children) b.classList.toggle('active', b.dataset.mode === state.activeMode);
  video.volume = settings.volume;
  video.muted = settings.muted;
  $('volume').value = settings.volume;
  syncMute();
}

function setView(view) {
  settings.view = view;
  theater.setView(view);
  for (const b of $('viewSeg').children) b.classList.toggle('active', b.dataset.view === view);
}

function setEnv(env) {
  settings.env = env;
  theater.setEnvironment(env);
  for (const b of $('envSeg').children) b.classList.toggle('active', b.dataset.env === env);
}

function syncMute() {
  $('mute').textContent = video.muted || video.volume === 0 ? '🔇' : '🔊';
}

// ---------- UI wiring ----------
function setTab(name) {
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.tab === name);
  for (const b of document.querySelectorAll('.tab-body')) b.classList.toggle('active', b.dataset.tab === name);
}
for (const t of document.querySelectorAll('.tab')) t.onclick = () => setTab(t.dataset.tab);

function togglePanel(show = $('panel').classList.contains('collapsed')) {
  $('panel').classList.toggle('collapsed', !show);
  $('panelOpen').classList.toggle('hidden', show);
}
$('panelToggle').onclick = () => togglePanel(false);
$('panelOpen').onclick = () => togglePanel(true);

$('search').oninput = (e) => { state.query = e.target.value; applyFilter(); };
$('groupFilter').onchange = (e) => { state.group = e.target.value; applyFilter(); };
$('favFilter').onclick = (e) => { state.favOnly = !state.favOnly; e.target.classList.toggle('on', state.favOnly); applyFilter(); };

$('loadUrl').onclick = () => {
  let u = $('m3uUrl').value.trim();
  if (!u) return;
  if (!/^[a-z]+:\/\//i.test(u)) u = `http://${u}`;
  loadPlaylistUrl(u);
};
$('m3uUrl').onkeydown = (e) => { if (e.key === 'Enter') $('loadUrl').click(); };
$('m3uFile').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  setChannels(parseM3U(text), file.name);
  if (text.length < 2_000_000) { store.set('localText', text); store.set('last', { local: file.name }); }
};
$('xtLoad').onclick = () => {
  let server = $('xtServer').value.trim();
  const user = $('xtUser').value.trim(), pass = $('xtPass').value;
  if (parseXtream(server)) return loadPlaylistUrl(server); // a full get.php link pasted into the server box
  if (!server || !user) return toast('Enter server and username', true);
  if (!/^https?:\/\//i.test(server)) server = `http://${server}`;
  loadPlaylistUrl(xtreamUrl(server, user, pass));
};
for (const b of $('kindSeg').children) b.onclick = () => { state.kind = b.dataset.kind; for (const x of $('kindSeg').children) x.classList.toggle('active', x === b); rebuildGroups(); };
$('cfToggle').onclick = () => { settings.contentFilter.on = !settings.contentFilter.on; saveSettings(); syncFilterForm(); rebuildLibrary(); };

function syncFilterForm() {
  const cf = settings.contentFilter;
  $('cfOn').checked = cf.on;
  $('cfLive').value = cf.live;
  $('cfVod').value = cf.vod;
  $('cfUntagged').checked = cf.vodUntagged;
}
const readFilterForm = () => {
  Object.assign(settings.contentFilter, {
    on: $('cfOn').checked, live: $('cfLive').value, vod: $('cfVod').value, vodUntagged: $('cfUntagged').checked,
  });
  saveSettings();
  rebuildLibrary();
};
for (const id of ['cfOn', 'cfLive', 'cfVod', 'cfUntagged']) $(id).onchange = readFilterForm;
syncFilterForm();

$('refreshList').onclick = () => state.source && loadPlaylistUrl(state.source.url, state.source.name, { fresh: true });
$('copyLog').onclick = async () => {
  try { await navigator.clipboard.writeText($('playbackLog').textContent); toast('Playback log copied'); }
  catch { toast('Couldn’t copy. Select the text and copy it manually.', true); }
};
$('playDirect').onclick = () => playDirect($('directUrl').value.trim());
$('directUrl').onkeydown = (e) => { if (e.key === 'Enter') $('playDirect').click(); };

for (const p of PRESETS) {
  const b = document.createElement('button');
  b.className = 'chip';
  b.textContent = p.name;
  b.onclick = () => (p.builtin ? loadBuiltinDemo() : loadPlaylistUrl(p.url, p.name));
  $('presets').append(b);
}

for (const b of $('modeSeg').children) b.onclick = () => applyMode(b.dataset.mode);
const saveProxyUrl = async () => {
  settings.proxyUrl = $('proxyUrl').value.trim();
  saveSettings();
  await detectProxy();
  toast(proxy.available ? 'Proxy connected' : 'Proxy not reachable', !proxy.available);
};
$('proxyUrl').value = settings.proxyUrl;
$('proxyUrlSave').onclick = saveProxyUrl;
$('proxyUrl').onkeydown = (e) => { if (e.key === 'Enter') saveProxyUrl(); };
for (const b of $('proxySeg').children) b.onclick = () => { settings.proxy = b.dataset.proxy; saveSettings(); renderProxyStatus(); };
for (const b of $('viewSeg').children) b.onclick = () => { setView(b.dataset.view); saveSettings(); };
for (const b of $('envSeg').children) b.onclick = () => { setEnv(b.dataset.env); saveSettings(); };
for (const key of Object.keys(SLIDERS)) $(key).oninput = (e) => { applySetting(key, +e.target.value); saveSettings(); };

const bindCheck = (id, key, fn) => { $(id).onchange = (e) => { settings[key] = e.target.checked; fn(e.target.checked); saveSettings(); }; };
bindCheck('invertDepth', 'invert', (v) => theater.screen.set('uInvert', v ? 1 : 0));
bindCheck('showDepth', 'showDepth', (v) => theater.screen.set('uShowDepth', v ? 1 : 0));
bindCheck('swapEyes', 'swap', (v) => theater.screen.set('uSwap', v ? 1 : 0));
bindCheck('ambient', 'ambient', (v) => { theater.ambientOn = v; });

$('resetSettings').onclick = () => {
  Object.assign(settings, DEFAULTS);
  saveSettings();
  applyAll();
  toast('Settings reset');
};

$('prevCh').onclick = () => step(-1);
$('nextCh').onclick = () => step(1);
$('playPause').onclick = togglePlay;
$('mute').onclick = () => { video.muted = !video.muted; settings.muted = video.muted; saveSettings(); syncMute(); };
$('volume').oninput = (e) => { video.volume = +e.target.value; video.muted = false; settings.volume = video.volume; settings.muted = false; saveSettings(); syncMute(); };

addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  const k = e.key;
  if (k === ' ') { e.preventDefault(); togglePlay(); }
  else if (k === 'PageDown' || k === 'ArrowDown') { e.preventDefault(); step(1); }
  else if (k === 'PageUp' || k === 'ArrowUp') { e.preventDefault(); step(-1); }
  else if (k === 'm' || k === 'M') $('mute').click();
  else if (k === 'h' || k === 'H') togglePanel();
  else if (k === '3') cycleMode();
  else if (k === 'd' || k === 'D') { $('showDepth').click(); }
  else if (k === 'f' || k === 'F') { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.(); }
  else if (k === 'v' || k === 'V') { if (!$('enterVR').disabled) $('enterVR').click(); }
});

function cycleMode() {
  const i = MODES.indexOf(state.activeMode);
  applyMode(MODES[(i + 1) % MODES.length]);
  toast(`3D mode: ${state.activeMode.toUpperCase()}`);
}

// ---------- WebXR ----------
const vrBtn = $('enterVR');
const arBtn = $('enterAR');
Theater.support().then(({ vr, ar }) => {
  if (vr) { vrBtn.disabled = false; vrBtn.textContent = 'Enter VR'; }
  else vrBtn.title = window.isSecureContext ? 'No WebXR headset detected' : 'WebXR needs HTTPS or localhost';
  if (ar) arBtn.classList.remove('hidden');
});
const startXR = async (mode, btn) => {
  try {
    await theater.enterXR(mode);
    if (theater.renderer.xr.isPresenting) btn.textContent = 'Exit';
  } catch (err) {
    toast(`Couldn’t start XR: ${err.message}`, true);
  }
};
vrBtn.onclick = () => startXR('immersive-vr', vrBtn);
arBtn.onclick = () => startXR('immersive-ar', arBtn);
theater.onXREnd = () => { vrBtn.textContent = 'Enter VR'; arBtn.textContent = 'Passthrough'; };

vrPanel = new VRPanel(theater, {
  channels: () => state.filtered,
  current: () => state.current,
  status: () => state.status,
  groups: () => state.groups || [],
  group: () => state.group,
  setGroup: (g) => { state.group = g; $('groupFilter').value = g; applyFilter(); },
  play,
  next: () => step(1),
  prev: () => step(-1),
  togglePlay,
  playing: () => !video.paused,
  mode: () => state.activeMode,
  cycleMode,
  adjust,
  exitVR: () => theater.renderer.xr.getSession()?.end(),
});

// ---------- Boot ----------
applyAll();
renderSaved();
await detectProxy();
// server.js and the Cloudflare deployment include a demo Xtream panel (proxy/xtream-demo.js).
if (proxy.available && !settings.proxyUrl) {
  const b = document.createElement('button');
  b.className = 'chip';
  b.textContent = 'Xtream demo';
  b.title = 'Built-in test panel: get.php?username=demo&password=demo';
  b.onclick = () => loadPlaylistUrl(new URL('get.php?username=demo&password=demo&type=m3u_plus', location.href).href, 'Xtream demo');
  $('presets').prepend(b);
}
const last = store.get('last', null);
if (last?.url) loadPlaylistUrl(last.url, last.name, { fresh: false });
else if (last?.local && store.get('localText', null)) setChannels(parseM3U(store.get('localText', '')), last.local);
else loadBuiltinDemo();

// Debug handle for the console.
window.o3xr = { theater, vrPanel, state, settings };
