// Poster gallery for movies and series, with a preview page per title (backdrop, plot, cast,
// ratings incl. Rotten Tomatoes, trailer, play/resume, and seasons/episodes for series).

const PAGE = 120; // cards rendered per "Show more"

const SORTS = {
  added: { label: 'Recently added', fn: (a, b) => (b.added || 0) - (a.added || 0) },
  rt: { label: 'Rotten Tomatoes', fn: null }, // needs ratings; set in constructor
  rating: { label: 'Top rated', fn: (a, b) => (b.rating || 0) - (a.rating || 0) },
  year: { label: 'Newest', fn: (a, b) => (b.year || 0) - (a.year || 0) },
  title: { label: 'A–Z', fn: (a, b) => cleanName(a.name).localeCompare(cleanName(b.name)) },
};

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cleanName = (n) => n.replace(/^\s*(\d{1,3}\s*[-.)]\s+|\|?[A-Z]{2,3}\|\s*|[A-Z]{2,3}\s*[-:|]\s+)/, '');
const fmtTime = (s) => (s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}` : `${Math.floor(s / 60)}`) + `:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export class GalleryView {
  // app: { library(), categories(kind), loadCategory(kind, id), episodes(series), movieInfo(item),
  //        ratings, play(item, startAt), progress(id), isFav(id), toggleFav(item), external(item),
  //        imageUrl(url) → proxied fallback, parseTitle }
  constructor(root, app) {
    this.root = root;
    this.app = app;
    this.kind = 'movie';
    this.sort = 'added';
    this.query = '';
    SORTS.rt.fn = (a, b) => (app.ratings.peek(b)?.rt ?? -1) - (app.ratings.peek(a)?.rt ?? -1);
    root.innerHTML = `
      <header class="gallery-head">
        <div class="seg gallery-kind"><button data-kind="movie">Movies</button><button data-kind="series">Series</button></div>
        <select class="gallery-cat" aria-label="Category"></select>
        <input class="gallery-search" type="search" placeholder="Search this category…">
        <select class="gallery-sort" aria-label="Sort">${Object.entries(SORTS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}</select>
        <button class="gallery-close icon-btn" title="Close (Esc)">✕</button>
      </header>
      <div class="gallery-note muted small hidden"></div>
      <div class="gallery-scroll"><div class="gallery-grid"></div><div class="gallery-more"></div></div>
      <div class="gallery-preview hidden"></div>`;
    this.grid = root.querySelector('.gallery-grid');
    this.more = root.querySelector('.gallery-more');
    this.preview = root.querySelector('.gallery-preview');
    this.note = root.querySelector('.gallery-note');
    this.cards = new Map(); // item id → card element
    // Ratings cost a lookup each (1,000 a day on a free key), so only posters that stay on
    // screen for a moment ask; scrolling quickly past a hundred titles costs nothing.
    this.dwell = new Map(); // card → timer
    this.observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        clearTimeout(this.dwell.get(e.target));
        if (e.isIntersecting) {
          this.dwell.set(e.target, setTimeout(() => this.app.ratings.get(this.itemsById.get(e.target.dataset.id)), 500));
        }
      }
    }, { root: root.querySelector('.gallery-scroll') });

    for (const b of root.querySelectorAll('.gallery-kind button')) b.onclick = () => this.open(b.dataset.kind);
    root.querySelector('.gallery-cat').onchange = (e) => this.showCategory(e.target.value);
    root.querySelector('.gallery-search').oninput = (e) => { this.query = e.target.value.toLowerCase(); this.render(); };
    root.querySelector('.gallery-sort').onchange = (e) => { this.sort = e.target.value; this.render(); };
    root.querySelector('.gallery-close').onclick = () => this.close();
    addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !this.isOpen()) return;
      if (!this.preview.classList.contains('hidden')) this.closePreview(); else this.close();
    });
  }

  isOpen() { return !this.root.classList.contains('hidden'); }

  async open(kind = this.kind, catId) {
    this.kind = kind;
    this.root.classList.remove('hidden');
    this.closePreview();
    for (const b of this.root.querySelectorAll('.gallery-kind button')) b.classList.toggle('active', b.dataset.kind === kind);
    const cats = this.app.categories(kind);
    const sel = this.root.querySelector('.gallery-cat');
    sel.innerHTML = cats.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
    const pick = catId && cats.some((c) => c.id === catId) ? catId : this.lastCat?.[kind] && cats.some((c) => c.id === this.lastCat[kind]) ? this.lastCat[kind] : cats[0]?.id;
    if (!pick) { this.grid.innerHTML = '<p class="muted">No categories.</p>'; return; }
    sel.value = pick;
    await this.showCategory(pick);
  }

  close() {
    this.root.classList.add('hidden');
    this.closePreview();
  }

  async showCategory(catId) {
    this.query = '';
    this.root.querySelector('.gallery-search').value = '';
    this.root.querySelector('.gallery-scroll').scrollTop = 0;
    this.lastCat = { ...this.lastCat, [this.kind]: catId };
    this.catId = catId;
    this.limit = PAGE;
    this.grid.innerHTML = '<p class="muted gallery-loading">Loading…</p>';
    this.more.innerHTML = '';
    let items;
    try {
      items = await this.app.loadCategory(this.kind, catId);
    } catch (err) {
      this.grid.innerHTML = `<p class="muted">Couldn’t load this category: ${esc(err.message)}</p>`;
      return;
    }
    if (this.catId !== catId) return;
    this.items = items;
    this.itemsById = new Map(items.map((i) => [i.id, i]));
    this.render();
  }

  render() {
    this.observer.disconnect();
    for (const t of this.dwell.values()) clearTimeout(t);
    this.dwell.clear();
    this.app.ratings.clearQueue();
    this.cards.clear();
    const q = this.query;
    let list = this.items.filter((i) => !q || i.name.toLowerCase().includes(q));
    if (SORTS[this.sort].fn) list = [...list].sort(SORTS[this.sort].fn);
    this.note.classList.toggle('hidden', this.app.ratings.enabled());
    this.note.innerHTML = 'Add a free OMDb key in <b>Sources → Ratings</b> to see Rotten Tomatoes, IMDb and Metacritic scores.';
    const frag = document.createDocumentFragment();
    for (const item of list.slice(0, this.limit)) frag.append(this.card(item));
    this.grid.innerHTML = '';
    this.grid.append(frag);
    if (!list.length) this.grid.innerHTML = '<p class="muted">Nothing here.</p>';
    this.more.innerHTML = '';
    if (list.length > this.limit) {
      const b = document.createElement('button');
      b.className = 'btn ghost';
      b.textContent = `Show more (${list.length - this.limit} left)`;
      b.onclick = () => { this.limit += PAGE; this.render(); };
      this.more.append(b);
    }
  }

  card(item) {
    const el = document.createElement('button');
    el.className = 'gcard';
    el.dataset.id = item.id;
    const { title, year } = this.app.parseTitle(item.name);
    el.innerHTML = `<div class="gposter"><span class="ginitial">${esc((title || item.name).charAt(0))}</span></div>
      <div class="gtitle">${esc(title || item.name)}</div>
      <div class="gmeta"><span>${item.year || year || ''}</span><span class="gbadges"></span></div>`;
    if (item.logo) this.poster(el.querySelector('.gposter'), item.logo);
    const prog = this.app.progress(item.id);
    if (prog && prog.d) el.querySelector('.gposter').insertAdjacentHTML('beforeend', `<i class="gprog" style="width:${Math.min(100, (prog.t / prog.d) * 100)}%"></i>`);
    if (this.app.isFav(item.id)) el.querySelector('.gposter').insertAdjacentHTML('beforeend', '<span class="gfav">★</span>');
    this.badges(el, item);
    el.onclick = () => this.showPreview(item);
    this.cards.set(item.id, el);
    this.observer.observe(el);
    return el;
  }

  poster(box, url) {
    const img = new Image();
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.alt = '';
    let triedProxy = false;
    img.onerror = () => {
      // http:// artwork on an https page is often blocked; the proxy can fetch it.
      const alt = !triedProxy && this.app.imageUrl(url);
      if (alt && alt !== img.src) { triedProxy = true; img.src = alt; } else img.remove();
    };
    img.onload = () => box.classList.add('loaded');
    img.src = url;
    box.prepend(img);
  }

  badges(el, item) {
    const r = this.app.ratings.peek(item);
    const out = [];
    if (r?.rt != null) out.push(tomato(r.rt));
    else if (r?.imdb) out.push(`<span class="badge imdb">IMDb ${esc(r.imdb)}</span>`);
    else if (item.rating) out.push(`<span class="badge star">★ ${(+item.rating).toFixed(1)}</span>`);
    el.querySelector('.gbadges').innerHTML = out.join('');
  }

  // A rating arrived for an item (from Ratings.onUpdate).
  updated(item) {
    const el = item && this.cards.get(item.id);
    if (el) this.badges(el, item);
    if (this.previewItem && item?.id === this.previewItem.id) this.renderPreview();
  }

  // ---------- Preview page ----------
  async showPreview(item) {
    this.previewItem = item;
    this.details = {};
    this.episodes = null;
    this.season = null;
    this.preview.classList.remove('hidden');
    this.app.ratings.get(item);
    this.renderPreview();
    try {
      if (item.kind === 'series') this.episodes = await this.app.episodes(item);
      else this.details = await this.app.movieInfo(item);
    } catch (err) {
      this.loadError = err.message;
    }
    if (this.previewItem === item) this.renderPreview();
  }

  closePreview() {
    this.previewItem = null;
    this.preview.classList.add('hidden');
    this.preview.innerHTML = '';
  }

  renderPreview() {
    const item = this.previewItem;
    if (!item) return;
    const d = this.details || {};
    const r = this.app.ratings.peek(item) || {};
    const { title, year } = this.app.parseTitle(item.name);
    const backdrop = d.backdrop || item.backdrop;
    const poster = r.poster || d.poster || item.logo;
    const plot = d.plot || item.plot || r.plot || '';
    const meta = [item.year || year || r.year, d.runtime || r.runtime, d.genre || item.genre || r.genre, r.rated || d.age]
      .filter((x) => x && x !== 'N/A').map(esc).join(' · ');
    const badges = [
      r.rt != null ? tomato(r.rt, true) : '',
      r.imdb ? `<span class="badge imdb big">IMDb ${esc(r.imdb)}</span>` : '',
      r.metacritic != null ? `<span class="badge meta big ${r.metacritic >= 61 ? 'good' : r.metacritic >= 40 ? 'mixed' : 'bad'}">Metacritic ${r.metacritic}</span>` : '',
      !r.rt && !r.imdb && (d.rating || item.rating) ? `<span class="badge star big">★ ${(+(d.rating || item.rating)).toFixed(1)}</span>` : '',
    ].join('');
    const people = [
      (d.director || item.director || r.director) && `<div><span class="muted">Director</span> ${esc(d.director || item.director || r.director)}</div>`,
      (d.cast || item.cast || r.actors) && `<div><span class="muted">Cast</span> ${esc(trimList(d.cast || item.cast || r.actors, 6))}</div>`,
      r.awards && `<div><span class="muted">Awards</span> ${esc(r.awards)}</div>`,
    ].filter(Boolean).join('');
    const prog = this.app.progress(item.id);
    const canResume = item.kind === 'movie' && prog && prog.t > 30 && prog.t < prog.d - 60;
    const trailer = youtubeId(d.trailer || item.trailer);

    this.preview.innerHTML = `
      <div class="pv-backdrop">${backdrop ? `<img src="${esc(backdrop)}" alt="" referrerpolicy="no-referrer">` : ''}</div>
      <button class="pv-back icon-btn" title="Back">‹</button>
      <div class="pv-body">
        <div class="pv-poster">${poster ? `<img src="${esc(poster)}" alt="" referrerpolicy="no-referrer">` : ''}</div>
        <div class="pv-info">
          <h2>${esc(r.title || title || item.name)}</h2>
          <div class="muted">${meta}</div>
          <div class="pv-badges">${badges || (this.app.ratings.enabled() ? '<span class="muted small">Looking up ratings…</span>' : '')}</div>
          <div class="pv-actions">
            ${item.kind === 'movie' ? `<button class="btn pv-play">${canResume ? `▶ Resume ${fmtTime(prog.t)}` : '▶ Play'}</button>` : ''}
            ${canResume ? '<button class="btn ghost pv-restart">From the start</button>' : ''}
            ${trailer ? '<button class="btn ghost pv-trailer">Trailer</button>' : ''}
            <button class="btn ghost pv-fav">${this.app.isFav(item.id) ? '★ Favorite' : '☆ Favorite'}</button>
            ${item.kind === 'movie' ? '<button class="btn ghost pv-ext">Open in…</button>' : ''}
          </div>
          <p class="pv-plot">${esc(plot) || (item.kind === 'series' && !this.episodes ? '<span class="muted">Loading…</span>' : '')}</p>
          <div class="pv-people small">${people}</div>
          <div class="pv-trailer-box"></div>
          ${item.kind === 'series' ? '<div class="pv-episodes"></div>' : ''}
        </div>
      </div>`;
    for (const img of this.preview.querySelectorAll('img')) {
      img.onerror = () => { const alt = this.app.imageUrl(img.getAttribute('src')); if (alt && img.src !== alt) img.src = alt; else img.remove(); };
    }
    const $ = (s) => this.preview.querySelector(s);
    $('.pv-back').onclick = () => this.closePreview();
    $('.pv-play')?.addEventListener('click', () => { this.app.play(item, canResume ? prog.t : 0); this.close(); });
    $('.pv-restart')?.addEventListener('click', () => { this.app.play(item, 0); this.close(); });
    $('.pv-fav').onclick = () => { this.app.toggleFav(item); this.renderPreview(); const c = this.cards.get(item.id); if (c) c.replaceWith(this.card(item)); };
    $('.pv-ext')?.addEventListener('click', () => this.app.external(item));
    $('.pv-trailer')?.addEventListener('click', () => {
      $('.pv-trailer-box').innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(trailer)}?autoplay=1&rel=0" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen title="Trailer"></iframe>`;
    });
    if (item.kind === 'series') this.renderEpisodes();
  }

  renderEpisodes() {
    const box = this.preview.querySelector('.pv-episodes');
    if (!box) return;
    if (!this.episodes) { box.innerHTML = '<p class="muted">Loading episodes…</p>'; return; }
    if (!this.episodes.length) { box.innerHTML = '<p class="muted">No episodes listed.</p>'; return; }
    const seasons = [...new Set(this.episodes.map((e) => e.season))].sort((a, b) => a - b);
    if (!seasons.includes(this.season)) {
      // Open the season you were last watching, else the first.
      const watched = this.episodes.filter((e) => this.app.progress(e.id)).pop();
      this.season = watched ? watched.season : seasons[0];
    }
    box.innerHTML = `<div class="seg pv-seasons">${seasons.map((s) => `<button data-s="${s}" class="${s === this.season ? 'active' : ''}">Season ${s}</button>`).join('')}</div><ol class="pv-eplist"></ol>`;
    for (const b of box.querySelectorAll('.pv-seasons button')) b.onclick = () => { this.season = +b.dataset.s; this.renderEpisodes(); };
    const ol = box.querySelector('.pv-eplist');
    for (const ep of this.episodes.filter((e) => e.season === this.season)) {
      const prog = this.app.progress(ep.id);
      const li = document.createElement('li');
      li.innerHTML = `<button class="pv-ep">
          <span class="pv-epnum">${ep.episode || ''}</span>
          <span class="pv-eptext"><b>${esc(ep.title || ep.name)}</b>${ep.plot ? `<span class="muted small">${esc(ep.plot)}</span>` : ''}</span>
          <span class="muted small">${prog && prog.d ? (prog.t > prog.d - 60 ? 'Watched' : `${fmtTime(prog.t)} / ${fmtTime(prog.d)}`) : esc(ep.runtime || '')}</span>
          <span class="pv-epplay">▶</span></button>`;
      li.querySelector('button').onclick = () => {
        this.app.play(ep, prog && prog.t > 30 && prog.t < prog.d - 60 ? prog.t : 0);
        this.close();
      };
      ol.append(li);
    }
  }
}

function tomato(score, big = false) {
  const fresh = score >= 60;
  return `<span class="badge tomato ${fresh ? 'fresh' : 'rotten'}${big ? ' big' : ''}" title="Rotten Tomatoes Tomatometer">${fresh ? '🍅' : '🤢'} ${score}%</span>`;
}

function trimList(s, n) {
  const parts = String(s).split(',').map((x) => x.trim()).filter(Boolean);
  return parts.length > n ? `${parts.slice(0, n).join(', ')}…` : parts.join(', ');
}

function youtubeId(t) {
  if (!t) return '';
  const m = String(t).match(/(?:v=|youtu\.be\/|embed\/)([\w-]{11})/);
  return m ? m[1] : /^[\w-]{11}$/.test(t) ? t : '';
}
