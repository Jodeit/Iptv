import { preferFlat, device } from './device.js';
import { FlatStage } from './flat-stage.js';
import { StreamPlayer, setHlsPreference, setBufferLevel, setAirPlay } from './stream.js';
import { Cast } from './cast.js';
import { parseM3U, fetchPlaylist, xtreamUrl, parseXtream, maskUrl, playlistKey, xtreamAccount, xtreamAlternates, readBody } from './m3u.js';
import { XtreamLibrary } from './xtream.js';
import { cacheGet, cachePut, cacheDelete } from './cache.js';
import { FILTER_DEFAULTS, makeFilter, kindOf } from './filter.js';
import { annotate, localFilter, dedupe } from './normalize.js';
import { VERSION } from './version.js';
import { Profiles, emptyDoc, canSync, capMeta, mergeProgress } from './profiles.js';
import { Guide } from './epg.js';
import { GuideView } from './guide-view.js';
import { Ratings, parseTitle } from './ratings.js';
import { GalleryView } from './gallery.js';
import { Similar, indexCatalog, matchCatalog } from './similar.js';
import { findLatestSources } from './source-finder.js';

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
  volume: 1, muted: false, proxy: 'auto', proxyUrl: '', vodPlayer: 'builtin', display: 'auto', hlsEngine: 'auto',
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
const isTV = /TunerTV/.test(navigator.userAgent); // the Android TV app (see js/tv.js)
const TV_MAX_COPY_AGE = 6 * 3600 * 1000; // the TV has no ↻ button, so it doesn't trust an older saved copy
const state = {
  channels: [],
  library: [], // channels after the content filter
  filtered: [],
  kind: '',
  current: null,
  group: '',
  query: '',
  favOnly: false,
  favs: new Set(),
  status: 'Pick a channel to start',
  activeMode: settings.mode,
};

let vrPanel = null;
let logTimer = 0;
setHlsPreference(settings.hlsEngine);
setBufferLevel(settings.buffer);

// ---------- Guide (EPG) ----------
// Guide requests go direct when the server allows it, otherwise through the proxy.
async function smartFetch(url) {
  const plan = proxyPlan(url);
  if (plan !== 'proxy-first') {
    try { return await fetch(url); } catch {
      if (plan === 'direct') throw new Error('blocked');
      markBlocked(url);
    }
  }
  return fetch(proxied(url));
}

async function fetchJsonSmart(url, onProgress) {
  const res = await smartFetch(url);
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  const parts = [];
  await readBody(res, (t) => parts.push(t), onProgress);
  return JSON.parse(parts.join(''));
}

const guide = new Guide({
  fetcher: smartFetch,
  onUpdate: (ids) => {
    for (const id of ids || visibleRows) if (visibleRows.has(id)) updateRowEpg(id);
    if (!ids || ids.includes(state.current?.id)) updateNowPlayingEpg();
    guideView.refresh(ids);
  },
});

const guideView = new GuideView({
  root: $('guideView'),
  guide,
  channels: () => state.filtered.filter((c) => kindOf(c) === 'live'),
  // Playing from the guide keeps it open; the video pops out into a floating window.
  onPlay: (ch) => { miniHidden = false; play(ch); syncMini(); },
  onToggle: () => syncMini(),
});

let miniHidden = false;
// The player shrinks to a thumbnail whenever the guide or the movie/series gallery covers the screen.
function syncMini() {
  const on = (guideView.isOpen() || gallery.isOpen()) && !miniHidden;
  document.body.classList.toggle('mini-on', on);
  $('miniBar').classList.toggle('hidden', !on);
  $('miniGrip').classList.toggle('hidden', !on);
  // Full-size player: a way back to the guide.
  $('guideOpen').classList.toggle('hidden', guideView.isOpen() || gallery.isOpen() || !guide.available());
  $('miniTitle').textContent = state.current?.name || 'Nothing playing';
}

function updateNowPlayingEpg() {
  const ch = state.current;
  const nn = ch && guide.nowNext(ch);
  $('npName').textContent = ch ? (nn?.now ? `${ch.name} · ${nn.now.title}` : ch.name) : 'No channel';
  $('npName').title = nn?.now ? `${fmtTime(nn.now.start)}–${fmtTime(nn.now.stop)} ${nn.now.title}${nn.now.desc ? `\n${nn.now.desc}` : ''}` : '';
  syncMediaSession(ch, nn?.now);
}

// ---------- Remote control (Media Session) ----------
// What the system shows for this page's video (Control Center, lock screen, the Apple TV's
// info panel during AirPlay) and what its remotes do. On live channels the skip buttons and
// the Siri Remote's left/right change channel, since there's nothing to skip through.
function syncMediaSession(ch, now) {
  const ms = navigator.mediaSession;
  if (!ms || !ch || typeof MediaMetadata === 'undefined') return;
  ms.metadata = new MediaMetadata({
    title: now?.title || ch.title || ch.name,
    artist: now?.title ? ch.name : (ch.seriesName || ch.group || ''),
    album: 'Tuner',
    artwork: ch.logo ? [{ src: ch.logo, sizes: '512x512' }] : [],
  });
}

(() => {
  const ms = navigator.mediaSession;
  if (!ms) return;
  const live = () => !state.current || kindOf(state.current) === 'live';
  const set = (action, fn) => { try { ms.setActionHandler(action, fn); } catch { /* not supported here */ } };
  set('play', () => video.play().catch(() => {}));
  set('pause', () => video.pause());
  set('nexttrack', () => step(1));
  set('previoustrack', () => step(-1));
  set('seekforward', (d) => (live() ? step(1) : (video.currentTime += d.seekOffset || 10)));
  set('seekbackward', (d) => (live() ? step(-1) : (video.currentTime -= d.seekOffset || 10)));
  set('seekto', (d) => { if (!live() && Number.isFinite(d.seekTime)) video.currentTime = d.seekTime; });
})();

// Keep progress bars and "now" titles current as programmes change.
setInterval(() => {
  for (const id of visibleRows) updateRowEpg(id);
  updateNowPlayingEpg();
  guideView.tick();
}, 60000);

// ---------- Profiles ----------
// Playlists, favorites, the content filter and the last playlist live in the active profile's
// document (synced across devices); everything else in settings stays on this device.
const apiBase = () => {
  const u = (settings.proxyUrl || '').trim();
  return u ? new URL('/api/', new URL(u, location.href)).href : new URL('api/', location.href).href;
};

// First run with profiles: move this device's existing data into its local document.
function legacyDoc() {
  const now = Date.now();
  const seen = new Set();
  const playlists = store.get('playlists', []).map((p, i) => ({ key: playlistKey(p.url), name: p.name, url: p.url, at: now - i }))
    .filter((p) => !seen.has(p.key) && seen.add(p.key));
  return {
    ...emptyDoc(),
    playlists,
    favs: Object.fromEntries(store.get('favs', []).map((id) => [id, now])),
    contentFilter: { ...settings.contentFilter },
    last: store.get('last', null),
    updatedAt: now,
  };
}

// Resume points; declared before profiles so a profile update can merge into it at any time.
const progress = store.get('progress', {});
const profiles = new Profiles({
  apiBase,
  migrate: legacyDoc,
  onDoc: (doc, reason) => applyDoc(doc, reason),
  onStatus: () => renderProfiles(),
});
state.favs = new Set(Object.keys(profiles.doc.favs));
if (profiles.doc.contentFilter) settings.contentFilter = { ...FILTER_DEFAULTS, ...profiles.doc.contentFilter };

const setLast = (last) => {
  if (JSON.stringify(profiles.doc.last) !== JSON.stringify(last)) profiles.update((d) => { d.last = last; });
};

// Another device changed the profile, or the user switched profiles.
function applyDoc(doc, reason) {
  Object.assign(progress, mergeProgress(progress, doc.progress));
  store.set('progress', progress);
  state.favs = new Set(Object.keys(doc.favs));
  $('omdbKey').value = doc.omdbKey || '';
  $('tmdbKey').value = doc.tmdbKey || '';
  settings.contentFilter = { ...FILTER_DEFAULTS, ...(doc.contentFilter || {}) };
  saveSettings();
  syncFilterForm();
  renderSaved();
  const want = doc.last;
  const showing = state.source?.url ? playlistKey(state.source.url) : null;
  if (want?.url && playlistKey(want.url) !== showing && (reason === 'switch' || !state.channels.length)) {
    loadPlaylistUrl(want.url, want.name, { fresh: false });
  } else if (reason === 'switch' && !want?.url) {
    setChannels([], 'Profile', null);
    setStatus('Add a playlist in Settings → Playlists');
  } else {
    rebuildLibrary();
  }
}
// ---------- Resume points (films and episodes) ----------
// Kept on this device and synced through the profile (at most once a minute, and on pause).
// Episodes also update their show's entry ('xtream-series:<id>'), which says where to continue.
Object.assign(progress, mergeProgress(progress, profiles.doc.progress));
// Keyed by what's being watched, not where it's listed, so progress survives switching
// provider, server address or duplicate listing: title|year for films and shows, plus
// season and episode for episodes. Anything else (live, direct links) keeps its own id.
function progressKey(item) {
  const show = (name) => { const { title, year } = parseTitle(name || ''); return title ? `${title.toLowerCase()}|${year || ''}` : ''; };
  const kind = item.kind || kindOf(item);
  if (kind === 'episode' && item.seriesName && item.season != null) {
    const s = show(item.seriesName);
    if (s) return `s:${s}:S${item.season}E${item.episode}`;
  }
  if (kind === 'series') { const s = show(item.name); if (s) return `s:${s}`; }
  if (kind === 'movie') { const s = show(item.name); if (s) return `m:${s}`; }
  return item.id;
}
// (Falls back to the old per-listing entry for resume points saved before this change.)
const getProgress = (item) => progress[progressKey(item)] || progress[item.id];
let progressSavedAt = 0;
let progressSyncedAt = 0;

