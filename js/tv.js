// Remote-control mode. Only active inside the Android TV app, whose WebView adds "TunerTV" to
// the user agent. Everywhere else this file does nothing.
//
// Setup and settings live on the phone. A TV with no playlist shows a setup screen: a phone on the
// same Wi-Fi finds it (Profile → Link a TV) and sends its profile, end-to-end encrypted, after the TV
// asks "Allow?". The drawer is cut down to the channel list and a Phone tab; everything else syncs in.
//
// Playing, nothing open:  ▲/▼ channel up/down, OK or ◀ open the channel panel, ▶ open the guide.
// Panel / guide / gallery open: arrows move focus to the nearest control in that direction,
// OK clicks it, Back closes the overlay. The app's letter shortcuts never fire here.

if (/TunerTV/.test(navigator.userAgent)) {
  const $ = (id) => document.getElementById(id);
  const FOCUSABLE = 'button, a[href], input, select, textarea, summary, [tabindex], .channel-list li, .gcard';
  const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  document.documentElement.classList.add('tv');

  const style = document.createElement('style');
  style.textContent = `
    html.tv *:focus { outline: 3px solid var(--accent, #4da3ff) !important; outline-offset: 2px; }
    html.tv .channel-list li:focus, html.tv .gcard:focus { background: rgba(255,255,255,.12); }
    html.tv { cursor: none; }`;
  document.head.append(style);

  const open = {
    setup: () => !$('tvSetup').classList.contains('hidden'),
    panel: () => !$('panel').classList.contains('collapsed'),
    guide: () => !$('guideView').classList.contains('hidden'),
    gallery: () => !$('gallery').classList.contains('hidden'),
  };
  const overlay = () => (open.setup() && $('tvSetup')) || (open.gallery() && $('gallery')) || (open.guide() && $('guideView')) || (open.panel() && $('panel')) || null;
  // The gallery and guide close themselves on Escape (the gallery also steps back from a preview).
  let synthetic = false;
  const closeOverlay = () => {
    if (open.setup()) $('tvsSkip').click();
    else if (open.gallery() || open.guide()) {
      synthetic = true;
      (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      synthetic = false;
    } else if (open.panel()) $('panelToggle').click();
  };

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && !el.disabled && getComputedStyle(el).visibility !== 'hidden';
  };
  // Nearest focusable in a direction; distance counts the off-axis gap double so a row
  // doesn't jump to a far-away control that happens to line up.
  function move(root, dx, dy) {
    const cur = document.activeElement && root.contains(document.activeElement) ? document.activeElement : null;
    const items = [...root.querySelectorAll(FOCUSABLE)].filter(visible);
    if (!items.length) return;
    if (!cur) { items[0].focus(); return; }
    const a = cur.getBoundingClientRect();
    const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
    let best = null, bestScore = Infinity;
    for (const el of items) {
      if (el === cur) continue;
      const r = el.getBoundingClientRect();
      const ex = r.left + r.width / 2 - ax, ey = r.top + r.height / 2 - ay;
      const along = dx ? ex * dx : ey * dy, across = Math.abs(dx ? ey : ex);
      if (along <= 1) continue;
      const score = along + across * 2;
      if (score < bestScore) { bestScore = score; best = el; }
    }
    if (best) { best.focus(); best.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
  }

  const DIR = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  addEventListener('keydown', (e) => {
    if (synthetic) return;
    const typing = e.target.matches?.('input, textarea, select');
    const root = overlay();
    if (e.key === 'Escape' || e.key === 'GoBack' || e.key === 'BrowserBack') {
      if (root) { e.preventDefault(); e.stopImmediatePropagation(); closeOverlay(); }
      return;
    }
    if (root) {
      if (typing && !DIR[e.key]) return; // let the keyboard type
      if (typing && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return; // move the caret
      if (DIR[e.key]) {
        e.preventDefault(); e.stopImmediatePropagation();
        move(root, ...DIR[e.key]);
      } else if (e.key === 'Enter' && !typing && document.activeElement && document.activeElement !== document.body) {
        e.preventDefault(); e.stopImmediatePropagation();
        document.activeElement.click();
      } else if (!typing && e.key.length === 1) {
        e.stopImmediatePropagation(); // no letter shortcuts while browsing
      }
      return;
    }
    // Plain playback.
    if (e.key === 'Enter' || e.key === 'ArrowLeft') {
      e.preventDefault(); e.stopImmediatePropagation();
      $('panelOpen').click();
      requestAnimationFrame(() => (document.querySelector('#panel .channel-list li, #panel button') || {}).focus?.());
    } else if (e.key === 'ArrowRight') {
      e.preventDefault(); e.stopImmediatePropagation();
      if (!$('guideOpen').classList.contains('hidden')) $('guideOpen').click();
      else $('panelOpen').click();
    } else if (e.key === 'ChannelUp') { e.preventDefault(); $('nextCh').click(); }
    else if (e.key === 'ChannelDown') { e.preventDefault(); $('prevCh').click(); }
  }, true);

  // ---------- Setup screen ----------
  const setup = document.createElement('div');
  setup.id = 'tvSetup';
  setup.className = 'tv-setup hidden';
  setup.innerHTML = '<div class="tvs-card"><div id="tvsBody"></div><div class="tvs-actions"><button id="tvsSkip" class="btn ghost">Skip for now</button></div></div>';
  document.body.append(setup);
  const body = $('tvsBody');
  const host = location.host;
  const fmt = (c) => `${c.slice(0, 4)} ${c.slice(4)}`;
  let dismissed = false, running = false, abort = null;

  const P = () => window.o3xr.profiles;
  const needsSetup = () => !dismissed && (!P().active() || !P().doc.playlists.length);

  function render(html, focusSel) {
    body.innerHTML = html;
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
      render(`<h1>Link this TV to “${esc(name)}”?</h1><p class="muted">A phone is asking to share its profile with this TV. Only allow it if that was you.</p>
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
          render(`<h1>Linked to “${esc(p.active().name)}”</h1><p>Now add a playlist on your phone: <b>Sources</b>. It will appear here automatically.</p>`);
          await sleep(4000);
          await p.pull();
          continue;
        }
        let req;
        try { req = await p.tvRequest(); } catch (e) {
          render(`<h1>Can’t set up linking</h1><p class="muted">${esc(e.message)}</p>`);
          await sleep(8000);
          continue;
        }
        render(steps(req.code));
        abort = new AbortController();
        const got = await p.tvWait(req, abort.signal).catch(() => null);
        if (!got) continue; // code expired (new one next round) or Skip pressed
        if (await confirmLink(got.name)) {
          try { await p.join(got.token, got.name); } catch (e) {
            render(`<h1>Couldn’t link</h1><p class="muted">${esc(e.message)}</p>`);
            await sleep(5000);
          }
        }
      }
    } finally {
      setup.classList.add('hidden');
      running = false;
      // Playlists arrived but nothing is playing yet (phone hadn't set a "last playlist").
      const o = window.o3xr, first = o.profiles.doc.playlists[0];
      if (!dismissed && first && !o.state.channels.length) o.loadPlaylist(first.url, first.name, { fresh: false });
    }
  }
  $('tvsSkip').onclick = () => { dismissed = true; abort?.abort(); setup.classList.add('hidden'); };

  // ---------- Slimmed-down drawer: channels, plus a Phone tab ----------
  const tabs = document.querySelector('#panel .tabs');
  const phoneTab = document.createElement('button');
  phoneTab.className = 'tab';
  phoneTab.dataset.tab = 'phone';
  phoneTab.textContent = 'Phone';
  tabs.append(phoneTab);
  const phoneBody = document.createElement('section');
  phoneBody.className = 'tab-body';
  phoneBody.dataset.tab = 'phone';
  phoneBody.innerHTML = `
    <div class="profile-card"><span class="avatar big" id="tvpAvatar">·</span>
      <div class="profile-meta"><div id="tvpName" class="np-name"></div><div id="tvpStatus" class="muted small"></div></div></div>
    <p class="muted">Playlists, filters, keys and 3D options are set up on your phone, and sync to this TV.
      Open <b>${esc(host)}</b> there.</p>
    <div class="row"><button id="tvpSync" class="btn">Sync now</button><button id="tvpUnlink" class="btn ghost">Unlink this TV</button></div>
    <h3>Playlists</h3><div id="tvpLists" class="stack"></div>`;
  $('panel').append(phoneBody);
  $('panel').querySelector('.drawer-title').textContent = 'Tuner';

  const setTabTV = (name) => {
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.tab === name);
    for (const b of document.querySelectorAll('.tab-body')) b.classList.toggle('active', b.dataset.tab === name);
  };
  phoneTab.onclick = () => setTabTV('phone');
  // The app also switches tabs itself (e.g. to Sources after a profile switch). Only Channels and
  // Phone exist here, and Channels is hidden when the guide takes over, so fall back to Phone.
  const ensureTab = () => {
    const now = document.querySelector('.tab.active')?.dataset.tab;
    const channelsOk = now === 'channels' && !$('channelsTab').classList.contains('hidden');
    if (!channelsOk && now !== 'phone') setTabTV($('channelsTab').classList.contains('hidden') ? 'phone' : 'channels');
    refreshPhoneTab();
  };
  new MutationObserver(() => { if (open.panel()) ensureTab(); }).observe($('panel'), { attributes: true, attributeFilter: ['class'] });

  function refreshPhoneTab() {
    const p = P(), a = p.active();
    $('tvpName').textContent = a ? a.name : 'Not linked';
    $('tvpAvatar').textContent = a ? a.name.trim().charAt(0).toUpperCase() : '·';
    const st = p.status;
    $('tvpStatus').textContent = !a ? 'Link a phone to get your playlists'
      : st.state === 'synced' ? `Synced ${Math.max(0, Math.round((Date.now() - st.at) / 60000))} min ago` : st.message || 'Synced';
    $('tvpUnlink').textContent = a ? 'Unlink this TV' : 'Link a phone';
    const box = $('tvpLists');
    const lists = p.doc.playlists;
    const sig = JSON.stringify(lists.map((x) => x.key));
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    box.innerHTML = '';
    for (const l of lists) {
      const b = document.createElement('button');
      b.className = 'btn ghost';
      b.textContent = l.name;
      b.onclick = () => { window.o3xr.loadPlaylist(l.url, l.name, { fresh: false }); $('panelToggle').click(); };
      box.append(b);
    }
    if (!lists.length) box.innerHTML = '<p class="muted small">None yet. Add one on your phone.</p>';
  }
  $('tvpSync').onclick = () => P().sync();
  $('tvpUnlink').onclick = () => {
    const a = P().active();
    if (a) P().signOut(a.id);
    dismissed = false;
    $('panelToggle').click();
    runSetup();
  };
  // The Profile chip in the top bar opens this tab instead of the (hidden) phone-side profile form.
  $('profileChip').addEventListener('click', (e) => {
    e.stopImmediatePropagation();
    if ($('panel').classList.contains('collapsed')) $('panelOpen').click();
    setTabTV('phone');
    refreshPhoneTab();
  }, true);
  setInterval(() => { if (open.panel()) refreshPhoneTab(); }, 2000);

  // Phone edits should reach the TV quickly: check for them every 45 s (the app's own check is every 5 min).
  const boot = () => {
    setInterval(() => { if (document.visibilityState === 'visible' && !running) P().pull(); }, 45000);
    if (needsSetup()) runSetup();
  };
  if (window.o3xr) boot(); else addEventListener('o3xr-ready', boot, { once: true });

  // Media keys, forwarded by the Android activity (WebView doesn't always deliver them).
  window.tunerTV = {
    key(action) {
      const v = $('video');
      if (action === 'playpause') $('playPause').click();
      else if (action === 'play') { if (v.paused) $('playPause').click(); }
      else if (action === 'pause') { if (!v.paused) $('playPause').click(); }
      else if (action === 'next') $('nextCh').click();
      else if (action === 'prev') $('prevCh').click();
      else if (action === 'ff') v.currentTime += 30;
      else if (action === 'rw') v.currentTime -= 10;
    },
    // Called by the activity on Back. Returns true if the page used it.
    back() {
      if (!overlay()) return false;
      closeOverlay();
      return true;
    },
  };
}
