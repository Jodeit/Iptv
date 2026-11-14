// Electronic programme guide for live channels.
//
// Two sources:
//  - Xtream accounts: the panel's get_short_epg API, one channel at a time, only for channels
//    that are actually on screen (a few requests in parallel, cached 30 minutes).
//  - Any playlist that names an XMLTV file in its header (url-tvg / x-tvg-url): the file is
//    streamed, gunzipped if needed, and only programmes for this playlist's channels in the
//    next 24 hours are kept.
//
// Programmes are { start, stop (ms), title, desc }.

import { kindOf } from './filter.js';

const TTL = 30 * 60 * 1000;
const PARALLEL = 3;

export class Guide {
  constructor({ fetcher, onUpdate }) {
    this.fetcher = fetcher; // (url) => Promise<Response>, proxied as needed
    this.onUpdate = onUpdate; // (channelIds[]) => void
    this.reset();
  }

  reset() {
    this.source = null;
    this.byChannel = new Map(); // channel.id → { at, programmes }
    this.queue = [];
    this.inFlight = new Set();
    this.active = 0;
    this.xmltv = null; // Map tvg-id → programmes once loaded
    this.xmltvState = 'none';
  }

  // xtream: { server, username, password } or null; tvgUrl: XMLTV URL or null.
  setSource({ xtream = null, tvgUrl = null } = {}) {
    const key = JSON.stringify([xtream?.server, xtream?.username, tvgUrl]);
    if (key === this.sourceKey) return;
    this.reset();
    this.sourceKey = key;
    this.source = { xtream, tvgUrl };
  }

  available() {
    return !!(this.source?.xtream || this.source?.tvgUrl);
  }

  // Programmes for a channel if known; schedules a load otherwise.
  programmes(ch) {
    if (!this.source || kindOf(ch) !== 'live') return null;
    if (this.source.tvgUrl && !this.source.xtream) {
      if (this.xmltvState === 'none') this.loadXmltv();
      return this.xmltv?.get(ch.tvgId) || null;
    }
    const hit = this.byChannel.get(ch.id);
    if (!hit || Date.now() - hit.at > TTL) this.request(ch);
    return hit?.programmes || null;
  }

  // What is already known, without scheduling a load (for painting many rows).
  peek(ch, now = Date.now()) {
    if (!this.source || kindOf(ch) !== 'live') return null;
    const list = this.source.tvgUrl && !this.source.xtream ? this.xmltv?.get(ch.tvgId) : this.byChannel.get(ch.id)?.programmes;
    return list ? this.#nowNext(list, now) : null;
  }

  // Current and next programme.
  nowNext(ch, now = Date.now()) {
    const list = this.programmes(ch);
    return list ? this.#nowNext(list, now) : null;
  }

