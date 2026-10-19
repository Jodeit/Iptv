// "More like this": TMDB's recommendations for a title, kept to what the provider carries.
// TMDB (themoviedb.org) recommends from what its users watched together; a free API key is
// enough. The provider's own catalog is the filter: a recommendation only shows if a title
// with the same TMDB id, or the same name and year, is in it.

import { cacheGet, cachePut } from './cache.js';
import { parseTitle } from './ratings.js';

const API = 'https://api.themoviedb.org/3';
const TTL = 7 * 86400000;
const MAX = 24;

export class Similar {
  // fetcher(url, init) → Response; getKey() → TMDB API key (v3 key or v4 read token) or ''.
  constructor({ fetcher, getKey }) {
    this.fetcher = fetcher;
    this.getKey = getKey;
    this.lastError = '';
  }

  enabled() { return !!this.getKey(); }

  async api(path, params = {}, key = this.getKey()) {
    // v3 keys are 32 hex characters and go in the query; v4 read tokens are long JWTs.
    const v3 = /^[0-9a-f]{32}$/i.test(key);
    const q = new URLSearchParams({ ...params, ...(v3 ? { api_key: key } : {}) });
    const res = await this.fetcher(`${API}${path}?${q}`, v3 ? undefined : { headers: { Authorization: `Bearer ${key}` } });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.status_message || `HTTP ${res.status}`);
    return d;
  }

  // Checks a key. → '' if it works, else the reason.
  async test(key) {
    try { await this.api('/configuration', {}, key); return ''; } catch (err) { return err.message; }
  }

  // TMDB id for an item: from the provider if it has one, else via the IMDb id (from OMDb),
  // else by searching the title and year.
  async tmdbId(item, { tmdb, imdbID } = {}) {
    const type = item.kind === 'series' ? 'tv' : 'movie';
    if (tmdb || item.tmdb) return { type, id: String(tmdb || item.tmdb) };
    const { title, year } = parseTitle(item.name);
    const key = `tmdb-id:${type}:${imdbID || `${title.toLowerCase()}:${year || ''}`}`;
    const cached = await cacheGet(key);
    if (cached && Date.now() - cached.at < 30 * 86400000) return cached.id ? { type, id: cached.id } : null;
    let id = '';
    if (imdbID) {
      const d = await this.api(`/find/${imdbID}`, { external_source: 'imdb_id' });
      id = String((type === 'tv' ? d.tv_results : d.movie_results)?.[0]?.id || '');
    }
    if (!id && title) {
      const params = { query: title, include_adult: 'false' };
      if (year) params[type === 'tv' ? 'first_air_date_year' : 'year'] = String(year);
      let d = await this.api(`/search/${type}`, params);
      if (!d.results?.length && year) d = await this.api(`/search/${type}`, { query: title, include_adult: 'false' });
      id = String(d.results?.[0]?.id || '');
    }
    cachePut(key, { at: Date.now(), id });
    return id ? { type, id } : null;
  }

  // US age rating and popularity for a title: { cert: 'PG-13' | 'TV-14' | '', pop: number }.
  async meta({ type, id }) {
    const key = `tmdb-meta:${type}:${id}`;
    const cached = await cacheGet(key);
    if (cached && Date.now() - cached.at < 30 * 86400000) return cached.meta;
    const d = await this.api(`/${type}/${id}`, { append_to_response: type === 'tv' ? 'content_ratings' : 'release_dates' });
    let cert = '';
    if (type === 'tv') cert = d.content_ratings?.results?.find((r) => r.iso_3166_1 === 'US')?.rating || '';
    else {
      const us = d.release_dates?.results?.find((r) => r.iso_3166_1 === 'US')?.release_dates || [];
      cert = us.map((r) => r.certification).find(Boolean) || '';
    }
    const meta = { cert, pop: +d.popularity || 0 };
    cachePut(key, { at: Date.now(), meta });
    return meta;
  }

  // TMDB's picks for a title, best first: [{ id, title, year }].
  async recommendations({ type, id }) {
    const key = `tmdb-recs:${type}:${id}`;
    const cached = await cacheGet(key);
    if (cached && Date.now() - cached.at < TTL) return cached.recs;
    const pick = (r) => ({ id: String(r.id), title: r.title || r.name || '', original: r.original_title || r.original_name || '', year: +(r.release_date || r.first_air_date || '').slice(0, 4) || 0 });
    const recs = [];
    const seen = new Set([String(id)]);
    const add = (list) => { for (const r of list || []) if (!seen.has(String(r.id))) { seen.add(String(r.id)); recs.push(pick(r)); } };
    // Recommendations ("people who liked this also liked") first, then "similar" (shared
    // genres and keywords), two pages each: plenty for a provider that only has some of them.
    for (const kind of ['recommendations', 'similar']) {
      for (const page of [1, 2]) {
        const d = await this.api(`/${type}/${id}/${kind}`, { page: String(page) });
        add(d.results);
        if (page >= (d.total_pages || 1)) break;
      }
    }
    cachePut(key, { at: Date.now(), recs });
    return recs;
  }
}

// "The Lord of the Rings: The Fellowship of the Ring" → "lord of rings fellowship of ring"
export const normTitle = (s) => String(s).toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/&/g, ' and ').replace(/\b(the|a|an)\b/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ').trim();

// Index of a provider catalog for matching: by TMDB id and by normalized title.
export function indexCatalog(items) {
  const byTmdb = new Map();
  const byTitle = new Map();
  for (const it of items) {
    if (it.tmdb) byTmdb.set(String(it.tmdb), it);
    const { title, year } = parseTitle(it.name);
    const k = normTitle(title);
    if (!k) continue;
    if (!byTitle.has(k)) byTitle.set(k, []);
    byTitle.get(k).push({ it, year: it.year || year });
  }
  return { byTmdb, byTitle, size: items.length };
}

// Recommendations the provider has, in TMDB's order.
export function matchCatalog(recs, index, exclude) {
  const out = [];
  const used = new Set([exclude]);
  for (const r of recs) {
    let hit = index.byTmdb.get(r.id);
    if (!hit) {
      for (const t of [r.title, r.original]) {
        const cands = t ? index.byTitle.get(normTitle(t)) : null;
        // Same name and a year within one (providers often list the release year off by one);
        // without a year on either side the name alone has to do.
        hit = cands?.find((c) => !r.year || !c.year || Math.abs(c.year - r.year) <= 1)?.it;
        if (hit) break;
      }
    }
    if (hit && !used.has(hit.id)) {
      used.add(hit.id);
      out.push(hit);
      if (out.length >= MAX) break;
    }
  }
  return out;
}
