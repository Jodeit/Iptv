import { classify, TOPIC_NAMES } from './livecats.js';

// TV guide grid: channels down the side, a 6-hour timeline across, a line at "now".
// Rows load their programmes only when scrolled into view.

const PX_PER_MIN = 4;          // 30 minutes = 120 px
const HOURS = 6;
const PAGE = 60; // rows added each time the bottom comes into view

const fmt = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export class GuideView {
  constructor({ root, guide, channels, onPlay, onToggle }) {
    this.root = root;
    this.guide = guide;
    this.channels = channels; // () => live channels to show
    this.onPlay = onPlay;
    this.onToggle = onToggle || (() => {});
    this.scroll = root.querySelector('.guide-scroll');
    this.grid = root.querySelector('.guide-grid');
    this.detail = root.querySelector('.guide-detail');
    this.info = root.querySelector('.guide-info');
    this.rows = new Map(); // channel id → { el, ch }
    this.visible = new Set();
    this.observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const id = e.target.dataset.id;
        if (e.isIntersecting) { this.visible.add(id); this.renderRow(id); } else this.visible.delete(id);
      }
    }, { root: this.scroll, rootMargin: '300px 0px' });
    this.f = { region: '', topic: '', q: '' };
    this.bar = document.createElement('div');
    this.bar.className = 'guide-filters';
    this.bar.innerHTML = `<select class="gv-region" aria-label="Region"></select>
      <select class="gv-topic" aria-label="Topic"></select>
      <input class="gv-search" type="search" placeholder="Search channels…" autocomplete="off">`;
    root.querySelector('.guide-head').after(this.bar);
    const apply = () => {
      this.f = { region: this.bar.querySelector('.gv-region').value, topic: this.bar.querySelector('.gv-topic').value, q: this.bar.querySelector('.gv-search').value.trim().toLowerCase() };
      this.build();
    };
    this.bar.querySelector('.gv-region').onchange = apply;
    this.bar.querySelector('.gv-topic').onchange = apply;
    this.bar.querySelector('.gv-search').oninput = apply;
    // Rows arrive a page at a time as the bottom of the grid scrolls into view.
    this.more = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) this.addRows(); }, { root: this.scroll, rootMargin: '400px 0px' });
    root.querySelector('.guide-now').onclick = () => this.scrollToNow();
    addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.isOpen()) this.close(); });
  }

  isOpen() { return !this.root.classList.contains('hidden'); }

  open() {
    this.root.classList.remove('hidden');
    this.build();
    this.scrollToNow();
    this.onToggle(true);
  }

  close() {
    this.root.classList.add('hidden');
    this.observer.disconnect();
    this.more.disconnect();
    this.detail.classList.add('hidden');
    this.onToggle(false);
  }

  // Region/topic menus list only what's present, with counts.
  fillMenus(all) {
    const count = (key) => { const m = new Map(); for (const c of all) { const v = classify(c)[key]; m.set(v, (m.get(v) || 0) + 1); } return m; };
    const fill = (sel, map, label, order) => {
      const names = [...map.keys()].sort(order);
      sel.innerHTML = `<option value="">${label} (${all.length.toLocaleString()})</option>` + names.map((n) => `<option value="${n}">${n} (${map.get(n).toLocaleString()})</option>`).join('');
    };
    const regions = count('region');
    const topics = count('topic');
    const r = this.bar.querySelector('.gv-region');
    const t = this.bar.querySelector('.gv-topic');
    // Keep the menus from the full list; counts don't shift while filtering.
    if (this.menuFor !== all) {
      this.menuFor = all;
      fill(r, regions, 'All regions', (a, b) => (a === 'United States' ? -1 : b === 'United States' ? 1 : regions.get(b) - regions.get(a)));
      fill(t, topics, 'All topics', (a, b) => TOPIC_NAMES.indexOf(a) - TOPIC_NAMES.indexOf(b));
      r.value = this.f.region; t.value = this.f.topic;
    }
  }

  build() {
    this.observer.disconnect();
    this.rows.clear();
    this.visible.clear();
    this.labelW = parseFloat(getComputedStyle(this.root).getPropertyValue('--guide-label-w')) || 260;
    const now = Date.now();
    this.t0 = Math.floor(now / 1800000) * 1800000 - 1800000; // half-hour boundary, 30 min back
    this.t1 = this.t0 + HOURS * 3600000;
    const width = this.labelW + (HOURS * 60) * PX_PER_MIN;
    this.grid.style.width = `${width}px`;
    this.grid.innerHTML = '';

    // Time ruler
    const ruler = document.createElement('div');
    ruler.className = 'guide-ruler';
    ruler.innerHTML = '<div class="guide-corner"></div>';
    for (let t = this.t0; t < this.t1; t += 1800000) {
      const mark = document.createElement('div');
      mark.className = 'guide-mark';
      mark.style.left = `${this.labelW + this.x(t)}px`;
      mark.textContent = fmt(t);
      ruler.append(mark);
    }
    this.grid.append(ruler);

    const all = this.channels();
    this.fillMenus(all);
    const { region, topic, q } = this.f;
    this.list = all.filter((c) => {
      if (region || topic) { const k = classify(c); if ((region && k.region !== region) || (topic && k.topic !== topic)) return false; }
      return !q || c.name.toLowerCase().includes(q) || (c.group || '').toLowerCase().includes(q);
    });
    this.shown = 0;
    this.sentinel = document.createElement('div');
    this.sentinel.className = 'guide-sentinel';
    this.grid.append(this.sentinel);
    this.addRows();

    this.nowLine = document.createElement('div');
    this.nowLine.className = 'guide-nowline';
    this.grid.append(this.nowLine);
    this.tick();
  }

  // Appends the next page of rows above the sentinel; the sentinel's visibility asks for more.
  addRows() {
    const list = this.list;
    const next = list.slice(this.shown, this.shown + PAGE);
    this.shown += next.length;
    for (const ch of next) {
      const row = document.createElement('div');
      row.className = 'guide-row';
      row.dataset.id = ch.id;
      const label = document.createElement('button');
      label.className = 'guide-label';
      label.title = `Watch ${ch.name}`;
      if (ch.logo) {
        const img = document.createElement('img');
        img.src = ch.logo; img.alt = ''; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer';
        img.onerror = () => img.remove();
        label.append(img);
      }
      const name = document.createElement('span');
      name.textContent = ch.name;
      label.append(name);
      label.onclick = () => { this.onPlay(ch); };
      const track = document.createElement('div');
      track.className = 'guide-track';
      // Click a programme for details; double-click anywhere on the row to watch the channel.
      track.ondblclick = () => { this.detail.classList.add('hidden'); this.onPlay(ch); };
      row.append(label, track);
      this.sentinel.before(row);
      this.rows.set(ch.id, { el: row, track, ch });
      this.observer.observe(row);
    }
    this.info.textContent = `${Math.min(this.shown, list.length).toLocaleString()} of ${list.length.toLocaleString()} channel${list.length === 1 ? '' : 's'}`;
    this.grid.querySelector('.guide-empty')?.remove();
    if (!list.length) this.grid.insertAdjacentHTML('beforeend', '<p class="muted guide-empty">No live channels match.</p>');
    // Re-arm: if the sentinel is still on screen after a page, the observer fires again.
    this.more.disconnect();
    if (this.shown < list.length) this.more.observe(this.sentinel);
  }

  x(t) { return ((t - this.t0) / 60000) * PX_PER_MIN; }

  renderRow(id) {
    const row = this.rows.get(id);
    if (!row) return;
    const list = this.guide.programmes(row.ch);
    row.track.innerHTML = '';
    if (!list) { row.track.innerHTML = '<span class="guide-msg">Loading…</span>'; return; }
    const items = list.filter((p) => p.stop > this.t0 && p.start < this.t1);
    if (!items.length) { row.track.innerHTML = '<span class="guide-msg">No guide information</span>'; return; }
    const now = Date.now();
    for (const p of items) {
      const cell = document.createElement('button');
      cell.className = 'guide-cell';
      if (p.start <= now && p.stop > now) cell.classList.add('live');
      const left = Math.max(0, this.x(p.start));
      const right = Math.min(this.x(this.t1), this.x(p.stop));
      cell.style.left = `${left}px`;
      cell.style.width = `${Math.max(2, right - left - 2)}px`;
      cell.innerHTML = '<b></b><small></small>';
      cell.firstChild.textContent = p.title || 'Untitled';
      cell.lastChild.textContent = `${fmt(p.start)}–${fmt(p.stop)}`;
      cell.onclick = () => this.showDetail(row.ch, p);
      row.track.append(cell);
    }
  }

  showDetail(ch, p) {
    const now = Date.now();
    const airing = p.start <= now && p.stop > now;
    this.detail.innerHTML = '<div class="guide-detail-text"><div class="np-name"></div><div class="muted small"></div><p></p></div>';
    const [title, meta, desc] = this.detail.querySelectorAll('.np-name, .muted, p');
    title.textContent = p.title || 'Untitled';
    meta.textContent = `${ch.name} · ${fmt(p.start)}–${fmt(p.stop)}${airing ? ' · on now' : p.start > now ? ` · starts in ${Math.round((p.start - now) / 60000)} min` : ''}`;
    desc.textContent = p.desc || '';
    const watch = document.createElement('button');
    watch.className = 'btn';
    watch.textContent = airing ? 'Watch now' : 'Watch channel';
    watch.onclick = () => { this.onPlay(ch); };
    this.detail.append(watch);
    this.detail.classList.remove('hidden');
  }

  // Called when programmes arrive (ids = channel ids, or null for everything).
  refresh(ids) {
    if (!this.isOpen()) return;
    for (const id of ids || this.visible) if (this.visible.has(id)) this.renderRow(id);
  }

  tick() {
    if (!this.isOpen() || !this.nowLine) return;
    if (Date.now() > this.t0 + 3600000 * 2) { this.build(); return; } // keep "now" near the start
    this.nowLine.style.left = `${this.labelW + this.x(Date.now())}px`;
  }

  scrollToNow() {
    this.scroll.scrollLeft = Math.max(0, this.x(Date.now()) - 60);
  }
}
