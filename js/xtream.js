// Xtream Codes library loaded through the panel's player_api.php, the way dedicated IPTV
// apps do it, instead of one giant get.php playlist with every channel, movie and episode.
//
//  - Categories (small) load first.
//  - Live channels load next: only the categories the content filter keeps, or all of
//    them in one request when the filter is off.
//  - Movies and series load one category at a time, when that category is opened;
//    a series' episodes load when the series is opened.
//
// This keeps memory low enough for iPad Safari, which reloads a tab that uses too much.
// Items use the same shape as M3U channels: { num, id, url, name, logo, group, tvgId, kind }.

export class XtreamLibrary {
  // fetchJson(url, onProgress?) → parsed JSON (direct or proxied as needed).
  constructor(xt, fetchJson) {
    this.xt = xt;
    this.fetchJson = fetchJson;
    this.cats = { live: [], movie: [], series: [] };
    this.items = { movie: new Map(), series: new Map() }; // category id → items
    this.episodes = new Map(); // series id → episodes
    this.liveLoaded = null; // 'all' or Set of category ids
  }

  api(action, params = {}) {
    const q = new URLSearchParams({ username: this.xt.username, password: this.xt.password, ...(action ? { action } : {}), ...params });
    return `${this.xt.server}/player_api.php?${q}`;
  }

  // Account + categories. Throws if this panel has no usable API (caller falls back to M3U).
  async init() {
    const info = await this.fetchJson(this.api(''));
    if (!info?.user_info) throw new Error('no player_api');
    if (info.user_info.auth === 0) throw new Error('The Xtream server refused the login. Check the username and password.');
    this.account = info.user_info;
    // Stream URLs use the server the panel advertises (often the same host; sometimes another port).
    const si = info.server_info || {};
    const proto = si.server_protocol === 'https' ? 'https' : 'http';
    const port = proto === 'https' ? si.https_port : si.port;
    this.streamBase = si.url ? `${proto}://${si.url}${port && !['80', '443'].includes(String(port)) ? `:${port}` : ''}` : this.xt.server;
    const [live, movie, series] = await Promise.all([
      this.fetchJson(this.api('get_live_categories')).catch(() => []),
      this.fetchJson(this.api('get_vod_categories')).catch(() => []),
      this.fetchJson(this.api('get_series_categories')).catch(() => []),
    ]);
    const norm = (list) => (Array.isArray(list) ? list : []).map((c) => ({ id: String(c.category_id), name: c.category_name || 'Uncategorized' }));
    this.cats = { live: norm(live), movie: norm(movie), series: norm(series) };
    return this;
  }

  catName(kind, id) {
    return this.cats[kind].find((c) => c.id === String(id))?.name || 'Uncategorized';
  }

  // Live channels for the given category ids (null = all, in one request).
  async live(catIds, onProgress) {
    let rows = [];
    if (!catIds) {
      rows = await this.fetchJson(this.api('get_live_streams'), onProgress);
      this.liveLoaded = 'all';
    } else {
      const ids = [...catIds];
      let done = 0;
      // A few categories at a time; each is a small request.
      for (let i = 0; i < ids.length; i += 4) {
        const batch = await Promise.all(ids.slice(i, i + 4).map((id) => this.fetchJson(this.api('get_live_streams', { category_id: id })).catch(() => [])));
        for (const b of batch) if (Array.isArray(b)) rows.push(...b);
        done += batch.length;
        onProgress?.({ phase: 'categories', done, total: ids.length });
      }
      this.liveLoaded = new Set([...(this.liveLoaded instanceof Set ? this.liveLoaded : []), ...ids]);
    }
    const auth = `${enc(this.xt.username)}/${enc(this.xt.password)}`;
    return (Array.isArray(rows) ? rows : []).map((s, i) => {
      const url = `${this.streamBase}/${auth}/${s.stream_id}`;
      return {
        num: +s.num || i + 1,
        id: url,
        url,
        name: s.name || `Channel ${s.stream_id}`,
        logo: s.stream_icon || '',
        group: this.catName('live', s.category_id),
        tvgId: s.epg_channel_id || '',
        layout: null,
        kind: 'live',
      };
    });
  }

  async category(kind, catId, onProgress) {
    const cache = this.items[kind];
    if (cache.has(catId)) return cache.get(catId);
    const action = kind === 'movie' ? 'get_vod_streams' : 'get_series';
    const rows = await this.fetchJson(this.api(action, { category_id: catId }), onProgress);
    const group = this.catName(kind, catId);
    const items = (Array.isArray(rows) ? rows : []).map((s, i) => this.toItem(kind, s, i, group));
    // Keep a handful of categories in memory; older ones reload when reopened.
    cache.set(catId, items);
    if (cache.size > 6) cache.delete(cache.keys().next().value);
    return items;
  }

  toItem(kind, s, i, group) {
    const auth = `${enc(this.xt.username)}/${enc(this.xt.password)}`;
    const tmdb = String(s.tmdb || s.tmdb_id || '').replace(/\D/g, '');
    return kind === 'movie'
      ? {
        num: i + 1,
        id: `${this.streamBase}/movie/${auth}/${s.stream_id}.${s.container_extension || 'mp4'}`,
        url: `${this.streamBase}/movie/${auth}/${s.stream_id}.${s.container_extension || 'mp4'}`,
        name: s.name, logo: s.stream_icon || '', group, tvgId: '', layout: null, kind: 'movie',
        streamId: s.stream_id, rating: +s.rating || 0, added: +s.added || 0, year: +s.year || yearOf(s.name, s.releaseDate || s.release_date), tmdb,
      }
      : {
        num: i + 1,
        id: `xtream-series:${s.series_id}`,
        url: `xtream-series:${s.series_id}`,
        seriesId: s.series_id,
        name: s.name, logo: s.cover || '', group, tvgId: '', layout: null, kind: 'series', plot: s.plot || '',
        rating: +s.rating || 0, added: +s.last_modified || 0, year: yearOf(s.name, s.releaseDate || s.release_date),
        genre: s.genre || '', cast: s.cast || '', director: s.director || '', trailer: s.youtube_trailer || '',
        backdrop: firstOf(s.backdrop_path), tmdb,
      };
  }