function saveProgress(force = false) {
  const ch = state.current;
  const kind = ch && kindOf(ch);
  if (!ch || (kind !== 'movie' && kind !== 'episode' && kind !== 'series')) return;
  const d = video.duration;
  if (!Number.isFinite(d) || d < 120 || video.currentTime < 5) return;
  if (!force && performance.now() - progressSavedAt < 10000) return;
  progressSavedAt = performance.now();
  const at = Date.now();
  const key = progressKey(ch);
  progress[key] = { t: Math.floor(video.currentTime), d: Math.floor(d), at };
  // Movies keep enough to play again from Continue watching.
  if (kind === 'movie') progress[key].item = { id: ch.id, url: ch.url, name: ch.name, logo: ch.logo || '', kind: 'movie', year: ch.year || 0, tmdb: ch.tmdb || '' };
  // The show's own entry: which episode to continue from, and the show to open.
  if (kind === 'episode' && ch.seriesName) {
    const show = { id: `xtream-series:${ch.seriesId}`, seriesId: ch.seriesId, name: ch.seriesName, logo: ch.seriesLogo || ch.logo || '', kind: 'series' };
    progress[progressKey(show)] = { t: progress[key].t, d: progress[key].d, at, season: ch.season, episode: ch.episode, item: show };
  }
  if (force || at - progressSyncedAt > 60000) {
    progressSyncedAt = at;
    const snapshot = { ...progress };
    profiles.update((doc) => { doc.progress = mergeProgress(doc.progress, snapshot); });
  }
  const ids = Object.keys(progress);
  if (ids.length > 300) {
    ids.sort((a, b) => progress[a].at - progress[b].at);
    for (const id of ids.slice(0, ids.length - 300)) delete progress[id];
  }
  store.set('progress', progress);
}

// Where to pick a film up again: mid-way through only (not the first half minute or the credits).
function resumePoint(ch) {
  const p = getProgress(ch);
  return p && p.t > 30 && p.t < p.d - 60 ? p.t : 0;
}

// ---------- Gallery (movies & series) ----------
const ratings = new Ratings({
  fetcher: (u) => smartFetch(u),
  getKey: () => profiles.doc.omdbKey || '',
  onUpdate: (item) => gallery.updated(item),
});

// "More like this": TMDB's recommendations, kept to titles this provider has. TMDB allows
// browsers to call it directly, so no proxy is involved.
const similar = new Similar({ fetcher: (u, init) => fetch(u, init), getKey: () => profiles.doc.tmdbKey || '' });

// Age rating and popularity for a title, from the profile if any device looked it up already
// (within 30 days), else from TMDB. New results are saved to the profile in batches.
const META_TTL = 30 * 86400000;
const metaKey = (item) => {
  const { title, year } = parseTitle(item.name);
  return `${item.kind === 'series' ? 't' : 'm'}:${item.tmdb || `${title.toLowerCase()}|${year || ''}`}`;
};
let metaBatch = {}, metaTimer = 0;
async function tmdbMeta(item) {
  const key = metaKey(item);
  const have = profiles.doc.tmdbMeta?.[key] || metaBatch[key];
  if (have && Date.now() - have[2] < META_TTL) return { cert: have[0], pop: have[1] };
  const ref = await similar.tmdbId(item);
  const meta = ref ? await similar.meta(ref) : { cert: '', pop: 0 };
  metaBatch[key] = [meta.cert, Math.round(meta.pop * 10) / 10, Date.now()];
  clearTimeout(metaTimer);
  metaTimer = setTimeout(() => {
    const batch = metaBatch;
    metaBatch = {};
    profiles.update((d) => { d.tmdbMeta = capMeta({ ...d.tmdbMeta, ...batch }); });
  }, 3000);
  return meta;
}

// Title index of the provider's movies or series, to check recommendations against. With the
// Xtream API that means every category the content filter keeps, fetched once a day.
const catalogs = new Map(); // kind → { key, promise }
function catalogIndex(kind, onProgress) {
  const lib = state.xlib;
  const cats = lib ? vodCategories(kind).map((c) => c.id) : [];
  const key = lib ? `catalog:${playlistKey(state.source?.url || '')}:${kind}:${cats.join(',')}` : `m3u:${state.library.length}`;
  const have = catalogs.get(kind);
  if (have?.key === key) return have.promise;
  const promise = (async () => {
    if (!lib) return indexCatalog(state.library.filter((c) => kindOf(c) === kind));
    const cached = await cacheGet(key);
    if (cached && Date.now() - cached.at < 86400000) return indexCatalog(cached.items);
    const items = await lib.catalog(kind, cats, onProgress);
    cachePut(key, { at: Date.now(), items });
    return indexCatalog(items);
  })();
  promise.catch(() => catalogs.delete(kind));
  catalogs.set(kind, { key, promise });
  return promise;
}

async function moreLike(item, details, onProgress) {
  if (!similar.enabled()) return { items: [], note: 'Add a free TMDB key in Settings → Playback → Ratings to see recommendations.' };
  const kind = kindOf(item) === 'series' ? 'series' : 'movie';
  const ref = await similar.tmdbId(item, { tmdb: details.tmdb || item.tmdb, imdbID: ratings.peek(item)?.imdbID });
  if (!ref) return { items: [], note: 'TMDB doesn’t know this title, so there are no recommendations.' };
  const [recs, index] = await Promise.all([similar.recommendations(ref), catalogIndex(kind, onProgress)]);
  const items = matchCatalog(recs, index, item.id);
  return {
    items,
    note: items.length ? '' : recs.length ? `None of TMDB’s ${recs.length} recommendations are on your provider${state.xlib && settings.contentFilter.on ? ' (in the categories your content filter keeps)' : ''}.` : 'TMDB has no recommendations for this title yet.',
  };
}

// Playlists without the Xtream API: categories are the groups of that kind.
const galleryGroups = (kind) => [...new Set(state.library.filter((c) => kindOf(c) === kind).map((c) => c.group))]
  .sort((a, b) => a.localeCompare(b)).map((g) => ({ id: g, name: g }));

// Every movie/series of a kind, for searching across categories. Honours the content filter.
async function allOfKind(kind) {
  if (!state.xlib) return state.library.filter((c) => kindOf(c) === kind);
  const lib = state.xlib;
  const before = state.status;
  let items;
  try {
    showLoading('Loading the full list to search it…');
    items = await lib.all(kind, (p) => showLoading(`Loading the full list · ${mb(p.received)}`));
  } finally { hideLoading(); setStatus(before); }
  const allowed = new Set(vodCategories(kind).map((c) => c.id));
  return items.filter((i) => allowed.has(i.catId));
}

const gallery = new GalleryView($('gallery'), {
  onToggle: () => syncMini(),
  categories: (kind) => (state.xlib ? vodCategories(kind) : galleryGroups(kind)),
  loadCategory: async (kind, catId) => {
    if (!state.xlib) return state.library.filter((c) => kindOf(c) === kind && c.group === catId);
    const lib = state.xlib;
    const have = lib.items[kind].get(catId);
    if (have) return have;
    const before = state.status;
    try {
      showLoading(`Loading ${lib.catName(kind, catId)}…`);
      return await lib.category(kind, catId, (p) => showLoading(`Loading ${lib.catName(kind, catId)} · ${mb(p.received)}`));
    } finally { hideLoading(); setStatus(before); }
  },
  searchAll: (kind) => allOfKind(kind),
  episodes: (series) => state.xlib.seriesEpisodes(series),
  // Seasons and episode count for a series card, cached a day. One API call each (not a
  // stream, so it doesn't use a connection), made only for cards that stay on screen.
  seriesCounts: async (series) => {
    if (!state.xlib) return null;
    const key = `series-counts:${playlistKey(state.source?.url || '')}:${series.seriesId}`;
    const cached = await cacheGet(key);
    if (cached && Date.now() - cached.at < 86400000) return cached.counts;
    const eps = await state.xlib.seriesEpisodes(series);
    const seasons = new Set(eps.map((e) => e.season)).size;
    const counts = { seasons, episodes: eps.length, described: eps.filter((e) => e.plot).length };
    cachePut(key, { at: Date.now(), counts });
    return counts;
  },
  movieInfo: (item) => (state.xlib ? state.xlib.movieInfo(item) : {}),
  moreLike,
  ratings,
  parseTitle,
  play: (item, startAt) => play(item, { startAt }),
  progress: getProgress,
  // Part-way films (or shows, for the Shows tab), newest first.
  continueList: (kind) => Object.values(progress)
    .filter((p) => p.item?.kind === kind && p.d && (kind === 'series' || p.t < p.d - 60))
    .sort((a, b) => b.at - a.at)
    .slice(0, 20)
    .map((p) => ({ item: p.item, p })),
  isFav: (id) => state.favs.has(id),
  toggleFav: (item) => toggleFav(item),
  external: (item) => offerExternal(item),
  get tmdbMeta() { return similar.enabled() ? tmdbMeta : null; },
  imageUrl: (url) => (proxy.available && /^https?:/.test(url) && !url.includes('/proxy?') ? proxied(url) : ''),
});

const galleryKind = () => (state.kind === 'movie' || state.kind === 'series') && (state.xlib || state.library.some((c) => kindOf(c) === state.kind));

