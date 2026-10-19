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
    const auth = `${enc(this.xt.username)}/${enc(this.xt.password)}`;
    const group = this.catName(kind, catId);
    const items = (Array.isArray(rows) ? rows : []).map((s, i) => (kind === 'movie'
      ? {
        num: i + 1,
        id: `${this.streamBase}/movie/${auth}/${s.stream_id}.${s.container_extension || 'mp4'}`,
        url: `${this.streamBase}/movie/${auth}/${s.stream_id}.${s.container_extension || 'mp4'}`,
        name: s.name, logo: s.stream_icon || '', group, tvgId: '', layout: null, kind: 'movie',
      }
      : {
        num: i + 1,
        id: `xtream-series:${s.series_id}`,
        url: `xtream-series:${s.series_id}`,
        seriesId: s.series_id,
        name: s.name, logo: s.cover || '', group, tvgId: '', layout: null, kind: 'series', plot: s.plot || '',
      }));
    // Keep a handful of categories in memory; older ones reload when reopened.
    cache.set(catId, items);
    if (cache.size > 6) cache.delete(cache.keys().next().value);
    return items;
  }

  async seriesEpisodes(series) {
    if (this.episodes.has(series.seriesId)) return this.episodes.get(series.seriesId);
    const info = await this.fetchJson(this.api('get_series_info', { series_id: series.seriesId }));
    const auth = `${enc(this.xt.username)}/${enc(this.xt.password)}`;
    const out = [];
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
        });
      }
    }
    this.episodes.set(series.seriesId, out);
    if (this.episodes.size > 10) this.episodes.delete(this.episodes.keys().next().value);
    return out;
  }
}

const enc = encodeURIComponent;
