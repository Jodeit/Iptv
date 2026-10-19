// Attaches HLS, MPEG-TS/FLV or plain progressive streams to a <video> element,
// falling back through engines when one can't handle a URL.

/* global Hls, mpegts */

import { probe, describeProbe } from './diagnose.js';

export class StreamPlayer {
  constructor(video, { onStatus = () => {}, onError = () => {} } = {}) {
    this.video = video;
    this.onStatus = onStatus;
    this.onError = onError;
    this.hls = null;
    this.ts = null;
    this.token = 0;
    this.report = [];
  }

  destroy() {
    if (this.hls) { this.hls.destroy(); this.hls = null; }
    if (this.ts) {
      try { this.ts.pause(); this.ts.unload(); this.ts.detachMediaElement(); this.ts.destroy(); } catch { /* ignore */ }
      this.ts = null;
    }
    this.video.removeAttribute('src');
    this.video.load();
  }

  // `sources` is a URL or a list of { src, hint } candidates tried in order. `hint` is the
  // original stream URL, used to pick engines when `src` is a proxied URL.
  async load(sources) {
    const token = ++this.token;
    this.destroy();
    const list = (Array.isArray(sources) ? sources : [sources]).map((s) => (typeof s === 'string' ? { src: s, hint: s } : s));
    this.report = [];
    const attempts = list.reduce((n, s) => n + orderEngines(s.hint || s.src).length, 0);
    let n = 0;
    for (const { src, hint, label } of list) {
      for (const engine of orderEngines(hint || src)) {
        if (token !== this.token) return false;
        n++;
        this.step = `${ENGINE_NAMES[engine]}${label ? ' via proxy' : ''}${attempts > 1 ? ` (try ${n} of ${attempts})` : ''}`;
        this.progress(token, 'Connecting');
        try {
          await this[engine](src, token);
          if (token !== this.token) return false;
          this.progress(token, 'Starting video');
          await withTimeout(this.video.play().catch(() => {
            // Autoplay with sound can be blocked until the user interacts; retry muted.
            this.video.muted = true;
            return this.video.play();
          }), 25000, 'no video within 25s');
          if (token !== this.token) return false;
          this.onStatus(`Playing · ${engine}${label ? ` · ${label}` : ''}`);
          return true;
        } catch (err) {
          console.warn(`[stream] ${engine} failed for ${hint || src}`, err);
          this.report.push(`✗ ${engine}${label ? ` (${label})` : ''} ${hint || src}: ${err.message}`);
          this.destroy();
        }
      }
    }
    if (token !== this.token) return false;
    // Look at what each address actually returns (one probe per distinct source).
    const seen = new Set();
    const probes = Math.min(4, new Set(list.map((s) => s.src)).size);
    for (const { src, hint } of list) {
      if (seen.has(src) || seen.size >= 4 || token !== this.token) continue;
      seen.add(src);
      this.onStatus(`Didn’t play. Checking why (${seen.size} of ${probes})…`, { loading: true, frac: (seen.size - 1) / probes });
      this.report.push(`? ${hint || src} → ${describeProbe(await probe(src))}`);
    }
    if (token === this.token) this.onError(summarise(this.report), this.report);
    return false;
  }

  // Status while tuning: current step, plus how much video has arrived.
  progress(token, phase, detail = '', frac = null) {
    if (token !== this.token) return;
    this.onStatus(`${phase} · ${this.step}${detail ? ` · ${detail}` : ''}…`, { loading: true, frac });
  }

  bufferedAhead() {
    const v = this.video;
    for (let i = 0; i < v.buffered.length; i++) {
      if (v.buffered.end(i) >= v.currentTime) return v.buffered.end(i) - Math.max(v.currentTime, v.buffered.start(i));
    }
    return 0;
  }