const video = $('video');
// Phones and tablets without WebXR get the plain video player; the 3D theater (three.js,
// WebGL) isn't even downloaded there.
const flat = await preferFlat(settings.display);
document.body.classList.toggle('flat', flat);
document.body.classList.toggle('ios', device.ios);
// The now-playing bar wraps to two rows on phones; everything else sizes itself around it.
new ResizeObserver(([e]) => {
  document.documentElement.style.setProperty('--bar-h', `${Math.round(e.borderBoxSize?.[0]?.blockSize ?? e.target.offsetHeight)}px`);
}).observe($('bar'));
const TheaterModule = flat ? null : await import('./theater.js');
const theater = flat ? new FlatStage(video) : new TheaterModule.Theater($('stage'), video);
const LAYOUT = { mono: 0, sbs: 1, tab: 2 }; // must match xr3d.js
const player = new StreamPlayer(video, {
  onStatus: (s, { loading = false, frac = null } = {}) => (loading ? showLoading(s, frac) : (hideLoading(), setStatus(s))),
  onWarn: (m) => toast(m, true),
  onSlow: () => {
    const ch = state.current;
    if (ch && settings.vodPlayer === 'slow' && kindOf(ch) !== 'live') offerExternal(ch, 'This is downloading slower than it plays.');
  },
  // The log updates while playing (stalls, buffer, speed), not only after a failure.
  onLog: (report) => {
    clearTimeout(logTimer);
    logTimer = setTimeout(() => renderPlaybackLog(report), 300);
  },
  onError: (e, report, { refused = false } = {}) => {
    hideLoading();
    setStatus(e);
    toast(e, true);
    theater.setVideoActive(false);
    theater.setPlaceholder('Stream unavailable', state.current?.name || '');
    if (report) renderPlaybackLog(report);
    if (refused) explainRefusal(report);
    else if (state.current) offerExternal(state.current, e);
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

const mb = (n) => (n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`);

// The VR panel is a canvas texture: every redraw re-uploads ~3 MB to the GPU and causes a
// visible hitch in the headset. So it shows the status without the ticking parts (elapsed
// seconds, buffer level) and only redraws when that text actually changes.
const panelText = (s) => s.replace(/ · \d+s buffered/, '').replace(/ · \d+s$/, '');

function setStatus(s) {
  state.status = s;
  $('npStatus').textContent = s;
  const p = panelText(s);
  if (p !== state.panelStatus) {
    state.panelStatus = p;
    vrPanel?.draw();
  }
}

// ---------- Play in another app ----------
// Player apps fetch the stream themselves, from this device's own connection, so they need
// neither the proxy nor a browser-friendly format (MKV, DTS audio…).
function externalPlayers(url) {
  const e = encodeURIComponent(url);
  if (device.ios) {
    return [
      ['VLC', `vlc-x-callback://x-callback-url/stream?url=${e}`],
      ['Infuse', `infuse://x-callback-url/play?url=${e}`],
    ];
  }
  if (device.android) {
    return [
      ['Open with…', `intent:${url}#Intent;action=android.intent.action.VIEW;type=video/*;end`],
      ['VLC', `vlc://${url}`],
    ];
  }
  // Desktop: these apps register URL schemes when installed.
  return [
    ['IINA', `iina://weblink?url=${e}`],
    ['VLC', `vlc://${url}`],
    ['Infuse', `infuse://x-callback-url/play?url=${e}`],
  ];
}

function offerExternal(ch, why = '') {
  const kind = kindOf(ch);
  $('extWhy').textContent = `${why ? `${why} ` : ''}${kind === 'live' ? '' : 'Player apps handle every movie format.'}`.trim();
  const box = $('extButtons');
  box.innerHTML = '';
  for (const [label, href] of externalPlayers(ch.url)) {
    const a = document.createElement('a');
    a.className = 'btn';
    a.textContent = `Open in ${label}`.replace('Open in Open with…', 'Open with…');
    a.href = href;
    box.append(a);
  }
  const copy = document.createElement('button');
  copy.className = 'btn ghost';
  copy.textContent = 'Copy link';
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(ch.url); toast('Link copied. Paste it into your player app (it includes your login).'); }
    catch { prompt('Copy this link:', ch.url); }
  };
  box.append(copy);
  $('extSheet').classList.remove('hidden');
}
$('extClose').onclick = () => $('extSheet').classList.add('hidden');

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
    `Player: ${flat ? 'flat' : '3D theater'} · HLS engine ${settings.hlsEngine || 'auto'}`,
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
// MKV plays through the in-app remuxer wherever Media Source Extensions exist, so there's no
// need to guess at an HLS version of the film first.
const canRemux = (url) => /\.mkv(\?|$)/i.test(url) && !!(window.ManagedMediaSource || window.MediaSource);

