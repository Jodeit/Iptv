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
  document.documentElement.classList.add('tv');

  // ---------- DOM ----------
  const osd = el('div', 'tv-osd hidden');
  osd.id = 'tvOsd';
  osd.innerHTML = '<img class="osd-logo" alt=""><div class="osd-main"><div class="osd-name"></div><div class="osd-sub"></div><div class="osd-bar"><u></u></div></div><div class="osd-hint"></div>';
  const home = el('div', 'tv-home hidden');
  home.id = 'tvHome';
  home.innerHTML = '<div class="tvh-panel"><div class="tvh-tabs"></div><div class="tvh-main"><div class="tvh-chips"></div><div class="tvh-body"></div></div></div>';
  const setup = el('div', 'tv-setup hidden');
  setup.id = 'tvSetup';
  setup.innerHTML = '<div class="tvs-card"><div id="tvsBody"></div><div class="tvs-actions"><button id="tvsSkip" class="btn ghost">Skip for now</button></div><div class="tvs-ver">Tuner ' + VERSION + '</div></div>';
  document.body.append(osd, home, setup);
  const tabsEl = home.querySelector('.tvh-tabs'), chipsEl = home.querySelector('.tvh-chips'), bodyEl = home.querySelector('.tvh-body');

  // ---------- State ----------
  let tab = 'live';            // 'live' | 'phone' (Movies and Shows open the poster gallery)
  let group = '';              // '' = all, FAV = favorites, else a group name
  const FAV = '\u0000fav';
  let dismissed = false, running = false, abort = null, liveCode = null;
  const isOpen = { home: () => !home.classList.contains('hidden'), setup: () => !setup.classList.contains('hidden'), gallery: () => !!O()?.tv.galleryOpen() };
  const screen = () => (isOpen.setup() ? 'setup' : isOpen.gallery() ? 'gallery' : isOpen.home() ? 'home' : 'player');
  const isVod = () => { const c = O()?.state.current; return !!c && kindOf(c) !== 'live'; };

  // ---------- Channel list helpers ----------
  const liveAll = () => T().live();
  const groups = () => [...new Set(liveAll().map((c) => c.group).filter(Boolean))];
  const visibleList = () => {
    const all = liveAll();
    if (group === FAV) return all.filter((c) => T().isFav(c.id));
    return group ? all.filter((c) => c.group === group) : all;
  };
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
    if (c && c !== lastShown) { lastShown = c; showOsd(); }
  }, 400);

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
    if (liveAll().length) defs.push(['live', 'Live']);
    if (T().hasKind('movie')) defs.push(['movie', 'Movies']);
    if (T().hasKind('series')) defs.push(['series', 'Shows']);
    defs.push(['phone', 'Phone']);
    if (!defs.some(([k]) => k === tab)) tab = defs[0][0];
    const ver = el('button', 'tvh-version', '');
    ver.onclick = () => location.reload();
    verEl = ver;
    paintVersion();
    for (const [k, label] of defs) {
      const b = el('button', `tvh-tab${k === tab ? ' on' : ''}`, esc(label));
      b.dataset.tab = k;
      b.onclick = () => {
        if (k === 'movie' || k === 'series') { closeHome(); T().openGallery(k); } else selectTab(k, true);
      };
      // Live and Phone switch as soon as they get focus, so ◀ ▶ browses without pressing OK.
      b.onfocus = () => { if ((k === 'live' || k === 'phone') && k !== tab) selectTab(k, false); };
      tabsEl.append(b);
    }
    tabsEl.append(ver);
  }
  function selectTab(k, focusBody) {
    tab = k;
    for (const b of tabsEl.children) b.classList.toggle('on', b.dataset.tab === k);
    renderBody();
    if (focusBody) focusFirstInBody();
  }
  function focusFirstInBody() {
    (bodyEl.querySelector('.tvh-row.playing') || bodyEl.querySelector('button'))?.focus();
  }

  function renderChips() {
    chipsEl.innerHTML = '';
    chipsEl.classList.toggle('hidden', tab !== 'live');
    if (tab !== 'live') return;
    const defs = [['', 'All']];
    if (liveAll().some((c) => T().isFav(c.id))) defs.push([FAV, '★ Favorites']);
    for (const g of groups().slice(0, 80)) defs.push([g, g]);
    for (const [k, label] of defs) {
      const b = el('button', `tvh-chip${k === group ? ' on' : ''}`, esc(label));
      b.onclick = () => { group = k; renderChips(); renderBody(); [...chipsEl.children].find((x) => x.classList.contains('on'))?.focus(); };
      // Browsing groups previews them: the list follows focus, so ▲▼ then ▶ is enough.
      b.onfocus = () => { if (group !== k) { group = k; for (const x of chipsEl.children) x.classList.toggle('on', x === b); renderBody(false); } };
      chipsEl.append(b);
    }
  }

  const ROW_PAGE = 100;
  let shown = 0, listCache = [];
  function rowFor(ch, i) {
    const b = el('button', 'tvh-row');
    b.dataset.i = i; // position in listCache; ids can repeat when a provider lists a stream twice
    b.classList.toggle('playing', ch === O().state.current);
    b.innerHTML = `<img alt="" referrerpolicy="no-referrer"><span class="meta"><b></b><small></small><i class="prog"><u></u></i></span><span class="star">★</span>`;
    b.querySelector('b').textContent = ch.name;
    if (ch.logo) b.querySelector('img').src = ch.logo; else b.querySelector('img').style.display = 'none';
    b.querySelector('.star').style.visibility = T().isFav(ch.id) ? 'visible' : 'hidden';
    paintRow(b, ch);
    return b;
  }
  function paintRow(b, ch) {
    const nn = T().guide.nowNext(ch);
    const small = b.querySelector('small'), prog = b.querySelector('.prog');
    if (nn?.now) {
      small.textContent = `${nn.now.title}${nn.next ? `  ·  next ${nn.next.title}` : ''}`;
      prog.classList.add('on');
      prog.firstElementChild.style.width = `${Math.round(((Date.now() - nn.now.start) / (nn.now.stop - nn.now.start)) * 100)}%`;
    } else {
      small.textContent = ch.group || '';
      prog.classList.remove('on');
      T().guide.request?.(ch);
    }
  }
  function addRows() {
    const next = listCache.slice(shown, shown + ROW_PAGE);
    next.forEach((ch, k) => bodyEl.append(rowFor(ch, shown + k)));
    shown += next.length;
  }
  let holdFired = false, rowPressed = false;

  function renderBody(withChips = true) {
    if (withChips) renderChips();
    bodyEl.innerHTML = '';
    bodyEl.className = `tvh-body ${tab}`;
    if (tab === 'phone') return renderPhone();
    listCache = visibleList();
    shown = 0;
    if (!listCache.length) {
      bodyEl.innerHTML = `<p class="tvh-empty">${group === FAV ? 'No favorites yet. Hold OK on a channel to add one.' : 'No channels here.'}</p>`;
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
    const detail = `${p.doc.playlists.length} playlist${p.doc.playlists.length === 1 ? '' : 's'} · v${a.version}`;
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
    P().pull(); // anything new from the phone
    checkUpdate('timer');
    renderTabs();
    renderBody();
    requestAnimationFrame(() => {
      const row = bodyEl.querySelector('.tvh-row.playing') || bodyEl.querySelector('.tvh-row');
      (row || bodyEl.querySelector('button') || tabsEl.firstElementChild)?.focus();
      row?.scrollIntoView({ block: 'center' });
    });
  }
  function closeHome() { home.classList.add('hidden'); document.documentElement.classList.remove('home-open'); document.activeElement?.blur?.(); }
  // Rows' what's-on lines fill in as guide data arrives.
  setInterval(() => {
    if (!isOpen.home() || tab !== 'live') return;
    for (const row of bodyEl.querySelectorAll('.tvh-row')) {
      const ch = listCache[+row.dataset.i];
      if (ch) paintRow(row, ch);
    }
  }, 5000);

  // ---------- Setup: link a phone ----------
  const body = $('tvsBody');
  const fmt = (c) => `${c.slice(0, 4)} ${c.slice(4)}`;
  const needsSetup = () => !dismissed && (!P().active() || !P().doc.playlists.length);
  function renderSetup(html, focusSel) {
    body.innerHTML = html;
    hideOsd();
    closeHome();
    setup.classList.remove('hidden');
    document.querySelector(focusSel || '#tvsSkip')?.focus();
  }
  const steps = (code) => `
    <h1>Set up Tuner on your phone</h1>
    <ol>
      <li>On your phone, open <b>${esc(host)}</b></li>
      <li>Go to <b>Profile → Link a TV</b> and tap this TV</li>
      <li>Add your playlist there. It shows up here by itself.</li>
    </ol>
    <p class="muted">Phone not on this Wi-Fi? In Link a TV, type this code:</p>
    <div class="tvs-code">${code ? esc(fmt(code)) : '…'}</div>`;
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
          renderSetup(`<h1>Linked to “${esc(p.active().name)}”</h1><p>Now add a playlist on your phone: <b>Sources</b>. It will appear here automatically.</p>`);
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
      running = false;
      // Playlists arrived but nothing is loaded yet (the phone hadn't set a "last playlist").
      const o = O(), first = o.profiles.doc.playlists[0];
      if (!dismissed && first && !o.state.channels.length) o.loadPlaylist(first.url, first.name, { fresh: false });
      settleOnHome();
    }
  }
  $('tvsSkip').onclick = () => { dismissed = true; abort?.abort(); setup.classList.add('hidden'); settleOnHome(); };

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
      if (s === 'home' && tab === 'live') {
        const t = document.activeElement;
        // Groups are a column on the left: ◀ from the list goes to it, ▶ from it goes back.
        if (e.key === 'ArrowLeft' && t?.classList.contains('tvh-row')) { e.preventDefault(); e.stopImmediatePropagation(); (chipsEl.querySelector('.on') || chipsEl.firstElementChild)?.focus(); return; }
        if (e.key === 'ArrowRight' && t?.classList.contains('tvh-chip')) { e.preventDefault(); e.stopImmediatePropagation(); focusFirstInBody(); return; }
      }
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
    T().video.controls = false;
    checkUpdate('timer'); // sets the baseline
    // Phone edits should reach the TV quickly: look every 45 s (the app's own check is every 5 min).
    setInterval(() => { if (document.visibilityState === 'visible' && !running) P().pull(); }, 45000);
    if (needsSetup()) runSetup(); else settleOnHome();
  };
  if (window.o3xr) boot(); else addEventListener('o3xr-ready', boot, { once: true });
}