  hlsjs(url, token) {
    return new Promise((resolve, reject) => {
      if (!window.Hls || !Hls.isSupported()) return reject(new Error('hls.js unsupported'));
      const hls = new Hls({ enableWorker: true, backBufferLength: 30, maxBufferLength: 30 });
      this.hls = hls;
      let ready = false;
      let bytes = 0;
      hls.on(Hls.Events.MANIFEST_LOADED, () => this.progress(token, 'Channel found, loading video'));
      hls.on(Hls.Events.FRAG_LOADED, (_, data) => {
        bytes += data.payload?.byteLength || 0;
        if (this.video.paused) this.progress(token, 'Buffering', mb(bytes), this.bufferedAhead() / 3);
      });
      hls.on(Hls.Events.MANIFEST_PARSED, () => { ready = true; resolve(); });
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (!data.fatal) return;
        if (!ready) return reject(new Error(`${data.details}${data.response?.code ? ` (HTTP ${data.response.code})` : ''}`));
        if (token !== this.token) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) { this.onStatus('Network hiccup, retrying…'); hls.startLoad(); }
        else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) { this.onStatus('Recovering media…'); hls.recoverMediaError(); }
        else this.onError(`Playback error: ${data.details}`);
      });
      hls.loadSource(url);
      hls.attachMedia(this.video);
    });
  }

  native(url) {
    return new Promise((resolve, reject) => {
      const v = this.video;
      const ok = () => { cleanup(); resolve(); };
      const bad = () => { cleanup(); reject(new Error('native playback failed')); };
      const cleanup = () => { v.removeEventListener('loadedmetadata', ok); v.removeEventListener('error', bad); clearTimeout(t); };
      const t = setTimeout(bad, 15000);
      v.addEventListener('loadedmetadata', ok);
      v.addEventListener('error', bad);
      v.src = url;
    });
  }

  mpegts(url) {
    return new Promise((resolve, reject) => {
      if (!window.mpegts || !mpegts.getFeatureList().mseLivePlayback) return reject(new Error('mpegts.js unsupported'));
      const type = /\.flv(\?|$)/i.test(url) ? 'flv' : 'mpegts';
      const p = mpegts.createPlayer({ type, isLive: true, url }, { enableWorker: true, liveBufferLatencyChasing: true });
      this.ts = p;
      const v = this.video;
      p.on(mpegts.Events.STATISTICS_INFO, (s) => {
        if (v.paused && s.speed) this.progress(token, 'Receiving', `${Math.round(s.speed)} KB/s`, this.bufferedAhead() / 3);
      });
      const ok = () => { cleanup(); resolve(); };
      const cleanup = () => { v.removeEventListener('loadedmetadata', ok); clearTimeout(t); };
      const t = setTimeout(() => { cleanup(); reject(new Error('mpegts timeout')); }, 15000);
      p.on(mpegts.Events.ERROR, (type, detail, info) => {
        cleanup();
        const extra = info?.code > 0 ? ` (HTTP ${info.code})` : info?.msg ? ` (${info.msg})` : '';
        reject(new Error(`${type}: ${detail}${extra}`));
      });
      v.addEventListener('loadedmetadata', ok);
      p.attachMediaElement(v);
      p.load();
    });
  }
}

// Turns the attempt/probe log into one actionable sentence.
function summarise(report) {
  const text = report.join('\n');
  if (/⚠ ([^\n·]+)/.test(text)) return `Stream found, but ${text.match(/⚠ ([^\n·]+)/)[1].trim()}`;
  if (/proxy error “ip-unsupported”|error code: 1003/.test(text)) {
    return 'This provider sends streams from a bare IP address, which Cloudflare can’t connect to. '
      + 'Run server.js at home and use it as the proxy (see README: Home proxy).';
  }
  if (/proxy error “port-unsupported”/.test(text)) {
    return 'The stream server uses a port Cloudflare can’t connect to. Use server.js at home as the proxy for this provider.';
  }
  if (/provider answered (401|403|406|451|456|458)|HTTP (401|403|406|451|456|458)\b/.test(text)) {
    return 'The provider refused the stream. Close other players using this account (many allow one connection at a time), then retry. '
      + 'If it keeps failing through Cloudflare, use server.js at home as the proxy.';
  }
  const page = text.match(/(?:HTML page|JSON|text) \(not video\) · “([^”]+)”/);
  if (page) return `The provider sent a message instead of video: “${page[1].slice(0, 100)}”`;
  if (/no data within/.test(text)) return 'The stream connected but sent no data. The channel may be offline.';
  if (/request blocked or failed/.test(text)) return 'The browser couldn’t reach the stream. A proxy is needed (Sources → Proxy).';
  return 'Stream failed to load. See Sources → Playback log for details.';
}

const ENGINE_NAMES = { hlsjs: 'HLS', mpegts: 'MPEG-TS', native: 'built-in player' };
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

function withTimeout(promise, ms, message) {
  let t;
  return Promise.race([promise, new Promise((_, reject) => { t = setTimeout(() => reject(new Error(message)), ms); })])
    .finally(() => clearTimeout(t));
}

function orderEngines(url) {
  const path = url.split('?')[0].toLowerCase();
  const canNativeHls = document.createElement('video').canPlayType('application/vnd.apple.mpegurl');
  if (path.endsWith('.m3u8') || path.endsWith('.m3u') || url.includes('m3u8')) {
    return canNativeHls && !(window.Hls && Hls.isSupported()) ? ['native', 'hlsjs'] : ['hlsjs', 'native', 'mpegts'];
  }
  if (path.endsWith('.ts') || path.endsWith('.flv')) return ['mpegts', 'native'];
  if (/\.(mp4|webm|mkv|mov|ogv|avi)$/.test(path)) return ['native'];
  // Extension-less IPTV URLs (e.g. Xtream /user/pass/123) are usually raw MPEG-TS.
  return ['mpegts', 'hlsjs'];
}