function streamCandidates(ch) {
  // HLS first: it's what Xtream web players use, works with hls.js everywhere, and uses
  // short requests instead of one long TS connection that counts against account limits.
  const xt = state.source?.url && parseXtream(state.source.url);
  const kind = kindOf(ch);
  // Movies/episodes: some panels also serve an HLS version, which every browser can play.
  const own = ch.alts || (xt && kind === 'live' ? xtreamAlternates(ch.url, xt)
    : xt && (kind === 'movie' || kind === 'episode') && !canRemux(ch.url) ? [ch.url.replace(/\.\w+$/, '.m3u8')].filter((u) => u !== ch.url) : []);
  // Copies of the same station that were merged into this one (other folders, other qualities): last resorts.
  const dupeUrls = (ch.dupes || []).map((d) => d.url).filter((u) => u !== ch.url);
  const urls = [...[ch.url, ...own].sort((a, b) => isHls(b) - isHls(a)), ...dupeUrls];
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
// Expiry, status and device limit from the Xtream panel; hidden for other sources.
let accountSeq = 0;
async function showAccount(source = state.source, { quiet = false } = {}) {
  const el = $('accountInfo');
  const xt = source?.url && parseXtream(source.url);
  if (!xt) { el.classList.add('hidden'); return; }
  if (!quiet) el.classList.add('hidden');
  const seq = ++accountSeq;
  $('accountRefresh').classList.add('spin');
  try {
    const a = await xtreamAccount(xt, proxyPlan(xt.server) === 'direct' ? undefined : proxied);
    if (seq !== accountSeq || state.source !== source) return;
    const days = a.expires ? Math.ceil((a.expires - Date.now()) / 864e5) : null;
    const over = a.active != null && a.max != null && a.active > a.max;
    const conns = a.max != null
      ? `${a.active ?? '?'} of ${a.max} connection${a.max === 1 ? '' : 's'} open${over ? ' (over the limit)' : ''}`
      : `${a.active ?? '?'} connection${a.active === 1 ? '' : 's'} open`;
    $('accountText').textContent = `Account ${a.status} · expires ${a.expires ? `${a.expires.toLocaleDateString()} (${days} d)` : 'never'} · ${conns}`
      + ` · checked ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    el.classList.toggle('warn', !/^active$/i.test(a.status) || (days != null && days <= 7) || over);
    el.classList.remove('hidden');
  } catch { if (seq === accountSeq && !quiet) el.classList.add('hidden'); /* no account API on this panel */ } finally {
    if (seq === accountSeq) $('accountRefresh').classList.remove('spin');
  }
}
$('accountRefresh').onclick = () => showAccount(state.source, { quiet: true });
// The provider's count follows playback, so re-read it shortly after a stream starts (it can
// take a few seconds to register) and when you come back to the tab.
let accountTimer = 0;
video.addEventListener('playing', () => { clearTimeout(accountTimer); accountTimer = setTimeout(() => showAccount(state.source, { quiet: true }), 6000); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) showAccount(state.source, { quiet: true }); });

function setChannels(channels, label, source = null) {
  annotate(channels); // once per playlist; the result is saved with the cached copy
  state.source = source;
  guide.setSource({ xtream: source?.url ? parseXtream(source.url) : null, tvgUrl: source?.tvgUrl || channels.tvgUrl || null });
  guide.setChannels(channels);
  $('guideBtn').classList.toggle('hidden', !guide.available());
  syncMini();
  // With a guide, Live is the guide; the channel list stays in the drawer only for playlists without one.
  $('channelsTab').classList.toggle('hidden', guide.available());
  $('refreshList').classList.toggle('hidden', !source?.url);
  state.channels = channels;
  state.group = '';
  rebuildLibrary();
  showAccount(source);
  toast(`${label}: ${state.library.length.toLocaleString()} channels${state.library.length < channels.length ? ' after filter' : ''}`);
  // Jump to the list after loading from Sources, but not when a profile switch or sync
  // reloads the playlist while you're on another tab.
  if (document.querySelector('.tab.active')?.dataset.tab === 'sources') {
    if (guide.available()) togglePanel(false); else setTab('channels');
  }
  if (guide.available() && document.querySelector('.tab.active')?.dataset.tab === 'channels') setTab('sources');
}

const ago = (t) => {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

// fresh=false opens the saved copy when there is one (app start, saved-list clicks);
// fresh=true always downloads (Load button, ↻ refresh).
// If the page reloads mid-load (iPad Safari does that when a tab runs out of memory), the
// marker survives and the next start doesn't retry automatically: no reload loop.
async function loadPlaylistUrl(url, name, opts = {}) {
  store.set('loadingSince', { url, name, at: Date.now() });
  try { await loadPlaylistInner(url, name, opts); } finally { store.set('loadingSince', null); }
}

async function loadPlaylistInner(url, name, { fresh = true } = {}) {
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
  if (xt && await loadXtream(url, name, xt, key, fresh)) return;
  state.xlib = null;
  if (!fresh) {
    const cached = await cacheGet(key);
    // The TV has no ↻ button, so a saved copy there only counts while it's fresh.
    const stale = isTV && cached && Date.now() - cached.savedAt > TV_MAX_COPY_AGE;
    if (cached?.channels?.length && !stale) {
      setChannels(cached.channels, name, { url, name, savedAt: cached.savedAt, tvgUrl: cached.tvgUrl });
      setLast({ url, name });
      rememberPlaylist(name, url, false);
      setStatus(`Saved copy from ${ago(cached.savedAt)} · ↻ to update`);
      return;
    }
  }
  const statusBefore = loading.active ? '' : state.status;
  showLoading(`Connecting to ${name}…`);
  const plan = proxyPlan(url);
  const onProgress = ({ received = 0, total = 0, rate = 0, channels: channelsSoFar = 0 }) => {
    const size = total ? `${mb(received)} of ${mb(total)}` : mb(received);
    showLoading(`Downloading playlist · ${size}${rate ? ` · ${mb(rate)}/s` : ''}${channelsSoFar ? ` · ${channelsSoFar.toLocaleString()} channels` : ''}`, total ? received / total : null);
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
    setChannels(channels, name, { url, name, savedAt, tvgUrl: channels.tvgUrl });
    cachePut(key, { url, name, savedAt, channels, tvgUrl: channels.tvgUrl });
    setLast({ url, name });
    rememberPlaylist(name, url, fresh);
    hideLoading();
    setStatus(state.current && statusBefore ? statusBefore : 'Pick a channel to start');
  } catch (err) {
    hideLoading();
    const msg = `Couldn’t load playlist: ${err.message}`;
    setStatus(msg);
    toast(msg, true);
  }
}

// ---------- Xtream API ----------
// Returns true when handled (loaded, or failed with a message); false to fall back to get.php.
async function loadXtream(url, name, xt, key, fresh) {
  const lib = new XtreamLibrary(xt, fetchJsonSmart);
  if (!fresh) {
    const cached = await cacheGet(key);
    if (cached?.xtream && cached.channels && !(isTV && Date.now() - cached.savedAt > TV_MAX_COPY_AGE)) {
      Object.assign(lib, {
        cats: cached.xtream.cats,
        streamBase: cached.xtream.streamBase,
        liveLoaded: cached.xtream.liveLoaded === 'all' ? 'all' : new Set(cached.xtream.liveLoaded || []),
      });
      state.xlib = lib;
      setChannels(cached.channels, name, { url, name, savedAt: cached.savedAt });
      setLast({ url, name });
      rememberPlaylist(name, url, false);
      setStatus(`Saved copy from ${ago(cached.savedAt)} · ↻ to update`);
      ensureLiveCoverage();
      return true;
    }
  }
  const statusBefore = loading.active ? '' : state.status;
  showLoading(`Connecting to ${name}…`);
  try {
    await lib.init();
  } catch (err) {
    if (/refused the login/.test(err.message) || err.status === 401) {
      hideLoading();
      const msg = `Couldn’t load playlist: ${err.status === 401 ? 'The Xtream server refused the login. Check the username and password.' : err.message}`;
      setStatus(msg);
      toast(msg, true);
      return true;
    }
    return false; // no usable player_api: use the classic playlist
  }
  // An API that answers but lists nothing is broken or locked down; the playlist may still work.
  if (!lib.cats.live.length && !lib.cats.movie.length && !lib.cats.series.length) return false;
  try {
    state.xlib = lib;
    const cats = liveCategoriesWanted(lib);
    showLoading(cats ? `Loading live channels · 0 of ${cats.length} categories` : 'Downloading live channels…', cats ? 0 : null);
    const channels = await lib.live(cats, (p) => (p.phase === 'categories'
      ? showLoading(`Loading live channels · ${p.done} of ${p.total} categories`, p.done / p.total)
      : showLoading(`Downloading live channels · ${mb(p.received)}`, null)));
    const savedAt = Date.now();
    setChannels(channels, name, { url, name, savedAt });
    saveXtreamCache(key, url, name, savedAt);
    setLast({ url, name });
    rememberPlaylist(name, url, fresh);
    hideLoading();
    setStatus(state.current && statusBefore ? statusBefore : 'Pick a channel to start');
  } catch (err) {
    hideLoading();
    const msg = `Couldn’t load live channels: ${err.message}`;
    setStatus(msg);
    toast(msg, true);
  }
  return true;
}

function saveXtreamCache(key, url, name, savedAt = Date.now()) {
  const lib = state.xlib;
  cachePut(key, {
    url, name, savedAt, channels: state.channels,
    xtream: { cats: lib.cats, streamBase: lib.streamBase, liveLoaded: lib.liveLoaded === 'all' ? 'all' : [...lib.liveLoaded] },
  });
}

// Live categories the content filter keeps (null = everything, in one request).
function liveCategoriesWanted(lib) {
  const cf = settings.contentFilter;
  if (!cf.on) return null;
  const keep = makeFilter(cf);
  const ids = lib.cats.live.filter((c) => keep({ group: c.name, kind: 'live', url: '' })).map((c) => c.id);
  return ids.length ? ids : null;
}

// After the filter changes, fetch live categories that are now wanted but weren't loaded.
async function ensureLiveCoverage() {
  const lib = state.xlib;
  if (!lib || lib.liveLoaded === 'all') return;
  const wanted = liveCategoriesWanted(lib);
  const missing = wanted ? wanted.filter((id) => !lib.liveLoaded.has(id)) : null;
  if (missing && !missing.length) return;
  try {
    showLoading(missing ? `Loading ${missing.length} more categories…` : 'Downloading all live channels…');
    const more = await lib.live(missing, (p) => p.phase === 'categories' && showLoading(`Loading live channels · ${p.done} of ${p.total} categories`, p.done / p.total));
    const have = new Set(state.channels.map((c) => c.id));
    const merged = missing ? [...state.channels, ...more.filter((c) => !have.has(c.id))] : more;
    state.channels = merged;
    hideLoading();
    rebuildLibrary();
    if (state.source?.url) saveXtreamCache(playlistKey(state.source.url), state.source.url, state.source.name, state.source.savedAt);
  } catch (err) {
    hideLoading();
    toast(`Couldn’t load more channels: ${err.message}`, true);
  }
}

// Movies and series: categories first, a category's items when opened, a series' episodes
// when opened.
const isVodKind = () => state.xlib && (state.kind === 'movie' || state.kind === 'series');

function vodCategories(kind) {
  const cf = settings.contentFilter;
  const cats = state.xlib.cats[kind];
  if (!cf.on) return cats;
  const keep = makeFilter(cf);
  const kept = cats.filter((c) => keep({ group: c.name, kind: 'movie', url: '' }));
  return kept.length ? kept : cats;
}

async function showVod() {
  const lib = state.xlib;
  const kind = state.kind;
  const q = state.query.toLowerCase();
  state.listMode = 'items';
  if (state.seriesOpen) {
    state.filtered = state.seriesOpen.episodes.filter((e) => !q || e.name.toLowerCase().includes(q));
  } else if (!state.group) {
    if (q.length >= 2) {
      // Searching with no category open: look through every category.
      state.listMode = 'loading';
      state.filtered = [];
      renderList();
      let all = [];
      try { all = await allOfKind(kind); } catch (err) { toast(`Couldn’t search everything: ${err.message}`, true); }
      if (state.query.toLowerCase() !== q || state.kind !== kind || state.group || state.seriesOpen) return;
      state.listMode = 'items';
      state.filtered = all.filter((c) => (!state.favOnly || state.favs.has(c.id)) && c.name.toLowerCase().includes(q));
    } else {
      state.listMode = 'categories';
      state.vodCats = vodCategories(kind).filter((c) => !q || c.name.toLowerCase().includes(q));
      state.filtered = [];
    }
  } else {
    const catId = state.group;
    let items = lib.items[kind].get(catId);
    if (!items) {
      state.filtered = [];
      state.listMode = 'loading';
      renderList();
      try {
        showLoading(`Loading ${lib.catName(kind, catId)}…`);
        items = await lib.category(kind, catId, (p) => showLoading(`Loading ${lib.catName(kind, catId)} · ${mb(p.received)}`));
      } catch (err) {
        toast(`Couldn’t load category: ${err.message}`, true);
        items = [];
      } finally { hideLoading(); }
      if (state.group !== catId || state.kind !== kind) return; // moved on meanwhile
      state.listMode = 'items';
    }
    state.filtered = items.filter((c) => (!state.favOnly || state.favs.has(c.id)) && (!q || c.name.toLowerCase().includes(q)));
  }
  renderList();
  vrPanel?.draw();
}

async function openSeries(series) {
  try {
    showLoading(`Loading episodes of ${series.name}…`);
    const episodes = await state.xlib.seriesEpisodes(series);
    hideLoading();
    state.seriesOpen = { series, episodes };
    showVod();
  } catch (err) {
    hideLoading();
    toast(`Couldn’t load episodes: ${err.message}`, true);
  }
}

function loadBuiltinDemo() {
  state.xlib = null;
  setChannels(parseM3U(DEMO_M3U), 'Demo streams');
  setLast({ builtin: true });
}

// Saved playlists are unique per playlistKey, so re-adding an account replaces its entry.
const savedPlaylists = () => profiles.doc.playlists;

// `touch` is true when someone asked for this playlist (Load, a fresh download). Reopening what a profile
// already points at (startup, a sync, the TV's saved list) must not bump it or bring back one that was
// forgotten on another device: a newer timestamp would beat that device's deletion everywhere.
function rememberPlaylist(name, url, touch = true) {
  const key = playlistKey(url);
  if (!touch) return;
  const top = profiles.doc.playlists[0];
  if (top?.key === key && top.name === name && top.url === url) return; // nothing new to sync
  profiles.update((d) => {
    d.playlists = [{ key, name, url, at: Date.now() }, ...d.playlists.filter((p) => p.key !== key)].slice(0, 30);
    delete d.playlistsRemoved[key];
  });
  renderSaved();
}

function renderSaved() {
  const ul = $('savedList');
  ul.innerHTML = '';
  const saved = savedPlaylists();
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
      profiles.update((d) => {
        d.playlists = d.playlists.filter((x) => x.key !== key);
        d.playlistsRemoved[key] = Date.now();
        if (d.last?.url && playlistKey(d.last.url) === key) d.last = null;
      });
      cacheDelete(key);
      renderSaved();
    };
    li.append(span, del);
    ul.append(li);
  }
}

// ---------- Channel list ----------
const LIST_PAGE = 200; // rows added each time the end of the list scrolls into view
let listMore = null;

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
  // Local stations: with a home market set, other cities' ABC / CBS / NBC / FOX / PBS / CW… stations are hidden
  if (cf.market?.trim() && cf.localOnly !== false) {
    const kept = localFilter(lib, cf.market);
    if (kept.length < lib.length) {
      state.filterNote += ` · ${(lib.length - kept.length).toLocaleString()} other-city stations hidden`;
      lib = kept;
    }
  }
  if (cf.dedupe !== false) {
    const merged = dedupe(lib, (id) => state.favs.has(id));
    if (merged.length < lib.length) {
      state.filterNote += ` · ${(lib.length - merged.length).toLocaleString()} duplicates merged`;
      lib = merged;
    }
  }
  state.library = lib;
  $('cfToggle').classList.toggle('on', cf.on || !!cf.market?.trim());

  const xl = state.xlib;
  const hasVod = xl ? !!(xl.cats.movie.length || xl.cats.series.length) : lib.some((c) => kindOf(c) !== 'live');
  for (const k of ['', 'movie', 'series']) $('kindSeg').querySelector(`[data-kind="${k}"]`).classList.toggle('hidden', !hasVod);
  // With the Xtream API, movies and series are browsed separately, so there's no "All".
  if (xl) $('kindSeg').querySelector('[data-kind=""]').classList.add('hidden');
  if (!hasVod) state.kind = '';
  if (xl && !state.kind) state.kind = 'live';
  for (const b of $('kindSeg').children) b.classList.toggle('active', b.dataset.kind === state.kind);
  rebuildGroups();
  // First playlist of the visit: start on the guide (live TV) instead of an empty stage.
  if (!isTV && !guideShown && lib.length && !galleryKind() && guide.available() && !gallery.isOpen()) { guideShown = true; guideView.open(); }
}
let guideShown = false;

function rebuildGroups() {
  state.seriesOpen = null;
  $('browseBtn').classList.toggle('hidden', !galleryKind());
  if (isVodKind()) {
    const cats = vodCategories(state.kind);
    state.groups = cats.map((c) => c.name);
    if (!cats.some((c) => c.id === state.group)) state.group = '';
    const sel = $('groupFilter');
    sel.innerHTML = `<option value="">All ${state.kind === 'movie' ? 'movie' : 'series'} categories</option>`;
    for (const c of cats) sel.add(new Option(c.name, c.id));
    sel.value = state.group;
    applyFilter();
    return;
  }
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
  if (isVodKind()) return showVod();
  state.listMode = 'items';
  const q = state.query.toLowerCase();
  state.filtered = state.library.filter((c) =>
    (!state.kind || kindOf(c) === state.kind) &&
    (!state.group || c.group === state.group) &&
    (!state.favOnly || state.favs.has(c.id)) &&
    (!q || c.name.toLowerCase().includes(q) || c.group.toLowerCase().includes(q)));
  renderList();
  vrPanel?.draw();
}

// Rows on screen ask the guide for their programmes; others don't cost a request.
const rowEls = new Map(); // channel id → { li, ch }
const visibleRows = new Set();
const rowObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const id = e.target.dataset.id;
    if (e.isIntersecting) { visibleRows.add(id); updateRowEpg(id); } else visibleRows.delete(id);
  }
}, { root: null, rootMargin: '200px' });

function updateRowEpg(id) {
  const row = rowEls.get(id);
  if (!row) return;
  const nn = guide.nowNext(row.ch);
  const line = row.li.querySelector('.ch-group');
  const bar = row.li.querySelector('.ch-prog');
  if (nn?.now) {
    const { now: p } = nn;
    line.textContent = `${p.title}${nn.next ? `  ·  next ${fmtTime(nn.next.start)} ${nn.next.title}` : ''}`;
    line.title = p.desc || '';
    bar.classList.add('on');
    bar.firstElementChild.style.width = `${Math.round(((Date.now() - p.start) / (p.stop - p.start)) * 100)}%`;
  } else {
    line.textContent = row.ch.group + (row.ch.layout ? ` · 3D ${row.ch.layout.toUpperCase()}` : '');
    bar.classList.remove('on');
  }
}

const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function renderList() {
  const ul = $('channelList');
  rowObserver.disconnect();
  rowEls.clear();
  visibleRows.clear();
  ul.innerHTML = '';
  const frag = document.createDocumentFragment();
  const special = (text, sub, onClick, cls = '') => {
    const li = document.createElement('li');
    li.className = `special ${cls}`;
    li.innerHTML = '<div class="ch-text"><div class="ch-name"></div><div class="ch-group"></div></div><span class="chev">›</span>';
    li.querySelector('.ch-name').textContent = text;
    li.querySelector('.ch-group').textContent = sub;
    if (onClick) li.onclick = onClick; else li.querySelector('.chev').remove();
    frag.append(li);
  };
  if (state.listMode === 'categories') {
    for (const c of state.vodCats) {
      special(c.name, state.kind === 'movie' ? 'Movies' : 'Series', () => { state.group = c.id; $('groupFilter').value = c.id; applyFilter(); });
    }
    ul.append(frag);
    $('listInfo').textContent = `${state.vodCats.length} ${state.kind === 'movie' ? 'movie' : 'series'} categories${state.filterNote || ''}`;
    return;
  }
  if (state.listMode === 'loading') {
    special('Loading…', 'Fetching this category from your provider');
    ul.append(frag);
    $('listInfo').textContent = '';
    return;
  }
  if (state.seriesOpen) {
    special(`‹ ${state.seriesOpen.series.name}`, `${state.seriesOpen.episodes.length} episodes · back to series`, () => { state.seriesOpen = null; showVod(); }, 'back');
  }
  const makeRow = (ch) => {
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
    text.innerHTML = '<div class="ch-name"></div><div class="ch-group"></div><div class="ch-prog"><i></i></div>';
    text.firstChild.textContent = ch.name;
    text.children[1].textContent = ch.group + (ch.layout ? ` · 3D ${ch.layout.toUpperCase()}` : '');
    rowEls.set(ch.id, { li, ch });
    rowObserver.observe(li);
    const fav = document.createElement('button');
    fav.className = 'fav' + (state.favs.has(ch.id) ? ' on' : '');
    fav.textContent = '★';
    fav.title = 'Favorite';
    fav.onclick = (e) => { e.stopPropagation(); toggleFav(ch, fav); };
    li.append(num, img, text, fav);
    li.onclick = () => (kindOf(ch) === 'series' ? openSeries(ch) : play(ch));
    return li;
  };
  // Rows come a page at a time: a sentinel at the end asks for the next one.
  listMore?.disconnect();
  let shown = 0;
  const sentinel = document.createElement('li');
  sentinel.className = 'list-sentinel';
  const addPage = () => {
    const page = document.createDocumentFragment();
    for (const ch of state.filtered.slice(shown, shown + LIST_PAGE)) page.append(makeRow(ch));
    shown = Math.min(state.filtered.length, shown + LIST_PAGE);
    sentinel.before(page);
    if (shown >= state.filtered.length) listMore.disconnect();
  };
  listMore = new IntersectionObserver((e) => { if (e.some((x) => x.isIntersecting)) addPage(); }, { rootMargin: '600px' });
  frag.append(sentinel);
  ul.append(frag);
  addPage();
  if (shown < state.filtered.length) listMore.observe(sentinel);
  const n = state.filtered.length;
  const updated = state.source?.savedAt ? ` · updated ${ago(state.source.savedAt)}` : '';
  const noun = state.seriesOpen ? ['episode', 'episodes']
    : isVodKind() ? (state.kind === 'movie' ? ['movie', 'movies'] : ['series', 'series']) : ['channel', 'channels'];
  $('listInfo').textContent = `${n.toLocaleString()} ${noun[n === 1 ? 0 : 1]}` + (isVodKind() ? '' : updated + (state.filterNote || ''));
}

function toggleFav(ch, btn) {
  const on = !state.favs.has(ch.id);
  if (on) state.favs.add(ch.id); else state.favs.delete(ch.id);
  profiles.update((d) => {
    const now = Date.now();
    if (on) { d.favs[ch.id] = now; delete d.favsRemoved[ch.id]; } else { delete d.favs[ch.id]; d.favsRemoved[ch.id] = now; }
  });
  btn?.classList.toggle('on', state.favs.has(ch.id));
  if (state.favOnly) applyFilter();
}

function markPlaying() {
  for (const li of $('channelList').children) li.classList.toggle('playing', li.dataset.id === state.current?.id);
}

// ---------- Playback ----------
async function play(ch, { startAt = resumePoint(ch) } = {}) {
  $('extSheet').classList.add('hidden');
  saveProgress(true); // where the previous film got to
  state.current = ch;
  $('npName').textContent = ch.name;
  updateNowPlayingEpg();
  const logo = $('npLogo');
  logo.referrerPolicy = 'no-referrer';
  if (ch.logo) logo.src = ch.logo; else logo.removeAttribute('src');
  markPlaying();
  syncEpisodes(ch);
  theater.setVideoActive(false);
  theater.setPlaceholder(ch.name, 'Tuning…');
  // Channels tagged as native 3D switch the screen to that layout automatically.
  applyMode(ch.layout || settings.mode, false);
  vrPanel?.draw();
  const sources = streamCandidates(ch);
  if (!sources.length) {
    const msg = 'This http:// stream can’t play on an https:// page without a proxy. Set one under Settings → Playback → Proxy.';
    setStatus(msg); toast(msg, true);
    theater.setPlaceholder('Stream blocked', ch.name);
    return;
  }
  // Movies and episodes go straight to a player app when that's the chosen setting.
  if (settings.vodPlayer === 'external' && kindOf(ch) !== 'live') {
    setStatus('Playing in another app');
    theater.setPlaceholder(ch.name, 'Opened in a player app');
    offerExternal(ch);
    return;
  }
  if (castCtl.connected) return castCurrent(ch, startAt);
  if (startAt) toast(`Resuming at ${fmtDuration(startAt)}`);
  const ok = await player.load(sources, { startAt });
  if (ok && state.current === ch) {
    theater.setVideoActive(true);
    updateAspect();
    syncPlayButton();
  }
}

// ---------- Episode picker ----------
// Loads the episode list for the series that's playing (cached by XtreamLibrary) and shows
// the Episodes button; the menu lists one season at a time.
async function syncEpisodes(ch) {
  const isEp = ch?.kind === 'episode' && ch.seriesId && state.xlib;
  $('episodesBtn').classList.toggle('hidden', !isEp);
  $('prevCh').title = isEp ? 'Previous episode (PgUp)' : 'Previous channel (PgUp)';
  $('nextCh').title = isEp ? 'Next episode (PgDn)' : 'Next channel (PgDn)';
  if (!isEp) { state.episodes = null; $('epMenu').classList.add('hidden'); return; }
  if (state.episodes?.[0]?.seriesId === ch.seriesId) return renderEpMenu();
  try {
    state.episodes = await state.xlib.seriesEpisodes({ seriesId: ch.seriesId, name: ch.seriesName });
  } catch { state.episodes = null; }
  renderEpMenu();
}

function renderEpMenu(season = state.current?.season) {
  const eps = state.episodes || [];
  const cur = state.current;
  $('epTitle').textContent = cur?.seriesName || 'Episodes';
  const seasons = [...new Set(eps.map((e) => e.season))].sort((a, b) => a - b);
  if (!seasons.includes(season)) season = seasons[0];
  state.epSeason = season;
  $('epSeasons').innerHTML = '';
  for (const s of seasons) {
    const b = document.createElement('button');
    b.className = `chip${s === season ? ' on' : ''}`;
    b.textContent = `Season ${s}`;
    b.onclick = () => renderEpMenu(s);
    $('epSeasons').append(b);
  }
  const list = $('epList');
  list.innerHTML = '';
  for (const e of eps.filter((x) => x.season === season)) {
    const li = document.createElement('li');
    li.className = e.id === cur?.id ? 'playing' : '';
    const p = getProgress(e);
    li.innerHTML = `<span class="ep-num"></span><span class="ep-name"></span><span class="ep-meta muted small"></span>`;
    li.children[0].textContent = e.episode || '';
    li.children[1].textContent = e.title || e.name;
    li.children[2].textContent = [e.runtime, p?.d && p.t / p.d > 0.9 ? 'watched' : ''].filter(Boolean).join(' · ');
    li.onclick = () => { $('epMenu').classList.add('hidden'); play(e); };
    list.append(li);
  }
  list.querySelector('.playing')?.scrollIntoView({ block: 'nearest' });
}

$('episodesBtn').onclick = () => {
  const menu = $('epMenu');
  menu.classList.toggle('hidden');
  if (!menu.classList.contains('hidden')) renderEpMenu();
};
$('epClose').onclick = () => $('epMenu').classList.add('hidden');

// ---------- Chromecast ----------
// The proxy that Chromecasts fetch through: this site's own when it's https, else the hosted
// Worker (a Chromecast can't reach localhost, and its player refuses plain http).
const HOSTED = 'https://iptv.jodeit.workers.dev';
const castProxied = (u) => (location.protocol === 'https:' && proxy.available ? proxied(u) : `${HOSTED}/proxy?url=${encodeURIComponent(u)}`);

const castCtl = new Cast({ onChange: (s) => syncCast(s) });
let castWas = 'unavailable';
function syncCast(s) {
  $('castBtn').classList.toggle('hidden', s === 'unavailable');
  $('castBtn').classList.toggle('on', s === 'connected');
  $('castBtn').textContent = s === 'connected' ? `Casting · ${castCtl.deviceName}` : s === 'connecting' ? 'Connecting…' : 'Cast';
  if (s === 'connected' && castWas !== 'connected' && state.current) castCurrent(state.current, kindOf(state.current) === 'live' ? 0 : Math.floor(video.currentTime));
  // Back from the TV: carry on here from where it got to.
  if (castWas === 'connected' && s !== 'connected' && state.current) {
    const at = kindOf(state.current) === 'live' ? 0 : Math.floor(castCtl.lastPosition || 0);
    play(state.current, { startAt: at });
  }
  // Keep the TV's position, to resume here if the session ends from Chrome's own Cast menu.
  clearInterval(castTimer);
  if (s === 'connected') castTimer = setInterval(() => { castCtl.lastPosition = castCtl.position() || castCtl.lastPosition; }, 5000);
  castWas = s;
}
let castTimer = 0;

async function castCurrent(ch, startAt = 0) {
  player.destroy?.();
  video.pause();
  const live = kindOf(ch) === 'live';
  // HLS for channels (the Chromecast can't play a raw MPEG-TS stream); the file itself otherwise.
  const urls = streamCandidates(ch).map((s) => s.hint || s.src);
  const pick = (live && urls.find((u) => /\.m3u8(\?|$)/i.test(u))) || ch.url;
  if (/\.(mkv|avi)(\?|$)/i.test(pick)) toast('Chromecast may not play MKV files (especially with surround audio). If it fails, try Infuse or VLC.');
  theater.setPlaceholder(ch.name, `Playing on ${castCtl.deviceName}`);
  setStatus(`Casting to ${castCtl.deviceName}`);
  try {
    await castCtl.load({ url: castProxied(pick), title: ch.name, subtitle: ch.seriesName || ch.group || '', image: ch.logo || undefined, live, startAt });
  } catch (err) {
    toast(`The Chromecast couldn’t play this: ${err.message || err}`, true);
  }
}
$('castBtn').onclick = () => (castCtl.connected ? (castCtl.lastPosition = castCtl.position(), castCtl.stop()) : castCtl.pick().catch(() => {}));

function playDirect(url) {
  if (!url) return;
  play({ id: url, url, name: url.split('/').pop().split('?')[0] || url, group: 'Direct', logo: '', num: 0, layout: null });
}

function step(dir) {
  // In a series, ⏮/⏭ go to the previous/next episode (across seasons), not the channel list.
  const eps = state.current?.kind === 'episode' && state.episodes;
  if (eps?.length) {
    const i = eps.findIndex((e) => e.id === state.current.id);
    const next = eps[i + dir];
    if (next) play(next); else toast(dir > 0 ? 'That was the last episode' : 'This is the first episode');
    return;
  }
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
// AirPlay: switch to a stream the Apple TV can fetch on its own (see setAirPlay).
video.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', () => {
  const wireless = !!video.webkitCurrentPlaybackTargetIsWireless;
  setAirPlay(wireless);
  const ch = state.current;
  if (!wireless || !ch || player.lastEngine === 'native') return;
  if (/\.(mkv|avi)(\?|$)/i.test(ch.url)) {
    toast('Apple TV can’t play this file format over AirPlay. Open it in Infuse on the Apple TV instead.', true);
    return;
  }
  if (/^(localhost|127\.)/.test(location.hostname)) {
    toast('AirPlay needs the hosted site (iptv.jodeit.workers.dev): the Apple TV can’t reach this computer’s localhost proxy.', true);
  }
  play(ch, { startAt: kindOf(ch) === 'live' ? 0 : Math.floor(video.currentTime) });
});
video.addEventListener('timeupdate', () => saveProgress());
video.addEventListener('pause', () => saveProgress(true));
addEventListener('pagehide', () => saveProgress(true));
const fmtDuration = (s) => (s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}` : Math.floor(s / 60)) + `:${String(Math.floor(s % 60)).padStart(2, '0')}`;
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
}
$('panelToggle').onclick = () => togglePanel(false);
$('panelOpen').onclick = () => togglePanel();
// It's a drawer: clicking anywhere outside it closes it.
addEventListener('pointerdown', (e) => {
  if (!$('panel').classList.contains('collapsed') && !e.target.closest('#panel, #panelOpen, #profileChip, .toast')) togglePanel(false);
});
// The video can start after a channel switch already moved on, or while it's a thumbnail:
// whenever it's actually playing, nothing should cover it.
video.addEventListener('playing', () => { if (state.current) theater.setVideoActive(true); });

// Filtering tens of thousands of channels on every keystroke makes typing lag on a phone.
let searchTimer = 0;
$('search').oninput = (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.query = e.target.value; applyFilter(); }, state.library.length > 2000 ? 150 : 0);
};
$('groupFilter').onchange = (e) => { state.group = e.target.value; state.seriesOpen = null; applyFilter(); };
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
  if (text.length < 2_000_000) { store.set('localText', text); setLast({ local: file.name }); }
};
$('xtLoad').onclick = () => {
  let server = $('xtServer').value.trim();
  const user = $('xtUser').value.trim(), pass = $('xtPass').value;
  if (parseXtream(server)) return loadPlaylistUrl(server); // a full get.php link pasted into the server box
  if (!server || !user) return toast('Enter server and username', true);
  if (!/^https?:\/\//i.test(server)) server = `http://${server}`;
  loadPlaylistUrl(xtreamUrl(server, user, pass));
};
for (const b of $('kindSeg').children) {
  b.onclick = () => {
    state.kind = b.dataset.kind;
    for (const x of $('kindSeg').children) x.classList.toggle('active', x === b);
    rebuildGroups();
    if (galleryKind()) { guideView.close(); gallery.open(state.kind, state.group || undefined); } // movies and series open as posters
    else { gallery.close(); if (guide.available()) guideView.open(); else { togglePanel(true); setTab('channels'); } }
  };
}
// Picture-in-picture: the browser's own floating window, which stays on top of other apps.
// It's off in the video's overflow menu (disablePictureInPicture) and offered by a corner button.
async function popOut() {
  try {
    if (document.pictureInPictureElement) return await document.exitPictureInPicture();
    video.disablePictureInPicture = false;
    await video.requestPictureInPicture();
  } catch (err) {
    video.disablePictureInPicture = true;
    toast(`Can’t pop out here: ${err.message}`, true);
  }
}
// Re-hide it from the overflow menu once the pop-out closes (doing it earlier would close it).
video.addEventListener('leavepictureinpicture', () => { video.disablePictureInPicture = true; });
video.disablePictureInPicture = true;
for (const b of document.querySelectorAll('.pip-btn')) {
  b.classList.toggle('hidden', !document.pictureInPictureEnabled);
  b.onclick = (e) => { e.stopPropagation(); popOut(); };
}
$('guideOpen').onclick = () => { gallery.close(); guideView.open(); };
$('miniClose').onclick = () => { miniHidden = true; syncMini(); };
$('miniFull').onclick = () => { miniHidden = false; guideView.close(); gallery.close(); };
// Resize the pop-out from its bottom-left corner (it's anchored bottom-right).
$('miniGrip').onpointerdown = (e) => {
  e.preventDefault();
  const root = document.documentElement.style, sx = e.clientX;
  const w0 = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--mini-w')) || 360;
  const move = (m) => {
    const grow = sx - m.clientX;
    root.setProperty('--mini-w', `${Math.round(Math.max(200, Math.min(innerWidth - 40, w0 + grow)))}px`);
  };
  const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
  addEventListener('pointermove', move); addEventListener('pointerup', up);
};
// Drag the pop-out by its title bar.
$('miniBar').onpointerdown = (e) => {
  if (e.target.closest('button')) return;
  const root = document.documentElement.style, sx = e.clientX, sy = e.clientY;
  const r0 = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--mini-r')) || 24;
  const b0 = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--mini-b')) || 100;
  const move = (m) => {
    root.setProperty('--mini-r', `${Math.max(0, Math.min(innerWidth - 120, r0 - (m.clientX - sx)))}px`);
    root.setProperty('--mini-b', `${Math.max(0, Math.min(innerHeight - 120, b0 - (m.clientY - sy)))}px`);
  };
  const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
  addEventListener('pointermove', move); addEventListener('pointerup', up);
};
$('browseBtn').onclick = () => gallery.open(state.kind, state.group || undefined);

// OMDb key for ratings: checked with one lookup before it's saved to the profile.
$('omdbKey').value = profiles.doc.omdbKey || '';
$('omdbSave').onclick = () => busy($('omdbSave'), async () => {
  const key = $('omdbKey').value.trim();
  const status = $('omdbStatus');
  if (key) {
    status.textContent = 'Checking…';
    const problem = await ratings.test(key);
    if (problem) { status.textContent = `That key didn’t work: ${problem}`; return; }
  }
  profiles.update((d) => { d.omdbKey = key; });
  status.textContent = key ? 'Saved. Ratings appear in Browse as posters come into view.' : 'Removed.';
  if (gallery.isOpen()) gallery.render();
});
$('omdbKey').onkeydown = (e) => { if (e.key === 'Enter') $('omdbSave').click(); };

$('tmdbKey').value = profiles.doc.tmdbKey || '';
$('tmdbSave').onclick = () => busy($('tmdbSave'), async () => {
  const key = $('tmdbKey').value.trim();
  const status = $('tmdbStatus');
  if (key) {
    status.textContent = 'Checking…';
    const problem = await similar.test(key);
    if (problem) { status.textContent = `That key didn’t work: ${problem}`; return; }
  }
  profiles.update((d) => { d.tmdbKey = key; });
  status.textContent = key ? 'Saved. Preview pages now show “More like this”.' : 'Removed.';
});
$('tmdbKey').onkeydown = (e) => { if (e.key === 'Enter') $('tmdbSave').click(); };
$('cfToggle').onclick = () => { settings.contentFilter.on = !settings.contentFilter.on; saveFilter(); syncFilterForm(); rebuildLibrary(); };
const saveFilter = () => {
  saveSettings();
  profiles.update((d) => { d.contentFilter = { ...settings.contentFilter }; });
  ensureLiveCoverage();
};

function syncFilterForm() {
  const cf = settings.contentFilter;
  $('cfOn').checked = cf.on;
  $('cfLive').value = cf.live;
  $('cfVod').value = cf.vod;
  $('cfUntagged').checked = cf.vodUntagged;
  $('cfMarket').value = cf.market || '';
  $('cfLocalOnly').checked = cf.localOnly !== false;
  $('cfDedupe').checked = cf.dedupe !== false;
}
const readFilterForm = () => {
  Object.assign(settings.contentFilter, {
    on: $('cfOn').checked, live: $('cfLive').value, vod: $('cfVod').value, vodUntagged: $('cfUntagged').checked,
    market: $('cfMarket').value.trim(), localOnly: $('cfLocalOnly').checked, dedupe: $('cfDedupe').checked,
  });
  saveFilter();
  rebuildLibrary();
};
for (const id of ['cfOn', 'cfLive', 'cfVod', 'cfUntagged', 'cfMarket', 'cfLocalOnly', 'cfDedupe']) $(id).onchange = readFilterForm;
syncFilterForm();

// ---------- Profile tab ----------
const initial = (name) => (name || '?').trim().charAt(0).toUpperCase() || '?';
let pairTimer = 0;

function renderProfiles() {
  const active = profiles.active();
  const st = profiles.status;
  $('pfName').textContent = active?.name || 'This device only';
  $('chipName').textContent = active ? active.name : 'This device';
  for (const el of [$('pfAvatar'), $('chipAvatar')]) {
    el.textContent = active ? initial(active.name) : '·';
    el.classList.toggle('local', !active);
  }
  $('pfStatus').textContent = !active
    ? 'Not synced. Create a profile or link this device to sync.'
    : (st.state === 'synced' ? `Synced ${ago(st.at)}` : st.message || 'Synced') + ` · ${profiles.doc.playlists.length} playlist${profiles.doc.playlists.length === 1 ? '' : 's'} · #${active.id.slice(0, 4)} v${active.version}`;
  $('pfActions').classList.toggle('hidden', !active);
  $('pfDanger').classList.toggle('hidden', !active);
  if (active && document.activeElement !== $('pfRename')) $('pfRename').value = active.name;

  const ul = $('pfList');
  ul.innerHTML = '';
  for (const p of [null, ...profiles.list()]) {
    const li = document.createElement('li');
    const isActive = (p?.id ?? null) === (active?.id ?? null);
    li.classList.toggle('active', isActive);
    const av = document.createElement('span');
    av.className = `avatar${p ? '' : ' local'}`;
    av.textContent = p ? initial(p.name) : '·';
    const label = document.createElement('span');
    label.className = 'grow';
    label.textContent = p ? p.name : 'This device only (not synced)';
    li.append(av, label);
    li.onclick = () => {
      if (isActive) return;
      profiles.switchTo(p?.id ?? null);
      toast(`Switched to ${p ? p.name : 'this device only'}`);
    };
    ul.append(li);
  }
}

async function checkSyncAvailable() {
  const why = await profiles.available();
  $('pfUnavailable').textContent = why;
  $('pfUnavailable').classList.toggle('hidden', !why);
  for (const id of ['pfCreate', 'pfClaim', 'pfLink', 'pfSync']) $(id).disabled = !!why;
  return !why;
}

const busy = async (btn, fn) => {
  btn.disabled = true;
  try { await fn(); } catch (err) { toast(err.message, true); } finally { btn.disabled = false; }
};

$('profileChip').onclick = () => { togglePanel(true); setTab('profile'); };
$('pfCreate').onclick = () => busy($('pfCreate'), async () => {
  const name = $('pfNewName').value.trim();
  if (!name) return toast('Give the profile a name', true);
  await profiles.create(name, { copyCurrent: $('pfCopy').checked });
  $('pfNewName').value = '';
  toast(`Profile “${name}” created. Use Sync → “Link a device” to add it to your other devices.`);
});
$('pfNewName').onkeydown = (e) => { if (e.key === 'Enter') $('pfCreate').click(); };
$('pfClaim').onclick = () => busy($('pfClaim'), async () => {
  const code = $('pfClaimCode').value.trim();
  if (!code) return toast('Enter the code shown on your other device', true);
  const name = await profiles.claim(code);
  $('pfClaimCode').value = '';
  toast(`This device is now linked to “${name}”`);
});
$('pfClaimCode').onkeydown = (e) => { if (e.key === 'Enter') $('pfClaim').click(); };
$('pfSync').onclick = () => busy($('pfSync'), () => profiles.sync());
$('pfLink').onclick = () => busy($('pfLink'), async () => {
  const { code, expiresIn } = await profiles.pairingCode();
  $('pfCode').textContent = `${code.slice(0, 4)} ${code.slice(4)}`;
  $('pfCodeBox').classList.remove('hidden');
  const until = Date.now() + expiresIn * 1000;
  clearInterval(pairTimer);
  const tick = () => {
    const left = Math.max(0, Math.round((until - Date.now()) / 1000));
    $('pfCodeTimer').textContent = left ? `Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} · works once` : 'Expired';
    if (!left) { clearInterval(pairTimer); $('pfCodeBox').classList.add('hidden'); }
  };
  tick();
  pairTimer = setInterval(tick, 1000);
});
$('pfRenameBtn').onclick = () => { profiles.rename($('pfRename').value); toast('Renamed'); };
$('pfSignOut').onclick = () => {
  const p = profiles.active();
  if (p && confirm(`Remove “${p.name}” from this device? It stays on your other devices.`)) profiles.signOut(p.id);
};
$('pfDelete').onclick = () => busy($('pfDelete'), async () => {
  const p = profiles.active();
  if (!p || !confirm(`Delete “${p.name}” everywhere? Its playlists and favorites will be removed from all linked devices.`)) return;
  await profiles.destroy(p.id);
  toast(`Deleted “${p.name}”`);
});

// ---------- Linking a TV from this device ----------
// A TV that's open on the same network (same public IP) is listed here, so linking needs no typing.
let nearbyTvs = [];
let syncOk = false;
const tvDismissed = new Set();
const fmtCode = (c) => `${c.slice(0, 4)} ${c.slice(4)}`;

async function linkTv(code) {
  if (!profiles.active()) {
    const name = prompt('The TV will share a profile with this phone, so playlists you add here show up there. Name the profile:', 'Home')?.trim();
    if (!name) return;
    await profiles.create(name, { copyCurrent: true });
  }
  const name = await profiles.tvOffer(code);
  toast(`Sent “${name}” to the TV. Approve it on the TV screen.`);
  tvDismissed.add(code.toUpperCase().replace(/[^0-9A-Z]/g, ''));
  setTimeout(refreshTvs, 4000);
}

function renderTvs() {
  const ul = $('pfTvList');
  ul.innerHTML = '';
  for (const code of nearbyTvs) {
    const li = document.createElement('li');
    const av = document.createElement('span');
    av.className = 'avatar';
    av.textContent = '📺';
    const label = document.createElement('span');
    label.className = 'grow';
    label.textContent = `TV · ${fmtCode(code)}`;
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = 'Link';
    btn.onclick = () => busy(btn, () => linkTv(code));
    li.append(av, label, btn);
    ul.append(li);
  }
  $('pfTvNone').classList.toggle('hidden', !!nearbyTvs.length);
  const fresh = nearbyTvs.filter((c) => !tvDismissed.has(c));
  $('tvBanner').classList.toggle('hidden', !fresh.length);
  $('tvBanner').dataset.code = fresh[0] || '';
}

async function refreshTvs() {
  if (isTV || !syncOk) return;
  try { nearbyTvs = await profiles.tvNearby(); } catch { nearbyTvs = []; }
  renderTvs();
}
$('tvBannerLink').onclick = () => busy($('tvBannerLink'), () => linkTv($('tvBanner').dataset.code));
$('tvBannerX').onclick = () => { for (const c of nearbyTvs) tvDismissed.add(c); renderTvs(); };
$('pfTvLink').onclick = () => busy($('pfTvLink'), async () => {
  const code = $('pfTvCode').value.trim();
  if (!code) return toast('Enter the code shown on the TV', true);
  await linkTv(code);
  $('pfTvCode').value = '';
});
$('pfTvCode').onkeydown = (e) => { if (e.key === 'Enter') $('pfTvLink').click(); };
document.querySelector('.tab[data-tab="profile"]').addEventListener('click', refreshTvs);
addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshTvs(); });

