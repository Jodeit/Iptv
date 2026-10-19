// TV guide grid: channels down the side, a 6-hour timeline across, a line at "now".
// Rows load their programmes only when scrolled into view.

const PX_PER_MIN = 4;          // 30 minutes = 120 px
const HOURS = 6;
const LABEL_W = 170;
const ROW_LIMIT = 300;

const fmt = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export class GuideView {
  constructor({ root, guide, channels, onPlay }) {
    this.root = root;
    this.guide = guide;
    this.channels = channels; // () => live channels to show
    this.onPlay = onPlay;
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
    root.querySelector('.guide-close').onclick = () => this.close();
    root.querySelector('.guide-now').onclick = () => this.scrollToNow();
    addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.isOpen()) this.close(); });
  }

  isOpen() { return !this.root.classList.contains('hidden'); }

  open() {
    this.root.classList.remove('hidden');
    this.build();
    this.scrollToNow();
  }

  close() {
    this.root.classList.add('hidden');
    this.observer.disconnect();
    this.detail.classList.add('hidden');
  }

  build() {
    this.observer.disconnect();
    this.rows.clear();
    this.visible.clear();
    const now = Date.now();
    this.t0 = Math.floor(now / 1800000) * 1800000 - 1800000; // half-hour boundary, 30 min back
    this.t1 = this.t0 + HOURS * 3600000;
    const width = LABEL_W + (HOURS * 60) * PX_PER_MIN;
    this.grid.style.width = `${width}px`;
    this.grid.innerHTML = '';

    // Time ruler
    const ruler = document.createElement('div');
    ruler.className = 'guide-ruler';
    ruler.innerHTML = '<div class="guide-corner"></div>';
    for (let t = this.t0; t < this.t1; t += 1800000) {
      const mark = document.createElement('div');
      mark.className = 'guide-mark';
      mark.style.left = `${LABEL_W + this.x(t)}px`;
      mark.textContent = fmt(t);
      ruler.append(mark);
    }
    this.grid.append(ruler);

    const list = this.channels();
    const shown = list.slice(0, ROW_LIMIT);
    for (const ch of shown) {
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
      label.onclick = () => { this.onPlay(ch); this.close(); };
      const track = document.createElement('div');
      track.className = 'guide-track';
      row.append(label, track);
      this.grid.append(row);
      this.rows.set(ch.id, { el: row, track, ch });
      this.observer.observe(row);
    }

    this.nowLine = document.createElement('div');
    this.nowLine.className = 'guide-nowline';
    this.grid.append(this.nowLine);
    this.tick();
    this.info.textContent = list.length > ROW_LIMIT
      ? `First ${ROW_LIMIT} of ${list.length} channels. Pick a group to narrow down.`
      : `${list.length} channel${list.length === 1 ? '' : 's'}`;
    if (!shown.length) this.grid.insertAdjacentHTML('beforeend', '<p class="muted guide-empty">No live channels in the current list.</p>');
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
    watch.onclick = () => { this.onPlay(ch); this.close(); };
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
    this.nowLine.style.left = `${LABEL_W + this.x(Date.now())}px`;
  }

  scrollToNow() {
    this.scroll.scrollLeft = Math.max(0, this.x(Date.now()) - 60);
  }
}
