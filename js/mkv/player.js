// Plays an MKV file in browsers that can't open Matroska (Safari) by remuxing it into
// fragmented MP4 on the fly and feeding Media Source Extensions. Nothing is re-encoded.
//
// It streams the file with one HTTP request, a cluster (a few seconds) at a time, keeps
// about 45 s (adjustable) buffered ahead and trims what's long behind, so a two-hour film never sits in
// memory. Seeking uses the file's Cues index (fetched with a range request on first seek)
// to restart the download at the right cluster.

import { ByteReader } from './ebml.js';
import { MatroskaDemuxer, ID } from './demux.js';
import { Remuxer } from './remux.js';

const BEHIND = 30; // seconds kept behind the playhead

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class MkvPlayer {
  constructor(video, url, { onWarn = () => {}, onFatal = () => {}, onLog = () => {}, startAt = 0, ahead = 45, preroll = 0 } = {}) {
    this.maxAhead = ahead; // seconds buffered before pausing the download
    this.preroll = preroll; // seconds to build up before playback may start
    this.video = video;
    this.url = url;
    this.onWarn = onWarn;
    this.onFatal = onFatal;
    this.onLog = onLog;
    this.startAt = startAt;
    this.dead = false;
    this.seekTo = null;
    this.buffers = {};
    this.trackEls = [];
    this.textTracks = new Map();
    this.cueKeys = new Set();
    this.onSeeking = () => this.handleSeeking();
  }

  async open(from) {
    const res = await fetch(this.url, { headers: { Range: `bytes=${from}-` }, cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const range = res.headers.get('content-range');
    if (res.status === 206) this.rangeOK = true;
    else if (from > 0) throw new Error('this server can’t jump to a position in the file');
    const total = range?.match(/\/(\d+)/);
    if (total) this.total = +total[1];
    else if (!this.total && res.headers.get('content-length')) this.total = +res.headers.get('content-length') + from;
    return new ByteReader(res.body, from);
  }

  // Resolves once the first media is buffered (so the caller can call play()).
  async start() {
    const MS = window.ManagedMediaSource || window.MediaSource;
    if (!MS) throw new Error('this browser has no Media Source Extensions');
    this.ms = new MS();
    if (window.ManagedMediaSource && this.ms instanceof window.ManagedMediaSource) this.video.disableRemotePlayback = true;
    this.objectUrl = URL.createObjectURL(this.ms);
    this.video.src = this.objectUrl;
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('media source didn’t open')), 10000);
      this.ms.addEventListener('sourceopen', () => { clearTimeout(t); resolve(); }, { once: true });
    });

    this.demux = new MatroskaDemuxer();
    this.r = await this.open(0);
    await this.demux.readHeader(this.r);

    // Read a few clusters so every track has a first frame (some codec details live there).
    const first = [];
    const want = new Set(this.demux.tracks.filter((t) => t.type === 'video' || t.type === 'audio'));
    while (first.length < 6 && want.size) {
      const c = await this.demux.readCluster(this.r);
      if (!c) break;
      first.push(c);
      for (const b of c.blocks) want.delete(b.track);
    }
    const canPlay = (kind, codec) => MS.isTypeSupported(`${kind}/mp4; codecs="${codec}"`);
    this.remux = new Remuxer(this.demux, { canPlay });
    const setup = this.remux.setup(first);
    for (const w of setup.warnings) this.onWarn(w);
    this.onLog(`MKV: ${[setup.video && `video ${setup.video.cfg.codec}`, setup.audio && `audio ${setup.audio.cfg.codec}`,
      setup.subs.length && `${setup.subs.length} subtitle track(s)`].filter(Boolean).join(', ')}; ${this.demux.duration ? `${Math.round(this.demux.duration / 60)} min` : 'unknown length'}; seeking ${this.rangeOK ? 'supported' : 'not supported by server'}`);

    if (this.demux.duration) this.ms.duration = this.demux.duration + this.remux.shiftSec;
    for (const kind of ['video', 'audio']) {
      if (!setup[kind]) continue;
      const sb = this.ms.addSourceBuffer(`${kind}/mp4; codecs="${setup[kind].cfg.codec}"`);
      this.buffers[kind] = sb;
    }
    for (const kind of Object.keys(this.buffers)) await this.append(this.buffers[kind], setup.init[kind]);
    this.addSubtitleTracks(setup.subs);

    for (const c of first) await this.appendCluster(c);
    this.video.addEventListener('seeking', this.onSeeking);

    // Content starts a frame or two after 0 when B-frames needed a shift: start there.
    const b = this.video.buffered;
    if (this.startAt > 0) {
      this.video.currentTime = this.startAt;
      this.handleSeeking();
    } else if (b.length && b.start(0) > this.video.currentTime && b.start(0) < 2) {
      this.video.currentTime = b.start(0);
    }

    this.loop().catch((err) => { if (!this.dead) this.onFatal(err); });

    // Optional head start: let the cushion build before playback begins (capped at 60 s).
    const until = Date.now() + 60000;
    while (!this.dead && this.preroll > 0 && this.ahead() < this.preroll && Date.now() < until) await sleep(300);
  }

  // ---------- Feeding ----------
  async loop() {
    while (!this.dead) {
      if (this.seekTo !== null) { await this.doSeek(); continue; }
      while (!this.dead && this.seekTo === null && this.ahead() > this.maxAhead) await sleep(400);
      if (this.dead || this.seekTo !== null) continue;
      let c;
      try {
        c = await this.demux.readCluster(this.r);
      } catch (err) {
        if (this.dead || this.seekTo !== null) continue;
        throw err;
      }
      if (!c) {
        await this.finish();
        while (!this.dead && this.seekTo === null) await sleep(500);
        continue;
      }
      await this.appendCluster(c);
      await this.trim();
    }
  }

  async appendCluster(c) {
    const out = this.remux.process(c);
    if (out.video && this.buffers.video) await this.append(this.buffers.video, out.video);
    if (out.audio && this.buffers.audio) await this.append(this.buffers.audio, out.audio);
    for (const cue of out.cues) this.addCue(cue);
  }

  async append(sb, data) {
    for (let attempt = 0; attempt < 3; attempt++) {
      await idle(sb);
      if (this.dead) return;
      try {
        sb.appendBuffer(data);
        await idle(sb);
        return;
      } catch (err) {
        if (err.name !== 'QuotaExceededError') throw err;
        await this.trim(10); // full: drop more of what's behind and try again
        await sleep(300);
      }
    }
  }

  ahead() {
    const v = this.video;
    const t = v.currentTime;
    for (let i = 0; i < v.buffered.length; i++) {
      if (v.buffered.start(i) <= t + 0.5 && v.buffered.end(i) >= t) return v.buffered.end(i) - t;
    }
    return 0;
  }

  async trim(keep = BEHIND) {
    const t = this.video.currentTime;
    for (const sb of Object.values(this.buffers)) {
      if (!sb.buffered.length || sb.buffered.start(0) >= t - keep) continue;
      await idle(sb);
      try { sb.remove(0, Math.max(0.1, t - keep)); await idle(sb); } catch { /* removing is best-effort */ }
    }
  }

  async finish() {
    for (const sb of Object.values(this.buffers)) await idle(sb);
    if (this.ms.readyState === 'open') { try { this.ms.endOfStream(); } catch { /* already ended */ } }
  }

  // ---------- Seeking ----------
  handleSeeking() {
    const t = this.video.currentTime;
    const b = this.video.buffered;
    for (let i = 0; i < b.length; i++) if (b.start(i) <= t && t < b.end(i) - 0.2) return; // already have it
    if (!this.rangeOK) { this.onWarn('This server doesn’t allow jumping ahead; the movie keeps loading from where it was.'); return; }
    this.seekTo = t;
    this.r?.cancel();
  }

  async doSeek() {
    const t = this.seekTo;
    this.seekTo = null;
    if (!this.demux.cues.length) await this.loadCues();
    const target = Math.max(0, t - this.remux.shiftSec);
    let pos = this.demux.cueFor(target)?.pos;
    if (pos === undefined) {
      // No index: estimate from the average bitrate, then find the next cluster.
      const len = (this.total || 0) - this.demux.segmentStart;
      pos = this.demux.duration && len > 0 ? Math.floor((target / this.demux.duration) * len) : this.demux.firstClusterPos;
    }
    for (const sb of Object.values(this.buffers)) {
      await idle(sb);
      try { sb.abort(); } catch { /* not updating */ }
      try { sb.remove(0, Infinity); await idle(sb); } catch { /* nothing buffered */ }
    }
    this.remux.reset();
    this.r = await this.open(this.demux.segmentStart + pos);
    this.demux.pending = null;
    if (!this.demux.cues.length) await resyncToCluster(this.r);
    this.onLog(`MKV: jumped to ${fmt(t)} (file position ${Math.round((this.demux.segmentStart + pos) / 1048576)} MB)`);
  }

  async loadCues() {
    const rel = this.demux.seek[ID.Cues];
    if (rel === undefined || !this.rangeOK) return;
    try {
      const r = await this.open(this.demux.segmentStart + rel);
      const h = await r.header();
      if (h?.id === ID.Cues) this.demux.parseCues(await r.read(h.size));
      r.cancel();
    } catch (err) {
      this.onLog(`MKV: couldn’t read the seek index (${err.message})`);
    }
  }

  // ---------- Subtitles ----------
  addSubtitleTracks(subs) {
    for (const t of subs) {
      const el = document.createElement('track');
      el.kind = 'subtitles';
      const lang = /^und/i.test(t.language || 'und') ? '' : t.language;
      el.label = t.name || (lang ? langName(lang) : 'Subtitles');
      if (lang) el.srclang = lang.split('-')[0].slice(0, 3);
      el.src = 'data:text/vtt;charset=utf-8,WEBVTT%0A';
      this.video.append(el);
      el.track.mode = t.forced ? 'showing' : 'hidden';
      this.trackEls.push(el);
      this.textTracks.set(t, el.track);
    }
  }

  addCue({ track, start, end, text }) {
    const tt = this.textTracks.get(track);
    const key = `${track.number}|${start.toFixed(3)}`;
    if (!tt || this.cueKeys.has(key)) return;
    this.cueKeys.add(key);
    try { tt.addCue(new VTTCue(start, end, text)); } catch { /* malformed cue */ }
  }

  destroy() {
    this.dead = true;
    this.video.removeEventListener('seeking', this.onSeeking);
    this.r?.cancel();
    for (const el of this.trackEls) el.remove();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
  }
}

function idle(sb) {
  return sb.updating ? new Promise((r) => sb.addEventListener('updateend', r, { once: true })) : Promise.resolve();
}

// After jumping to an estimated byte position, skip to the next Cluster element.
async function resyncToCluster(r) {
  const sig = [0x1f, 0x43, 0xb6, 0x75];
  for (let scanned = 0; scanned < 16 * 1048576;) {
    if (!await r.fill(4)) return;
    const b = r.buf;
    let i = r.off;
    for (; i + 3 < b.length; i++) if (b[i] === sig[0] && b[i + 1] === sig[1] && b[i + 2] === sig[2] && b[i + 3] === sig[3]) break;
    const skip = i - r.off;
    if (skip) await r.skip(skip);
    scanned += skip;
    if (i + 3 < b.length) return;
    if (!await r.fill(r.available + 65536)) return;
  }
}

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function langName(code) {
  try { return new Intl.DisplayNames([navigator.language], { type: 'language' }).of(code) || code; } catch { return code || 'Subtitles'; }
}