$('guideBtn').onclick = () => guideView.open();

for (const b of $('displaySeg').children) {
  b.classList.toggle('active', b.dataset.display === (settings.display || 'auto'));
  b.onclick = () => {
    if (b.dataset.display === settings.display) return;
    settings.display = b.dataset.display;
    saveSettings();
    location.reload();
  };
}
for (const b of $('vodSeg').children) {
  b.classList.toggle('active', b.dataset.vod === settings.vodPlayer);
  b.onclick = () => {
    settings.vodPlayer = b.dataset.vod;
    saveSettings();
    for (const x of $('vodSeg').children) x.classList.toggle('active', x === b);
  };
}
for (const b of $('hlsSeg').children) {
  b.classList.toggle('active', b.dataset.hls === (settings.hlsEngine || 'auto'));
  b.onclick = () => {
    settings.hlsEngine = b.dataset.hls;
    saveSettings();
    setHlsPreference(settings.hlsEngine);
    for (const x of $('hlsSeg').children) x.classList.toggle('active', x === b);
    toast('Applies from the next channel you open');
  };
}
for (const b of $('bufferSeg').children) {
  b.classList.toggle('active', b.dataset.buffer === (settings.buffer || 'normal'));
  b.onclick = () => {
    settings.buffer = b.dataset.buffer;
    saveSettings();
    setBufferLevel(settings.buffer);
    for (const x of $('bufferSeg').children) x.classList.toggle('active', x === b);
    toast('Applies from the next channel or movie you open');
  };
}
$('displayNote').textContent = flat
  ? 'This device is using the flat player (no VR here). Choose “3D theater” for the 3D view.'
  : 'This device is using the 3D theater. “Flat player” is lighter on phones and tablets.';

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