  #nowNext(list, now) {
    const i = list.findIndex((p) => p.stop > now);
    if (i < 0) return null;
    const cur = list[i].start <= now ? list[i] : null;
    return { now: cur, next: cur ? list[i + 1] || null : list[i] };
  }

  // ---------- Xtream short EPG ----------
  request(ch) {
    if (this.inFlight.has(ch.id) || this.queue.some((c) => c.id === ch.id)) return;
    const streamId = ch.url.split('?')[0].split('/').pop().replace(/\.\w+$/, '');
    if (!/^\d+$/.test(streamId)) return;
    this.queue.push({ id: ch.id, streamId });
    this.pump();
  }

  // Only the most recently requested (visible) channels matter; drop stale requests.
  trimQueue(keep = 60) {
    if (this.queue.length > keep) this.queue = this.queue.slice(-keep);
  }

  pump() {
    this.trimQueue();
    while (this.active < PARALLEL && this.queue.length) {
      const job = this.queue.pop();
      this.active++;
      this.inFlight.add(job.id);
      this.loadShort(job).finally(() => {
        this.active--;
        this.inFlight.delete(job.id);
        this.pump();
      });
    }
  }

  async loadShort({ id, streamId }) {
    const { server, username, password } = this.source.xtream;
    const q = new URLSearchParams({ username, password, action: 'get_short_epg', stream_id: streamId, limit: '12' });
    let programmes = [];
    try {
      const res = await this.fetcher(`${server}/player_api.php?${q}`);
      if (res.ok) {
        const data = await res.json();
        programmes = (data?.epg_listings || []).map((e) => ({
          start: +e.start_timestamp * 1000 || Date.parse(e.start),
          stop: +e.stop_timestamp * 1000 || Date.parse(e.end || e.stop),
          title: b64(e.title),
          desc: b64(e.description),
        })).filter((p) => p.stop > p.start).sort((a, b) => a.start - b.start);
      }
    } catch { /* leave empty; retried after TTL */ }
    this.byChannel.set(id, { at: Date.now(), programmes });
    this.onUpdate?.([id]);
  }

  // ---------- XMLTV ----------
  async loadXmltv() {
    this.xmltvState = 'loading';
    const wanted = this.wantedIds;
    const map = new Map();
    const now = Date.now();
    const from = now - 3 * 3600 * 1000;
    const to = now + 24 * 3600 * 1000;
    try {
      const res = await this.fetcher(this.source.tvgUrl);
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      let body = res.body;
      // Gzipped files served without Content-Encoding still need unpacking.
      const [peek, rest] = body.tee();
      const first = await peek.getReader().read();
      body = rest;
      if (first.value?.[0] === 0x1f && first.value?.[1] === 0x8b) body = body.pipeThrough(new DecompressionStream('gzip'));
      const reader = body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (value) buf += value;
        let end;
        while ((end = buf.indexOf('</programme>')) >= 0) {
          const startTag = buf.lastIndexOf('<programme', end);
          const block = buf.slice(startTag, end);
          buf = buf.slice(end + 12);
          const attrs = block.slice(0, block.indexOf('>'));
          const channel = attr(attrs, 'channel');
          if (wanted && !wanted.has(channel)) continue;
          const start = xmltvTime(attr(attrs, 'start'));
          const stop = xmltvTime(attr(attrs, 'stop'));
          if (!(stop > from && start < to)) continue;
          const p = { start, stop, title: tag(block, 'title'), desc: tag(block, 'desc') };
          if (!map.has(channel)) map.set(channel, []);
          map.get(channel).push(p);
        }
        if (buf.length > 1 << 20) buf = buf.slice(-(1 << 16)); // skip huge non-programme sections
        if (done) break;
      }
      for (const list of map.values()) list.sort((a, b) => a.start - b.start);
      this.xmltv = map;
      this.xmltvState = 'ready';
    } catch {
      this.xmltvState = 'failed';
    }
    this.onUpdate?.(null);
  }

  // tvg-ids in the playlist, so the XMLTV parser can skip everything else.
  setChannels(channels) {
    const ids = new Set(channels.map((c) => c.tvgId).filter(Boolean));
    this.wantedIds = ids.size ? ids : null;
  }
}

function b64(s) {
  if (!s) return '';
  try { return new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0))); } catch { return s; }
}

function attr(s, name) {
  const m = s.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? unescapeXml(m[1]) : '';
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? unescapeXml(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, '$1')).trim() : '';
}

function unescapeXml(s) {
  return s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e) => {
    const map = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
    if (map[e.toLowerCase()]) return map[e.toLowerCase()];
    return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  });
}

// "20261019183000 +0100" → ms
function xmltvTime(s) {
  const m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?/);
  if (!m) return NaN;
  const [, y, mo, d, h, mi, se = '00', tz = '+0000'] = m;
  const off = (tz[0] === '-' ? -1 : 1) * (+tz.slice(1, 3) * 60 + +tz.slice(3, 5));
  return Date.UTC(+y, +mo - 1, +d, +h, +mi, +se) - off * 60000;
}
