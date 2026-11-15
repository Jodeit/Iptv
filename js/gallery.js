// Poster gallery for movies and series, with a preview page per title (backdrop, plot, cast,
// ratings incl. Rotten Tomatoes, trailer, play/resume, and seasons/episodes for series).
import { servicesFor } from './services.js';

const PAGE = 120; // cards rendered per "Show more"

const SORTS = {
  added: { label: 'Recently added', fn: (a, b) => (b.added || 0) - (a.added || 0) },
  popular: { label: 'Most popular', fn: null }, // needs TMDB; set in constructor
  rt: { label: 'Rotten Tomatoes', fn: null }, // needs ratings; set in constructor
  rating: { label: 'Top rated', fn: (a, b) => (b.rating || 0) - (a.rating || 0) },
  year: { label: 'Newest', fn: (a, b) => (b.year || 0) - (a.year || 0) },
  title: { label: 'A–Z', fn: (a, b) => cleanName(a.name).localeCompare(cleanName(b.name)) },
};

// Age levels on one scale for film (MPAA) and TV (TV Parental Guidelines) certifications.
const AGE = {
  'TV-Y': 1,
  G: 2, 'TV-Y7': 2, 'TV-Y7-FV': 2, 'TV-G': 2,
  PG: 3, 'TV-PG': 3,
  'PG-13': 4, 'TV-14': 4,
  R: 5, 'TV-MA': 5,
  'NC-17': 6, NR: 6,
};
// The Age menu speaks each system's own terms.
const AGE_MENU = {
  movie: [[2, 'Kids (G)'], [3, 'Up to PG'], [4, 'Up to PG-13'], [5, 'Up to R']],
  series: [[1, 'Little kids (TV-Y)'], [2, 'Kids (TV-Y7, TV-G)'], [3, 'Up to TV-PG'], [4, 'Up to TV-14'], [5, 'Up to TV-MA']],
};

