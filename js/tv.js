// Remote-control mode. Only active inside the Android TV app, whose WebView adds "TunerTV" to
// the user agent. Everywhere else this file does nothing.
//
// Playing, nothing open:  ▲/▼ channel up/down, OK or ◀ open the channel panel, ▶ open the guide.
// Panel / guide / gallery open: arrows move focus to the nearest control in that direction,
// OK clicks it, Back closes the overlay. The app's letter shortcuts never fire here.

if (/TunerTV/.test(navigator.userAgent)) {
  const $ = (id) => document.getElementById(id);
  const FOCUSABLE = 'button, a[href], input, select, textarea, summary, [tabindex], .channel-list li, .gcard';
  document.documentElement.classList.add('tv');

  const style = document.createElement('style');
  style.textContent = `
    html.tv *:focus { outline: 3px solid var(--accent, #4da3ff) !important; outline-offset: 2px; }
    html.tv .channel-list li:focus, html.tv .gcard:focus { background: rgba(255,255,255,.12); }
    html.tv { cursor: none; }`;
  document.head.append(style);

  const open = {
    panel: () => !$('panel').classList.contains('collapsed'),
    guide: () => !$('guideView').classList.contains('hidden'),
    gallery: () => !$('gallery').classList.contains('hidden'),
  };
  const overlay = () => (open.gallery() && $('gallery')) || (open.guide() && $('guideView')) || (open.panel() && $('panel')) || null;
  // The gallery and guide close themselves on Escape (the gallery also steps back from a preview).
  let synthetic = false;
  const closeOverlay = () => {
    if (open.gallery() || open.guide()) {
      synthetic = true;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
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
