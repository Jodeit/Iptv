// The TV interface. Only active inside the Android TV app, whose WebView adds "TunerTV" to the
// user agent; everywhere else this file does nothing. The phone UI's chrome (top bar, drawer,
// guide, pop-out player) is hidden there and replaced by three things:
//
//   Player   the video, full screen, nothing on top. Up opens playback controls.
//   Home     one screen on the left, video still playing on the right: tabs Live | Movies | Shows |
//            Settings; Live toggles between On Now and the provider's channel list.
//   Setup    shown when no profile/playlist: a phone on the same Wi-Fi sends its profile (js/profiles.js).
//
// Remote:  Player: Up opens controls (then Guide on live TV), OK toggles playback, ◀▶ skip 10 s on VOD.
//          On live TV, ◀ opens the guide and ▼ browses the playing channel's folder.
//          Home: arrows move, OK plays, hold OK = favorite, Back returns to the picture.
//          Back on the picture leaves the app.

import { kindOf } from './filter.js';
import { genreOf, GENRES } from './genre.js';
import * as sports from './sports.js';
import { VERSION } from './version.js';
import { logEvent } from './telemetry.js';
import { createSearchIndex, normalizeSearchText } from './search.js';
import { TV_WALLS, TV_WALL_DEFAULT, hexToHsl, hslToHex } from './tv-wall.js';

if (/TunerTV/.test(navigator.userAgent) || window.__tunerWeb) initTV();