const pad = (n) => String(n || 0).padStart(2, '0');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cleanName = (n) => n.replace(/^\s*(\d{1,3}\s*[-.)]\s+|\|?[A-Z]{2,4}\|\s*|[A-Z]{2,4}\s*[-:|]\s+)/, '');
const fmtTime = (s) => (s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}` : `${Math.floor(s / 60)}`) + `:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export class GalleryView {
  // app: { library(), categories(kind), loadCategory(kind, id), episodes(series), movieInfo(item),
  //        ratings, play(item, startAt), progress(item), isFav(id), toggleFav(item), external(item),
  //        imageUrl(url) → proxied fallback, parseTitle }
  constructor(root, app) {
    this.root = root;
    this.app = app;
    this.kind = 'movie';
    this.sort = 'added';
    this.query = '';
    SORTS.popular.fn = (a, b) => (this.meta.get(b.id)?.pop ?? -1) - (this.meta.get(a.id)?.pop ?? -1);
    this.meta = new Map(); // item id → { cert, pop } from TMDB
    SORTS.rt.fn = (a, b) => (app.ratings.peek(b)?.rt ?? -1) - (app.ratings.peek(a)?.rt ?? -1);
    root.innerHTML = `
      <header class="gallery-head">
        <select class="gallery-cat" aria-label="Category"></select>
        <input class="gallery-search" type="search" placeholder="Search all categories…">
        <select class="gallery-sort" aria-label="Sort">${Object.entries(SORTS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}</select>
        <button class="gallery-close icon-btn" title="Close (Esc)">✕</button>
      </header>
      <div class="gallery-filters">
        <label>Rating <select class="gf-rating"><option value="0">Any</option><option value="5">5+</option><option value="6">6+</option><option value="7">7+</option><option value="8">8+</option><option value="9">9+</option></select></label>
        <label>Age <select class="gf-age"></select></label>
        <label>Year <select class="gf-year"><option value="">Any</option><option value="2020">2020s</option><option value="2010">2010s</option><option value="2000">2000s</option><option value="1990">1990s</option><option value="1980">1980s</option><option value="old">Before 1980</option></select></label>
        <label class="gf-genre-wrap hidden">Genre <select class="gf-genre"><option value="">Any</option></select></label>
        <label class="gf-service-wrap hidden">Service <select class="gf-service"><option value="">Any</option></select></label>
        <label class="check"><input type="checkbox" class="gf-fav"> Favorites</label>
        <label class="check"><input type="checkbox" class="gf-unwatched"> Hide watched</label>
        <button class="chip gf-reset hidden">Clear filters</button>
      </div>
      <div class="gallery-note muted small hidden"></div>
      <div class="gallery-scroll"><section class="gfor-you hidden"><h3>Picked for you</h3><div class="pv-row"></div><p class="muted small"></p></section><section class="gcontinue hidden"><h3>Continue watching</h3><div class="pv-row"></div></section><div class="gallery-grid"></div><div class="gallery-more"></div></div>
      <div class="gallery-preview hidden"></div>`;
    this.grid = root.querySelector('.gallery-grid');
    this.more = root.querySelector('.gallery-more');
    this.preview = root.querySelector('.gallery-preview');
    this.note = root.querySelector('.gallery-note');
    this.cards = new Map(); // item id → card element
    this.counts = new Map(); // series id → { seasons, episodes }
    this.countQueue = [];
    this.countBusy = 0;
    this.best = new Set(); // ids of the fullest listing among duplicates
    this.forYouCards = new Map();
    // Ratings cost a lookup each (1,000 a day on a free key), so only posters that stay on
    // screen for a moment ask; scrolling quickly past a hundred titles costs nothing.
    this.dwell = new Map(); // card → timer
    this.observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        clearTimeout(this.dwell.get(e.target));
        if (e.isIntersecting) {
          this.dwell.set(e.target, setTimeout(() => {
            const item = this.itemsById.get(e.target.dataset.id);
            this.app.ratings.get(item);
            if (item?.kind === 'series') this.queueCounts(item);
          }, 500));
        }
      }
    }, { root: root.querySelector('.gallery-scroll') });

    for (const b of root.querySelectorAll('.gallery-kind button')) b.onclick = () => this.open(b.dataset.kind);
    root.querySelector('.gallery-cat').onchange = (e) => this.showCategory(e.target.value);
    root.querySelector('.gallery-search').oninput = (e) => this.search(e.target.value);
    this.filters = { age: 0, rating: 0, year: '', genre: '', service: '', fav: false, unwatched: false };
    const f = (cls) => root.querySelector(cls);
    const sync = () => {
      this.filters = { age: +f('.gf-age').value, rating: +f('.gf-rating').value, year: f('.gf-year').value, genre: f('.gf-genre').value, service: f('.gf-service').value, fav: f('.gf-fav').checked, unwatched: f('.gf-unwatched').checked };
      this.limit = PAGE;
      this.render();
    };
    for (const c of ['.gf-age', '.gf-rating', '.gf-year', '.gf-genre', '.gf-service']) f(c).onchange = sync;
    for (const c of ['.gf-fav', '.gf-unwatched']) f(c).onchange = sync;
    f('.gf-reset').onclick = () => {
      f('.gf-age').value = '0'; f('.gf-rating').value = '0'; f('.gf-year').value = ''; f('.gf-genre').value = '';
      f('.gf-service').value = '';
      f('.gf-fav').checked = false; f('.gf-unwatched').checked = false;
      sync();
    };
    root.querySelector('.gallery-sort').onchange = (e) => { this.sort = e.target.value; this.render(); };
    root.querySelector('.gallery-close').onclick = () => this.close();
    addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !this.isOpen()) return;
      if (!this.preview.classList.contains('hidden')) this.back(); else this.close();
    });
  }

  isOpen() { return !this.root.classList.contains('hidden'); }

  async open(kind = this.kind, catId) {
    this.kind = kind;
    this.forYouRun = (this.forYouRun || 0) + 1;
    this.forYouKind = null;
    this.forYouState = null;
    this.root.classList.remove('hidden');
    this.closePreview();
    this.app.onToggle?.(true);
    for (const b of this.root.querySelectorAll('.gallery-kind button')) b.classList.toggle('active', b.dataset.kind === kind);
    this.fillAgeMenu(kind);
    const cats = this.app.categories(kind);
    const sel = this.root.querySelector('.gallery-cat');
    sel.innerHTML = cats.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
    const pick = catId && cats.some((c) => c.id === catId) ? catId : this.lastCat?.[kind] && cats.some((c) => c.id === this.lastCat[kind]) ? this.lastCat[kind] : cats[0]?.id;
    if (!pick) { this.grid.innerHTML = '<p class="muted">No categories.</p>'; return; }
    sel.value = pick;
    await this.showCategory(pick);
  }

  // The TV's own Movies / Shows grid opens a title straight into its detail page, without the gallery grid behind it.
  openDirect(item) {
    this.kind = item.kind;
    this.direct = true;
    this.items ??= [];
    this.itemsById ??= new Map();
    this.itemsById.set(item.id, item);
    this.root.classList.remove('hidden');
    this.app.onToggle?.(true);
    return this.showPreview(item);
  }

  // viaBack: closed by stepping back (Esc / Back), as opposed to starting playback
  close(viaBack = false) {
    this.direct = false;
    this.root.classList.add('hidden');
    this.closePreview();
    this.app.onToggle?.(false);
    this.app.onClosed?.(viaBack);
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
    this.loadForYou();
  }

  // Two or more characters search every category of this kind; clearing returns to the category.
  async search(text) {
    this.query = text.trim().toLowerCase();
    const kind = this.kind;
    this.limit = PAGE;
    if (this.query.length >= 2 && this.app.searchAll) {
      if (!this.pool?.[kind]) {
        this.note.classList.remove('hidden');
        this.note.textContent = 'Loading the full list to search it…';
        try {
          this.pool = { ...this.pool, [kind]: await this.app.searchAll(kind) };
        } catch (err) {
          this.note.textContent = `Couldn’t search everything: ${err.message}. Searching this category only.`;
        }
        if (this.query.length < 2 || this.kind !== kind) return this.render();
      }
    }
    this.render();
  }

  render() {
    this.observer.disconnect();
    for (const t of this.dwell.values()) clearTimeout(t);
    this.dwell.clear();
    this.app.ratings.clearQueue();
    this.countQueue = [];
    this.cards.clear();
    const q = this.query;
    const everywhere = q.length >= 2 && this.pool?.[this.kind];
    let list = (everywhere ? this.pool[this.kind] : this.items).filter((i) => !q || i.name.toLowerCase().includes(q));
    for (const i of list) this.itemsById.set(i.id, i);
    const needMeta = this.filters.age || this.sort === 'popular';
    if (needMeta && !this.quiet) this.fetchMeta(list);
    list = this.applyFilters(list);
    if (SORTS[this.sort].fn) list = [...list].sort(SORTS[this.sort].fn);
    this.note.classList.toggle('hidden', this.app.ratings.enabled());
    if (needMeta && !this.app.tmdbMeta) {
      this.note.classList.remove('hidden');
      this.note.innerHTML = 'Age ratings and popularity come from TMDB: add a free key in <b>Settings → Playback → Ratings</b>.';
    } else if (needMeta && this.metaPending) {
      this.note.classList.remove('hidden');
      this.note.textContent = `Looking up age ratings and popularity… ${this.metaDone.toLocaleString()} of ${this.metaTotal.toLocaleString()}`;
    } else if (everywhere) {
      this.note.classList.remove('hidden');
      this.note.textContent = `${list.length.toLocaleString()} result${list.length === 1 ? '' : 's'} across all categories`;
    } else this.note.innerHTML = 'Add a free OMDb key in <b>Settings → Playback → Ratings</b> to see Rotten Tomatoes, IMDb and Metacritic scores.';
    this.renderContinue(!q && !everywhere);
    this.renderForYou(!q && !everywhere);
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

  // Rebuilds the Age menu for movies or series, keeping the closest level that still fits.
  fillAgeMenu(kind) {
    const sel = this.root.querySelector('.gf-age');
    const menu = AGE_MENU[kind === 'series' ? 'series' : 'movie'];
    sel.innerHTML = '<option value="0">Any</option>' + menu.map(([v, label]) => `<option value="${v}">${label}</option>`).join('');
    const want = this.filters.age;
    const keep = want ? [...menu].reverse().find(([v]) => v <= want)?.[0] ?? menu[0][0] : 0;
    sel.value = String(keep);
    this.filters.age = keep;
  }

  // Looks up TMDB age ratings and popularity for a list, a few at a time, re-rendering as they arrive.
  async fetchMeta(list) {
    if (!this.app.tmdbMeta) return;
    const todo = list.filter((i) => !this.meta.has(i.id)).slice(0, 2000);
    const run = (this.metaRun = (this.metaRun || 0) + 1);
    if (!todo.length) { this.metaPending = false; return; }
    Object.assign(this, { metaPending: true, metaDone: 0, metaTotal: todo.length });
    let next = 0, last = performance.now();
    const worker = async () => {
      while (next < todo.length && this.metaRun === run) {
        const item = todo[next++];
        try { this.meta.set(item.id, (await this.app.tmdbMeta(item, { refreshPopularity: this.sort === 'popular' })) || { cert: '', pop: 0 }); } catch { this.meta.set(item.id, { cert: '', pop: 0 }); }
        this.metaDone++;
        if (performance.now() - last > 1500) { last = performance.now(); this.rerender(); }
      }
    };
    await Promise.all(Array.from({ length: 16 }, worker)); // TMDB allows ~40 requests a second
    if (this.metaRun !== run) return;
    this.metaPending = false;
    this.rerender();
  }

  // Re-render without kicking off another lookup round or losing the scroll position.
  rerender() {
    if (!this.isOpen() || !this.preview.classList.contains('hidden')) return;
    const scroll = this.root.querySelector('.gallery-scroll');
    const top = scroll.scrollTop;
    this.quiet = true;
    try { this.render(); } finally { this.quiet = false; }
    scroll.scrollTop = top;
  }

  // Best available score on a 0–10 scale: IMDb or Rotten Tomatoes if looked up, else the panel's own.
  score(item) {
    const r = this.app.ratings.peek(item);
    const imdb = parseFloat(r?.imdb);
    if (imdb > 0) return imdb;
    if (r?.rt != null) return r.rt / 10;
    return +item.rating || 0;
  }

  applyFilters(list) {
    const f = this.filters;
    const genres = new Set();
    const source = this.pool?.[this.kind] && this.query.length >= 2 ? this.pool[this.kind] : this.items;
    const services = new Set();
    for (const category of this.app.categories(this.kind)) {
      for (const service of servicesFor({ group: category.name })) services.add(service);
    }
    for (const i of source) {
      for (const g of String(i.genre || '').split(/[,/]/)) if (g.trim()) genres.add(g.trim());
      for (const service of servicesFor(i)) services.add(service);
    }
    const sel = this.root.querySelector('.gf-genre');
    const names = [...genres].sort((a, b) => a.localeCompare(b));
    if (sel.options.length - 1 !== names.length) {
      sel.innerHTML = '<option value="">Any</option>' + names.map((g) => `<option>${esc(g)}</option>`).join('');
      sel.value = names.includes(f.genre) ? f.genre : '';
      f.genre = sel.value;
    }
    this.root.querySelector('.gf-genre-wrap').classList.toggle('hidden', !names.length);
    const serviceSel = this.root.querySelector('.gf-service');
    const serviceNames = [...services].sort((a, b) => a.localeCompare(b));
    const oldServices = [...serviceSel.options].slice(1).map((o) => o.value);
    if (oldServices.length !== serviceNames.length || oldServices.some((v, i) => v !== serviceNames[i])) {
      serviceSel.innerHTML = '<option value="">Any</option>' + serviceNames.map((name) => `<option>${esc(name)}</option>`).join('');
    }
    serviceSel.value = serviceNames.includes(f.service) ? f.service : '';
    f.service = serviceSel.value;
    this.root.querySelector('.gf-service-wrap').classList.toggle('hidden', !serviceNames.length);
    const active = f.age || f.rating || f.year || f.genre || f.service || f.fav || f.unwatched;
    this.root.querySelector('.gf-reset').classList.toggle('hidden', !active);
    if (!active) return list;
    return list.filter((i) => {
      if (f.age) { const lvl = AGE[this.meta.get(i.id)?.cert]; if (!lvl || lvl > f.age) return false; } // unknown counts as too old
      if (f.rating && this.score(i) < f.rating) return false;
      if (f.year) {
        if (!i.year) return false;
        if (f.year === 'old' ? i.year >= 1980 : i.year < +f.year || i.year >= +f.year + 10) return false;
      }
      if (f.genre && !String(i.genre || '').split(/[,/]/).some((g) => g.trim() === f.genre)) return false;
      if (f.service && !servicesFor(i).includes(f.service)) return false;
      if (f.fav && !this.app.isFav(i.id)) return false;
      if (f.unwatched) { const p = this.app.progress(i); if (p && p.d && p.t / p.d > 0.9) return false; }
      return true;
    });
  }

  card(item) {
    const el = document.createElement('button');
    el.className = 'gcard';
    el.dataset.id = item.id;
    const { title, year } = this.app.parseTitle(item.name);
    el.innerHTML = `<div class="gposter"><span class="ginitial">${esc((title || item.name).charAt(0))}</span></div>
      <div class="gtitle">${esc(title || item.name)}</div>
      <div class="gmeta"><span>${item.year || year || ''}</span><span class="gbadges"></span></div>
      <div class="ginfo"></div>`;
    if (item.logo) this.poster(el.querySelector('.gposter'), item.logo);
    const prog = this.app.progress(item);
    if (prog && prog.d) el.querySelector('.gposter').insertAdjacentHTML('beforeend', `<i class="gprog" style="width:${Math.min(100, (prog.t / prog.d) * 100)}%"></i>`);
    if (this.app.isFav(item.id)) el.querySelector('.gposter').insertAdjacentHTML('beforeend', '<span class="gfav">★</span>');
    this.badges(el, item);
    this.info(el, item);
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

  // Films and shows you're part-way through, newest first, above the posters.
  renderContinue(show) {
    const box = this.root.querySelector('.gcontinue');
    const entries = show && this.app.continueList ? this.app.continueList(this.kind) : [];
    box.classList.toggle('hidden', !entries.length);
    const row = box.querySelector('.pv-row');
    row.innerHTML = '';
    for (const { item, p } of entries) {
      const el = document.createElement('button');
      el.className = 'gcard';
      const { title } = this.app.parseTitle(item.name);
      const sub = item.kind === 'series'
        ? `S${pad(p.season)}E${pad(p.episode)}${p.t < p.d - 60 ? ` · ${fmtTime(p.d - p.t)} left` : ' · next up'}`
        : `${fmtTime(p.d - p.t)} left`;
      el.innerHTML = `<div class="gposter"><span class="ginitial">${esc((title || item.name).charAt(0))}</span><i class="gprog" style="width:${Math.min(100, (p.t / p.d) * 100)}%"></i></div>
        <div class="gtitle">${esc(title || item.name)}</div><div class="ginfo">${esc(sub)}</div>`;
      if (item.logo) this.poster(el.querySelector('.gposter'), item.logo);
      el.onclick = () => {
        if (item.kind === 'series') this.showPreview(item);
        else { this.app.play(item, p.t > 30 ? p.t : 0); this.close(); }
      };
      row.append(el);
    }
  }

  loadForYou() {
    if (!this.app.forYou || this.forYouKind === this.kind) return;
    this.forYouKind = this.kind;
    const run = this.forYouRun = (this.forYouRun || 0) + 1;
    this.forYouState = { loading: 'Based on your favorites and watch history…' };
    this.renderForYou(!this.query);
    const kind = this.kind;
    this.app.forYou(kind, (done, total) => {
      if (this.kind === kind && this.forYouRun === run) {
        this.forYouState = { loading: `Checking your catalog · ${done} of ${total} categories` };
        this.renderForYou(!this.query);
      }
    }).then((state) => {
      if (this.kind !== kind || this.forYouRun !== run) return;
      this.forYouState = state;
      this.renderForYou(!this.query);
    }).catch((err) => {
      if (this.kind !== kind || this.forYouRun !== run) return;
      this.forYouState = { items: [], note: `Couldn’t load personalized picks: ${err.message}` };
      this.renderForYou(!this.query);
    });
  }

  renderForYou(show) {
    const box = this.root.querySelector('.gfor-you');
    const state = this.forYouState;
    box.classList.toggle('hidden', !show || !state);
    if (!show || !state) return;
    const row = box.querySelector('.pv-row');
    const note = box.querySelector('p');
    this.forYouCards.clear();
    if (state.loading) {
      row.innerHTML = '';
      note.textContent = state.loading;
      return;
    }
    row.innerHTML = '';
    note.textContent = state.note || '';
    for (const item of state.items || []) {
      const el = document.createElement('button');
      el.className = 'gcard';
      const { title, year } = this.app.parseTitle(item.name);
      el.innerHTML = `<div class="gposter"><span class="ginitial">${esc((title || item.name).charAt(0))}</span></div>
        <div class="gtitle">${esc(title || item.name)}</div><div class="gmeta"><span>${item.year || year || ''}</span><span class="gbadges"></span></div>`;
      if (item.logo) this.poster(el.querySelector('.gposter'), item.logo);
      this.badges(el, item);
      el.onclick = () => this.showPreview(item);
      this.forYouCards.set(item.id, el);
      row.append(el);
    }
    for (const item of (state.items || []).slice(0, 10)) this.app.ratings.get(item);
  }

  // What tells one listing of a title from another: its category (language, quality), how
  // many seasons and episodes it has, and when the provider last updated it.
  info(el, item) {
    const box = el.querySelector('.ginfo');
    if (!box) return;
    const c = this.counts.get(item.id);
    const bits = [];
    if (c) bits.push(`${c.seasons} season${c.seasons === 1 ? '' : 's'} · ${c.episodes} ep${c.episodes === 1 ? '' : 's'}`);
    if (item.kind === 'series' && item.added) bits.push(`updated ${new Date(item.added * 1000).toLocaleDateString([], { month: 'short', year: 'numeric' })}`);
    const tags = (`${item.name}`.match(/\b(4K|UHD|FHD|HDR|MULTI[- ]?SUBS?|DUAL)\b/gi) || []).map((t) => t.toUpperCase()).filter((t) => !(item.group || '').toUpperCase().includes(t)); // tags in the title the category doesn't already say
    box.innerHTML = [
      bits.length ? `<div>${esc(bits.join(' · '))}</div>` : '',
      `<div class="gcat">${esc(item.group || '')}${tags.length ? ` <b>${esc([...new Set(tags)].join(' '))}</b>` : ''}</div>`,
      this.best.has(item.id) ? '<span class="badge best">Most episodes</span>' : '',
    ].join('');
  }

  // Episode counts for series cards on screen, two requests at a time.
  queueCounts(item) {
    if (!this.app.seriesCounts || this.counts.has(item.id) || this.countQueue.includes(item)) return;
    this.countQueue.push(item);
    this.pumpCounts();
  }

  async pumpCounts() {
    while (this.countBusy < 2 && this.countQueue.length) {
      const item = this.countQueue.shift();
      this.countBusy++;
      this.app.seriesCounts(item).then((c) => {
        if (c) { this.counts.set(item.id, c); this.markBest(); }
      }).catch(() => {}).finally(() => { this.countBusy--; this.pumpCounts(); });
    }
  }

  // Among cards for the same title, flag the listing with the most episodes.
  markBest() {
    const groups = new Map();
    for (const id of this.cards.keys()) {
      const item = this.itemsById.get(id);
      const c = this.counts.get(id);
      if (!item || !c) continue;
      const { title, year } = this.app.parseTitle(item.name);
      const key = `${(title || item.name).toLowerCase()}|${item.year || year || ''}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push([id, c.episodes]);
    }
    const best = new Set();
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      const max = Math.max(...list.map(([, n]) => n));
      const top = list.filter(([, n]) => n === max);
      if (max > 0 && top.length < list.length) for (const [id] of top) best.add(id);
    }
    this.best = best;
    for (const [id, el] of this.cards) this.info(el, this.itemsById.get(id));
  }

  // A rating arrived for an item (from Ratings.onUpdate).
  updated(item) {
    const el = item && this.cards.get(item.id);
    if (el) this.badges(el, item);
    const row = item && this.rowCards?.get(item.id);
    if (row) this.badges(row, item);
    const forYouCard = item && this.forYouCards.get(item.id);
    if (forYouCard) this.badges(forYouCard, item);
    if (this.previewItem && item?.id === this.previewItem.id) this.renderPreview();
  }

  // ---------- Preview page ----------
  // `from` is the title whose "More like this" row was used, for the back button.
  async showPreview(item, from = null) {
    this.stack = from ? [...(this.stack || []), from] : [];
    this.previewItem = item;
    this.moreState = null;
    this.preview.scrollTop = 0;
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
    if (this.previewItem !== item) return;
    this.renderPreview();
    this.loadMore(item);
  }

  async loadMore(item) {
    this.moreState = { loading: 'Finding recommendations…' };
    this.renderMore();
    let state;
    try {
      state = await this.app.moreLike(item, this.details || {}, (done, total) => {
        if (this.previewItem !== item) return;
        this.moreState = { loading: `Checking which recommendations your provider has · indexing ${done} of ${total} categories (once a day)` };
        this.renderMore();
      });
    } catch (err) {
      state = { items: [], note: `Couldn’t get recommendations: ${err.message}` };
    }
    if (this.previewItem !== item) return;
    this.moreState = state;
    this.renderMore();
  }

  renderMore() {
    const box = this.preview.querySelector('.pv-more');
    const st = this.moreState;
    if (!box || !st) return;
    const scroll = box.querySelector('.pv-row')?.scrollLeft || 0;
    this.rowCards = new Map();
    if (st.loading) { box.innerHTML = `<h3>More like this</h3><p class="muted small">${esc(st.loading)}</p>`; return; }
    if (!st.items.length) { box.innerHTML = st.note ? `<h3>More like this</h3><p class="muted small">${esc(st.note)}</p>` : ''; return; }
    box.innerHTML = `<h3>More like this <span class="muted small">· ${st.items.length} on your provider, picked by TMDB</span></h3><div class="pv-row"></div>`;
    const row = box.querySelector('.pv-row');
    for (const [i, it] of st.items.entries()) {
      const el = document.createElement('button');
      el.className = 'gcard';
      const { title, year } = this.app.parseTitle(it.name);
      el.innerHTML = `<div class="gposter"><span class="ginitial">${esc((title || it.name).charAt(0))}</span></div>
        <div class="gtitle">${esc(title || it.name)}</div>
        <div class="gmeta"><span>${it.year || year || ''}</span><span class="gbadges"></span></div>`;
      if (it.logo) this.poster(el.querySelector('.gposter'), it.logo);
      this.badges(el, it);
      if (i < 10) this.app.ratings.get(it); // the first few get scores; cached for next time
      el.onclick = () => this.showPreview(it, this.previewItem);
      this.rowCards.set(it.id, el);
      row.append(el);
    }
    row.scrollLeft = scroll;
  }

  back() {
    const prev = this.stack?.pop();
    if (!prev) { if (this.direct) { this.close(true); return; } this.closePreview(); return; }
    const stack = this.stack;
    this.showPreview(prev);
    this.stack = stack;
  }

  closePreview() {
    this.stack = [];
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
    const prog = this.app.progress(item);
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
      </div>
      <section class="pv-more"></section>`;
    for (const img of this.preview.querySelectorAll('img')) {
      img.onerror = () => { const alt = this.app.imageUrl(img.getAttribute('src')); if (alt && img.src !== alt) img.src = alt; else img.remove(); };
    }
    const $ = (s) => this.preview.querySelector(s);
    $('.pv-back').onclick = () => this.back();
    $('.pv-play')?.addEventListener('click', () => { this.app.play(item, canResume ? prog.t : 0); this.close(); });
    $('.pv-restart')?.addEventListener('click', () => { this.app.play(item, 0); this.close(); });
    $('.pv-fav').onclick = () => {
      this.app.toggleFav(item);
      this.forYouKind = null;
      this.loadForYou();
      this.renderPreview();
      const c = this.cards.get(item.id);
      if (c) c.replaceWith(this.card(item));
    };
    $('.pv-ext')?.addEventListener('click', () => this.app.external(item));
    $('.pv-trailer')?.addEventListener('click', () => {
      $('.pv-trailer-box').innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(trailer)}?autoplay=1&rel=0" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen title="Trailer"></iframe>`;
    });
    if (item.kind === 'series') this.renderEpisodes();
    this.renderMore();
  }

  renderEpisodes() {
    const box = this.preview.querySelector('.pv-episodes');
    if (!box) return;
    if (!this.episodes) { box.innerHTML = '<p class="muted">Loading episodes…</p>'; return; }
    if (!this.episodes.length) { box.innerHTML = '<p class="muted">No episodes listed.</p>'; return; }
    const seasons = [...new Set(this.episodes.map((e) => e.season))].sort((a, b) => a - b);
    if (!seasons.includes(this.season)) {
      // Open the season you were last watching, else the first.
      const watched = this.episodes.filter((e) => this.app.progress(e)).pop();
      this.season = watched ? watched.season : seasons[0];
    }
    // Where to carry on: the episode you were in the middle of, else the one after the last you finished.
    const show = this.app.progress(this.previewItem);
    let next = this.episodes[0], label = `▶ Play S${pad(next.season)}E${pad(next.episode)}`, at = 0;
    const i = show?.season != null ? this.episodes.findIndex((e) => e.season === show.season && e.episode === show.episode) : -1;
    if (i >= 0) {
      const ep = this.episodes[i], p = this.app.progress(ep) || show;
      if (p.t < p.d - 60) { next = ep; at = p.t > 30 ? p.t : 0; label = `▶ Continue S${pad(ep.season)}E${pad(ep.episode)}${at ? ` · ${fmtTime(at)}` : ''}`; }
      else if (this.episodes[i + 1]) { next = this.episodes[i + 1]; label = `▶ Next: S${pad(next.season)}E${pad(next.episode)}`; }
      else label = '✓ Watched all · Play S01E01 again';
    }
    box.innerHTML = `<div class="pv-continue"><button class="btn pv-next">${esc(label)}</button>${next.title ? ` <span class="muted small">${esc(next.title)}</span>` : ''}</div>
      <div class="seg pv-seasons">${seasons.map((s) => `<button data-s="${s}" class="${s === this.season ? 'active' : ''}">Season ${s}</button>`).join('')}</div><ol class="pv-eplist"></ol>`;
    box.querySelector('.pv-next').onclick = () => { this.app.play(next, at); this.close(); };
    for (const b of box.querySelectorAll('.pv-seasons button')) b.onclick = () => { this.season = +b.dataset.s; this.renderEpisodes(); };
    const ol = box.querySelector('.pv-eplist');
    for (const ep of this.episodes.filter((e) => e.season === this.season)) {
      const prog = this.app.progress(ep);
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
