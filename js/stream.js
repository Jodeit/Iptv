// Attaches HLS, MPEG-TS/FLV or plain progressive streams to a <video> element,
// falling back through engines when one can't handle a URL.

/* global Hls, mpegts */

export class StreamPlayer {
  constructor(video, { onStatus = () => {}, onError = () => {} } = {}) {
    this.video = video;
    this.onStatus = onStatus;
    this.onError = onError;
    this.hls = null;
    this.ts = null;
    this.token = 0;
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
    let n = 0;
    for (const { src, hint, label } of list) {
      n++;
      for (const engine of orderEngines(hint || src)) {
        if (token !== this.token) return false;
        this.onStatus(`Connecting (${engine}${label ? ` · ${label}` : ''}${list.length > 1 ? ` · ${n}/${list.length}` : ''})…`);
        try {
          await this[engine](src, token);
          if (token !== this.token) return false;
          await this.video.play().catch(() => {
            // Autoplay with sound can be blocked until the user interacts; retry muted.
            this.video.muted = true;
            return this.video.play();
          });
          this.onStatus(`Playing · ${engine}${label ? ` · ${label}` : ''}`);
          return true;
        } catch (err) {
          console.warn(`[stream] ${engine} failed for ${hint || src}`, err);
          this.destroy();
        }
      }
    }
    if (token === this.token) this.onError('Stream failed to load. It may be offline, geo-blocked, or block browser playback.');
    return false;
  }

  hlsjs(url, token) {
    return new Promise((resolve, reject) => {
      if (!window.Hls || !Hls.isSupported()) return reject(new Error('hls.js unsupported'));
      const hls = new Hls({ enableWorker: true, backBufferLength: 30, maxBufferLength: 30 });
      this.hls = hls;
      let ready = false;
      hls.on(Hls.Events.MANIFEST_PARSED, () => { ready = true; resolve(); });
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (!data.fatal) return;
        if (!ready) return reject(new Error(data.details));
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
      const ok = () => { cleanup(); resolve(); };
      const cleanup = () => { v.removeEventListener('loadedmetadata', ok); clearTimeout(t); };
      const t = setTimeout(() => { cleanup(); reject(new Error('mpegts timeout')); }, 15000);
      p.on(mpegts.Events.ERROR, (type, detail) => { cleanup(); reject(new Error(`${type}: ${detail}`)); });
      v.addEventListener('loadedmetadata', ok);
      p.attachMediaElement(v);
      p.load();
    });
  }
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