  // Every title in the given categories, for matching recommendations against what this
  // provider carries. Fetched a few categories at a time; nothing is kept beyond the result
  // (the caller caches it), so memory stays at one list of titles.
  async catalog(kind, catIds, onProgress) {
    const out = [];
    const seen = new Set();
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (next < catIds.length) {
        const catId = catIds[next++];
        let items = this.items[kind].get(catId);
        if (!items) {
          try {
            const rows = await this.fetchJson(this.api(kind === 'movie' ? 'get_vod_streams' : 'get_series', { category_id: catId }));
            const group = this.catName(kind, catId);
            items = (Array.isArray(rows) ? rows : []).map((s, i) => this.toItem(kind, s, i, group));
          } catch { items = []; } // one broken category shouldn't sink the rest
        }
        for (const it of items) {
          if (seen.has(it.id)) continue;
          seen.add(it.id);
          // Long text isn't needed to match titles; the preview page fetches details anyway.
          out.push({ ...it, plot: undefined, cast: undefined });
        }
        onProgress?.(++done, catIds.length);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    return out;
  }

  // Full details for a film's preview page (plot, cast, trailer…); {} if the panel has none.
  async movieInfo(item) {
    if (!item.streamId) return {};
    const key = `vod:${item.streamId}`;
    if (this.details?.has(key)) return this.details.get(key);
    let info = {};
    try {
      const r = await this.fetchJson(this.api('get_vod_info', { vod_id: item.streamId }));
      const i = r?.info || {};
      info = {
        plot: i.plot || i.description || '', cast: i.cast || i.actors || '', director: i.director || '', genre: i.genre || '',
        runtime: runtimeOf(i.duration) || (i.duration_secs ? runtimeOf(+i.duration_secs) : '') || (i.episode_run_time ? `${i.episode_run_time} min` : ''),
        released: i.releasedate || i.release_date || '', rating: +i.rating || 0, trailer: i.youtube_trailer || '',
        poster: i.movie_image || i.cover_big || '', backdrop: firstOf(i.backdrop_path), tmdb: String(i.tmdb_id || i.tmdb || '').replace(/\D/g, ''), age: i.mpaa_rating || i.age || '',
      };
    } catch { /* details are optional */ }
    this.details ??= new Map();
    this.details.set(key, info);
    if (this.details.size > 50) this.details.delete(this.details.keys().next().value);
    return info;
  }

  async seriesEpisodes(series) {
    if (this.episodes.has(series.seriesId)) return this.episodes.get(series.seriesId);
    const info = await this.fetchJson(this.api('get_series_info', { series_id: series.seriesId }));
    const auth = `${enc(this.xt.username)}/${enc(this.xt.password)}`;
    const out = [];
    // Series details for the preview page arrive with the episodes.
    const si = info?.info || {};
    Object.assign(series, {
      plot: si.plot || series.plot, cast: si.cast || series.cast, director: si.director || series.director,
      genre: si.genre || series.genre, trailer: si.youtube_trailer || series.trailer,
      backdrop: firstOf(si.backdrop_path) || series.backdrop, released: si.releaseDate || si.release_date || '',
      tmdb: String(si.tmdb || si.tmdb_id || series.tmdb || '').replace(/\D/g, ''),
    });
    for (const [season, eps] of Object.entries(info?.episodes || {})) {
      for (const e of eps || []) {
        const url = `${this.streamBase}/series/${auth}/${e.id}.${e.container_extension || 'mp4'}`;
        out.push({
          num: out.length + 1,
          id: url,
          url,
          name: `S${String(season).padStart(2, '0')} E${String(e.episode_num).padStart(2, '0')} · ${e.title || ''}`.trim(),
          logo: e.info?.movie_image || series.logo,
          group: series.name,
          tvgId: '',
          layout: null,
          kind: 'episode',
          season: +season,
          episode: +e.episode_num || 0,
          title: e.title || '',
          plot: e.info?.plot || '',
          runtime: runtimeOf(e.info?.duration || e.info?.duration_secs),
        });
      }
    }
    this.episodes.set(series.seriesId, out);
    if (this.episodes.size > 10) this.episodes.delete(this.episodes.keys().next().value);
    return out;
  }
}

const enc = encodeURIComponent;
const firstOf = (v) => (Array.isArray(v) ? v[0] : v) || '';
// "Movie Title (2019)", "Movie - 2019 [Multi]" or a release date.
const yearOf = (name = '', date = '') => +((`${date}`.match(/\b(19|20)\d{2}\b/) || `${name}`.match(/\b(19[2-9]\d|20[0-4]\d)\b/) || [0])[0]);

// "02:22:00" or 8520 (seconds) → "2h 22m"; other text passes through.
function runtimeOf(d) {
  let secs = typeof d === 'number' ? d : NaN;
  const m = typeof d === 'string' && d.match(/^(\d+):(\d{2}):(\d{2})$/);
  if (m) secs = +m[1] * 3600 + +m[2] * 60 + +m[3];
  if (!Number.isFinite(secs)) return d || '';
  if (!secs) return '';
  const h = Math.floor(secs / 3600), min = Math.round((secs % 3600) / 60);
  return h ? `${h}h ${min}m` : `${min}m`;
}