function initTV() {
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const O = () => window.o3xr;
  const P = () => O().profiles;
  const T = () => O().tv;
  const host = location.host;
  const fmtClock = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const fmtDur = (s) => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return `${h ? h + ':' : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(s % 60).padStart(2, '0')}`; };
  const html = document.documentElement;
  const WEB = !!window.__tunerWeb; // Tuner view in a browser (iPhone, iPad): touch instead of a remote
  let nativeAppleControls = false;
  html.classList.add('tv');
  // index.html already set tv + tv-booting before first paint (a splash, so the phone UI never flashes). Lift
  // it once there is something to show: the setup screen, Home, or a picture.
  const ready = () => html.classList.remove('tv-booting');
  setTimeout(ready, 8000);

  // ---------- DOM ----------
  const osd = el('div', 'tv-osd hidden');
  osd.id = 'tvOsd';
  osd.innerHTML = '<img class="osd-logo" alt=""><div class="osd-main"><div class="osd-name"></div><div class="osd-sub"></div><div class="osd-bar"><u></u></div></div><div class="osd-hint"></div>';
  const home = el('div', 'tv-home hidden');
  home.id = 'tvHome';
  home.innerHTML = '<div class="tvh-panel"><div class="tvh-tabs"></div><div class="tvh-main"><div class="tvh-chips"></div><div class="tvh-body"></div></div><div class="tvh-info hidden"></div></div>';
  const setup = el('div', 'tv-setup hidden');
  setup.id = 'tvSetup';
  setup.innerHTML = '<div class="tvs-card"><div id="tvsBody"></div><div class="tvs-actions"><button id="tvsSkip" class="btn ghost">Skip for now</button></div><div class="tvs-ver">Tuner ' + VERSION + '</div></div>';
  const detail = el('div', 'tv-detail hidden');
  detail.id = 'tvDetail';
  const controls = el('div', 'tv-controls hidden');
  controls.id = 'tvControls';
  document.body.append(osd, home, setup, detail, controls);
  const tabsEl = home.querySelector('.tvh-tabs'), chipsEl = home.querySelector('.tvh-chips'), bodyEl = home.querySelector('.tvh-body'), infoEl = home.querySelector('.tvh-info');

  // ---------- State ----------
  let tab = 'live';            // 'live' | 'phone' | 'vod' (Movies and Shows)
  let group = '';              // '' = all, FAV = favorites, else a group name
  const FAV = '\u0000fav';
  let searchQuery = '', searchSubmitted = false, searchPending = [], searchErrors = [], searchProgress = '';
  let searchResults = [], searchRestoreI = null, searchRun = 0, searchCatalogSig = '';
  let searchPools = new Map(), searchLoads = new Map(), searchRowsEl = null, searchInputTimer = 0;
  const emptySearchPool = [];
  let searchIndex = null, searchIndexSignature = '', searchIndexMoviePool = null, searchIndexSeriesPool = null;
  let searchIndexMovieCategories = '', searchIndexSeriesCategories = '';
  const searchSignature = () => String(T().searchRevision?.() ?? T().source()?.url ?? '');
  function resetSearchCatalogs() {
    const sig = searchSignature();
    if (sig === searchCatalogSig) return;
    searchCatalogSig = sig;
    searchPools = new Map();
    searchLoads = new Map();
    searchIndex = null;
  }
  function searchPool(kind, onProgress) {
    resetSearchCatalogs();
    if (searchPools.has(kind)) return Promise.resolve(searchPools.get(kind));
    if (searchLoads.has(kind)) return searchLoads.get(kind);
    const request = T().searchAll(kind, onProgress).then((items) => {
      if (searchSignature() === searchCatalogSig) searchPools.set(kind, items || []);
      return items || [];
    }).finally(() => {
      if (searchLoads.get(kind) === request) searchLoads.delete(kind);
    });
    searchLoads.set(kind, request);
    return request;
  }
  function matchingSearchResults(query) {
    if (!normalizeSearchText(query)) return [];
    const moviePool = searchPools.get('movie') || emptySearchPool;
    const seriesPool = searchPools.get('series') || emptySearchPool;
    const movieSelection = vodCategorySelection('movie');
    const seriesSelection = vodCategorySelection('series');
    const movieCategorySignature = movieSelection.categories.map(({ c }) => String(c.id)).join('\u0000');
    const seriesCategorySignature = seriesSelection.categories.map(({ c }) => String(c.id)).join('\u0000');
    let indexBuildMs = 0;
    if (!searchIndex || searchIndexSignature !== searchCatalogSig || searchIndexMoviePool !== moviePool || searchIndexSeriesPool !== seriesPool ||
      searchIndexMovieCategories !== movieCategorySignature || searchIndexSeriesCategories !== seriesCategorySignature) {
      const started = performance.now();
      const movieCategoryIds = new Set(movieSelection.categories.map(({ c }) => String(c.id)));
      const seriesCategoryIds = new Set(seriesSelection.categories.map(({ c }) => String(c.id)));
      const visibleMovies = moviePool.filter((item) => movieCategoryIds.has(String(item.catId ?? item.group)));
      const visibleSeries = seriesPool.filter((item) => seriesCategoryIds.has(String(item.catId ?? item.group)));
      searchIndex = createSearchIndex([...liveAll(), ...visibleMovies, ...visibleSeries], {
        titleOf: (item) => kindOf(item) === 'live' ? (item.clean || cleanName(item.name)) : (T().vod.title(item).title || item.name),
        fieldsOf: (item) => [item.name, item.group, item.genre, item.cast, item.director, item.year],
        dynamicFieldsOf: (item) => {
          if (kindOf(item) !== 'live') return [];
          const nn = T().guide.peek(item);
          return [nn?.now?.title, nn?.next?.title];
        },
      });
      indexBuildMs = Math.round(performance.now() - started);
      searchIndexSignature = searchCatalogSig;
      searchIndexMoviePool = moviePool;
      searchIndexSeriesPool = seriesPool;
      searchIndexMovieCategories = movieCategorySignature;
      searchIndexSeriesCategories = seriesCategorySignature;
    }
    const started = performance.now();
    searchResults = searchIndex.search(query).map(({ item }) => item);
    const durationMs = Math.round(performance.now() - started);
    if (durationMs + indexBuildMs >= 150) {
      logEvent('perf', 'TV search filter', {
        durationMs,
        indexBuildMs,
        catalogSize: searchIndex.size,
        resultCount: searchResults.length,
        queryLength: String(query).length,
      }, { dedupe: false });
    }
    return searchResults;
  }
  // The Live tab toggles between provider channels and what's airing now (Sports, Movies, News…).
  // Remembered once you pick a view; until then On Now is the default when the provider has a guide.
  let viewChosen = false;
  let view = (() => { try { const v = localStorage.getItem('tvView'); if (v === 'now' || v === 'channels') { viewChosen = true; return v; } } catch { /* fine */ } return 'now'; })();
  const autoView = () => { if (!viewChosen) view = T().guide.available() ? 'now' : 'channels'; };
  let genre = '';              // '' = everything on now
  let dismissed = false, running = false, abort = null, liveCode = null;
  const isOpen = { home: () => !home.classList.contains('hidden'), setup: () => !setup.classList.contains('hidden'), settings: () => html.classList.contains('settings-open'), gallery: () => !!O()?.tv.galleryOpen(), detail: () => !detail.classList.contains('hidden'), controls: () => !controls.classList.contains('hidden') };
  const screen = () => (isOpen.setup() ? 'setup' : isOpen.settings() ? 'settings' : isOpen.detail() ? 'detail' : isOpen.controls() ? 'controls' : isOpen.gallery() ? 'gallery' : isOpen.home() ? 'home' : 'player');
  const isVod = () => { const c = O()?.state.current; return !!c && kindOf(c) !== 'live'; };

  // ---------- Channel list helpers ----------
  // Providers pad names with '######' banners and the like; show them tidied, keep the real name for playback.
  const cleanName = (n) => String(n || '').replace(/^[#*=\-_\s]+|[#*=\-_\s]+$/g, '').replace(/\s{2,}/g, ' ') || String(n || '');
  const liveAll = () => T().live();
  const groups = () => [...new Set(liveAll().map((c) => c.group).filter(Boolean))];
  const visibleList = () => {
    if (view === 'now') {
      computeNow();
      if (genre === SCORES) return [...scoreData.map((x) => x.ch), dayBtn]; // the last tile asks for tomorrow
      return nowData.filter((x) => !genre || x.genre === genre).map((x) => x.ch);
    }
    const all = liveAll();
    if (group === FAV) return all.filter((c) => T().isFav(c.id));
    return group ? all.filter((c) => c.group === group) : all;
  };
  // ---------- What's on now ----------
  // Every live channel that has a current programme, tagged with its kind. Rebuilt on demand and every few
  // seconds while the guide is still arriving; classification is a handful of regexes per channel.
  let nowData = [], nowMap = new Map(), nowAt = 0;
  function computeNow(force = false) {
    if (!force && Date.now() - nowAt < 2500) return;
    nowAt = Date.now();
    const g = T().guide, t = nowAt, out = [];
    for (const ch of liveAll()) {
      const nn = g.peek(ch, t);
      if (!nn?.now) continue;
      const genre = genreOf(nn.now, ch).genre;
      const x = { ch, p: nn.now, nx: nn.next, genre };
      if (genre === 'Sports') { sports.want(sports.leagueOf(nn.now)); x.sp = sports.match(ch, nn.now); }
      out.push(x);
    }
    nowData = out;
    nowMap = new Map(out.map((x) => [x.ch, x]));
    // Scoreboard: one entry per game, on the channel of yours that carries it (live, later today, finished, and
    // tomorrow's once asked for). The entry is a copy of the channel (so the tile can say which game it is);
    // playing it plays the real channel.
    const best = new Map();
    for (const ch of liveAll()) {
      for (const g of sports.gamesFor(ch)) {
        if (g.when === 'tomorrow' && !showTomorrow) continue;
        // The same game can be on two of your channels ("ESPN" and "ESPN 1"): keep one, preferring the numbered feed
        const rank = /\b1$/.test(ch.clean || cleanName(ch.name)) ? 2 : 1;
        const had = best.get(g.key);
        if (!had || rank > had.rank) best.set(g.key, { ch, g, rank });
      }
    }
    const order = { live: 0, later: 1, final: 2, tomorrow: 3 };
    scoreData = [...best.values()].map(({ ch, g }) => ({
      g,
      ch: Object.create(ch, { _game: { value: g }, _real: { value: ch }, _gkey: { value: `${ch.id}|${g.key}` }, _sect: { value: '', writable: true } }),
    }));
    scoreData.sort((a, b) => a.g.sport.localeCompare(b.g.sport) || order[a.g.when] - order[b.g.when] || (a.g.when === 'final' ? b.g.start - a.g.start : a.g.start - b.g.start));
    scoreData.forEach((x, k) => { x.ch._sect = k === 0 || scoreData[k - 1].g.sport !== x.g.sport ? x.g.sport : ''; });
  }
  let scoreData = [], scoreSig = '', showTomorrow = false;
  const dayBtn = { _day: true, id: '__day', name: '' };
  const SCORES = '__scores';
  // A scoreboard arrived: swap "College Football" for the game in the rows already on screen
  sports.onChange(() => {
    if (view !== 'now' || !isOpen.home()) return;
    computeNow(true);
    if (scoreView()) { // scores changed: redraw the tiles, keeping your place
      const sig = scoreData.map((x) => x.ch._gkey + x.g.status).join('|');
      if (sig === scoreSig) return;
      scoreSig = sig;
      const at = document.activeElement?.closest?.('.tvh-row')?.dataset.i;
      if (!chipsEl.contains(document.activeElement)) renderChips();
      renderBody(false);
      if (at !== undefined) bodyEl.querySelector(`.tvh-row[data-i="${at}"]`)?.focus();
      return;
    }
    for (const row of bodyEl.querySelectorAll('.tvh-row')) {
      const ch = listCache[+row.dataset.i], it = ch && nowMap.get(ch);
      if (!it) continue;
      if (!row.classList.contains('game')) row.querySelector('b').textContent = titleOf(it);
      paintRow(row, ch);
    }
    const f = document.activeElement?.closest?.('.tvh-row');
    if (f) paintInfo(listCache[+f.dataset.i]);
  });
  const onRatingArrived = (item) => {
    if (isOpen.detail() && dItem && (!item || item.id === dItem.id)) paintDetail();
    if (tab === 'vod' && isOpen.home()) {
      for (const row of bodyEl.querySelectorAll('.tvh-row.vod')) { const it = listCache[+row.dataset.i]; if (it && (!item || it.id === item.id)) fillVod(row, it); }
      return;
    }
    if (!posterView() || !isOpen.home()) return;
    for (const row of bodyEl.querySelectorAll('.tvh-row.movie')) paintRow(row, listCache[+row.dataset.i]);
  };
  setInterval(() => { if (view === 'now' && isOpen.home()) for (const x of nowData) if (x.genre === 'Sports') sports.want(sports.leagueOf(x.p)); }, 60000);
  const nowCounts = () => { const m = new Map(); for (const x of nowData) m.set(x.genre, (m.get(x.genre) || 0) + 1); return m; };
  // One big request for the whole lineup when the provider offers it, else a slow background crawl.
  function ensureGuide() {
    const g = T().guide;
    if (!g.available()) return;
    if (g.source?.xtream) g.loadBulk(liveAll());
    else if (liveAll()[0]) g.nowNext(liveAll()[0]); // XMLTV playlists: starts the file download
  }
  function guideStatus() {
    const g = T().guide, n = nowData.length, total = liveAll().length, pr = g.progress();
    if (!g.available()) return 'This provider has no programme guide.';
    if (pr.state === 'loading') return 'Reading the guide…';
    if (pr.state === 'crawling') return `Reading the guide… ${Math.round((pr.done / Math.max(1, pr.total)) * 100)}%`;
    return n ? `${n.toLocaleString()} of ${total.toLocaleString()} channels have guide data` : 'No guide data yet.';
  }

  function surf(dir) {
    const list = visibleList();
    if (!list.length) return;
    const i = list.indexOf(O().state.current);
    T().play(list[(i + dir + list.length) % list.length]);
  }

  // ---------- Player overlay ----------
  let osdTimer = 0, osdTick = 0;
  // "EN - Stick - S02E03 - Chip Off the Old Butch" → { title: "Stick", sub: "S02E03 · Chip Off the Old Butch" }
  const stripLang = (n) => String(n || '').replace(/^\s*[A-Za-z]{2,3}\s*[-:|]\s+/, '').trim();
  // An episode's own title for the list: "EN - Stick - S02E03 - Chip Off the Old Butch" → "Chip Off the Old Butch"
  // (the show and the number are already on the page)
  function epTitle(ep, show) {
    let n = stripLang(ep.title || ep.name);
    n = n.replace(/^(?:.*?[-–:|]\s*)?S\d+\s*E\d+\s*[-–:|]?\s*/i, ''); // everything up to and including S02E03
    const s = stripLang(show || '');
    if (s && n.toLowerCase().startsWith(s.toLowerCase())) n = n.slice(s.length).replace(/^[\s\-–:|]+/, '');
    return n || (ep.episode ? `Episode ${ep.episode}` : stripLang(ep.name));
  }
  function playLabels(c) {
    if (kindOf(c) === 'live') return { title: c.clean || cleanName(c.name), sub: '' };
    let name = stripLang(c.title || c.name), series = c.seriesName ? stripLang(c.seriesName) : '';
    if (series && name.toLowerCase().startsWith(series.toLowerCase())) name = name.slice(series.length).replace(/^[\s\-–:|]+/, '');
    else { const m = name.match(/^(.*?)\s*[-–]\s*(S\d+E\d+\b.*)$/i); if (m) { series = series || m[1]; name = m[2]; } }
    name = name.replace(/^(S\d+E\d+)\s*[-–:]\s*/i, (x, id) => `${id.toUpperCase()} · `);
    return series ? { title: series, sub: name } : { title: T().vod.title(c).title || stripLang(c.name), sub: '' };
  }
  function paintOsd() {
    const o = O(), c = o.state.current;
    if (!c) return;
    const v = T().video, live = kindOf(c) === 'live';
    const logo = osd.querySelector('.osd-logo');
    if (c.logo) { logo.referrerPolicy = 'no-referrer'; if (logo.getAttribute('src') !== c.logo) logo.src = c.logo; } else logo.removeAttribute('src');
    const lab = playLabels(c);
    osd.querySelector('.osd-name').textContent = lab.title;
    let sub = c.group || '', pct = null;
    if (live) {
      const nn = T().guide.nowNext(c);
      if (nn?.now) {
        sub = `${nn.now.title}  ·  until ${fmtClock(nn.now.stop)}${nn.next ? `  ·  next ${nn.next.title}` : ''}`;
        pct = ((Date.now() - nn.now.start) / (nn.now.stop - nn.now.start)) * 100;
      }
    } else if (Number.isFinite(v.duration) && v.duration > 0) {
      sub = `${lab.sub ? `${lab.sub}  ·  ` : ''}${v.paused ? '⏸ ' : ''}${fmtDur(v.currentTime)} / ${fmtDur(v.duration)}`;
      pct = (v.currentTime / v.duration) * 100;
    }
    osd.querySelector('.osd-sub').textContent = sub;
    const bar = osd.querySelector('.osd-bar');
    bar.classList.toggle('on', pct != null);
    if (pct != null) bar.firstElementChild.style.width = `${Math.min(100, Math.max(0, pct))}%`;
    osd.querySelector('.osd-hint').textContent = updateReady ? 'Update ready: installs when you pause or leave' : live ? '▲▼ browse     ◀ guide     OK controls' : '◀ ▶ skip     OK controls';
  }
  function showOsd(ms = 4500) {
    if (!O()?.state.current || screen() !== 'player') return;
    paintOsd();
    osd.classList.remove('hidden');
    clearTimeout(osdTimer);
    clearInterval(osdTick);
    osdTick = setInterval(paintOsd, 1000);
    osdTimer = setTimeout(hideOsd, ms);
  }
  function hideOsd() { osd.classList.add('hidden'); clearInterval(osdTick); }
  // A different channel started: say what it is.
  let lastShown = null;
  setInterval(() => {
    const c = O()?.state.current;
    if (c && c !== lastShown) { lastShown = c; ready(); showOsd(); }
  }, 400);

  // Whether a picture is on screen: with one, Home is frosted glass over it; without, it sits on a wall-coloured backdrop.
  setInterval(() => {
    const v = T()?.video;
    html.classList.toggle('tv-picture', !!v && !!O().state.current && v.readyState >= 2 && !v.ended && v.videoWidth > 0);
  }, 700);

  // ---------- Background colour ----------
  // The profile's tvWall (set on the phone) tints the plaster and the glass; the splash uses the saved copy so it matches
  // from the first frame. Hi / lo are lighter and darker steps of it, the glass is mostly white with a touch of it.
  const hexRgb = (h) => { const m = /^#?([0-9a-f]{6})$/i.exec(h || ''); return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : null; };
  const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
  const hex = (c) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  let wallSeen;
  function applyWall(h) {
    const root = document.documentElement.style;
    const c = hexRgb(h);
    const names = ['--tv-wall', '--tv-wall-hi', '--tv-wall-lo', '--tv-glass'];
    if (!c) { for (const n of names) root.removeProperty(n); try { localStorage.removeItem('tvWallVars'); } catch { /* fine */ } return; }
    const vars = { '--tv-wall': hex(c), '--tv-wall-hi': hex(mix(c, [255, 255, 255], 0.45)), '--tv-wall-lo': hex(mix(c, [0, 0, 0], 0.1)), '--tv-glass': mix(c, [255, 255, 255], 0.65).join(', ') };
    for (const [k, v] of Object.entries(vars)) root.setProperty(k, v);
    try { localStorage.setItem('tvWallVars', JSON.stringify(vars)); } catch { /* fine */ }
  }
  setInterval(() => {
    const w = P()?.doc?.tvWall || '';
    if (w !== wallSeen) { wallSeen = w; applyWall(w); }
  }, 1000);

  // ---------- Updates ----------
  // The app stays open in the background, so a deploy would otherwise wait until someone closed it. Once a
  // minute (and whenever the app comes back to the screen) the deployed files are compared with the ones this
  // page started with. A change installs by reloading the page, but never under a playing picture: right
  // away on coming back to the app or on the setup screen, otherwise once the TV has sat idle on Home or a
  // paused picture. While watching, a small "Update ready" note is all you get.
  const WATCH = ['index.html', 'css/style.css', 'js/main.js', 'js/tv.js', 'js/profiles.js', 'js/version.js', 'js/filter.js'];
  const TUNE = window.__TV_TEST || {}; // tests shorten these
  const POLL_MS = TUNE.pollMs || 60 * 1000, IDLE_MS = TUNE.idleMs || 60 * 1000;
  let verEl = null, latest = null, baseline = null, updateReady = false, lastKey = Date.now();
  const stamp = async (f) => {
    try {
      const r = await fetch(f, { method: 'HEAD', cache: 'no-store' });
      return r.headers.get('etag') || r.headers.get('last-modified') || r.headers.get('content-length') || '?';
    } catch { return null; }
  };
  const stamps = async () => Object.fromEntries(await Promise.all(WATCH.map(async (f) => [f, await stamp(f)])));
  function paintVersion() {
    if (verEl) {
      verEl.classList.toggle('new', updateReady);
      verEl.textContent = updateReady ? `Update ${latest && latest !== VERSION ? `to ${latest} ` : ''}ready: press OK` : `Tuner ${VERSION}${window.__tunerHeadset ? ` · ${window.__tunerHeadset}` : ''} ↻`;
    }
    osd.classList.toggle('update', updateReady);
  }
  const playing = () => { const v = T()?.video, c = O()?.state.current; return !!c && !v.paused && !v.ended; };
  function reloadForUpdate() {
    // Never more than once in 10 minutes, in case the files look "changed" every time.
    try {
      const last = +sessionStorage.getItem('tvReloadAt') || 0;
      if (Date.now() - last < 10 * 60 * 1000) return;
      sessionStorage.setItem('tvReloadAt', String(Date.now()));
    } catch { /* no sessionStorage: reload anyway */ }
    location.reload();
  }
  async function checkUpdate(reason = 'timer') {
    const now = await stamps();
    if (Object.values(now).every((v) => v === null)) return; // offline
    if (!baseline) baseline = now;
    try {
      const t = await (await fetch(`js/version.js?${Date.now()}`, { cache: 'no-store' })).text();
      latest = /VERSION = '([^']+)'/.exec(t)?.[1] || null;
    } catch { /* keep what we know */ }
    updateReady = (latest && latest !== VERSION) || WATCH.some((f) => now[f] && baseline[f] && now[f] !== baseline[f]);
    paintVersion();
    if (!updateReady) return;
    const idle = Date.now() - lastKey > IDLE_MS;
    if (reason === 'resume' || screen() === 'setup' || (!playing() && idle)) reloadForUpdate();
  }
  setInterval(() => checkUpdate('timer'), POLL_MS);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkUpdate('resume'); });
  addEventListener('online', () => checkUpdate('timer'));

  // ---------- Home ----------
  function renderTabs() {
    tabsEl.innerHTML = '';
    const defs = [];
    const canSearch = liveAll().length || T().hasKind('movie') || T().hasKind('series');
    if (liveAll().length) defs.push(['live', 'Live']);
    if (T().hasKind('movie')) defs.push(['movie', 'Movies']);
    if (T().hasKind('series')) defs.push(['series', 'Shows']);
    defs.push(['phone', 'Settings']);
    if (tab === 'live' && !defs.some(([k]) => k === 'live')) tab = 'phone';
    const ver = el('button', 'tvh-version', '');
    ver.onclick = () => location.reload();
    verEl = ver;
    paintVersion();
    let liveTabFocusedFromElsewhere = false;
    if (WEB) tabsEl.append(profileChip()); // touch and headset: the profile you are on, first thing in the bar
    for (const [k, label] of defs) {
      const b = el('button', 'tvh-tab', esc(label));
      b.dataset.tab = k;
      b.onclick = () => {
        goTab(k, k === 'live' && !liveTabFocusedFromElsewhere);
        liveTabFocusedFromElsewhere = false;
        commitView(); focusFirstInBody();
      };
      // Tabs switch as soon as they get focus, so ◀ ▶ browses without pressing OK. Movies and Shows wait a moment, so
      // passing over them does not fetch a category.
      b.onfocus = () => {
        liveTabFocusedFromElsewhere = k === 'live' && tab !== 'live';
        clearTimeout(vodTabTimer);
        if (k === 'movie' || k === 'series') vodTabTimer = setTimeout(() => { if (document.activeElement === b) goTab(k); }, 350);
        else goTab(k);
      };
      tabsEl.append(b);
    }
    // Search is an icon at the end of the strip, not a tab: it never takes the first place, so Live opens by default.
    if (canSearch) {
      const s = el('button', 'tvh-tab tvh-icon-tab', '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 21 21"/></svg>');
      s.dataset.tab = 'search';
      s.title = 'Search';
      s.setAttribute('aria-label', 'Search');
      s.onclick = () => { goTab('search'); commitView(); focusFirstInBody(); }; // no focus-to-open: passing over it must not switch the view
      tabsEl.append(s);
    }
    tabsEl.append(ver);
    markTabs();
  }

  // ---------- Profile switcher (touch and headset) ----------
  let profileMenu = null;
  const closeProfileMenu = () => { profileMenu?.remove(); profileMenu = null; };
  document.addEventListener('click', closeProfileMenu);
  function profileChip() {
    const a = P().active();
    const b = el('button', 'tvh-pchip', `<span class="avatar${a ? '' : ' local'}">${a ? esc(a.name.trim().charAt(0).toUpperCase()) : '·'}</span><span class="tvh-pchip-name">${a ? esc(a.name) : 'This device'}</span><span class="tvh-pchip-caret" aria-hidden="true">▾</span>`);
    b.setAttribute('aria-haspopup', 'menu');
    b.title = 'Switch profile';
    b.onclick = (e) => { e.stopPropagation(); if (profileMenu) closeProfileMenu(); else openProfileMenu(b); };
    return b;
  }
  function openProfileMenu(anchor) {
    const p = P(), a = p.active();
    const menu = el('div', 'tvh-pmenu');
    menu.setAttribute('role', 'menu');
    menu.onclick = (e) => e.stopPropagation();
    const add = (id, name, letter) => {
      const on = (id ?? null) === (a?.id ?? null);
      const it = el('button', `tvh-pitem${on ? ' on' : ''}`, `<span class="avatar${id ? '' : ' local'}">${letter}</span><span class="grow">${esc(name)}</span>${on ? '<span class="tvh-pcheck">✓</span>' : ''}`);
      it.onclick = () => { closeProfileMenu(); if (on) return; p.switchTo(id); T().toast(`Switched to ${name}`); renderTabs(); };
      menu.append(it);
    };
    for (const pr of p.list()) add(pr.id, pr.name, esc(pr.name.trim().charAt(0).toUpperCase()));
    add(null, 'This device only', '·');
    const manage = el('button', 'tvh-pitem manage', 'Manage profiles…');
    manage.onclick = () => { closeProfileMenu(); goTab('phone'); commitView(); };
    menu.append(manage);
    document.body.append(menu);
    const r = anchor.getBoundingClientRect();
    menu.style.top = `${r.bottom + 8}px`;
    menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - 300))}px`;
    profileMenu = menu;
  }
  const markTabs = () => {
    for (const b of tabsEl.querySelectorAll('.tvh-tab')) {
      const k = b.dataset.tab;
      b.classList.toggle('on', k === 'movie' || k === 'series' ? tab === 'vod' && vodKind === k : k === 'phone' ? tab === 'phone' : k === 'live' ? tab === 'live' : false);
      if (k === 'search') b.classList.toggle('on', tab === 'search');
    }
  };
  // Remember the view when you actually use it (OK, or ▼ into the list), not merely by passing over its tab.
  function commitView() {
    if (tab !== 'live') return;
    viewChosen = true;
    try { localStorage.setItem('tvView', view); } catch { /* fine */ }
  }
  // The selected Live tab toggles between the channel list and On Now when activated again.
  function goTab(k, toggleLive = false) {
    if (k === 'search') {
      if (tab === 'search') { markTabs(); return; }
      tab = 'search';
      markTabs();
      renderBody();
      syncGuideMode();
      return;
    }
    if (k === 'movie' || k === 'series') {
      if (tab === 'vod' && vodKind === k) { markTabs(); return; }
      tab = 'vod'; vodKind = k; vodF.age = 0;
      markTabs();
      renderBody();
      syncGuideMode();
      return;
    }
    if (k === 'live' && tab === 'live') {
      if (!toggleLive) { markTabs(); return; }
      view = view === 'now' ? 'channels' : 'now';
      genre = ''; group = '';
      if (view === 'now') { ensureGuide(); computeNow(true); }
      markTabs();
      renderBody();
      syncGuideMode();
      return;
    }
    const nextTab = k === 'phone' ? 'phone' : 'live';
    if (nextTab === tab && nextTab === 'phone') { markTabs(); return; }
    tab = nextTab;
    if (tab === 'live') {
      genre = ''; group = '';
      if (view === 'now') { ensureGuide(); computeNow(true); }
    }
    markTabs();
    renderBody();
    syncGuideMode();
  }
  function focusFirstInBody() {
    if (tab === 'search') { bodyEl.querySelector('.tvh-search-input')?.focus(); return; }
    if (tab === 'vod') { chipsEl.querySelector('.tvh-chip')?.focus(); return; }
    (bodyEl.querySelector('.tvh-row.playing') || bodyEl.querySelector('button'))?.focus();
  }

  function renderChips() {
    chipsEl.innerHTML = '';
    chipsEl.classList.toggle('hidden', tab !== 'live' && tab !== 'vod');
    if (tab === 'vod') { renderVodChips(); return; }
    if (tab !== 'live') return;
    const add = (k, label, n, current, set) => {
      const b = el('button', `tvh-chip${k === current ? ' on' : ''}`, `<span class="nm">${esc(label)}</span><span class="n">${n}</span>`);
      b.dataset.key = k;
      const pick = (refocus) => { set(k); renderChips(); renderBody(false); if (refocus) chipsEl.querySelector('.tvh-chip.on:not(.mode)')?.focus(); };
      b.onclick = () => pick(true);
      // Browsing previews: the list follows focus, so ▲▼ then ▶ is enough.
      b.onfocus = () => { if (k !== current) { set(k); for (const x of chipsEl.querySelectorAll('.tvh-chip:not(.mode)')) x.classList.toggle('on', x === b); renderBody(false); } };
      chipsEl.append(b);
    };
    if (view === 'now') {
      computeNow();
      const counts = nowCounts();
      chipsEl.append(el('div', 'tvh-gstatus', esc(guideStatus()))); // on top, where it is seen while the guide loads
      sports.wantAll();
      if (scoreData.length) add(SCORES, '🏟 Scoreboard', scoreData.length, genre, (k) => { genre = k; });
      add('', 'Everything', nowData.length, genre, (k) => { genre = k; });
      for (const g of GENRES) if (counts.get(g)) add(g, g, counts.get(g), genre, (k) => { genre = k; });
      return;
    }
    const all = liveAll();
    const gcounts = new Map();
    for (const c of all) gcounts.set(c.group, (gcounts.get(c.group) || 0) + 1);
    const favs = all.filter((c) => T().isFav(c.id)).length;
    add('', 'All', all.length, group, (k) => { group = k; });
    if (favs) add(FAV, '★ Favorites', favs, group, (k) => { group = k; });
    for (const g of groups().slice(0, 120)) add(g, g, gcounts.get(g), group, (k) => { group = k; });
  }

  const ROW_PAGE = 100;
  let shown = 0, listCache = [];
  // Scoreboard tile: both teams with logo and score, the period or clock, and the channel it is on (small)
  function fillGame(b, ch, g) {
    if (g.leaderboard) {
      const channel = ch.net || ch.clean || cleanName(ch.name);
      b.innerHTML = `<span class="g-state tournament ${g.live ? 'live' : ''}"><b>${esc(g.title)}</b>
        <small><span>${esc(g.period)}</span>${ch.logo ? `<img alt="" src="${esc(ch.logo)}" referrerpolicy="no-referrer">` : ''}<span>${esc(channel)}</span></small></span>
        <span class="g-leaderboard">${(g.standings || []).map((p) => `<span class="g-leader"><b>${esc(p.position)}</b><span>${esc(p.name)}</span><strong>${esc(p.score)}</strong></span>`).join('')}</span>
        <span class="star">★</span>`;
      b.querySelector('.star').style.visibility = T().isFav(ch.id) ? 'visible' : 'hidden';
      return;
    }
    const side = (t, lead) => `<div class="tm${t.won || lead ? ' lead' : ''}">${t.logo ? `<img class="tl" alt="" src="${esc(t.logo)}" referrerpolicy="no-referrer">` : '<i class="tl"></i>'}<span class="tn">${t.rank ? `<em>${t.rank}</em>` : ''}${esc(t.name)}</span><b class="ts">${esc(String(t.score))}</b></div>`;
    const a = +g.away.score, h = +g.home.score, live = (g.live || g.when === 'final') && !isNaN(a) && !isNaN(h); // who is ahead (or won)
    b.innerHTML = `<span class="g-teams">${side(g.away, live && a > h)}${side(g.home, live && h > a)}</span>
      <span class="g-state ${g.live ? 'live' : ''}"><b>${esc(g.period)}</b><small>${ch.logo ? `<img alt="" src="${esc(ch.logo)}" referrerpolicy="no-referrer">` : ''}<span>${esc(ch.net || ch.clean || cleanName(ch.name))}</span></small></span>
      ${(g.when === 'later' || g.when === 'tomorrow') && g.odds ? `<span class="g-odds">${g.odds.line ? `<b>${esc(g.odds.line)}</b>` : ''}${g.odds.total ? `<span>O/U ${esc(String(g.odds.total))}</span>` : ''}</span>` : ''}
      <span class="star">★</span>`;
    b.querySelector('.star').style.visibility = T().isFav(ch.id) ? 'visible' : 'hidden';
  }
  // Film tile: poster, Rotten Tomatoes score, title, and what channel it is on until when. Without an OMDb key
  // (or before the lookup lands) the tile shows the title on a plain card.
  function fillMovie(b, ch, it) {
    const r = T().rating(it.p.title);
    const score = r?.rt != null ? `<span class="pc-rt"><i>🍅</i>${r.rt}%</span>` : r?.imdb ? `<span class="pc-rt"><i>★</i>${esc(r.imdb)}</span>` : '';
    const pct = Math.round(Math.min(100, Math.max(0, ((Date.now() - it.p.start) / ((it.p.stop - it.p.start) || 1)) * 100)));
    b.innerHTML = `<span class="pc-img">${r?.poster ? `<img alt="" src="${esc(r.poster)}" referrerpolicy="no-referrer">` : `<em>${esc(it.p.title)}</em>`}${score}</span>
      <b>${esc(it.p.title)}</b><small>${esc(ch.net || ch.clean || cleanName(ch.name))} · ${esc(fmtClock(it.p.stop))}</small><i class="prog on"><u style="width:${pct}%"></u></i><span class="star">★</span>`;
    b.querySelector('.star').style.visibility = T().isFav(ch.id) ? 'visible' : 'hidden';
  }
  function rowFor(ch, i) {
    if (tab === 'vod') return vodCard(ch, i);
    if (tab === 'search') return kindOf(ch) === 'live' ? searchLiveCard(ch, i) : vodCard(ch, i);
    const b = el('button', 'tvh-row');
    const mv = posterView() && nowMap.get(ch);
    if (mv) {
      b.dataset.i = i;
      b.classList.add('movie');
      b.classList.toggle('playing', ch === O().state.current);
      fillMovie(b, ch, mv);
      return b;
    }
    if (scoreView() && ch._day) {
      b.dataset.i = i;
      b.classList.add('daybtn');
      b.innerHTML = showTomorrow ? 'Hide tomorrow’s games' : 'Show tomorrow’s games ▸';
      return b;
    }
    if (scoreView() && ch._game) {
      b.dataset.i = i;
      b.classList.add('game');
      b.classList.toggle('playing', ch.id === O().state.current?.id);
      fillGame(b, ch, ch._game);
      return b;
    }
    b.dataset.i = i; // position in listCache; ids can repeat when a provider lists a stream twice
    b.classList.toggle('playing', ch === O().state.current);
    b.innerHTML = `<img alt="" referrerpolicy="no-referrer"><span class="meta"><b></b><small></small><i class="prog"><u></u></i></span><span class="star">★</span>`;
    b.querySelector('b').textContent = view === 'now' && nowMap.get(ch) ? titleOf(nowMap.get(ch)) : (ch.clean || cleanName(ch.name));
    if (ch.logo) b.querySelector('img').src = ch.logo; else b.querySelector('img').style.display = 'none';
    b.querySelector('.star').style.visibility = T().isFav(ch.id) ? 'visible' : 'hidden';
    paintRow(b, ch);
    return b;
  }
  const scoreView = () => view === 'now' && genre === SCORES;
  const posterView = () => view === 'now' && genre === 'Movies';
  const titleOf = (it) => it.sp?.title || it.p.title;
  function paintRow(b, ch) {
    if (b.classList.contains('movie')) { const it = nowMap.get(ch); if (it) fillMovie(b, ch, it); return; }
    if (b.classList.contains('daybtn')) return;
    if (b.classList.contains('game')) { fillGame(b, ch, ch._game); return; }
    if (view === 'now') {
      const it = nowMap.get(ch);
      if (!it) return;
      const small = b.querySelector('small'), prog = b.querySelector('.prog');
      small.textContent = `${ch.clean || cleanName(ch.name)}  ·  ${it.sp?.status ? `${it.sp.status}  ·  ` : ''}until ${fmtClock(it.p.stop)}`;
      small.style.display = '';
      prog.classList.add('on');
      prog.firstElementChild.style.width = `${Math.round(Math.min(100, Math.max(0, ((Date.now() - it.p.start) / (it.p.stop - it.p.start)) * 100)))}%`;
      return;
    }
    const nn = T().guide.peek(ch); // looks only; requestAround() asks for what's near the cursor
    const small = b.querySelector('small'), prog = b.querySelector('.prog');
    if (nn?.now) {
      small.textContent = `${nn.now.title}${nn.next ? `  ·  next ${nn.next.title}` : ''}`;
      small.style.display = '';
      prog.classList.add('on');
      prog.firstElementChild.style.width = `${Math.round(((Date.now() - nn.now.start) / (nn.now.stop - nn.now.start)) * 100)}%`;
    } else {
      // Inside a group the group name on every row is noise; show it only when browsing everything.
      small.textContent = group ? '' : (ch.group || '');
      small.style.display = small.textContent ? '' : 'none';
      prog.classList.remove('on');
    }
  }
  // The guide loads a few channels at a time from a queue that keeps only the most recent requests and serves
  // the newest first. Asking for a whole page of rows in order therefore dropped the ones on screen in any
  // group bigger than ~60. Ask only around the cursor, far to near, so the highlighted channel is served first.
  function requestAround(i) {
    const g = T().guide;
    if (!g.available()) return;
    if (g.source?.xtream) {
      const lo = Math.max(0, i - 4), hi = Math.min(listCache.length - 1, i + 14);
      for (let k = hi; k >= lo; k--) if (k !== i && listCache[k]) g.request(listCache[k]);
    }
    if (listCache[i]) g.nowNext(listCache[i]); // the channel itself last: it is served first (and starts an XMLTV load)
  }
  function addRows() {
    const next = listCache.slice(shown, shown + ROW_PAGE);
    next.forEach((ch, k) => {
      if (scoreView() && ch._sect) bodyEl.append(el('div', 'tvh-sect', esc(ch._sect)));
      (searchRowsEl || bodyEl).append(rowFor(ch, shown + k));
    });
    shown += next.length;
  }
  let holdFired = false, rowPressed = false;

  // The highlighted channel in full: name, group, what's on and what's next. Long provider names are cut off
  // in the list, so this is where you can always tell two similar channels apart.
  function paintInfo(ch) {
    if (!ch || scoreView() || posterView()) { infoEl.classList.add('hidden'); return; } // the game tile already says everything
    const nn = T().guide.nowNext(ch);
    const parts = [`<div class="i-name">${esc((ch.clean || cleanName(ch.name)))}</div>`, `<div class="i-meta">${esc(ch.group || '')}</div>`];
    if (nn?.now) {
      const pct = Math.min(100, Math.max(0, ((Date.now() - nn.now.start) / (nn.now.stop - nn.now.start)) * 100));
      const sp = nowMap.get(ch)?.sp;
      parts.push(`<div class="i-now"><b>Now</b> ${esc(sp ? `${sp.title}` : nn.now.title)} <span>${esc(sp?.status ? `${sp.status} · ` : '')}until ${esc(fmtClock(nn.now.stop))}</span></div>`);
      parts.push(`<div class="i-bar"><u style="width:${pct}%"></u></div>`);
      if (nn.next) parts.push(`<div class="i-next"><b>Next</b> ${esc(nn.next.title)} <span>${esc(fmtClock(nn.next.start))}</span></div>`);
      if (view === 'now' && nn.now.desc && nn.now.desc.length > 3) parts.push(`<div class="i-desc">${esc(nn.now.desc.slice(0, 220))}</div>`);
    } else {
      parts.push('<div class="i-next dim">No programme guide for this channel</div>');
    }
    infoEl.innerHTML = parts.join('');
    infoEl.classList.remove('hidden');
  }
  // Moving right into the list tucks the category column away into a thin drawer; moving left reopens it.
  const mainEl = home.querySelector('.tvh-main');
  home.addEventListener('focusin', (e) => { mainEl.classList.toggle('drawer', (tab === 'live' || tab === 'vod') && bodyEl.contains(e.target)); });
  bodyEl.addEventListener('focusin', (e) => {
    const row = e.target.closest?.('.tvh-row');
    if (row && tab === 'vod') { vodFocusI = +row.dataset.i; return; }
    if (row && tab === 'search' && kindOf(listCache[+row.dataset.i]) !== 'live') return;
    if (row) { requestAround(+row.dataset.i); paintInfo(listCache[+row.dataset.i]); }
  });

  function drawSearchResults() {
    const status = bodyEl.querySelector('.tvh-search-status');
    if (!status) return;
    const query = bodyEl.querySelector('.tvh-search-input')?.value.trim() || searchQuery;
    searchResults = matchingSearchResults(query);
    listCache = searchResults;
    shown = 0;
    if (searchRowsEl) searchRowsEl.replaceChildren();

    if (!query) {
      status.textContent = 'Search live channels, movies, and shows. Focus the box and use the microphone on the on-screen keyboard to speak.';
    } else if (!searchSubmitted) {
      status.textContent = `Press Search or Enter to search your full library · ${searchResults.length.toLocaleString()} quick matches so far`;
    } else if (searchPending.length) {
      status.textContent = `${searchProgress || 'Searching your library'} · ${searchResults.length.toLocaleString()} matches so far`;
    } else {
      status.textContent = `${searchResults.length.toLocaleString()} result${searchResults.length === 1 ? '' : 's'}${searchErrors.length ? ` · ${searchErrors.join(' · ')}` : ''}`;
    }

    if (searchRowsEl) {
      if (searchResults.length) addRows();
      else if (query && searchSubmitted && !searchPending.length && !searchErrors.length) {
        searchRowsEl.append(el('p', 'tvh-empty tvh-search-empty', `No matches for “${esc(query)}”.`));
      }
    }
  }

  async function submitSearch() {
    clearTimeout(searchInputTimer);
    const input = bodyEl.querySelector('.tvh-search-input');
    searchQuery = input?.value.trim() || '';
    if (input) input.value = searchQuery;
    const run = ++searchRun;
    if (!searchQuery) {
      searchSubmitted = false;
      searchErrors = [];
      searchProgress = '';
      searchPending = [];
      drawSearchResults();
      return;
    }
    searchSubmitted = true;
    searchErrors = [];
    searchProgress = '';
    resetSearchCatalogs();
    const kinds = ['movie', 'series'].filter((kind) => T().hasKind(kind) && !searchPools.has(kind));
    searchPending = [...kinds];
    drawSearchResults();

    for (const kind of kinds) {
      const label = kind === 'movie' ? 'movies' : 'shows';
      searchProgress = `Loading ${label} from your provider…`;
      drawSearchResults();
      try {
        await searchPool(kind, (p) => {
          if (run !== searchRun || !searchSubmitted) return;
          const received = ((p.received || 0) / 1048576).toFixed(1);
          const total = p.total ? ` of ${(p.total / 1048576).toFixed(1)} MB` : '';
          searchProgress = `Loading ${label} · ${received} MB${total}`;
          const status = bodyEl.querySelector('.tvh-search-status');
          if (status) status.textContent = `${searchProgress} · ${searchResults.length.toLocaleString()} matches so far`;
        });
      } catch (err) {
        if (run !== searchRun) return;
        searchErrors.push(`Couldn’t load ${label}: ${err.message}`);
      }
      if (run !== searchRun) return;
      searchPending = searchPending.filter((pending) => pending !== kind);
      searchProgress = '';
      drawSearchResults();
    }
  }

  function renderSearch() {
    bodyEl.className = 'tvh-body search';
    bodyEl.innerHTML = `<form class="tvh-search-form" role="search">
        <input class="tvh-search-input" type="search" inputmode="search" enterkeyhint="search" autocomplete="off" autocapitalize="off" spellcheck="false"
          aria-label="Search live channels, movies, and shows" placeholder="Search channels, movies, and shows…">
        <button class="btn" type="submit">Search</button>
      </form>
      <p class="tvh-search-status" aria-live="polite"></p>
      <div class="tvh-search-results"></div>`;
    searchRowsEl = bodyEl.querySelector('.tvh-search-results');
    const form = bodyEl.querySelector('.tvh-search-form');
    const input = bodyEl.querySelector('.tvh-search-input');
    input.value = searchQuery;
    form.addEventListener('submit', (event) => { event.preventDefault(); submitSearch(); });
    input.addEventListener('input', () => {
      searchQuery = input.value;
      searchSubmitted = false;
      clearTimeout(searchInputTimer);
      searchInputTimer = setTimeout(drawSearchResults, 120);
    });
    resetSearchCatalogs();
    drawSearchResults();
  }

  function renderBody(withChips = true) {
    clearTimeout(searchInputTimer);
    if (withChips) renderChips();
    searchRowsEl = null;
    bodyEl.innerHTML = '';
    bodyEl.className = `tvh-body ${tab}${tab === 'live' && scoreView() ? ' grid' : tab === 'live' && posterView() ? ' grid posters' : ''}`; // games and films are tiles
    infoEl.classList.add('hidden');
    if (tab === 'phone') return renderPhone();
    if (tab === 'search') return renderSearch();
    if (tab === 'vod') return renderVod();
    listCache = visibleList();
    shown = 0;
    if (!listCache.length) {
      bodyEl.innerHTML = `<p class="tvh-empty">${view === 'now' ? esc(guideStatus() || 'Nothing on yet.') : group === FAV ? 'No favorites yet. Hold OK on a channel to add one.' : 'No channels here.'}</p>`;
      return;
    }
    addRows();
  }

  function paintWallPicker() {
    const picker = bodyEl.querySelector('#tvWallTV'), swatches = bodyEl.querySelector('.tvh-wall-swatches');
    if (!picker || !swatches) return;
    const current = P().doc.tvWall || TV_WALL_DEFAULT;
    if (picker.value !== current) picker.value = current;
    for (const b of swatches.children) {
      const selected = b.dataset.hex === current;
      b.classList.toggle('on', selected);
      b.setAttribute('aria-pressed', String(selected));
    }
    const hsl = hexToHsl(current);
    if (!hsl) return;
    for (const [key, value, suffix] of [
      ['Hue', hsl.hue, '°'],
      ['Saturation', hsl.saturation, '%'],
      ['Lightness', hsl.lightness, '%'],
    ]) {
      const input = bodyEl.querySelector(`#tvWall${key}`);
      const output = bodyEl.querySelector(`#tvWall${key}Value`);
      if (input.value !== String(value)) input.value = String(value);
      output.value = `${value}${suffix}`;
    }
    bodyEl.querySelector('#tvWallHue').style.setProperty('--track', 'linear-gradient(90deg, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)');
    bodyEl.querySelector('#tvWallSaturation').style.setProperty('--track', `linear-gradient(90deg, hsl(${hsl.hue} 0% ${hsl.lightness}%), hsl(${hsl.hue} 100% ${hsl.lightness}%))`);
    bodyEl.querySelector('#tvWallLightness').style.setProperty('--track', `linear-gradient(90deg, #000, ${hslToHex(hsl.hue, hsl.saturation, 50)}, #fff)`);
  }

  function updateWallFromSliders() {
    const hue = bodyEl.querySelector('#tvWallHue').value;
    const saturation = bodyEl.querySelector('#tvWallSaturation').value;
    const lightness = bodyEl.querySelector('#tvWallLightness').value;
    chooseWall(hslToHex(hue, saturation, lightness));
  }

  function chooseWall(colour) {
    P().update((d) => { d.tvWall = colour === TV_WALL_DEFAULT ? '' : colour; });
    applyWall(colour);
    paintWallPicker();
  }

  function renderPhone() {
    const p = P(), a = p.active(), src = T().source();
    const n = p.doc.playlists.length;
    bodyEl.innerHTML = `
      <div class="tvh-profile"><span class="avatar">${a ? esc(a.name.trim().charAt(0).toUpperCase()) : '·'}</span>
        <div class="grow"><div class="tvh-pname">${a ? esc(a.name) : 'Not linked to a phone'}</div><div class="tvh-sync"></div></div></div>
      <div class="tvh-syncbar"><u></u></div>
      <p class="tvh-note">${WEB ? 'Manage playlists, playback, filters and account settings here. Changes sync to your other devices.' : `Change playlists on your phone at <b>${esc(host)}</b>. The TV background can be changed here and syncs to your profile.`}</p>
      <div class="tvh-actions"></div>
      <div class="tvh-wall-setting">
        <h3>TV background</h3>
        <div class="tvh-wall-swatches swatches row"></div>
        <div class="tvh-wall-picker">
          <label for="tvWallTV">Custom colour</label>
          <input id="tvWallTV" type="color" aria-label="Custom TV background colour">
          <button type="button" class="btn ghost tvh-wall-reset">Default</button>
        </div>
        <div class="tvh-wall-adjust">
          <label class="tvh-wall-axis"><span>Hue <output id="tvWallHueValue"></output></span><input id="tvWallHue" type="range" min="0" max="359" step="1"></label>
          <label class="tvh-wall-axis"><span>Saturation <output id="tvWallSaturationValue"></output></span><input id="tvWallSaturation" type="range" min="0" max="100" step="1"></label>
          <label class="tvh-wall-axis"><span>Lightness <output id="tvWallLightnessValue"></output></span><input id="tvWallLightness" type="range" min="0" max="100" step="1"></label>
        </div>
      </div>
      <p class="tvh-note dim tvh-showing"></p>
      <h3>Playlists on your profile${a ? ` (${n})` : ''}</h3><div class="tvh-lists"></div>`;
    const actions = bodyEl.querySelector('.tvh-actions');
    const mk = (label, fn, cls = 'btn') => { const b = el('button', cls, esc(label)); b.onclick = fn; actions.append(b); return b; };
    const wallSwatches = bodyEl.querySelector('.tvh-wall-swatches');
    for (const [name, hex] of TV_WALLS) {
      const b = el('button', 'swatch');
      b.type = 'button';
      b.dataset.hex = hex;
      b.title = name;
      b.style.background = hex;
      b.setAttribute('aria-label', `${name} TV background`);
      b.onclick = () => chooseWall(hex);
      wallSwatches.append(b);
    }
    bodyEl.querySelector('#tvWallTV').onchange = (e) => chooseWall(e.target.value);
    for (const id of ['tvWallHue', 'tvWallSaturation', 'tvWallLightness']) {
      bodyEl.querySelector(`#${id}`).oninput = updateWallFromSliders;
    }
    bodyEl.querySelector('.tvh-wall-reset').onclick = () => chooseWall(TV_WALL_DEFAULT);
    paintWallPicker();
    if (WEB) mk('Settings & playlists', openSettings);
    else mk('Advanced settings', openSettings, 'btn ghost');
    if (a) {
      mk('Sync now', () => { P().sync(); paintSync(); });
      if (src?.url) mk('Reload channels', () => { O().loadPlaylist(src.url, src.name, { fresh: true }); closeHome(); }, 'btn ghost');
      if (!WEB) mk('Unlink', async () => { await T().forgetCopies(); P().signOut(a.id); dismissed = false; closeHome(); runSetup(); }, 'btn ghost');
    } else if (!WEB) {
      mk('Link a phone', () => { dismissed = false; closeHome(); runSetup(); });
    }
    const lists = bodyEl.querySelector('.tvh-lists');
    for (const l of p.doc.playlists) {
      const b = el('button', `btn ghost pl-row${src?.url === l.url ? ' cur' : ''}`, `<span>${esc(l.name)}</span>${src?.url === l.url ? '<small>Showing now</small>' : ''}`);
      b.onclick = async () => {
        // Stay on the menu: show that it is loading, then confirm and land on the new channel list
        if (b.disabled) return;
        b.disabled = true; b.querySelector('small')?.remove(); b.append(el('small', '', 'Loading…'));
        await O().loadPlaylist(l.url, l.name, { fresh: true });
        const n = liveAll().length;
        if (n) { tab = 'live'; group = ''; genre = ''; autoView(); T().toast(`Loaded “${l.name}” · ${n.toLocaleString()} channel${n === 1 ? '' : 's'}`); renderTabs(); renderBody(); (bodyEl.querySelector('.tvh-row') || tabsEl.firstElementChild)?.focus(); }
        else if (isOpen.home() && tab === 'phone') renderPhone();
      };
      lists.append(b);
    }
    if (!n) lists.innerHTML = `<p class="tvh-note dim">None yet. ${WEB ? 'Add one in Settings & playlists.' : 'Add one on your phone.'}</p>`;
    paintSync();
  }

  function openSettings() {
    document.querySelector('.tab[data-tab="sources"]')?.click();
    $('panel').classList.remove('collapsed');
    html.classList.add('settings-open');
    requestAnimationFrame(() => $('panel').querySelector('.tab.active')?.focus());
  }

  function closeSettings() {
    $('panel').classList.add('collapsed');
    html.classList.remove('settings-open');
    if (isOpen.home()) tabsEl.querySelector('.tvh-tab.on')?.focus();
  }
  $('panelToggle').addEventListener('click', () => { if (isOpen.settings()) closeSettings(); });
  // Live sync line: what it's doing now, or when it last finished and what it found.
  function paintSync() {
    const line = bodyEl.querySelector('.tvh-sync'), bar = bodyEl.querySelector('.tvh-syncbar');
    if (!line) return;
    const src = T().source();
    bodyEl.querySelector('.tvh-showing').textContent = src ? `Showing “${src.name}”${src.savedAt ? `, downloaded ${ageText(src.savedAt)}` : ''}` : 'No channel list loaded';
    const p = P(), a = p.active(), st = p.status;
    if (!a) { line.textContent = 'Link a phone to get your playlists'; bar.classList.remove('on'); return; }
    const busy = st.state === 'syncing' || st.state === 'pending';
    const detail = `${p.doc.playlists.length} playlist${p.doc.playlists.length === 1 ? '' : 's'} · #${a.id.slice(0, 4)} v${a.version}${p.store ? ` · ${p.store === 'durable' ? 'durable' : 'kv'}` : ''}`;
    line.className = `tvh-sync ${st.state === 'offline' || st.state === 'error' ? 'bad' : ''}`;
    line.textContent = busy ? st.message || 'Syncing…'
      : st.state === 'synced' ? `Synced ${ageText(st.at)} · ${detail}`
      : `${st.message || 'Not synced'} · ${detail}`;
    bar.classList.toggle('on', busy);
  }
  setInterval(() => { if (isOpen.home() && tab === 'phone') { paintSync(); paintWallPicker(); } }, 400);
  const ageText = (t) => {
    const m = Math.round((Date.now() - t) / 60000);
    return m < 2 ? 'just now' : m < 120 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
  };
  
  // Opened from the picture (◀ or OK while a channel plays), Home becomes a guide: the list on the left and
  // the show carrying on in a window on the right. Without a picture it is the plain full-screen Home.
  const cap = el('div', 'tvh-cap');
  home.append(cap);
  function paintCap() {
    const c = O().state.current;
    const nn = c && T().guide.nowNext(c);
    const p = nn?.now, pct = p ? Math.round(Math.min(100, Math.max(0, ((Date.now() - p.start) / ((p.stop - p.start) || 1)) * 100))) : 0;
    cap.innerHTML = c ? `<b>${esc(c.clean || cleanName(c.name))}</b>${p ? `<div class="cap-now">${esc(p.title)} <small>until ${esc(fmtClock(p.stop))}</small></div><i class="prog on"><u style="width:${pct}%"></u></i>${p.desc && p.desc.length > 3 ? `<p class="cap-desc">${esc(p.desc)}</p>` : ''}${nn.next ? `<div class="cap-next"><b>Next</b> ${esc(nn.next.title)} <small>${esc(fmtClock(nn.next.start))}</small></div>` : ''}` : ''}<small class="dim">Back returns to the picture</small>` : '';
  }
  setInterval(() => { if (document.documentElement.classList.contains('guide-mode')) paintCap(); }, 2000); // guide data arrives late
  // The picture window belongs to Live. Movies, Shows and Settings are the full-width menu.
  let guideSession = false, savedNav = null, guidePictureReturn = null;
  function syncGuideMode() {
    const on = guideSession && tab === 'live';
    document.documentElement.classList.toggle('guide-mode', on);
    const stage = $('flatStage');
    if (stage) {
      if (on) {
        stage.setAttribute('tabindex', '0');
        stage.setAttribute('role', 'button');
        stage.setAttribute('aria-label', 'Return to full-screen playback');
      } else {
        stage.removeAttribute('tabindex');
        stage.removeAttribute('role');
        stage.removeAttribute('aria-label');
        guidePictureReturn = null;
      }
    }
    if (on) paintCap();
  }
  function focusGuidePicture(from) {
    if (!guideSession || tab !== 'live') return false;
    const stage = $('flatStage');
    if (!stage) return false;
    guidePictureReturn = from;
    stage.focus();
    return true;
  }
  function openHome(opts = {}) {
    if (screen() === 'setup') return;
    hideOsd();
    guideSession = !WEB && !opts.menu && document.documentElement.classList.contains('tv-picture') && !!O().state.current; // the picture window is for the guide, not the main menu
    // From the picture you get the live guide; coming back from a title's page you stay where you were (Movies / Shows)
    if (guideSession && !opts.keepTab && tab !== 'live' && liveAll().length) { tab = 'live'; group = ''; genre = ''; }
    // ▲▼ from the picture: the playing channel's folder, as a plain channel list (put back as it was when Home closes)
    if (opts.browse && O().state.current && liveAll().length) {
      savedNav ??= { tab, view, group, genre };
      tab = 'live'; view = 'channels'; genre = ''; group = O().state.current.group || '';
    }
    home.classList.remove('hidden');
    document.documentElement.classList.add('home-open');
    ready();
    P().pull(); // anything new from the phone
    checkUpdate('timer');
    libSeen = libSig();
    autoView();
    if (view === 'now') { ensureGuide(); computeNow(true); }
    renderTabs();
    renderBody();
    syncGuideMode();
    requestAnimationFrame(() => {
      let row = bodyEl.querySelector('.tvh-row.playing') || bodyEl.querySelector('.tvh-row');
      if (tab === 'search' && searchRestoreI != null) {
        const i = searchRestoreI;
        searchRestoreI = null;
        while (shown <= i && shown < listCache.length) addRows();
        row = bodyEl.querySelector(`.tvh-row[data-i="${i}"]`) || row;
      } else if (tab === 'search') row = null;
      if (opts.browse && row) { // one step from the playing channel, without tuning it
        const i = +row.dataset.i + opts.browse;
        while (shown <= i && shown < listCache.length) addRows();
        row = bodyEl.querySelector(`.tvh-row[data-i="${Math.max(0, Math.min(listCache.length - 1, i))}"]`) || row;
      }
      (row || (tab === 'search' ? bodyEl.querySelector('.tvh-search-input') : bodyEl.querySelector('button')) || tabsEl.querySelector('.tvh-tab[data-tab="live"]') || tabsEl.querySelector('.tvh-tab'))?.focus();
      row?.scrollIntoView({ block: 'center' });
    });
  }
  function closeHome() { closeProfileMenu(); home.classList.add('hidden'); document.documentElement.classList.remove('home-open'); guideSession = false; syncGuideMode();
    if (savedNav) { ({ tab, view, group, genre } = savedNav); savedNav = null; } document.activeElement?.blur?.(); }
  // A playlist can finish loading (or change after a sync) while Home is already open: rebuild instead of
  // leaving the old list on screen.
  let libSeen = '';
  const libSig = () => { const l = liveAll(); return `${l.length}|${l[0]?.id}|${l[l.length - 1]?.id}`; };
  setInterval(() => {
    if (!isOpen.home()) return;
    const sig = libSig();
    if (sig === libSeen) return;
    libSeen = sig;
    group = ''; genre = '';
    autoView();
    if (view === 'now') { ensureGuide(); computeNow(true); }
    const hadFocus = home.contains(document.activeElement);
    renderTabs();
    renderBody();
    if (!hadFocus || document.activeElement === document.body) bodyEl.querySelector('.tvh-row')?.focus();
  }, 1000);
  // While the guide is still arriving the kinds and their counts change under you. Update the left column in place
  // (keeping focus), and rebuild the list only if you are not in it.
  let nowSig = '';
  setInterval(() => {
    if (!isOpen.home() || tab !== 'live' || view !== 'now') return;
    computeNow(true);
    const pr = T().guide.progress();
    // The default view is On now; if the guide finished loading and holds nothing, Channels is the useful one.
    const gd = T().guide;
    if (!viewChosen && pr.state === 'ready' && !nowData.length && (gd.bulkState !== 'none' || gd.xmltvState !== 'none')) {
      view = 'channels'; genre = ''; group = '';
      renderTabs(); renderBody();
      return;
    }
    const sig = `${[...nowCounts()].join()}|${pr.state}|${pr.done}|${nowData.length}|${scoreData.length}`;
    if (sig === nowSig) return;
    nowSig = sig;
    const a = document.activeElement;
    const inList = !!a?.closest?.('.tvh-body');
    const inChips = chipsEl.contains(a);
    const key = a?.dataset?.key;
    renderChips();
    if (inChips && key !== undefined) chipsEl.querySelector(`.tvh-chip[data-key="${CSS.escape(key)}"]`)?.focus();
    if (!inList) renderBody(false);
  }, 1500);
  // Rows' what's-on lines fill in as guide data arrives.
  setInterval(() => {
    if (!isOpen.home() || tab !== 'live') return;
    const f = document.activeElement?.closest?.('.tvh-row');
    const at = f ? +f.dataset.i : 0;
    for (const row of bodyEl.querySelectorAll('.tvh-row')) {
      const i = +row.dataset.i;
      if (Math.abs(i - at) > 20) continue;
      const ch = listCache[i];
      if (ch) paintRow(row, ch);
    }
    if (f) paintInfo(listCache[at]);
  }, 1500);

  // ---------- Movies and Shows ----------
  // One flat list of titles instead of the provider's folder tree: every folder that matches the "primary" patterns
  // (Settings → Content filter on the phone, default "VOD | EN*, VOD | IMDB TOP 500") is loaded and merged, and the
  // part of each folder's name after the pattern ("VOD | EN Action" → "Action") becomes a filter chip. Same layout
  // as the films in On now; OK opens the title's page; Back returns to the same tile.
  let vodTabTimer = 0, vodKind = 'movie', vodSeq = 0, vodFocusI = 0, vodRestore = null, vodReturn = false;
  let vodItems = [], vodTags = new Map(); // what the grid is showing from, and each title's folder labels
  let vodAlias = new Map(); // id of a copy that was folded into another listing of the same title → the id that was kept
  // The same film or show is often listed in several folders, in several qualities, or twice with different ids
  const vodKey = (it) => {
    const { title, year } = T().vod.title(it);
    const t = String(title || it.name || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '');
    return t ? `${t}|${it.year || year || ''}` : `id:${it.id}`;
  };
  const vodDedupe = (list) => { const seen = new Set(); return list.filter((x) => { const k = vodKey(x); if (seen.has(k)) return false; seen.add(k); return true; }); };
  const vodIndex = {}; // kind → { sig, items, tags: Map(id → Set(label)), done, total, state }
  const vodTag = { movie: '', series: '' }; // selected genre / collection ('' = everything)
  const vodF = { sort: 'added', rating: 0, year: '', age: 0 };
  // Film (MPAA) and TV (Parental Guidelines) ratings on one scale; the menu is "up to" a level, in each system's terms
  const AGE = { 'TV-Y': 1, G: 2, 'TV-Y7': 2, 'TV-Y7-FV': 2, 'TV-G': 2, PG: 3, 'TV-PG': 3, 'PG-13': 4, 'TV-14': 4, R: 5, 'TV-MA': 5, 'NC-17': 6, NR: 6 };
  const AGE_MENU = { movie: [[2, 'G'], [3, 'PG'], [4, 'PG-13'], [5, 'R']], series: [[1, 'TV-Y'], [2, 'TV-G'], [3, 'TV-PG'], [4, 'TV-14'], [5, 'TV-MA']] };
  const vodMeta = new Map(); // id → { cert } for titles whose rating has been looked up
  let ageRun = 0;
  const SORTS = [['added', 'Recently added'], ['rt', 'Rotten Tomatoes'], ['rating', 'Top rated'], ['year', 'Newest'], ['title', 'A–Z']];
  const YEARS = [['', 'Any'], ['2020', '2020s'], ['2010', '2010s'], ['2000', '2000s'], ['1990', '1990s'], ['old', 'Before 1990']];
  const normName = (s) => String(s).toUpperCase().replace(/[\s|:\-–_]+/g, ' ').trim();
  const pretty = (s) => (s === s.toUpperCase() ? s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\bImdb\b/, 'IMDB').replace(/\bTv\b/, 'TV') : s);
  const isCollection = (label) => /\b(top|imdb|best|collection|oscar|award|classics?)\b/i.test(label);
  // The pattern a folder name matches (normalised), or '' if none. A trailing * allows more characters after it.
  function primaryMatch(name, pats) {
    const n = normName(name);
    for (const p of pats) {
      const pn = normName(p.replace(/\*+$/, ''));
      if (!pn) continue;
      if (n === pn || n.startsWith(`${pn} `) || (p.endsWith('*') && n.startsWith(pn))) return pn;
    }
    return '';
  }
  function vodCategorySelection(kind) {
    const pats = String(T().vod.primary?.() || '').split(',').map((s) => s.trim()).filter(Boolean);
    const all = T().vod.categories(kind) || [];
    let categories = pats.length ? all.map((c) => ({ c, m: primaryMatch(c.name, pats) })).filter((x) => x.m) : [];
    if (!categories.length) categories = all.slice(0, 60).map((c) => ({ c, m: '' }));
    return { pats, categories };
  }
  // "VOD | EN Action" matched by "VOD | EN*" → "Action"
  function folderLabel(name, matched) {
    const words = String(name).split(/[\s|:\-–_]+/).filter(Boolean);
    const skip = matched ? matched.split(' ').length : 0;
    const head = words.slice(0, skip).map((w) => w.toUpperCase()).join(' ');
    const rest = (head === matched ? words.slice(skip) : words).join(' ');
    if (!rest && isCollection(name)) return pretty(words.filter((w) => w.toUpperCase() !== 'VOD').join(' ') || String(name)); // "VOD | IMDB TOP 500" → "IMDB Top 500"
    if (/\bclassics?\b/i.test(rest)) return 'Classics'; // "Classic Series", "Classic Movies" → one category
    return pretty(rest || 'General');
  }
  // Starts loading (or returns the load already under way). Titles land in idx.items as each folder arrives, and
  // idx.onBatch is called so the grid can show them straight away.
  function loadVodIndex(kind) {
    const { pats, categories: chosen } = vodCategorySelection(kind);
    const sig = `${libSig()}|${pats.join(',')}`;
    let idx = vodIndex[kind];
    if (idx && idx.sig === sig) return idx;
    idx = vodIndex[kind] = { sig, items: [], tags: new Map(), alias: new Map(), byKey: new Map(), done: 0, total: 0, state: 'loading', onBatch: null };
    // Small curated folders (IMDB Top 500…) first, so there is something to look at quickly
    const withLabel = chosen.map((x) => ({ ...x, label: folderLabel(x.c.name, x.m) }));
    withLabel.sort((a, b) => isCollection(b.label) - isCollection(a.label));
    idx.total = withLabel.length;
    const queue = [...withLabel];
    const worker = async () => {
      while (queue.length) {
        const { c, label } = queue.shift();
        try {
          const items = await T().vod.loadQuiet(kind, c.id);
          for (const it of items) {
            let tags = idx.tags.get(it.id);
            if (!tags) {
              const k = vodKey(it), keep = idx.byKey.get(k);
              if (keep) { // already listed under another id: one tile, with the folder labels of both
                idx.alias.set(it.id, keep.id);
                for (const f of ['logo', 'rating', 'year', 'genre', 'added']) if (!keep[f] && it[f]) keep[f] = it[f];
                idx.tags.get(keep.id)?.add(label);
                continue;
              }
              tags = new Set(); idx.tags.set(it.id, tags); idx.items.push(it); idx.byKey.set(k, it);
            }
            tags.add(label);
          }
        } catch { /* one folder failing should not lose the rest */ }
        idx.done++;
        idx.onBatch?.(false);
      }
    };
    idx.promise = Promise.all([worker(), worker(), worker()]).then(() => { idx.state = 'done'; idx.onBatch?.(true); return idx; });
    return idx;
  }
  const vodStatusText = (idx) => `Still loading titles · ${idx.done} of ${idx.total} categories`;
  const vodSkeleton = () => Array.from({ length: 12 }, () => '<button class="tvh-row movie skel" tabindex="-1"><span class="pc-img"></span><b>&nbsp;</b><small>&nbsp;</small></button>').join('');
  const vodIO = new IntersectionObserver((es) => {
    // Scores cost a lookup each, so only posters that stay on screen for a moment ask
    for (const e of es) {
      clearTimeout(e.target._t);
      if (e.isIntersecting) e.target._t = setTimeout(() => { const it = listCache[+e.target.dataset.i]; if (it) T().vod.rating(it); }, 500);
    }
  }, { root: bodyEl });
  const vodScore = (i) => {
    const r = T().vod.peek(i), imdb = parseFloat(r?.imdb);
    return imdb > 0 ? imdb : r?.rt != null ? r.rt / 10 : +i.rating || 0;
  };
  let vodSeen = 0; // how many of the index's titles the grid has taken into account
  function vodPass(i, skipAge = false) {
    const f = vodF, tag = vodTag[vodKind];
    if (tag && !(vodTags.get(i.id) || vodTags.get(vodAlias.get(i.id)))?.has(tag)) return false;
    if (f.rating && vodScore(i) < f.rating) return false;
    if (f.year) { if (!i.year) return false; if (f.year === 'old' ? i.year >= 1990 : i.year < +f.year || i.year >= +f.year + 10) return false; }
    if (f.age && !skipAge) { const lvl = ageLevel(i); if (!lvl || lvl > f.age) return false; } // unknown counts as too old
    return true;
  }
  const ageLevel = (i) => AGE[vodMeta.get(i.id)?.cert || T().vod.peek(i)?.rated] || 0;
  // Looks up the age rating of every title in the list (TMDB allows plenty at once; results are cached in the profile)
  async function fetchAges() {
    const run = ++ageRun;
    await T().vod.metaReady?.();
    // Everything already known (from this device or the profile) is filled in at once
    for (const i of vodItems) if (!vodMeta.has(i.id)) { const hit = T().vod.metaPeek?.(i); if (hit) vodMeta.set(i.id, hit); }
    vodRefresh();
    // Only the rest is looked up
    // The titles the grid would show first (current sort, other filters applied) are checked first, so the first
    // screens fill in within seconds and the rest follow in the background
    const todo = vodItems.filter((i) => !vodMeta.has(i.id));
    const first = todo.filter((i) => vodPass(i, true)).sort(vodSortBy()), firstSet = new Set(first);
    const list = [...first, ...todo.filter((i) => !firstSet.has(i))], total = list.length;
    if (!total || ageRun !== run) return;
    let next = 0, done = 0, last = performance.now();
    const status = () => { const s = chipsEl.querySelector('.vod-age'); if (s) s.textContent = done < total ? `Checking age ratings · ${done.toLocaleString()} of ${total.toLocaleString()}` : ''; };
    const worker = async () => {
      while (next < total && ageRun === run) {
        const it = list[next++];
        try { vodMeta.set(it.id, (await T().vod.meta(it)) || { cert: '' }); } catch { vodMeta.set(it.id, { cert: '' }); }
        done++;
        if (performance.now() - last > 1200) { last = performance.now(); status(); vodRefresh(); }
      }
    };
    status();
    await Promise.all(Array.from({ length: 16 }, worker));
    if (ageRun === run) { status(); vodRefresh(); }
  }
  // Titles that now pass the filters: rebuild the grid if you are not in it, else add them to the end
  function vodRefresh() {
    if (tab !== 'vod') return;
    if (!(bodyEl.contains(document.activeElement) && bodyEl.querySelector('.tvh-row:not(.skel)'))) { renderVodList(); return; }
    const have = new Set(listCache.map((i) => i.id));
    const add = vodItems.filter((i) => !have.has(i.id) && vodPass(i));
    if (add.length) { const wasAll = shown >= listCache.length; listCache.push(...add); if (wasAll) addRows(); }
  }
  function vodSortBy() {
    return {
      added: (a, b) => (b.added || 0) - (a.added || 0),
      rt: (a, b) => (T().vod.peek(b)?.rt ?? -1) - (T().vod.peek(a)?.rt ?? -1),
      rating: (a, b) => (b.rating || 0) - (a.rating || 0),
      year: (a, b) => (b.year || 0) - (a.year || 0),
      title: (a, b) => cleanName(a.name).localeCompare(cleanName(b.name)),
    }[vodF.sort];
  }
  function vodList() {
    const f = vodF;
    const out = vodItems.filter((x) => vodPass(x));
    out.sort(vodSortBy());
    // Things you are part-way through come first (unless a category is picked)
    if (!vodTag[vodKind]) {
      const cont = T().vod.continueList(vodKind).filter((x) => vodPass(x));
      const ids = new Set(cont.map((x) => x.id));
      return vodDedupe([...cont, ...out.filter((x) => !ids.has(x.id))]);
    }
    return out;
  }
  function renderVodChips() {
    const keep = document.activeElement?.closest?.('.tvh-chips') ? document.activeElement.dataset.key : null;
    chipsEl.innerHTML = '';
    const mode = (key, label, value, press) => {
      const b = el('button', 'tvh-chip mode', `<span class="nm">${esc(label)}</span><span class="n">${esc(value)}</span>`);
      b.dataset.key = key;
      b.onclick = () => { press(); renderVodChips(); renderVodList(); };
      chipsEl.append(b);
    };
    const cycle = (list, cur) => list[(list.indexOf(cur) + 1) % list.length];
    const si = SORTS.findIndex(([k]) => k === vodF.sort);
    mode('sort', 'Sort', SORTS[si][1], () => { vodF.sort = SORTS[(si + 1) % SORTS.length][0]; });
    mode('rating', 'Rating', vodF.rating ? `${vodF.rating}+` : 'Any', () => { vodF.rating = cycle([0, 6, 7, 8], vodF.rating); });
    const yi = YEARS.findIndex(([k]) => k === vodF.year);
    mode('year', 'Year', YEARS[yi][1], () => { vodF.year = YEARS[(yi + 1) % YEARS.length][0]; });
    // Age rating: "up to" a level, in the terms of films (G…R) or shows (TV-Y…TV-MA)
    const ages = AGE_MENU[vodKind] || AGE_MENU.movie, ai = ages.findIndex(([n]) => n === vodF.age);
    mode('age', 'Age', vodF.age ? `Up to ${ages[ai]?.[1] || ''}` : 'Any', () => {
      vodF.age = ai + 1 < ages.length ? ages[ai + 1][0] : 0;
      if (vodF.age === 0 && ai === -1) vodF.age = ages[0][0];
      if (vodF.age && !T().vod.hasMeta()) { T().toast('Age ratings need a TMDB key: add one on your phone (Settings → Sync)'); }
      if (vodF.age) fetchAges();
    });
    if (vodF.age) chipsEl.append(el('div', 'tvh-gstatus vod-age', ''));
    // Genres and collections come from the folders the titles were found in
    const counts = new Map();
    for (const tags of vodTags.values()) for (const g of tags) counts.set(g, (counts.get(g) || 0) + 1);
    const chip = (key, label, n) => {
      const b = el('button', `tvh-chip${key === vodTag[vodKind] ? ' on' : ''}`, `<span class="nm">${esc(label)}</span><span class="n">${n}</span>`);
      b.dataset.key = `t:${key}`;
      b.onclick = () => { vodTag[vodKind] = key === vodTag[vodKind] ? '' : key; // pressing the chosen one again shows everything
       renderVodChips(); renderVodList(); chipsEl.querySelector('.tvh-chip.on:not(.mode)')?.focus(); };
      chipsEl.append(b);
    };
    const cur = vodIndex[vodKind];
    if (cur && cur.state === 'loading' && cur.done < cur.total) chipsEl.append(el('div', 'tvh-gstatus vod-status', vodStatusText(cur)));
    const labels = [...counts.keys()].sort((a, b) => a.localeCompare(b));
    if (labels.length) chipsEl.append(el('div', 'tvh-gstatus', 'Category'));
    for (const g of labels) chip(g, g, counts.get(g));
    if (keep) chipsEl.querySelector(`.tvh-chip[data-key="${CSS.escape(keep)}"]`)?.focus();
  }
  function renderVod() {
    const seq = ++vodSeq;
    infoEl.classList.add('hidden');
    listCache = [];
    const idx = loadVodIndex(vodKind);
    vodItems = idx.items;
    vodTags = idx.tags; vodAlias = idx.alias;
    idx.onBatch = (final) => { if (seq === vodSeq && tab === 'vod') vodBatch(idx, final); };
    if (idx.items.length || idx.state === 'done') {
      if (!chipsEl.contains(document.activeElement)) renderVodChips();
      renderVodList();
    } else {
      bodyEl.className = 'tvh-body vod grid posters';
      bodyEl.innerHTML = vodSkeleton();
    }
  }
  // A folder finished loading (or all of them did). Update the left panel and the grid without taking the cursor away.
  function vodBatch(idx, final) {
    const st = chipsEl.querySelector('.vod-status');
    if (st) { if (idx.done >= idx.total) st.remove(); else st.textContent = vodStatusText(idx); }
    vodItems = idx.items; vodTags = idx.tags; vodAlias = idx.alias;
    const inGrid = bodyEl.contains(document.activeElement) && bodyEl.querySelector('.tvh-row:not(.skel)');
    if (!chipsEl.contains(document.activeElement) && (final || idx.done % 2 === 1 || idx.done === idx.total)) renderVodChips();
    if (final && vodF.age) fetchAges();
    if (!inGrid) {
      const onSkeleton = document.activeElement?.classList.contains('skel'); // you pressed ▼ before anything had loaded
      renderVodList();
      if (onSkeleton) bodyEl.querySelector('.tvh-row:not(.skel)')?.focus();
      return;
    }
    // Browsing right now: add the new titles to the end of what is on screen; the next filter change re-sorts everything
    const fresh = idx.items.slice(vodSeen);
    vodSeen = idx.items.length;
    const have = new Set(listCache.map((x) => x.id)), add = fresh.filter((x) => vodPass(x) && !have.has(x.id));
    if (add.length) { const wasAll = shown >= listCache.length; listCache.push(...add); if (wasAll) addRows(); }
  }
  function renderVodList() {
    vodIO.disconnect();
    bodyEl.className = 'tvh-body vod grid posters';
    bodyEl.innerHTML = '';
    if (vodIndex[vodKind]) vodItems = vodIndex[vodKind].items;
    listCache = vodList();
    vodSeen = vodItems.length;
    shown = 0;
    if (!listCache.length) {
      const loading = vodIndex[vodKind]?.state === 'loading';
      bodyEl.innerHTML = loading ? vodSkeleton() : `<p class="tvh-empty">${vodItems.length ? 'Nothing matches these filters.' : 'Nothing here yet.'}</p>`;
      return;
    }
    addRows();
    if (vodRestore != null) {
      const i = vodRestore; vodRestore = null;
      while (shown <= i && shown < listCache.length) addRows();
      const row = bodyEl.querySelector(`.tvh-row[data-i="${i}"]`) || bodyEl.querySelector('.tvh-row');
      row?.focus(); row?.scrollIntoView({ block: 'center' });
    }
  }
  function vodCard(item, i) {
    const b = el('button', 'tvh-row movie vod');
    b.dataset.i = i;
    fillVod(b, item);
    vodIO.observe(b);
    return b;
  }
  function fillVod(b, item) {
    const r = T().vod.peek(item), { title } = T().vod.title(item);
    const poster = item.logo || r?.poster;
    const badge = r?.rt != null ? `<span class="pc-rt"><i>🍅</i>${r.rt}%</span>` : r?.imdb ? `<span class="pc-rt"><i>★</i>${esc(r.imdb)}</span>` : +item.rating > 0 ? `<span class="pc-rt"><i>★</i>${(+item.rating).toFixed(1)}</span>` : '';
    const p = T().vod.progress(item);
    const meta = [tab === 'search' ? (kindOf(item) === 'series' ? 'Show' : 'Movie') : '', item.year || r?.year, String(item.genre || r?.genre || '').split(/[,/]/)[0].trim()].filter(Boolean).join(' · ');
    b.innerHTML = `<span class="pc-img">${poster ? `<img alt="" src="${esc(poster)}" referrerpolicy="no-referrer">` : `<em>${esc(title || item.name)}</em>`}${badge}</span>
      <b>${esc(title || item.name)}</b><small>${esc(meta)}</small>${p?.d ? `<i class="prog on"><u style="width:${Math.round(Math.min(100, (p.t / p.d) * 100))}%"></u></i>` : ''}<span class="star">★</span>`;
    const img = b.querySelector('img');
    if (img) img.onerror = () => { const em = el('em', '', esc(title || item.name)); img.replaceWith(em); };
    b.querySelector('.star').style.visibility = T().isFav(item.id) ? 'visible' : 'hidden';
  }
  function searchLiveCard(ch, i) {
    const b = el('button', 'tvh-row movie search-live');
    b.dataset.i = i;
    const nn = T().guide.peek(ch);
    const info = [ch.group, nn?.now?.title ? `Now · ${nn.now.title}` : ''].filter(Boolean).join(' · ');
    b.innerHTML = `<span class="pc-img">${ch.logo ? `<img alt="" src="${esc(ch.logo)}" referrerpolicy="no-referrer">` : `<em>${esc(ch.clean || cleanName(ch.name))}</em>`}</span>
      <b>${esc(ch.clean || cleanName(ch.name))}</b><small>${esc(`Live${info ? ` · ${info}` : ''}`)}</small><span class="star">★</span>`;
    const img = b.querySelector('img');
    if (img) img.onerror = () => { const em = el('em', '', esc(ch.clean || cleanName(ch.name))); img.replaceWith(em); };
    b.querySelector('.star').style.visibility = T().isFav(ch.id) ? 'visible' : 'hidden';
    return b;
  }
  function openVod(item, i) {
    if (tab === 'search') { searchRestoreI = i; vodRestore = null; }
    else vodRestore = i;
    vodReturn = true;
    closeHome();
    openDetail(item);
  }

  // ---------- No-sound detection ----------
  // Chromium counts the audio it has decoded. A stream that has played for a few seconds with the volume up and
  // nothing decoded has a sound track this device cannot play (DTS, TrueHD, sometimes AC-3 / E-AC-3).
  let silent = null, silentKey = '', playSince = 0;
  const notice = el('div', 'tv-notice hidden');
  document.body.append(notice);
  let noticeTimer = 0;
  const showNotice = (text, ms = 9000) => { notice.textContent = text; notice.classList.remove('hidden'); clearTimeout(noticeTimer); noticeTimer = setTimeout(() => notice.classList.add('hidden'), ms); };
  const fixTried = new Set(); // channels we have already tried to repair the sound of
  setInterval(() => {
    const v = T()?.video, c = O()?.state.current;
    if (!v || !c) return;
    const key = `${c.id}|${v.currentSrc || ''}`;
    if (key !== silentKey) { silentKey = key; silent = null; playSince = 0; }
    if (v.paused || v.readyState < 3 || !(v.currentTime > 0)) { playSince = 0; return; }
    if (!playSince) playSince = Date.now();
    // A Matroska file with sound the built-in player cannot decode: replay it through the MKV remuxer, which converts it
    if (Date.now() - playSince >= 3500 && !fixTried.has(c.id) && v.webkitAudioDecodedByteCount === 0 && v.webkitVideoDecodedByteCount > 0 && !v.muted && v.volume > 0 && /\.mkv(\?|$)/i.test(c.url || '') && T().fixAudio) {
      fixTried.add(c.id);
      T().probeStream?.().then((p) => logEvent('silent', 'no audio decoded; trying the MKV engine', { file: p.container, contains: (p.streams || []).join(' + '), problems: p.problems })).catch(() => {});
      showNotice('This file’s audio format isn’t supported here. Converting it so it plays (the first time this downloads the decoder, which can take a minute)…', 150000);
      T().fixAudio().then((ok) => { logEvent('fix', ok ? 'MKV engine took the file' : 'MKV engine could not take the file', { engine: T().streamInfo?.().engine }); if (ok) { notice.classList.add('hidden'); } else showNotice('Couldn’t convert this audio. Press OK, then Info, to see why.'); });
      return;
    }
    if (Date.now() - playSince < 6000 || silent !== null || v.webkitAudioDecodedByteCount === undefined) return;
    silent = !v.muted && v.volume > 0 && v.webkitAudioDecodedByteCount === 0 && v.webkitVideoDecodedByteCount > 0;
    if (silent) {
      showNotice('No sound from this stream. Press OK, then Info, to see why.');
      T().probeStream?.().then((p) => logEvent('silent', 'still no audio decoded', { engine: T().streamInfo?.().engine, file: p.container, contains: (p.streams || []).join(' + ') })).catch(() => {});
    }
  }, 1500);

  // A small tag while the picture is paused with no other overlay.
  const pausedTag = el('div', 'tv-paused hidden', 'Paused · OK to play · ▲ controls');
  document.body.append(pausedTag);
  setInterval(() => {
    const v = T()?.video, c = O()?.state.current;
    pausedTag.classList.toggle('hidden', !(v && c && v.paused && v.readyState >= 2 && screen() === 'player'));
  }, 400);

  // ---------- Player controls ----------
  // Up opens the bar without interrupting playback. Audio and Captions open a short list; OK picks and Back goes up a level.
  let controlsMenu = '', controlsTick = 0;
  let epsData = null, epsSeason = 0, epsFocusNow = false; // the episode chooser
  const seekRange = () => { const v = T().video; return v.seekable?.length ? [v.seekable.start(0), v.seekable.end(v.seekable.length - 1)] : null; };
  function seekBy(seconds) {
    const v = T().video;
    const current = O().state.current;
    const live = !!current && kindOf(current) === 'live';
    const range = live ? seekRange() : null;
    if (live && !range) return;
    const [start, end] = range || [0, Number.isFinite(v.duration) && v.duration > 0 ? v.duration : Infinity];
    v.currentTime = Math.max(start, Math.min(end, v.currentTime + seconds));
    if (screen() === 'controls') paintControlsBar(); else showOsd();
  }
  function openControls() {
    const c = O().state.current;
    if (!c) { openHome(); return; }
    hideOsd();
    controlsMenu = '';
    controls.classList.remove('hidden');
    paintControls();
    controls.querySelector('[data-k="primary"]')?.focus();
    clearInterval(controlsTick);
    controlsTick = setInterval(paintControlsBar, 500);
  }
  function closeControls() {
    clearInterval(controlsTick);
    controls.classList.add('hidden');
    controlsMenu = '';
    document.activeElement?.blur?.();
  }
  function paintControlsBar() {
    const v = T().video, c = O().state.current;
    if (!c || controls.classList.contains('hidden')) return;
    const live = kindOf(c) === 'live', r = seekRange();
    const bar = controls.querySelector('.tvc-bar u'), l = controls.querySelector('.tvc-l'), rr = controls.querySelector('.tvc-r');
    if (!bar) return;
    if (!live && v.duration > 0) { bar.style.width = `${(v.currentTime / v.duration) * 100}%`; l.textContent = fmtDur(v.currentTime); rr.textContent = fmtDur(v.duration); }
    else if (r && r[1] - r[0] > 1) { bar.style.width = `${((v.currentTime - r[0]) / (r[1] - r[0])) * 100}%`; l.textContent = `${Math.max(0, Math.round(r[1] - v.currentTime))}s behind live`; rr.textContent = 'LIVE'; }
    else { bar.style.width = '100%'; l.textContent = ''; rr.textContent = live ? 'LIVE' : ''; }
  }
  function paintControls() {
    const v = T().video, c = O().state.current;
    if (!c) return;
    const live = kindOf(c) === 'live';
    const nn = live ? T().guide.peek(c) : null;
    const lab = playLabels(c);
    const title = live ? (nn?.now?.title || lab.title) : lab.title;
    const sub = live ? `${lab.title}${nn?.now ? ` · until ${fmtClock(nn.now.stop)}` : ''}` : lab.sub;
    const tr = T().tracks?.() || { audio: [], text: [] };
    const on = (list) => list.find((x) => x.on)?.label;
    const ICON = {
      back: 'M11 18V6l-8.5 6 8.5 6zm.5-6 8.5 6V6l-8.5 6z', fwd: 'M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z', play: 'M8 5v14l11-7z',
      pause: 'M6 19h4V5H6v14zm8-14v14h4V5h-4z',
      audio: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z',
      cc: 'M19 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm-8 7H9.5v-.5h-2v3h2V13H11v1a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1zm7 0h-1.5v-.5h-2v3h2V13H18v1a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1z',
      info: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z', warn: 'M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z',
      guide: 'M3 6h18v2H3V6zm0 5h18v2H3v-2zm0 5h18v2H3v-2z',
      eps: 'M3 5h14v2H3V5zm0 4h14v2H3V9zm0 4h9v2H3v-2zm12 0 6 3.5-6 3.5v-7z',
    };
    const btn = (k, icon, label, extra = '', disabled = false) => `<button class="tvc-btn" data-k="${k}"${disabled ? ' disabled' : ''}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ICON[icon]}"/></svg><span>${esc(label)}</span>${extra ? `<small>${esc(extra)}</small>` : ''}</button>`;
    const r = seekRange(), canSeek = !live || (r && r[1] - r[0] > 12);
    let menu = '';
    if (controlsMenu === 'eps') {
      if (!epsData) {
        menu = '<div class="tvc-menu tvc-eps"><h3>Episodes</h3><div class="tvc-line">Loading episodes…</div></div>';
      } else {
        const list = epsData.list, seasons = [...new Set(list.map((e) => e.season))].sort((a, b) => a - b);
        if (!seasons.includes(epsSeason)) epsSeason = seasons[0];
        const cur = O().state.current;
        menu = `<div class="tvc-menu tvc-eps"><h3>${esc(epsData.series || 'Episodes')}</h3>
          <div class="tvd-seasons">${seasons.map((s) => `<button class="tvd-season${s === epsSeason ? ' on' : ''}" data-k="s${s}" data-s="${s}">Season ${s}</button>`).join('')}</div>
          <div class="tvd-eps">${list.filter((e) => e.season === epsSeason).map((ep) => {
            const p = T().vod.progress(ep), now = cur && ep.id === cur.id;
            const st = now ? 'Now playing' : p?.d ? (p.t > p.d - 60 ? 'Watched' : `${fmtDur(p.t)} / ${fmtDur(p.d)}`) : '';
            return `<button class="tvd-ep${now ? ' now' : ''}" data-k="e${list.indexOf(ep)}" data-e="${list.indexOf(ep)}"><span class="n">${ep.episode || ''}</span><span class="t"><b>${esc(epTitle(ep, epsData.series))}</b></span><span class="s">${esc(st)}</span><span class="p">▶</span></button>`;
          }).join('')}</div></div>`;
      }
    } else if (controlsMenu === 'info') {
      const si = T().streamInfo?.() || {};
      const ENG = { native: 'Built-in player', mkv: 'MKV engine', hlsjs: 'HLS', mpegts: 'MPEG-TS' };
      const converted = (si.log || []).some((l) => /converting to AAC/i.test(l));
      // What the last attempt to fix the sound ran into (e.g. the MKV engine refusing the file)
      const problems = (si.log || []).filter((l) => /✗|switching|couldn.t convert|can.t play/i.test(l)).slice(-3).map((l) => l.replace(/^\S+ [AP]M /, '').replace(/https?:\/\/\S+/g, 'the file'));
      const heard = si.audioBytes === undefined ? null : si.audioBytes > 0;
      const row = (k, v, cls = '') => `<dt>${k}</dt><dd class="${cls}">${v}</dd>`;
      menu = `<div class="tvc-menu tvc-info"><h3>Stream info</h3><dl class="tvi-grid">
        ${row('Playing with', `${esc(ENG[si.engine] || si.engine || 'Built-in player')}${converted ? ' · audio converted for this TV' : ''}`)}
        ${row('Picture', si.w ? `${si.w}×${si.h}${si.videoBytes > 0 ? ' · decoding' : ''}` : 'not started')}
        ${row('Sound', heard === null ? 'unknown on this browser' : heard ? '✓ playing' : '⚠ no audio decoded', heard === false ? 'bad' : heard ? 'good' : '')}
        ${row('File', 'reading…', 'tvi-file')}
        ${row('Contains', 'reading…', 'tvi-contains')}
        ${(si.warnings || []).length ? row('Notes', (si.warnings || []).map(esc).join('<br>'), 'bad') : ''}
        ${problems.length ? row('Last problem', problems.map(esc).join('<br>'), 'bad') : ''}
      </dl><button class="tvc-opt" data-k="o:close">Close</button></div>`;
      T().probeStream?.().then((p) => {
        const f = controls.querySelector('.tvi-file'), c = controls.querySelector('.tvi-contains');
        if (!f || !c) return;
        if (p.error) { f.textContent = 'couldn’t read'; c.textContent = p.error; return; }
        f.textContent = p.container || 'unknown';
        c.innerHTML = (p.streams.length ? p.streams.map(esc).join(' · ') : 'nothing recognised') + (p.problems.length ? `<br><span class="bad">⚠ ${p.problems.map(esc).join('<br>⚠ ')}</span>` : '');
      }).catch((e) => { const f = controls.querySelector('.tvi-file'); if (f) f.textContent = `couldn’t read: ${e.message}`; });
    } else if (controlsMenu) {
      const list = controlsMenu === 'audio' ? tr.audio : [{ key: 'off', label: 'Off', on: !tr.text.some((x) => x.on) }, ...tr.text];
      menu = `<div class="tvc-menu"><h3>${controlsMenu === 'audio' ? 'Audio' : 'Captions'}</h3>${list.map((o) => `<button class="tvc-opt${o.on ? ' on' : ''}" data-k="o:${esc(o.key)}">${o.on ? '✓ ' : ''}${esc(o.label)}</button>`).join('')}</div>`;
    }
    controls.innerHTML = `<div class="tvc-panel">${menu}
      <div class="tvc-head"><b>${esc(title)}</b><span>${esc(sub)}</span></div>
      <div class="tvc-bar"><u></u></div><div class="tvc-times"><span class="tvc-l"></span><span class="tvc-r"></span></div>
      <div class="tvc-row">
        ${btn('back', 'back', '10 s', '', !canSeek)}
        ${btn('primary', v.paused ? 'play' : 'pause', v.paused ? 'Resume' : 'Pause')}
        ${btn('fwd', 'fwd', '10 s', '', !canSeek)}
        ${btn('audio', 'audio', 'Audio', tr.audio.length ? on(tr.audio) || '' : 'one track', !tr.audio.length)}
        ${btn('cc', 'cc', 'Captions', tr.text.length ? on(tr.text) || 'Off' : 'none', !tr.text.length)}
        ${c.kind === 'episode' && c.seriesId ? btn('eps', 'eps', 'Episodes', `S${pad2(c.season)}E${pad2(c.episode)}`) : ''}
        ${btn('info', silent ? 'warn' : 'info', 'Info', silent ? 'no sound' : '')}
        ${live ? btn('guide', 'guide', 'Guide') : ''}
      </div></div>`;
    const q = (s) => controls.querySelector(s);
    q('[data-k="primary"]').onclick = () => { T().togglePlay(); paintControls(); controls.querySelector('[data-k="primary"]')?.focus(); };
    q('[data-k="back"]').onclick = () => { const x = T().video, rg = seekRange(); x.currentTime = Math.max(rg && live ? rg[0] : 0, x.currentTime - 10); paintControlsBar(); };
    q('[data-k="fwd"]').onclick = () => { const x = T().video, rg = seekRange(); x.currentTime = Math.min(rg ? rg[1] : x.duration || x.currentTime + 10, x.currentTime + 10); paintControlsBar(); };
    q('[data-k="audio"]').onclick = () => { controlsMenu = 'audio'; paintControls(); controls.querySelector('.tvc-opt.on, .tvc-opt')?.focus(); };
    q('[data-k="cc"]').onclick = () => { controlsMenu = 'cc'; paintControls(); controls.querySelector('.tvc-opt.on, .tvc-opt')?.focus(); };
    q('[data-k="eps"]')?.addEventListener('click', () => {
      controlsMenu = 'eps'; epsData = null; epsFocusNow = true;
      paintControls();
      T().currentEpisodes?.().then((d) => {
        if (controlsMenu !== 'eps') return;
        epsData = d || { list: [], series: '' };
        epsSeason = O().state.current?.season ?? 0;
        paintControls();
      }).catch(() => { epsData = { list: [], series: '' }; paintControls(); });
    });
    for (const b of controls.querySelectorAll('.tvc-eps .tvd-season')) b.onclick = () => { epsSeason = +b.dataset.s; epsFocusNow = false; paintControls(); controls.querySelector(`.tvc-eps [data-k="s${epsSeason}"]`)?.focus(); };
    for (const b of controls.querySelectorAll('.tvc-eps .tvd-ep')) {
      b.onclick = () => {
        const ep = epsData.list[+b.dataset.e], p = T().vod.progress(ep);
        closeControls();
        T().vod.play(ep, p && p.t > 30 && p.t < p.d - 60 ? p.t : 0);
      };
    }
    if (controlsMenu === 'eps' && epsData && epsFocusNow) { epsFocusNow = false; const row = controls.querySelector('.tvc-eps .tvd-ep.now') || controls.querySelector('.tvc-eps .tvd-ep'); row?.focus(); row?.scrollIntoView({ block: 'center' }); }
    q('[data-k="info"]').onclick = () => { controlsMenu = 'info'; paintControls(); controls.querySelector('.tvc-opt')?.focus(); };
    q('[data-k="guide"]')?.addEventListener('click', () => { closeControls(); openHome(); });
    for (const b of controls.querySelectorAll('.tvc-opt')) {
      b.onclick = () => {
        const key = b.dataset.k.slice(2);
        if (controlsMenu === 'audio') T().setAudio(key); else if (controlsMenu === 'cc') T().setText(key);
        const was = controlsMenu;
        controlsMenu = '';
        paintControls();
        controls.querySelector(`[data-k="${was === 'audio' ? 'audio' : was === 'info' ? 'info' : 'cc'}"]`)?.focus();
      };
    }
    paintControlsBar();
  }

  // ---------- A single movie or show ----------
  // Poster and scores on the left; plot, actions and, for a show, seasons and episodes on the right. Everything on it
  // is a button, so ▲▼◀▶ move between them and OK presses.
  let dItem = null, dData = null, dSeason = null, dSeq = 0;
  const pad2 = (n) => String(n ?? 0).padStart(2, '0');
  function openDetail(item) {
    dItem = item; dData = null; dSeason = null;
    const seq = ++dSeq;
    document.documentElement.classList.add('detail-open');
    detail.classList.remove('hidden');
    ready();
    paintDetail();
    detail.querySelector('[data-k="primary"]')?.focus();
    T().vod.rating(item);
    T().vod.details(item).then((d) => { if (seq === dSeq) { dData = d; paintDetail(); } })
      .catch((e) => { if (seq === dSeq) { dData = e.message; paintDetail(); } });
  }
  function closeDetail(viaBack) {
    dSeq++;
    detail.classList.add('hidden');
    document.documentElement.classList.remove('detail-open');
    document.activeElement?.blur?.();
    if (viaBack && vodReturn) { vodReturn = false; openHome({ keepTab: true }); }
  }
  const playFromDetail = (item, at) => { vodReturn = false; closeDetail(false); T().vod.play(item, at || 0); };
  function paintDetail() {
    const item = dItem;
    if (!item) return;
    const keep = document.activeElement?.closest?.('#tvDetail') ? document.activeElement.dataset.k : null;
    const series = kindOf(item) === 'series';
    const r = T().vod.peek(item) || {}, { title, year } = T().vod.title(item);
    const d = !series && dData && typeof dData === 'object' ? dData : {};
    const eps = series && Array.isArray(dData) ? dData : null;
    const poster = item.logo || r.poster || d.poster;
    const plot = d.plot || item.plot || r.plot || '';
    const meta = [item.year || year || r.year, d.runtime || r.runtime, d.genre || item.genre || r.genre, r.rated || d.age].filter((x) => x && x !== 'N/A').map(esc).join(' · ');
    const badges = [
      r.rt != null ? `<span class="tvd-badge ${r.rt >= 60 ? 'fresh' : 'rotten'}">${r.rt >= 60 ? '🍅' : '🤢'} ${r.rt}%</span>` : '',
      r.imdb ? `<span class="tvd-badge">IMDb ${esc(r.imdb)}</span>` : '',
      r.metacritic != null ? `<span class="tvd-badge">Metacritic ${r.metacritic}</span>` : '',
      !r.rt && !r.imdb && +item.rating > 0 ? `<span class="tvd-badge">★ ${(+item.rating).toFixed(1)}</span>` : '',
    ].join('');
    const people = [
      (d.director || item.director || r.director) && `<span><i>Director</i> ${esc(d.director || item.director || r.director)}</span>`,
      (d.cast || item.cast || r.actors) && `<span><i>Cast</i> ${esc(String(d.cast || item.cast || r.actors).split(',').slice(0, 5).join(', '))}</span>`,
    ].filter(Boolean).join('');
    const prog = T().vod.progress(item);
    const canResume = !series && prog && prog.t > 30 && prog.t < prog.d - 60;
    let actions = '', lower = '';
    if (!series) {
      actions = `<button class="btn" data-k="primary">${canResume ? `▶ Resume ${fmtDur(prog.t)}` : '▶ Play'}</button>${canResume ? '<button class="btn ghost" data-k="restart">From the start</button>' : ''}`;
    } else if (!eps) {
      actions = `<button class="btn" data-k="primary" disabled>${typeof dData === 'string' ? 'Couldn’t load episodes' : 'Loading episodes…'}</button>`;
    } else if (!eps.length) {
      actions = '<button class="btn" data-k="primary" disabled>No episodes listed</button>';
    } else {
      const seasons = [...new Set(eps.map((e) => e.season))].sort((a, b) => a - b);
      if (!seasons.includes(dSeason)) { const w = eps.filter((e) => T().vod.progress(e)).pop(); dSeason = w ? w.season : seasons[0]; }
      // Carry on where you were: the episode you were part-way through, else the one after the last you finished
      let next = eps[0], label = `▶ Play S${pad2(next.season)}E${pad2(next.episode)}`, at = 0;
      const i = prog?.season != null ? eps.findIndex((e) => e.season === prog.season && e.episode === prog.episode) : -1;
      if (i >= 0) {
        const ep = eps[i], p = T().vod.progress(ep) || prog;
        if (p.t < p.d - 60) { next = ep; at = p.t > 30 ? p.t : 0; label = `▶ Continue S${pad2(ep.season)}E${pad2(ep.episode)}${at ? ` · ${fmtDur(at)}` : ''}`; }
        else if (eps[i + 1]) { next = eps[i + 1]; label = `▶ Next: S${pad2(next.season)}E${pad2(next.episode)}`; }
        else label = '✓ Watched all · play S01E01 again';
      }
      detail._next = { next, at };
      actions = `<button class="btn" data-k="primary">${esc(label)}</button>`;
      lower = `<div class="tvd-seasons">${seasons.map((s) => `<button class="tvd-season${s === dSeason ? ' on' : ''}" data-k="s${s}" data-s="${s}">Season ${s}</button>`).join('')}</div>
        <div class="tvd-eps">${eps.filter((e) => e.season === dSeason).map((ep, k) => {
          const p = T().vod.progress(ep);
          const st = p?.d ? (p.t > p.d - 60 ? 'Watched' : `${fmtDur(p.t)} / ${fmtDur(p.d)}`) : esc(ep.runtime || '');
          return `<button class="tvd-ep" data-k="e${k}" data-e="${eps.indexOf(ep)}"><span class="n">${ep.episode || ''}</span><span class="t"><b>${esc(epTitle(ep, T().vod.title(item).title))}</b>${ep.plot ? `<small>${esc(ep.plot)}</small>` : ''}</span><span class="s">${st}</span><span class="p">▶</span></button>`;
        }).join('')}</div>`;
    }
    const fav = T().isFav(item.id);
    detail.innerHTML = `<div class="tvd-card${series ? ' series' : ''}">
      <div class="tvd-side"><div class="tvd-poster">${poster ? `<img alt="" src="${esc(poster)}" referrerpolicy="no-referrer">` : `<em>${esc(title || item.name)}</em>`}</div></div>
      <div class="tvd-main">
        <h1>${esc(r.title || title || item.name)}</h1>
        <div class="tvd-meta">${meta}</div>
        <div class="tvd-badges">${badges}</div>
        <p class="tvd-plot">${esc(plot)}</p>
        ${series ? '' : `<div class="tvd-people">${people}</div>`}
        <div class="tvd-actions">${actions}<button class="btn ghost" data-k="fav">${fav ? '★ Favorite' : '☆ Favorite'}</button></div>
        ${lower}
      </div></div>`;
    const img = detail.querySelector('.tvd-poster img');
    if (img) img.onerror = () => img.replaceWith(el('em', '', esc(title || item.name)));
    const q = (s) => detail.querySelector(s);
    q('[data-k="primary"]').onclick = () => {
      if (series) { const { next, at } = detail._next || {}; if (next) playFromDetail(next, at); }
      else playFromDetail(item, canResume ? prog.t : 0);
    };
    q('[data-k="restart"]')?.addEventListener('click', () => playFromDetail(item, 0));
    q('[data-k="fav"]').onclick = () => { T().toggleFav(item); paintDetail(); };
    for (const b of detail.querySelectorAll('.tvd-season')) b.onclick = () => { dSeason = +b.dataset.s; paintDetail(); detail.querySelector(`[data-k="s${dSeason}"]`)?.focus(); };
    for (const b of detail.querySelectorAll('.tvd-ep')) {
      b.onclick = () => { const ep = eps[+b.dataset.e], p = T().vod.progress(ep); playFromDetail(ep, p && p.t > 30 && p.t < p.d - 60 ? p.t : 0); };
    }
    if (keep) detail.querySelector(`[data-k="${CSS.escape(keep)}"]`)?.focus();
    else if (!detail.contains(document.activeElement)) detail.querySelector('[data-k="primary"]:not(:disabled)')?.focus(); // the episodes just arrived
  }

  // ---------- Setup: link a phone ----------
  const body = $('tvsBody');
  const fmt = (c) => `${c.slice(0, 4)} ${c.slice(4)}`;
  const needsSetup = () => !WEB && !dismissed && (!P().active() || !P().doc.playlists.length);
  function renderSetup(html, focusSel) {
    body.innerHTML = html;
    hideOsd();
    closeHome();
    setup.classList.remove('hidden');
    document.documentElement.classList.add('setup-open'); // keeps the app's toasts off the setup card
    ready();
    document.querySelector(focusSel || '#tvsSkip')?.focus();
  }
  // Same Wi-Fi: the phone finds this TV by itself. Anywhere else: scan the code with the phone's camera.
  const steps = (code) => `
    <h1>Set up Tuner on your phone</h1>
    <div class="tvs-split">
      <ol>
        <li>On your phone, open <b>${esc(host)}</b></li>
        <li>On the same Wi-Fi this TV appears there. Tap <b>Link</b>.</li>
        <li>Add your playlist. It shows up here by itself.</li>
      </ol>
      <div class="tvs-scan">
        <div class="tvs-qr" aria-hidden="true"></div>
        <div class="muted">Not on this Wi-Fi? Scan to link.</div>
        <div class="tvs-code">${code ? esc(fmt(code)) : '…'}</div>
      </div>
    </div>`;
  // The QR is drawn after the screen (the generator loads on demand and is small)
  const paintQr = (code) => import('./qr.js').then(({ styledQr }) => {
    const box = setup.querySelector('.tvs-qr');
    if (box && code) box.innerHTML = styledQr(`${location.origin}/?tv=${code}`);
  }).catch(() => { /* the typed code is still there */ });
  function confirmLink(name) {
    return new Promise((done) => {
      renderSetup(`<h1>Link this TV to “${esc(name)}”?</h1><p class="muted">A phone is asking to share its profile with this TV. Only allow it if that was you.</p>
        <div class="tvs-actions"><button id="tvsAllow" class="btn">Allow</button><button id="tvsDeny" class="btn ghost">Deny</button></div>`, '#tvsAllow');
      $('tvsAllow').onclick = () => done(true);
      $('tvsDeny').onclick = () => done(false);
    });
  }
  async function runSetup() {
    if (running) return;
    running = true;
    try {
      while (needsSetup()) {
        const p = P();
        if (p.active()) {
          renderSetup(`<h1>Linked to “${esc(p.active().name)}”</h1><p>Now add a playlist on your phone, under <b>Playlists</b>. It will appear here automatically.</p>`);
          await sleep(4000);
          await p.pull();
          continue;
        }
        let req;
        try { req = await p.tvRequest(); } catch (e) {
          renderSetup(`<h1>Can’t set up linking</h1><p class="muted">${esc(e.message)}</p>`);
          await sleep(8000);
          continue;
        }
        renderSetup(steps(req.code));
        paintQr(req.code);
        abort = new AbortController();
        liveCode = req.code;
        const got = await p.tvWait(req, abort.signal).catch(() => null);
        if (!got) { p.tvCancel(req.code); liveCode = null; continue; } // expired (new code next round) or Skip pressed
        liveCode = null;
        if (await confirmLink(got.name)) {
          try { await p.join(got.token, got.name); } catch (e) {
            renderSetup(`<h1>Couldn’t link</h1><p class="muted">${esc(e.message)}</p>`);
            await sleep(5000);
          }
        }
      }
    } finally {
      setup.classList.add('hidden');
      html.classList.remove('setup-open');
      running = false;
      // Playlists arrived but nothing is loaded yet (the phone hadn't set a "last playlist").
      const o = O(), first = o.profiles.doc.playlists[0];
      if (!dismissed && first && !o.state.channels.length) o.loadPlaylist(first.url, first.name, { fresh: false });
      settleOnHome();
    }
  }
  $('tvsSkip').onclick = () => { dismissed = true; abort?.abort(); setup.classList.add('hidden'); html.classList.remove('setup-open'); settleOnHome(); };

  // With nothing playing, the useful screen is the channel list, not a black picture.
  async function settleOnHome() {
    for (let i = 0; i < 40 && !T().live().length && !O().state.channels.length; i++) await sleep(250);
    if (screen() === 'player' && !O().state.current) { if (WEB && !O().state.channels.length) tab = 'phone'; openHome(); }
  }

  // ---------- Keys ----------
  const FOCUSABLE = 'button, a[href], input, select, textarea, summary, [tabindex], .channel-list li, .gcard';
  const visible = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !e.disabled && getComputedStyle(e).visibility !== 'hidden'; };
  // Nearest focusable in a direction; the off-axis gap counts double so rows don't jump to far-away controls.
  function move(root, dx, dy) {
    const cur = document.activeElement && root.contains(document.activeElement) ? document.activeElement : null;
    const items = [...root.querySelectorAll(FOCUSABLE)].filter(visible);
    if (!items.length) return;
    if (!cur) { items[0].focus(); return; }
    const a = cur.getBoundingClientRect(), ax = a.left + a.width / 2, ay = a.top + a.height / 2;
    let best = null, bestScore = Infinity;
    for (const e of items) {
      if (e === cur) continue;
      const r = e.getBoundingClientRect();
      const ex = r.left + r.width / 2 - ax, ey = r.top + r.height / 2 - ay;
      const along = dx ? ex * dx : ey * dy, across = Math.abs(dx ? ey : ex);
      if (along <= 1) continue;
      const score = along + across * 2;
      if (score < bestScore) { bestScore = score; best = e; }
    }
    if (best) {
      best.focus();
      best.scrollIntoView({ block: dy ? 'center' : 'nearest', inline: 'nearest' });
      if (best.classList.contains('tvh-row') && !best.nextElementSibling && shown < listCache.length) addRows();
      else if (best.classList.contains('tvh-row') && shown < listCache.length && !best.nextElementSibling?.nextElementSibling) addRows();
    }
  }

  const DIR = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

  // Home is three sections: the tab bar on top, the group column on the left, the list on the right. Moving
  // between sections follows a fixed map instead of "nearest thing in that direction", which from the middle
  // of a long list never reached the tabs.
  //   tabs:    ◀ ▶ across the tabs (and the version tag), ▼ into the list
  //   groups:  ▶ to the list, ◀ or ▲ from the first group to the tabs
  //   list:    ◀ to the groups, ▲ from the first row to the tabs
  // Returns true when it handled the key; anything else (▲▼ inside a list) is left to the normal movement.
  function homeNav(key, e) {
    const t = document.activeElement;
    const picture = $('flatStage');
    if (guideSession && tab === 'live' && t === picture) {
      if (key === 'ArrowLeft') {
        const target = guidePictureReturn && home.contains(guidePictureReturn) && visible(guidePictureReturn)
          ? guidePictureReturn
          : bodyEl.querySelector('.tvh-row.playing') || bodyEl.querySelector('.tvh-row') || chipsEl.querySelector('.tvh-chip');
        target?.focus();
      }
      return true;
    }
    const tabs = [...tabsEl.querySelectorAll('.tvh-tab'), ...(verEl ? [verEl] : [])];
    const toTabs = () => (tabsEl.querySelector('.tvh-tab.on') || tabs[0])?.focus();
    if (tabs.includes(t)) {
      const i = tabs.indexOf(t);
      if (key === 'ArrowLeft') tabs[Math.max(0, i - 1)].focus();
      else if (key === 'ArrowRight') tabs[Math.min(tabs.length - 1, i + 1)].focus();
      else if (key === 'ArrowDown') {
        if (t.dataset.tab === 'movie' || t.dataset.tab === 'series') goTab(t.dataset.tab);
        commitView();
        focusFirstInBody();
      }
      return true; // ▲ stays on the tab bar
    }
    if (t?.classList.contains('tvh-chip')) {
      const chips = [...chipsEl.querySelectorAll('.tvh-chip')];
      if (key === 'ArrowRight') { focusFirstInBody(); return true; }
      if (key === 'ArrowLeft' || (key === 'ArrowUp' && chips[0] === t)) { toTabs(); return true; }
      return false;
    }
    if (tab === 'search' && (t?.classList.contains('tvh-search-input') || t?.matches('.tvh-search-form button'))) {
      if (key === 'ArrowDown') {
        const firstResult = bodyEl.querySelector('.tvh-search-results .tvh-row');
        if (firstResult) firstResult.focus();
        else if (t.classList.contains('tvh-search-input')) bodyEl.querySelector('.tvh-search-form button')?.focus();
        return true;
      }
      if (key === 'ArrowUp' && t.classList.contains('tvh-search-input')) { toTabs(); return true; }
    }
    if (t?.classList.contains('tvh-row')) {
      const chip = (tab === 'live' || tab === 'vod') && !chipsEl.classList.contains('hidden') ? (chipsEl.querySelector('.tvh-chip.on') || chipsEl.querySelector('.tvh-chip')) : null;
      const grid = bodyEl.classList.contains('grid');
      const first = bodyEl.querySelector('.tvh-row');
      if (key === 'ArrowLeft') {
        // In a grid, ◀ steps to the tile on the left; from the left-most column it opens the categories
        const prev = t.previousElementSibling;
        if (grid && prev?.classList.contains('tvh-row') && prev.offsetTop === t.offsetTop) { prev.focus(); return true; }
        (chip || tabsEl.querySelector('.tvh-tab.on'))?.focus();
        return true;
      }
      if (key === 'ArrowRight' && guideSession && tab === 'live') {
        const rect = t.getBoundingClientRect();
        const hasTileToRight = grid && [...bodyEl.querySelectorAll('.tvh-row')].some((row) => row !== t && row.offsetTop === t.offsetTop && row.getBoundingClientRect().left > rect.left);
        if (!hasTileToRight && focusGuidePicture(t)) return true;
      }
      if (key === 'ArrowUp' && (grid ? first.offsetTop === t.offsetTop : first === t)) { toTabs(); return true; }
      if (key === 'ArrowUp' && tab === 'search' && first === t) { bodyEl.querySelector('.tvh-search-input')?.focus(); return true; }
      if (key === 'ArrowDown') {
        moveRepeated(bodyEl, key, e);
        return true;
      }
      return false;
    }
    // Phone tab: ▲ from the first control goes up to the tabs
    if (bodyEl.contains(t) && key === 'ArrowUp' && bodyEl.querySelector('button') === t) { toTabs(); return true; }
    return false;
  }
  let synthetic = false, heldDirection = '', heldDirectionAt = 0;
  function moveRepeated(root, key, e) {
    const [dx, dy] = DIR[key];
    if (key !== 'ArrowUp' && key !== 'ArrowDown') return move(root, dx, dy);
    if (!e.repeat || heldDirection !== key) { heldDirection = key; heldDirectionAt = Date.now(); }
    const steps = e.repeat && Date.now() - heldDirectionAt > 650 ? 3 : 1;
    for (let i = 0; i < steps; i++) move(root, dx, dy);
  }
  const backKey = (k) => k === 'Escape' || k === 'GoBack' || k === 'BrowserBack';

  function goBack() {
    const s = screen();
    if (s === 'setup') { $('tvsSkip').click(); return true; }
    if (s === 'settings') { closeSettings(); return true; }
    if (s === 'gallery') {
      synthetic = true;
      (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      synthetic = false;
      return true;
    }
    if (s === 'controls') { if (controlsMenu) { controlsMenu = ''; paintControls(); controls.querySelector('[data-k="primary"]')?.focus(); } else closeControls(); return true; } // Back closes the bar without changing playback
    if (s === 'detail') { closeDetail(true); return true; }
    if (s === 'home') {
      if (tab === 'search' && document.activeElement === bodyEl.querySelector('.tvh-search-input')) {
        document.activeElement.blur();
        tabsEl.querySelector('.tvh-tab[data-tab="search"]')?.focus();
        return true;
      }
      // With a picture behind it, Back returns to the picture (no channel banner). With nothing playing there is
      // nowhere to return to, so Back leaves the app.
      if (!document.documentElement.classList.contains('tv-picture') || !O().state.current) return false;
      closeHome();
      return true;
    }
    if (s === 'player') { openHome({ menu: true }); return true; } // Back while watching opens the main menu (◀ opens the guide)
    return false;
  }

  addEventListener('keydown', (e) => {
    lastKey = Date.now();
    if (synthetic) return;
    const s = screen();
    const typing = e.target.matches?.('input, textarea, select');
    if (backKey(e.key)) {
      if (s === 'gallery') return; // the gallery steps back out of a preview itself
      if (goBack()) { e.preventDefault(); e.stopImmediatePropagation(); }
      return;
    }
    if (s !== 'player') {
      const root = s === 'setup' ? setup : s === 'gallery' ? $('gallery') : s === 'detail' ? detail : s === 'settings' ? $('panel') : s === 'controls' ? controls : home;
      if (typing && (!DIR[e.key] || e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return; // let the keyboard type
      if (s === 'controls' && e.key === 'ArrowUp' && !isVod() && !controlsMenu) {
        e.preventDefault(); e.stopImmediatePropagation();
        closeControls();
        openHome();
        return;
      }
      if (s === 'home' && DIR[e.key] && homeNav(e.key, e)) { e.preventDefault(); e.stopImmediatePropagation(); return; }
      if (DIR[e.key]) {
        e.preventDefault(); e.stopImmediatePropagation();
        const scroll = s === 'gallery' ? document.activeElement?.closest?.('.gallery-scroll') : null;
        moveRepeated(scroll || root, e.key, e);
        return;
      }
      if ((e.key === 'Enter' || (e.key === ' ' && document.activeElement === $('flatStage'))) && !typing) {
        const t = document.activeElement;
        if (s === 'home' && t?.classList.contains('tvh-row')) {
          // Press plays, hold favorites.
          e.preventDefault(); e.stopImmediatePropagation();
          if (e.repeat) { if (!holdFired && rowPressed) { holdFired = true; toggleFavRow(t); } return; }
          holdFired = false;
          rowPressed = true; // the release that follows this press plays the row
          return;
        }
        if (t && t !== document.body) { e.preventDefault(); e.stopImmediatePropagation(); t.click(); }
        return;
      }
      if (!typing && e.key.length === 1 && e.key !== ' ') e.stopImmediatePropagation(); // no letter shortcuts while browsing
      return;
    }
    // The picture.
    const vod = isVod();
    switch (e.key) {
      // ▲ opens the controls; ▼ browses the playing channel's list. Channel buttons still zap directly.
      case 'ArrowUp':
        e.preventDefault(); e.stopImmediatePropagation();
        openControls();
        break;
      case 'ArrowDown':
        e.preventDefault(); e.stopImmediatePropagation();
        if (vod) showOsd(); else openHome({ browse: 1 });
        break;
      case 'ChannelUp':
        e.preventDefault(); e.stopImmediatePropagation();
        if (vod) showOsd(); else surf(1);
        break;
      case 'ChannelDown':
        e.preventDefault(); e.stopImmediatePropagation();
        if (vod) showOsd(); else surf(-1);
        break;
      case 'ArrowLeft':
        e.preventDefault(); e.stopImmediatePropagation();
        if (vod) seekBy(-10); else openHome();
        break;
      case 'ArrowRight':
        e.preventDefault(); e.stopImmediatePropagation();
        if (vod) seekBy(10); else showOsd();
        break;
      case 'Enter':
        e.preventDefault(); e.stopImmediatePropagation();
        if (e.repeat) break;
        if (!nativeAppleControls) { T().togglePlay(); showOsd(); } // Apple’s native media controls handle playback on iOS
        break;
      default:
        if (e.key.length === 1 && e.key !== ' ') e.stopImmediatePropagation(); // the phone UI's letter shortcuts open hidden panels
    }
  }, true);

  addEventListener('keyup', (e) => {
    if (e.key === heldDirection) { heldDirection = ''; heldDirectionAt = 0; }
    if (e.key !== 'Enter') return;
    const pressed = rowPressed;
    rowPressed = false;
    // Ignore the release of the press that opened Home: it didn't start on a row.
    if (!pressed || screen() !== 'home') { holdFired = false; return; }
    const t = document.activeElement;
    if (t?.classList.contains('tvh-row') && !holdFired) {
      const ch = listCache[+t.dataset.i];
      if (ch?._day) { showTomorrow = !showTomorrow; if (showTomorrow) sports.wantTomorrow(); computeNow(true); renderChips(); renderBody(false); bodyEl.querySelector('.tvh-row.daybtn')?.focus(); }
      else if (ch && (tab === 'vod' || (tab === 'search' && kindOf(ch) !== 'live'))) {
        if (tab === 'search') searchRestoreI = +t.dataset.i;
        openVod(ch, +t.dataset.i);
      }
      else if (ch) { closeHome(); T().play(ch._real || ch); }
    }
    holdFired = false;
  }, true);

  function toggleFavRow(row) {
    const ch = listCache[+row.dataset.i];
    if (!ch || ch._day) return;
    T().toggleFav(ch._real || ch);
    row.querySelector('.star').style.visibility = T().isFav(ch.id) ? 'visible' : 'hidden';
    T().toast(T().isFav(ch.id) ? 'Added to favorites' : 'Removed from favorites');
    if (tab === 'vod') return;
    if (group === FAV) renderBody();
    else renderChips();
  }

  // ---------- Hooks for the Android activity ----------
  window.tunerTV = {
    key(action) {
      const v = T().video, c = O().state.current;
      if (action === 'playpause') { T().togglePlay(); if (screen() === 'controls') paintControls(); else showOsd(); }
      else if (action === 'play') { if (v.paused) T().togglePlay(); if (screen() === 'controls') paintControls(); else showOsd(); }
      else if (action === 'pause') { if (!v.paused) T().togglePlay(); if (screen() === 'controls') paintControls(); else showOsd(); }
      else if (action === 'next') { if (c && kindOf(c) === 'live') surf(1); else showOsd(); }
      else if (action === 'prev') { if (c && kindOf(c) === 'live') surf(-1); else showOsd(); }
      else if (action === 'ff') seekBy(10);
      else if (action === 'rw') seekBy(-10);
    },
    // Called by the activity on Back. True if the page used it; false means leave the app.
    back: () => goBack(),
  };

  addEventListener('pagehide', () => { if (liveCode) P().tvCancel(liveCode); });

  // ---------- Playlists arriving from the phone ----------
  // Edits made on the phone land here within a minute (or when Home opens); say so and show them.
  let seen = null;
  const sig = () => JSON.stringify(P().doc.playlists.map((l) => l.key));
  function watchPlaylists() {
    const now = sig();
    if (seen === null) { seen = now; return; }
    if (now === seen) return;
    const before = new Set(JSON.parse(seen));
    seen = now;
    const added = P().doc.playlists.filter((l) => !before.has(l.key));
    if (isOpen.home() && tab === 'phone') renderPhone();
    if (!added.length) return;
    const o = O();
    // Nothing on screen yet: just start the new playlist. Otherwise leave the picture alone and say it's there.
    if (!o.state.current && !o.state.channels.length) o.loadPlaylist(added[0].url, added[0].name, { fresh: false });
    else T().toast(`New from your phone: ${added[0].name}. Home → Settings to switch.`);
  }
  // ---------- Touch (Tuner view in a browser) ----------
  if (WEB) {
    // Rows play on a tap; a long press favorites (the remote's "hold OK")
    let pressTimer = 0, swallow = false;
    bodyEl.addEventListener('pointerdown', (e) => {
      const row = e.target.closest?.('.tvh-row');
      clearTimeout(pressTimer);
      if (!row || row.classList.contains('daybtn')) return;
      pressTimer = setTimeout(() => { swallow = true; toggleFavRow(row); navigator.vibrate?.(15); }, 650);
    });
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) bodyEl.addEventListener(ev, () => clearTimeout(pressTimer));
    bodyEl.addEventListener('scroll', () => clearTimeout(pressTimer), { passive: true });
    bodyEl.addEventListener('contextmenu', (e) => e.preventDefault());
    bodyEl.addEventListener('click', (e) => {
      const t = e.target.closest?.('.tvh-row');
      if (!t || screen() !== 'home') return;
      if (swallow) { swallow = false; return; }
      const ch = listCache[+t.dataset.i];
      if (ch?._day) { showTomorrow = !showTomorrow; if (showTomorrow) sports.wantTomorrow(); computeNow(true); renderChips(); renderBody(false); }
      else if (ch && (tab === 'vod' || (tab === 'search' && kindOf(ch) !== 'live'))) {
        if (tab === 'search') searchRestoreI = +t.dataset.i;
        openVod(ch, +t.dataset.i);
      }
      else if (ch) { closeHome(); T().play(ch._real || ch); }
    });
    // Visible Back / Close, since there is no Back key
    const mkBtn = (cls, label, fn) => { const b = el('button', `web-btn ${cls}`, label); b.onclick = fn; document.body.append(b); return b; };
    mkBtn('web-menu', '☰ Menu', () => { if (screen() === 'controls') closeControls(); if (screen() === 'player') openHome({ menu: true }); });
    mkBtn('web-back', '‹ Back', () => goBack());
    const x = el('button', 'tvh-x', '✕ Picture'); x.onclick = () => goBack(); tabsEl.append(x);
    new MutationObserver(() => { if (!tabsEl.contains(x)) tabsEl.append(x); }).observe(tabsEl, { childList: true });
    // Tap the picture for the controls (pause, seek, audio, captions, episodes, guide)
    $('flatStage')?.addEventListener('click', () => {
      if (screen() === 'home' && guideSession && tab === 'live') closeHome();
      else if (!nativeAppleControls && screen() === 'player' && O().state.current) openControls();
    });
    controls.addEventListener('click', (e) => { if (e.target === controls) goBack(); }); // tap outside the bar
    detail.addEventListener('click', (e) => { if (e.target === detail) goBack(); });
  }

  // ---------- Boot ----------
  const boot = () => {
    nativeAppleControls = WEB && !!T().nativeVideoControls;
    T().onRating?.(onRatingArrived);
    T().vod?.onClosed((viaBack) => { if (viaBack && vodReturn) { vodReturn = false; openHome({ keepTab: true }); } });
    import('./qr.js').catch(() => {}); // warm the cache so the setup screen draws its code at once
    T().video.controls = nativeAppleControls;
    // Android WebView draws a large grey play icon on a <video> that has nothing to show; a transparent poster replaces it.
    T().video.poster = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
    checkUpdate('timer'); // sets the baseline
    watchPlaylists();
    setInterval(watchPlaylists, 4000);
    if (needsSetup()) runSetup(); else settleOnHome();
  };
  if (window.o3xr) boot(); else addEventListener('o3xr-ready', boot, { once: true });
}
