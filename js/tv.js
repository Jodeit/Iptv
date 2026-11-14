// The TV interface. Only active inside the Android TV app, whose WebView adds "TunerTV" to the
// user agent; everywhere else this file does nothing. The phone UI's chrome (top bar, drawer,
// guide, pop-out player) is hidden there and replaced by three things:
//
//   Player   the video, full screen, nothing on top. A small overlay appears on any key.
//   Home     one screen on the left, video still playing on the right: tabs Live | Movies | Shows |
//            Phone; Live is a group row over a channel list with what's on now. No submenus.
//   Setup    shown when no profile/playlist: a phone on the same Wi-Fi sends its profile (js/profiles.js).
//
// Remote:  Player: ▲▼ channel, OK or ◀ Home, ▶ info.  (Movies/shows: OK pause, ◀▶ skip, ▲▼ info.)
//          Home: arrows move, OK plays, hold OK = favorite, Back returns to the picture.
//          Back on the picture leaves the app.

import { kindOf } from './filter.js';
import { genreOf, GENRES } from './genre.js';
import * as sports from './sports.js';
import { VERSION } from './version.js';

if (/TunerTV/.test(navigator.userAgent)) initTV();

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
  document.body.append(osd, home, setup);
  const tabsEl = home.querySelector('.tvh-tabs'), chipsEl = home.querySelector('.tvh-chips'), bodyEl = home.querySelector('.tvh-body'), infoEl = home.querySelector('.tvh-info');

  // ---------- State ----------
  let tab = 'live';            // 'live' | 'phone' (Movies and Shows open the poster gallery)
  let group = '';              // '' = all, FAV = favorites, else a group name
  const FAV = '\u0000fav';
  // 'channels' browses the provider's folders; 'now' groups by what is airing right now (Sports, Movies, News…)
  // Remembered once you pick one (by choosing it, not by passing over its tab); until then On now is the default
  // when the provider has a guide, and Channels when it has none.
  let viewChosen = false;
  let view = (() => { try { const v = localStorage.getItem('tvView'); if (v === 'now' || v === 'channels') { viewChosen = true; return v; } } catch { /* fine */ } return 'now'; })();
  const autoView = () => { if (!viewChosen) view = T().guide.available() ? 'now' : 'channels'; };
  let genre = '';              // '' = everything on now
  let dismissed = false, running = false, abort = null, liveCode = null;
  const isOpen = { home: () => !home.classList.contains('hidden'), setup: () => !setup.classList.contains('hidden'), gallery: () => !!O()?.tv.galleryOpen() };
  const screen = () => (isOpen.setup() ? 'setup' : isOpen.gallery() ? 'gallery' : isOpen.home() ? 'home' : 'player');
  const isVod = () => { const c = O()?.state.current; return !!c && kindOf(c) !== 'live'; };

  // ---------- Channel list helpers ----------
  // Providers pad names with '######' banners and the like; show them tidied, keep the real name for playback.
  const cleanName = (n) => String(n || '').replace(/^[#*=\-_\s]+|[#*=\-_\s]+$/g, '').replace(/\s{2,}/g, ' ') || String(n || '');
  const liveAll = () => T().live();
  const groups = () => [...new Set(liveAll().map((c) => c.group).filter(Boolean))];
  const visibleList = () => {
    if (view === 'now') {
      computeNow();
      if (genre === SCORES) return scoreData.map((x) => x.ch);
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
    // Scoreboard: channels carrying a live or upcoming game. A channel whose guide says something vaguer
    // (or nothing) still gets an entry, so you can pick from the games rather than the programme titles.
    scoreData = [];
    for (const ch of liveAll()) {
      const sp = sports.gameFor(ch);
      if (!sp) continue;
      let x = nowMap.get(ch);
      if (x) x.sc = sp; else { x = { ch, p: { title: sp.title, start: 0, stop: 0 }, genre: 'Sports', synth: true, sc: sp }; nowMap.set(ch, x); }
      scoreData.push(x);
    }
    scoreData.sort((a, b) => (b.sc.live - a.sc.live) || a.sc.start - b.sc.start);
  }
  let scoreData = [];
  const SCORES = '__scores';
  // A scoreboard arrived: swap "College Football" for the game in the rows already on screen
  sports.onChange(() => {
    if (view !== 'now' || !isOpen.home()) return;
    computeNow(true);
    for (const row of bodyEl.querySelectorAll('.tvh-row')) {
      const ch = listCache[+row.dataset.i], it = ch && nowMap.get(ch);
      if (!it) continue;
      if (!row.classList.contains('game')) row.querySelector('b').textContent = titleOf(it);
      paintRow(row, ch);
    }
    const f = document.activeElement?.closest?.('.tvh-row');
    if (f) paintInfo(listCache[+f.dataset.i]);
  });
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
  function paintOsd() {
    const o = O(), c = o.state.current;
    if (!c) return;
    const v = T().video, live = kindOf(c) === 'live';
    const logo = osd.querySelector('.osd-logo');
    if (c.logo) { logo.referrerPolicy = 'no-referrer'; if (logo.getAttribute('src') !== c.logo) logo.src = c.logo; } else logo.removeAttribute('src');
    osd.querySelector('.osd-name').textContent = c.name;
    let sub = c.group || '', pct = null;
    if (live) {
      const nn = T().guide.nowNext(c);
      if (nn?.now) {
        sub = `${nn.now.title}  ·  until ${fmtClock(nn.now.stop)}${nn.next ? `  ·  next ${nn.next.title}` : ''}`;
        pct = ((Date.now() - nn.now.start) / (nn.now.stop - nn.now.start)) * 100;
      }
    } else if (Number.isFinite(v.duration) && v.duration > 0) {
      sub = `${v.paused ? '⏸ ' : ''}${fmtDur(v.currentTime)} / ${fmtDur(v.duration)}`;
      pct = (v.currentTime / v.duration) * 100;
    }
    osd.querySelector('.osd-sub').textContent = sub;
    const bar = osd.querySelector('.osd-bar');
    bar.classList.toggle('on', pct != null);
    if (pct != null) bar.firstElementChild.style.width = `${Math.min(100, Math.max(0, pct))}%`;
    osd.querySelector('.osd-hint').textContent = updateReady ? 'Update ready: installs when you pause or leave' : live ? '▲▼ channel     OK channels' : '◀ ▶ skip     OK pause';
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
      verEl.textContent = updateReady ? `Update ${latest && latest !== VERSION ? `to ${latest} ` : ''}ready: press OK` : `Tuner ${VERSION} ↻`;
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
    if (liveAll().length) defs.push(['now', 'On now'], ['live', 'Channels']);
    if (T().hasKind('movie')) defs.push(['movie', 'Movies']);
    if (T().hasKind('series')) defs.push(['series', 'Shows']);
    defs.push(['phone', 'Phone']);
    if (tab === 'live' && !defs.some(([k]) => k === 'live')) tab = 'phone';
    const ver = el('button', 'tvh-version', '');
    ver.onclick = () => location.reload();
    verEl = ver;
    paintVersion();
    for (const [k, label] of defs) {
      const b = el('button', 'tvh-tab', esc(label));
      b.dataset.tab = k;
      b.onclick = () => {
        if (k === 'movie' || k === 'series') { closeHome(); T().openGallery(k); } else { goTab(k); commitView(); focusFirstInBody(); }
      };
      // Channels, On now and Phone switch as soon as they get focus, so ◀ ▶ browses without pressing OK.
      b.onfocus = () => { if (k !== 'movie' && k !== 'series') goTab(k); };
      tabsEl.append(b);
    }
    tabsEl.append(ver);
    markTabs();
  }
  const markTabs = () => {
    for (const b of tabsEl.querySelectorAll('.tvh-tab')) {
      const k = b.dataset.tab;
      b.classList.toggle('on', k === 'phone' ? tab === 'phone' : k === 'live' ? tab === 'live' && view === 'channels' : k === 'now' ? tab === 'live' && view === 'now' : false);
    }
  };
  // Remember the view when you actually use it (OK, or ▼ into the list), not merely by passing over its tab.
  function commitView() {
    if (tab !== 'live') return;
    viewChosen = true;
    try { localStorage.setItem('tvView', view); } catch { /* fine */ }
  }
  // Switch what the body shows: 'live' (Channels), 'now' (On now) or 'phone'.
  function goTab(k) {
    const nextTab = k === 'phone' ? 'phone' : 'live';
    const nextView = k === 'now' ? 'now' : 'channels';
    if (nextTab === tab && (nextTab === 'phone' || nextView === view)) { markTabs(); return; }
    tab = nextTab;
    if (tab === 'live') {
      view = nextView; genre = ''; group = '';
      if (view === 'now') { ensureGuide(); computeNow(true); }
    }
    markTabs();
    renderBody();
  }
  function focusFirstInBody() {
    (bodyEl.querySelector('.tvh-row.playing') || bodyEl.querySelector('button'))?.focus();
  }

  function renderChips() {
    chipsEl.innerHTML = '';
    chipsEl.classList.toggle('hidden', tab !== 'live');
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
    const side = (t, lead) => `<div class="tm${t.won || lead ? ' lead' : ''}">${t.logo ? `<img class="tl" alt="" src="${esc(t.logo)}" referrerpolicy="no-referrer">` : '<i class="tl"></i>'}<span class="tn">${t.rank ? `<em>${t.rank}</em>` : ''}${esc(t.name)}</span><b class="ts">${esc(String(t.score))}</b></div>`;
    const a = +g.away.score, h = +g.home.score, live = g.live && !isNaN(a) && !isNaN(h);
    b.innerHTML = `<span class="g-teams">${side(g.away, live && a > h)}${side(g.home, live && h > a)}</span>
      <span class="g-state ${g.live ? 'live' : ''}"><b>${esc(g.period)}</b><small>${ch.logo ? `<img alt="" src="${esc(ch.logo)}" referrerpolicy="no-referrer">` : ''}<span>${esc(ch.clean || cleanName(ch.name))}</span></small></span>
      <span class="star">★</span>`;
    b.querySelector('.star').style.visibility = T().isFav(ch.id) ? 'visible' : 'hidden';
  }
  function rowFor(ch, i) {
    const b = el('button', 'tvh-row');
    const gm = scoreView() && nowMap.get(ch)?.sc;
    if (gm) {
      b.dataset.i = i;
      b.classList.add('game');
      b.classList.toggle('playing', ch === O().state.current);
      fillGame(b, ch, gm);
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
  const titleOf = (it) => (scoreView() && it.sc ? it.sc.title : it.sp?.title || it.p.title);
  function paintRow(b, ch) {
    if (b.classList.contains('game')) { const g = nowMap.get(ch)?.sc; if (g) fillGame(b, ch, g); return; }
    if (view === 'now') {
      const it = nowMap.get(ch);
      if (!it) return;
      const small = b.querySelector('small'), prog = b.querySelector('.prog');
      if (scoreView() && it.sc) {
        small.textContent = `${ch.clean || cleanName(ch.name)}  ·  ${it.sc.status}`;
        small.style.display = '';
        prog.classList.remove('on');
        return;
      }
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
    next.forEach((ch, k) => bodyEl.append(rowFor(ch, shown + k)));
    shown += next.length;
  }
  let holdFired = false, rowPressed = false;

  // The highlighted channel in full: name, group, what's on and what's next. Long provider names are cut off
  // in the list, so this is where you can always tell two similar channels apart.
  function paintInfo(ch) {
    if (!ch) { infoEl.classList.add('hidden'); return; }
    const nn = T().guide.nowNext(ch);
    const parts = [`<div class="i-name">${esc((ch.clean || cleanName(ch.name)))}</div>`, `<div class="i-meta">${esc(ch.group || '')}</div>`];
    if (nn?.now) {
      const pct = Math.min(100, Math.max(0, ((Date.now() - nn.now.start) / (nn.now.stop - nn.now.start)) * 100));
      const sp = nowMap.get(ch)?.sp || nowMap.get(ch)?.sc;
      parts.push(`<div class="i-now"><b>Now</b> ${esc(sp ? `${sp.title}` : nn.now.title)} <span>${esc(sp?.status ? `${sp.status} · ` : '')}until ${esc(fmtClock(nn.now.stop))}</span></div>`);
      if (sp) parts.push(`<div class="i-meta">${esc(nn.now.title)}</div>`);
      parts.push(`<div class="i-bar"><u style="width:${pct}%"></u></div>`);
      if (nn.next) parts.push(`<div class="i-next"><b>Next</b> ${esc(nn.next.title)} <span>${esc(fmtClock(nn.next.start))}</span></div>`);
      if (view === 'now' && nn.now.desc && nn.now.desc.length > 3) parts.push(`<div class="i-desc">${esc(nn.now.desc.slice(0, 220))}</div>`);
    } else {
      const g = nowMap.get(ch)?.sc;
      parts.push(g ? `<div class="i-now"><b>Now</b> ${esc(g.title)} <span>${esc(g.status)}</span></div>` : '<div class="i-next dim">No programme guide for this channel</div>');
    }
    infoEl.innerHTML = parts.join('');
    infoEl.classList.remove('hidden');
  }
  bodyEl.addEventListener('focusin', (e) => {
    const row = e.target.closest?.('.tvh-row');
    if (row) { requestAround(+row.dataset.i); paintInfo(listCache[+row.dataset.i]); }
  });

  function renderBody(withChips = true) {
    if (withChips) renderChips();
    bodyEl.innerHTML = '';
    bodyEl.className = `tvh-body ${tab}`;
    infoEl.classList.add('hidden');
    if (tab === 'phone') return renderPhone();
    listCache = visibleList();
    shown = 0;
    if (!listCache.length) {
      bodyEl.innerHTML = `<p class="tvh-empty">${view === 'now' ? esc(guideStatus() || 'Nothing on yet.') : group === FAV ? 'No favorites yet. Hold OK on a channel to add one.' : 'No channels here.'}</p>`;
      return;
    }
    addRows();
  }

  function renderPhone() {
    const p = P(), a = p.active(), src = T().source();
    const n = p.doc.playlists.length;
    bodyEl.innerHTML = `
      <div class="tvh-profile"><span class="avatar">${a ? esc(a.name.trim().charAt(0).toUpperCase()) : '·'}</span>
        <div class="grow"><div class="tvh-pname">${a ? esc(a.name) : 'Not linked to a phone'}</div><div class="tvh-sync"></div></div></div>
      <div class="tvh-syncbar"><u></u></div>
      <p class="tvh-note">Change playlists and settings on your phone at <b>${esc(host)}</b>. They sync here.</p>
      <div class="tvh-actions"></div>
      <p class="tvh-note dim tvh-showing"></p>
      <h3>Playlists on your profile${a ? ` (${n})` : ''}</h3><div class="tvh-lists"></div>`;
    const actions = bodyEl.querySelector('.tvh-actions');
    const mk = (label, fn, cls = 'btn') => { const b = el('button', cls, esc(label)); b.onclick = fn; actions.append(b); return b; };
    if (a) {
      mk('Sync now', () => { P().sync(); paintSync(); });
      if (src?.url) mk('Reload channels', () => { O().loadPlaylist(src.url, src.name, { fresh: true }); closeHome(); }, 'btn ghost');
      mk('Unlink', async () => { await T().forgetCopies(); P().signOut(a.id); dismissed = false; closeHome(); runSetup(); }, 'btn ghost');
    } else {
      mk('Link a phone', () => { dismissed = false; closeHome(); runSetup(); });
    }
    const lists = bodyEl.querySelector('.tvh-lists');
    for (const l of p.doc.playlists) {
      const b = el('button', 'btn ghost', esc(l.name));
      b.onclick = () => { O().loadPlaylist(l.url, l.name, { fresh: true }); closeHome(); };
      lists.append(b);
    }
    if (!n) lists.innerHTML = '<p class="tvh-note dim">None yet. Add one on your phone.</p>';
    paintSync();
  }
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
  setInterval(() => { if (isOpen.home() && tab === 'phone') paintSync(); }, 400);
  const ageText = (t) => {
    const m = Math.round((Date.now() - t) / 60000);
    return m < 2 ? 'just now' : m < 120 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
  };
  
  function openHome() {
    if (screen() === 'setup') return;
    hideOsd();
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
    requestAnimationFrame(() => {
      const row = bodyEl.querySelector('.tvh-row.playing') || bodyEl.querySelector('.tvh-row');
      (row || bodyEl.querySelector('button') || tabsEl.firstElementChild)?.focus();
      row?.scrollIntoView({ block: 'center' });
    });
  }
  function closeHome() { home.classList.add('hidden'); document.documentElement.classList.remove('home-open'); document.activeElement?.blur?.(); }
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

  // ---------- Setup: link a phone ----------
  const body = $('tvsBody');
  const fmt = (c) => `${c.slice(0, 4)} ${c.slice(4)}`;
  const needsSetup = () => !dismissed && (!P().active() || !P().doc.playlists.length);
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
    if (screen() === 'player' && !O().state.current) openHome();
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
  function homeNav(key) {
    const t = document.activeElement;
    const tabs = [...tabsEl.querySelectorAll('.tvh-tab'), ...(verEl ? [verEl] : [])];
    const toTabs = () => (tabsEl.querySelector('.tvh-tab.on') || tabs[0])?.focus();
    if (tabs.includes(t)) {
      const i = tabs.indexOf(t);
      if (key === 'ArrowLeft') tabs[Math.max(0, i - 1)].focus();
      else if (key === 'ArrowRight') tabs[Math.min(tabs.length - 1, i + 1)].focus();
      else if (key === 'ArrowDown') { commitView(); focusFirstInBody(); }
      return true; // ▲ stays on the tab bar
    }
    if (t?.classList.contains('tvh-chip')) {
      const chips = [...chipsEl.querySelectorAll('.tvh-chip')];
      if (key === 'ArrowRight') { focusFirstInBody(); return true; }
      if (key === 'ArrowLeft' || (key === 'ArrowUp' && chips[0] === t)) { toTabs(); return true; }
      return false;
    }
    if (t?.classList.contains('tvh-row')) {
      const chip = tab === 'live' && !chipsEl.classList.contains('hidden') ? (chipsEl.querySelector('.tvh-chip.on') || chipsEl.querySelector('.tvh-chip')) : null;
      if (key === 'ArrowLeft') { (chip || tabsEl.querySelector('.tvh-tab.on'))?.focus(); return true; }
      if (key === 'ArrowUp' && bodyEl.querySelector('.tvh-row') === t) { toTabs(); return true; }
      return false;
    }
    // Phone tab: ▲ from the first control goes up to the tabs
    if (bodyEl.contains(t) && key === 'ArrowUp' && bodyEl.querySelector('button') === t) { toTabs(); return true; }
    return false;
  }
  let synthetic = false;
  const backKey = (k) => k === 'Escape' || k === 'GoBack' || k === 'BrowserBack';

  function goBack() {
    const s = screen();
    if (s === 'setup') { $('tvsSkip').click(); return true; }
    if (s === 'gallery') {
      synthetic = true;
      (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      synthetic = false;
      return true;
    }
    if (s === 'home') { closeHome(); showOsd(2500); return true; }
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
      const root = s === 'setup' ? setup : s === 'gallery' ? $('gallery') : home;
      if (typing && (!DIR[e.key] || e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return; // let the keyboard type
      if (s === 'home' && DIR[e.key] && homeNav(e.key)) { e.preventDefault(); e.stopImmediatePropagation(); return; }
      if (DIR[e.key]) { e.preventDefault(); e.stopImmediatePropagation(); move(root, ...DIR[e.key]); return; }
      if (e.key === 'Enter' && !typing) {
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
    const v = T()?.video;
    switch (e.key) {
      case 'ArrowUp': case 'ChannelUp':
        e.preventDefault(); e.stopImmediatePropagation();
        if (vod) showOsd(); else surf(1);
        break;
      case 'ArrowDown': case 'ChannelDown':
        e.preventDefault(); e.stopImmediatePropagation();
        if (vod) showOsd(); else surf(-1);
        break;
      case 'ArrowLeft':
        e.preventDefault(); e.stopImmediatePropagation();
        if (vod) { v.currentTime = Math.max(0, v.currentTime - 10); showOsd(); } else openHome();
        break;
      case 'ArrowRight':
        e.preventDefault(); e.stopImmediatePropagation();
        if (vod) { v.currentTime += 30; showOsd(); } else showOsd();
        break;
      case 'Enter':
        e.preventDefault(); e.stopImmediatePropagation();
        if (e.repeat) break;
        if (vod) { T().togglePlay(); showOsd(); } else openHome();
        break;
      default:
        if (e.key.length === 1 && e.key !== ' ') e.stopImmediatePropagation(); // the phone UI's letter shortcuts open hidden panels
    }
  }, true);

  addEventListener('keyup', (e) => {
    if (e.key !== 'Enter') return;
    const pressed = rowPressed;
    rowPressed = false;
    // Ignore the release of the press that opened Home: it didn't start on a row.
    if (!pressed || screen() !== 'home') { holdFired = false; return; }
    const t = document.activeElement;
    if (t?.classList.contains('tvh-row') && !holdFired) {
      const ch = listCache[+t.dataset.i];
      if (ch) { closeHome(); T().play(ch); }
    }
    holdFired = false;
  }, true);

  function toggleFavRow(row) {
    const ch = listCache[+row.dataset.i];
    if (!ch) return;
    T().toggleFav(ch);
    row.querySelector('.star').style.visibility = T().isFav(ch.id) ? 'visible' : 'hidden';
    T().toast(T().isFav(ch.id) ? 'Added to favorites' : 'Removed from favorites');
    if (group === FAV) renderBody();
    else renderChips();
  }

  // ---------- Hooks for the Android activity ----------
  window.tunerTV = {
    key(action) {
      const v = T().video, c = O().state.current;
      if (action === 'playpause') { T().togglePlay(); showOsd(); }
      else if (action === 'play') { if (v.paused) T().togglePlay(); showOsd(); }
      else if (action === 'pause') { if (!v.paused) T().togglePlay(); showOsd(); }
      else if (action === 'next') { if (c && kindOf(c) === 'live') surf(1); else showOsd(); }
      else if (action === 'prev') { if (c && kindOf(c) === 'live') surf(-1); else showOsd(); }
      else if (action === 'ff') { v.currentTime += 30; showOsd(); }
      else if (action === 'rw') { v.currentTime -= 10; showOsd(); }
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
    else T().toast(`New from your phone: ${added[0].name}. Home → Phone to switch.`);
  }
  setInterval(watchPlaylists, 4000);

  // ---------- Boot ----------
  const boot = () => {
    import('./qr.js').catch(() => {}); // warm the cache so the setup screen draws its code at once
    T().video.controls = false;
    // Android WebView draws a large grey play icon on a <video> that has nothing to show; a transparent poster replaces it.
    T().video.poster = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
    checkUpdate('timer'); // sets the baseline
    // Phone edits should reach the TV quickly: look every 45 s (the app's own check is every 5 min).
    setInterval(() => { if (document.visibilityState === 'visible' && !running) P().pull(); }, 45000);
    if (needsSetup()) runSetup(); else settleOnHome();
  };
  if (window.o3xr) boot(); else addEventListener('o3xr-ready', boot, { once: true });
}
