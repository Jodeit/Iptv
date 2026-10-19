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
    clearInterval(this.watchdog);
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
  async load(sources, { reconnect = false } = {}) {
    const token = ++this.token;
    this.destroy();
    let list = (Array.isArray(sources) ? sources : [sources]).map((s) => (typeof s === 'string' ? { src: s, hint: s } : s));
    if (!reconnect) {
      this.sources = list;
      this.reconnects = 0;
      this.report = [];
    } else if (this.winner) {
      // Go straight back to what worked.
      list = [this.winner.source, ...list.filter((x) => x !== this.winner.source)];
      await new Promise((r) => setTimeout(r, 1500)); // give the provider a moment to release the old connection
      if (token !== this.token) return false;
    }
    this.winner = null;
    const plans = list.flatMap((source) => orderEngines(source.hint || source.src).map((engine) => ({ source, engine })));
    if (reconnect && this.lastEngine) {
      const i = plans.findIndex((p) => p.source === list[0] && p.engine === this.lastEngine);
      if (i > 0) plans.unshift(...plans.splice(i, 1));
    }
    let refused = false;
    for (const [i, { source, engine }] of plans.entries()) {
      const { src, hint, label } = source;
      if (token !== this.token) return false;
      this.step = `${ENGINE_NAMES[engine]}${label ? ' via proxy' : ''}${plans.length > 1 ? ` (try ${i + 1} of ${plans.length})` : ''}`;
      this.progress(token, reconnect ? 'Reconnecting' : 'Connecting');
      try {
        // A source that never answers (or streams endlessly where a playlist was expected)
        // shouldn't hold up the remaining tries.
        await withTimeout(this[engine](src, token), 15000, 'no response within 15s');
        if (token !== this.token) return false;
        this.progress(token, 'Starting video');
        await withTimeout(this.video.play().catch(() => {
          // Autoplay with sound can be blocked until the user interacts; retry muted.
          this.video.muted = true;
          return this.video.play();
        }), 25000, 'no video within 25s');
        if (token !== this.token) return false;
        this.winner = { source };
        this.lastEngine = engine;
        this.onStatus(`Playing · ${engine}${label ? ` · ${label}` : ''}`);
        this.watch(token);
        return true;
      } catch (err) {
        console.warn(`[stream] ${engine} failed for ${hint || src}`, err);
        this.report.push(`✗ ${engine}${label ? ` (${label})` : ''} ${hint || src}: ${err.message}`);
        this.destroy();
        // A refusal (bad login, connection limit) won't change with another variant, and
        // every extra try counts against the account.
        if (/HTTP (401|403|456|458)\b/.test(err.message)) { refused = true; break; }
      }
    }
    if (token !== this.token) return false;
    // Look at what each address actually returns (one probe per distinct source).
    const seen = new Set();
    const max = refused ? 0 : 4; // a refusal already tells us the status; don't spend more requests
    const probes = Math.min(max, new Set(list.map((x) => x.src)).size);
    for (const { src, hint } of list) {
      if (seen.has(src) || seen.size >= max || token !== this.token) continue;
      seen.add(src);
      this.onStatus(`Didn’t play. Checking why (${seen.size} of ${probes})…`, { loading: true, frac: (seen.size - 1) / probes });
      this.report.push(`? ${hint || src} → ${describeProbe(await probe(src))}`);
    }
    if (token === this.token) this.onError(summarise(this.report), this.report, { refused });
    return false;
  }

  // Reconnects when playback freezes for 20s (or the engine reports a fatal error), up to
  // three times per channel, instead of leaving a dead picture on screen.
  watch(token) {
    clearInterval(this.watchdog);
    let last = this.video.currentTime;
    let stalled = 0;
    this.watchdog = setInterval(() => {
      if (token !== this.token) return clearInterval(this.watchdog);
      const v = this.video;
      if (v.paused || v.currentTime !== last) { last = v.currentTime; stalled = 0; return; }
      stalled += 2;
      if (stalled >= 20) this.recover(token, 'stream stalled');
    }, 2000);
  }

  recover(token, reason) {
    if (token !== this.token) return;
    clearInterval(this.watchdog);
    this.report.push(`↻ ${reason} after playing (reconnect ${this.reconnects + 1} of 3)`);
    if (this.reconnects >= 3) {
      this.destroy();
      this.onError('The stream keeps dropping. The provider or connection may be overloaded; try again later or another channel.', this.report);
      return;
    }
    this.reconnects++;
    this.onStatus(`Stream dropped (${reason}). Reconnecting ${this.reconnects} of 3…`, { loading: true });
    this.load(this.sources, { reconnect: true });
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
      const hls = new Hls({
        enableWorker: true,
        // Buffer generously and sit further behind the live edge: every segment travels
        // provider → proxy → headset, so a deeper cushion absorbs slow ones.
        backBufferLength: 30,
        maxBufferLength: 60,
        maxMaxBufferLength: 120,
        liveSyncDurationCount: 5,
        liveMaxLatencyDurationCount: Infinity, // don't skip ahead after a stall
        startFragPrefetch: true,
        // Fail fast on the playlist: other sources are waiting their turn.
        manifestLoadPolicy: {
          default: {
            maxTimeToFirstByteMs: 8000,
            maxLoadTimeMs: 12000,
            timeoutRetry: { maxNumRetry: 0, retryDelayMs: 0, maxRetryDelayMs: 0 },
            errorRetry: { maxNumRetry: 1, retryDelayMs: 500, maxRetryDelayMs: 1000 },
          },
        },
      });
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
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
        else this.recover(token, data.details);
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

  mpegts(url, token) {
    return new Promise((resolve, reject) => {
      if (!window.mpegts || !mpegts.getFeatureList().mseLivePlayback) return reject(new Error('mpegts.js unsupported'));
      const type = /\.flv(\?|$)/i.test(url) ? 'flv' : 'mpegts';
      const p = mpegts.createPlayer({ type, isLive: true, url }, {
        enableWorker: true,
        // Buffer before starting and don't keep jumping to the live edge: smoother on slow links.
        enableStashBuffer: true,
        stashInitialSize: 512 * 1024,
        liveBufferLatencyChasing: false,
        autoCleanupSourceBuffer: true,
      });
      this.ts = p;
      const v = this.video;
      p.on(mpegts.Events.STATISTICS_INFO, (s) => {
        if (v.paused && s.speed) this.progress(token, 'Receiving', `${Math.round(s.speed)} KB/s`, this.bufferedAhead() / 3);
      });
      let started = false;
      const ok = () => { started = true; cleanup(); resolve(); };
      const cleanup = () => { v.removeEventListener('loadedmetadata', ok); clearTimeout(t); };
      const t = setTimeout(() => { cleanup(); reject(new Error('mpegts timeout')); }, 15000);
      p.on(mpegts.Events.ERROR, (type, detail, info) => {
        if (started) return this.recover(token, `${type}: ${detail}`);
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
  if (/proxy error “socket-failed”/.test(text)) {
    return 'Cloudflare couldn’t open a direct connection to this provider’s stream server. '
      + 'Run server.js at home and use it as the proxy (see README: Home proxy).';
  }
  if (/proxy error “ip-unsupported”|error code: 1003/.test(text)) {
    return 'This provider sends streams from a bare IP address, which Cloudflare can’t connect to. '
      + 'Run server.js at home and use it as the proxy (see README: Home proxy).';
  }
  if (/proxy error “port-unsupported”/.test(text)) {
    return 'The stream server uses a port Cloudflare can’t connect to. Use server.js at home as the proxy for this provider.';
  }
  if (/provider answered (401|403|406|451|456|458)|HTTP (401|403|406|451|456|458)\b/.test(text)) {
    return 'The provider refused the stream. That usually means the account’s connection limit is reached: close other players '
      + 'using it, or wait a minute for the previous stream to be released, then retry.';
  }
  const page = text.match(/(?:HTML page|JSON|text) \(not video\) · “([^”]+)”/);
  if (page) return `The provider sent a message instead of video: “${page[1].slice(0, 100)}”`;
  const healthy = text.match(/· (MPEG-TS \[[^\]]+\]|HLS (?:master )?playlist)/);
  if (healthy && !/⚠/.test(text)) {
    return `The stream is reachable (${healthy[1]}), but the player couldn’t start it. Try again; if it keeps failing, copy the Playback log.`;
  }
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
