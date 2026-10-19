// Film and series ratings (Rotten Tomatoes, IMDb, Metacritic) from OMDb (omdbapi.com).
// Rotten Tomatoes has no public API; OMDb includes its Tomatometer. It needs a free key
// (1,000 lookups a day), so lookups are cached for 30 days and only made for posters that
// are on screen, a couple at a time, with a daily budget.

import { cacheGet, cachePut } from './cache.js';

const TTL = 30 * 86400000;
const MISS_TTL = 7 * 86400000;
const DAILY_BUDGET = 950;
const PARALLEL = 2;

// "01 - The Shawshank Redemption - 1994 [Multi sub]" → { title: 'The Shawshank Redemption', year: 1994 }
export function parseTitle(raw = '') {
  let s = ` ${raw} `
    .replace(/\[[^\]]*\]|\{[^}]*\}/g, ' ') // [Multi sub], {tags}
    .replace(/[._]/g, ' ');
  // Leading numbering and language/region prefixes: "01 - ", "EN - ", "|EN| ", "4K-EN: "
  for (let i = 0; i < 3; i++) s = s.replace(/^\s*(\d{1,3}\s*[-.)]\s+|\|?[A-Z]{2,3}\|\s*|[A-Z]{2,4}(\s*\|\s*[A-Z0-9]+)?\s*[-:|]\s+|4K\s*[-:|]\s*)/, ' ');
  let year = 0;
  const years = [...s.matchAll(/(?:^|[\s(\-–])((?:19[2-9]|20[0-4])\d)(?=$|[\s)\-–])/g)];
  const y = years[years.length - 1];
  if (y && y.index > 2) {
    year = +y[1];
    s = s.slice(0, y.index); // the year ends the title; quality tags usually follow it
  }
  s = s
    .replace(/\((?:19|20)\d{2}\)/g, ' ')
    .replace(/\b(4K|UHD|FHD|HD|SD|HDR10?|DV|1080p|2160p|720p|480p|x26[45]|HEVC|H ?26[45]|MULTI(?:[- ]?SUBS?)?|SUBS?|DUAL|VOSTFR|WEB-?DL|BluRay|BRRip|REMUX|EXTENDED|UNRATED|DIRECTORS? CUT)\b/gi, ' ')
    .replace(/[()]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–:|]+|[\s\-–:|]+$/g, '')
    .trim();
  return { title: s, year };
}

export class Ratings {
  // fetcher(url) → Response; getKey() → OMDb API key or ''; onUpdate(item) when a rating arrives.
  constructor({ fetcher, getKey, onUpdate }) {
    this.fetcher = fetcher;
    this.getKey = getKey;
    this.onUpdate = onUpdate;
    this.mem = new Map(); // cache key → result | null (miss)
    this.queue = [];
    this.active = 0;
    this.pending = new Set();
    this.lastError = '';
  }

  enabled() { return !!this.getKey(); }

  keyOf(item) {
    const { title, year } = parseTitle(item.name);
    const type = item.kind === 'series' ? 'series' : 'movie';
    return { key: `omdb:${type}:${title.toLowerCase()}:${year || ''}`, title, year, type };
  }

  // Known result for an item right now (undefined = not looked up yet, null = not found).
  peek(item) {
    return this.mem.get(this.keyOf(item).key);
  }

  // Result if known; otherwise queues a lookup and returns undefined. onUpdate fires later.
  get(item) {
    const k = this.keyOf(item);
    if (this.mem.has(k.key)) return this.mem.get(k.key);
    if (!this.enabled() || !k.title || this.pending.has(k.key)) return undefined;
    this.pending.add(k.key);
    this.queue.push({ item, ...k });
    this.pump();
    return undefined;
  }

  // Forget lookups that haven't started (the posters asking for them are gone).
  clearQueue() {
    for (const j of this.queue.splice(0)) this.pending.delete(j.key);
  }

  // Prefer what's newest on screen: requests for posters scrolled past are dropped.
  pump() {
    if (this.queue.length > 40) {
      for (const j of this.queue.splice(0, this.queue.length - 40)) this.pending.delete(j.key);
    }
    while (this.active < PARALLEL && this.queue.length) {
      const job = this.queue.pop();
      this.active++;
      this.load(job).finally(() => { this.active--; this.pending.delete(job.key); this.pump(); });
    }
  }

  async load({ item, key, title, year, type }) {
    const cached = await cacheGet(key);
    if (cached && Date.now() - cached.at < (cached.result ? TTL : MISS_TTL)) {
      this.mem.set(key, cached.result);
      this.onUpdate?.(item);
      return;
    }
    if (!this.spend()) { this.lastError = 'Daily ratings limit reached; more tomorrow.'; return; }
    let result = await this.query(title, year, type);
    if (result === null && year) {
      if (!this.spend()) return;
      result = await this.query(title, 0, type); // the year in a provider's name is sometimes off
    }
    if (result === undefined) return; // network/key trouble: try again another time
    this.mem.set(key, result);
    cachePut(key, { at: Date.now(), result });
    this.onUpdate?.(item);
  }

  // → result, null (not found), or undefined (couldn't ask)
  async query(title, year, type) {
    const q = new URLSearchParams({ apikey: this.getKey(), t: title, type, plot: 'full' });
    if (year) q.set('y', String(year));
    try {
      const res = await this.fetcher(`https://www.omdbapi.com/?${q}`);
      const d = await res.json();
      if (d.Response !== 'True') {
        if (/not found/i.test(d.Error || '')) return null;
        this.lastError = d.Error || `HTTP ${res.status}`;
        return undefined;
      }
      this.lastError = '';
      return toResult(d);
    } catch (err) {
      this.lastError = err.message;
      return undefined;
    }
  }

  // Checks a key with one lookup. → '' if it works, else the reason.
  async test(key) {
    try {
      const res = await this.fetcher(`https://www.omdbapi.com/?${new URLSearchParams({ apikey: key, t: 'Inception', type: 'movie' })}`);
      const d = await res.json();
      return d.Response === 'True' ? '' : d.Error || `HTTP ${res.status}`;
    } catch (err) {
      return err.message;
    }
  }

  spend() {
    const day = new Date().toISOString().slice(0, 10);
    let c;
    try { c = JSON.parse(localStorage.getItem('o3xr.omdbBudget')) || {}; } catch { c = {}; }
    if (c.day !== day) c = { day, n: 0 };
    if (c.n >= DAILY_BUDGET) return false;
    c.n++;
    try { localStorage.setItem('o3xr.omdbBudget', JSON.stringify(c)); } catch { /* ignore */ }
    return true;
  }
}

function toResult(d) {
  const r = Object.fromEntries((d.Ratings || []).map((x) => [x.Source, x.Value]));
  const num = (v) => (v && v !== 'N/A' ? v : '');
  return {
    title: d.Title,
    year: d.Year,
    rt: num(r['Rotten Tomatoes']) ? parseInt(r['Rotten Tomatoes'], 10) : null, // Tomatometer %
    imdb: num(d.imdbRating),
    metacritic: num(r.Metacritic) ? parseInt(r.Metacritic, 10) : null,
    imdbID: d.imdbID,
    rated: num(d.Rated),
    runtime: num(d.Runtime),
    genre: num(d.Genre),
    director: num(d.Director),
    actors: num(d.Actors),
    plot: num(d.Plot),
    poster: num(d.Poster),
    awards: num(d.Awards),
  };
}