let foundSources = [];
$('findSources').onclick = () => busy($('findSources'), async () => {
  const status = $('sourceFinderStatus');
  const select = $('foundSource');
  const load = $('loadFoundSource');
  status.textContent = 'Checking recent Reddit posts…';
  select.replaceChildren(new Option('Searching…', ''));
  select.disabled = true;
  load.disabled = true;
  try {
    const result = await findLatestSources(smartFetch);
    foundSources = result.sources;
    select.replaceChildren(...foundSources.map((source, index) => new Option(source.name, String(index))));
    select.disabled = false;
    load.disabled = false;
    status.textContent = `${foundSources.length} sources found in “${result.title}”.`;
  } catch (err) {
    foundSources = [];
    select.replaceChildren(new Option('No sources found', ''));
    status.textContent = err.message;
  }
});
$('loadFoundSource').onclick = () => {
  const source = foundSources[+$('foundSource').value];
  if (source) loadPlaylistUrl(source.url, source.name);
};

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
  if (k === 'b' || k === 'B') { if (gallery.isOpen()) gallery.close(); else if (galleryKind()) gallery.open(state.kind); return; }
  if (gallery.isOpen()) return; // its own buttons take the keys
  if (k === ' ') { e.preventDefault(); togglePlay(); }
  else if (k === 'PageDown' || k === 'ArrowDown') { e.preventDefault(); step(1); }
  else if (k === 'PageUp' || k === 'ArrowUp') { e.preventDefault(); step(-1); }
  else if (k === 'm' || k === 'M') $('mute').click();
  else if ((k === 'e' || k === 'E') && !$('episodesBtn').classList.contains('hidden')) $('episodesBtn').click();
  else if ((k === 'g' || k === 'G') && guide.available()) (guideView.isOpen() ? guideView.close() : guideView.open());
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
if (!flat) TheaterModule.Theater.support().then(({ vr, ar }) => {
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

if (!flat) vrPanel = new (await import('./vr-panel.js')).VRPanel(theater, {
  channels: () => state.filtered,
  current: () => state.current,
  status: () => state.panelStatus ?? state.status,
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
renderProfiles();
$('appVersion').textContent = VERSION;
checkSyncAvailable().then((ok) => { if (ok && profiles.store) $('appVersion').textContent = `${VERSION} · sync storage: ${profiles.store === 'durable' ? 'durable object' : 'KV (fallback)'}`; syncOk = ok; if (ok) { profiles.pull(); refreshTvs(); } });
// server.js and the Cloudflare deployment include a demo Xtream panel (proxy/xtream-demo.js).
if (proxy.available && !settings.proxyUrl) {
  const b = document.createElement('button');
  b.className = 'chip';
  b.textContent = 'Xtream demo';
  b.title = 'Built-in test panel: get.php?username=demo&password=demo';
  b.onclick = () => loadPlaylistUrl(new URL('get.php?username=demo&password=demo&type=m3u_plus', location.href).href, 'Xtream demo');
  $('presets').prepend(b);
}
const last = profiles.doc.last;
const interrupted = store.get('loadingSince', null);
if (interrupted && Date.now() - interrupted.at < 10 * 60 * 1000) {
  // The last load never finished: the page was reloaded under it, most likely out of memory.
  store.set('loadingSince', null);
  setChannels([], interrupted.name || 'Playlist', { url: interrupted.url, name: interrupted.name });
  const msg = `Loading “${interrupted.name || 'the playlist'}” didn’t finish last time; the page reloaded, probably out of memory. Tap ↻ to try again.`;
  setStatus(msg);
  toast(msg, true);
} else if (last?.url) loadPlaylistUrl(last.url, last.name, { fresh: false });
else if (last?.local && store.get('localText', null)) setChannels(parseM3U(store.get('localText', '')), last.local);
else loadBuiltinDemo();

// Debug handle for the console.
window.o3xr = {
  theater, vrPanel, state, settings, profiles, gallery, ratings, similar, loadPlaylist: loadPlaylistUrl,
  // What js/tv.js needs to drive the app without its phone-style chrome.
  tv: {
    video,
    play: (ch) => (kindOf(ch) === 'series' ? openSeries(ch) : play(ch)),
    togglePlay,
    toast,
    guide,
    isFav: (id) => state.favs.has(id),
    toggleFav: (ch) => toggleFav(ch),
    live: () => state.library.filter((c) => kindOf(c) === 'live'),
    hasKind: (k) => !!state.xlib || state.library.some((c) => kindOf(c) === k),
    openGallery(kind) { state.kind = kind; rebuildGroups(); guideView.close(); gallery.open(kind); },
    galleryOpen: () => gallery.isOpen(),
    source: () => state.source,
    forgetCopies: () => Promise.all(profiles.doc.playlists.map((p) => cacheDelete(playlistKey(p.url)))),
  },
};
if (isTV) video.controls = false; // no system player bar over the picture; js/tv.js draws a small overlay
dispatchEvent(new Event('o3xr-ready'));
