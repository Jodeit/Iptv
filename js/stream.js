// Attaches HLS, MPEG-TS/FLV or plain progressive streams to a <video> element,
// falling back through engines when one can't handle a URL.

/* global Hls, mpegts */

import { probe, describeProbe } from './diagnose.js';

// 'auto' | 'hlsjs' | 'native': which engine plays HLS first (Sources → Display).
let hlsPreference = 'auto';
export const setHlsPreference = (p) => { hlsPreference = p || 'auto'; };
// AirPlay sends the Apple TV a URL to fetch itself, so only Safari's own player (a plain src)
// can send video. MSE engines may play audio only on the Apple TV.
let airPlay = false;
export const setAirPlay = (on) => { airPlay = !!on; };

// Seconds to keep buffered ahead: a bigger cushion rides out slow providers and proxies.
// preroll = seconds to build up before a movie file starts playing.
const BUFFER_LEVELS = { normal: { ahead: 45, hls: 60, preroll: 0 }, large: { ahead: 150, hls: 180, preroll: 20 }, max: { ahead: 400, hls: 400, preroll: 45 } };
let bufferLevel = BUFFER_LEVELS.normal;
export const setBufferLevel = (k) => { bufferLevel = BUFFER_LEVELS[k] || BUFFER_LEVELS.normal; };

export class StreamPlayer {
  constructor(video, { onStatus = () => {}, onError = () => {}, onWarn = () => {}, onNote = () => {}, onProblem = () => {}, onLog = () => {}, onSlow = () => {} } = {}) {
    this.video = video;
    this.onStatus = onStatus;
    this.onError = onError;
    this.onWarn = onWarn;
    this.onNote = onNote;
    this.onProblem = onProblem; // a ✗ or ⚠ line of the playback log (failures, warnings)
    this.onLog = onLog; // (report) after each new line, so the playback log stays live
    this.health = new Health(video, (line) => this.log(line), () => onSlow());
    this.hls = null;
    this.ts = null;
    this.token = 0;
    this.report = [];
  }

  log(line) {
    const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    this.report.push(`${t} ${line}`);
    // Failures, warnings, reconnects and stalls of 2 s or more go to the problem log (and the server's /logs), so a
    // picture that jumps or freezes on a headset can be traced afterwards.
    if (/^[✗⚠↻]/.test(line) || /^MKV: (video|jumped|skipped)/.test(line) || /^⏸ buffering (?:[2-9]|\d{2,})/.test(line)) this.onProblem(line);
    if (this.report.length > 300) this.report.splice(0, this.report.length - 300);
    this.onLog(this.report);
  }

  destroy() {
    clearInterval(this.watchdog);
    this.health.stop();
    if (this.mkvp) { this.mkvp.destroy(); this.mkvp = null; }
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
  // `startAt` (seconds) resumes a film part-way through.
  // engine / forceTranscode: play with that engine only (and, for the MKV engine, convert AC-3 / E-AC-3 / DTS / TrueHD audio
  // whatever the browser claims). They stay in force for reconnects of the same source, until the next fresh load.
  async load(sources, { reconnect = false, startAt = 0, keepReport = false, engine: only = null, forceTranscode = false, live = false } = {}) {
    const token = ++this.token;
    this.destroy();
    let list = (Array.isArray(sources) ? sources : [sources]).map((s) => (typeof s === 'string' ? { src: s, hint: s } : s));
    if (!reconnect) {
      this.sources = list;
      this.sticky = { engine: only, force: forceTranscode };
      this.reconnects = 0;
      this.live = live;
      this.resumeAt = live ? 0 : startAt;
      if (!keepReport) this.report = [];
    } else if (this.winner) {
      // Go straight back to what worked.
      list = [this.winner.source, ...list.filter((x) => x !== this.winner.source)];
      await new Promise((r) => setTimeout(r, 1500)); // give the provider a moment to release the old connection
      if (token !== this.token) return false;
    }
    this.winner = null;
    let plans = list.flatMap((source) => orderEngines(source.hint || source.src).map((engine) => ({ source, engine })));
    const wanted = this.sticky?.engine;
    if (wanted && plans.some((p) => p.engine === wanted)) plans = plans.filter((p) => p.engine === wanted);
    if (reconnect && this.lastEngine) {
      const i = plans.findIndex((p) => p.source === list[0] && p.engine === this.lastEngine);
      if (i > 0) plans.unshift(...plans.splice(i, 1));
    }
    let refused = false;
    let refusal = null;
    let directRefused = false;
    const refusedFormats = new Set();
    if (!plans.length) this.report.push(`✗ unsupported format: this browser can’t play ${list[0]?.hint?.split('?')[0].split('.').pop().toUpperCase() || 'this'} files`);
    const deadSources = new Set();
    for (const [i, { source, engine }] of plans.entries()) {
      const { src, hint, label } = source;
      if (token !== this.token) return false;
      if (deadSources.has(source) || (directRefused && !label)) continue;
      if (label && refusedFormats.has(/\.m3u8(\?|$)/i.test(hint || src) ? 'hls' : 'other')) continue;
      this.step = `${ENGINE_NAMES[engine]}${label ? ' via proxy' : ''}${plans.length > 1 ? ` (try ${i + 1} of ${plans.length})` : ''}`;
      this.progress(token, reconnect ? 'Reconnecting' : 'Connecting');
      try {
        // A source that never answers (or streams endlessly where a playlist was expected)
        // shouldn't hold up the remaining tries.
        // The MKV engine may have to download the audio decoder first (about 32 MB), so it gets much longer when asked for
        const startLimit = engine === 'mkv' && this.sticky?.engine === 'mkv' ? 150000 : 15000;
        await withTimeout(this[engine](src, token), startLimit, `no response within ${startLimit / 1000}s`);
        if (token !== this.token) return false;
        this.progress(token, 'Starting video');
        await withTimeout(this.video.play().catch(async (e) => {
          // Interrupted, not refused: Safari aborts a pending play() when playback moves to
          // AirPlay (or the source reloads). Give it a moment and ask again.
          if (e?.name === 'AbortError') {
            await new Promise((r) => setTimeout(r, 800));
            if (token !== this.token) return;
            return this.video.play().catch((e2) => { if (e2?.name !== 'AbortError') throw e2; });
          }
          // Autoplay with sound can be blocked until the user interacts; retry muted.
          this.video.muted = true;
          return this.video.play();
        }), 25000, 'no video within 25s');
        if (token !== this.token) return false;
        await this.confirmPlaying(token);
        if (token !== this.token) return false;
        // The MKV remuxer starts at resumeAt itself; other engines jump once they're playing.
        if (!this.live && this.resumeAt > 0 && engine !== 'mkv' && Number.isFinite(this.video.duration) && this.resumeAt < this.video.duration - 5) {
          this.video.currentTime = this.resumeAt;
        }
        this.winner = { source };
        this.lastEngine = engine;
        this.lastPlayedAt = Date.now(); // lets a later refusal say whether other streams were working
        this.onStatus(`Playing · ${engine}${label ? ` · ${label}` : ''}`);
        this.log(`▶ playing with ${ENGINE_NAMES[engine]}${label ? ' via proxy' : ''}: ${hint || src}`);
        this.health.start(engine, this);
        this.watch(token);
        return true;
      } catch (err) {
        console.warn(`[stream] ${engine} failed for ${hint || src}`, err);
        if (airPlay && engine === 'native') this.log('ℹ AirPlay is on: the Apple TV fetched this stream itself and couldn’t play it');
        this.log(`✗ ${engine}${label ? ` (${label})` : ''} ${hint || src}: ${err.message}`);
        const v = this.video, rg = [...Array(v.buffered.length).keys()].map((i) => `${v.buffered.start(i).toFixed(1)}-${v.buffered.end(i).toFixed(1)}`).join(',');
        if (this.mkvp?.stateText) this.log(`✗ mkv buffers: ${this.mkvp.stateText()}`);
        this.log(`✗ video state: ready ${v.readyState}, network ${v.networkState}, error ${v.error ? `${v.error.code} ${v.error.message || ''}`.trim() : 'none'}, buffered [${rg}], ${v.videoWidth}×${v.videoHeight}`);
        this.destroy();
        // A refusal (bad login, connection limit) won't change with another variant, and
        // every extra try counts against the account.
        // A direct request can be refused just for coming from a browser (its Origin header or
        // user agent), so skip the other direct tries but still give the proxy its turn.
        if (/HTTP (401|403|456|458)\b/.test(err.message)) {
          if (!label && plans.some((p) => p.source.label)) { directRefused = true; continue; }
          // Some accounts may only use one format (e.g. .ts but not HLS): give each format one go.
          const fmt = (u) => (/\.m3u8(\?|$)/i.test(u) ? 'hls' : 'other');
          refusedFormats.add(fmt(hint || src));
          if (plans.slice(i + 1).some((p) => p.source.label && !refusedFormats.has(fmt(p.source.hint || p.source.src)))) continue;
          refused = true; break;
        }
        // Not there at all: other engines would only ask again for the same missing file.
        if (/HTTP (404|410)\b|manifestParsingError/.test(err.message)) deadSources.add(source);
      }
    }
    if (token !== this.token) return false;
    if (!refused && directRefused) refused = true; // the direct request was refused and the proxy tries found nothing better
    // Look at what each address actually returns (one probe per distinct source).
    const seen = new Set(), probed = [];
    const max = refused ? 1 : 4; // a refusal already tells us the status; one look at what the provider says (its own message, who answered)
    const probes = Math.min(max, new Set(list.map((x) => x.src)).size);
    for (const { src, hint } of list) {
      if (seen.has(src) || seen.size >= max || token !== this.token) continue;
      seen.add(src);
      this.onStatus(`Didn’t play. Checking why (${seen.size} of ${probes})…`, { loading: true, frac: (seen.size - 1) / probes });
      const pr = await probe(src);
      this.log(`? ${hint || src} → ${describeProbe(pr)}`);
      probed.push(pr);
    }
    // What the provider itself answered counts too: a player often reports only "format not supported" when the answer was a refusal
    const isRefusal = (x) => /^(401|403|406|451|456|458)$/.test(String(x.upstream || x.status));
    const bad = probed.find(isRefusal);
    if (bad && !probed.some((x) => !x.error && x.status < 400 && !isRefusal(x))) refused = true;
    if (refused) {
      const m = this.report.join('\n').match(/(?:provider answered|HTTP) (401|403|406|451|456|458)\b/);
      refusal = {
        status: bad ? String(bad.upstream || bad.status) : m?.[1] || '',
        message: bad?.content?.message || '',
        proxyKind: bad?.proxyKind || '',
        othersWorked: !!this.lastPlayedAt && Date.now() - this.lastPlayedAt < 30 * 60000,
      };
    }
    if (token === this.token) this.onError(summarise(this.report), this.report, { refused, refusal });
    return false;
  }

  // play() can resolve while nothing is actually showing (a stalled connection, a codec the
  // browser accepts but can't decode). Count the engine as working only once the clock moves.
  async confirmPlaying(token, ms = 12000) {
    const v = this.video;
    const start = v.currentTime;
    const t0 = Date.now();
    while (token === this.token && Date.now() - t0 < ms) {
      // On AirPlay the Apple TV plays it; this page's clock may not move for a while.
      if (v.paused || v.currentTime - start >= 0.4 || v.webkitCurrentPlaybackTargetIsWireless) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    if (token !== this.token) return;
    const buf = this.bufferedAhead();
    throw new Error(`no picture after ${ms / 1000}s (ready state ${v.readyState}, ${v.videoWidth}×${v.videoHeight}, ${buf.toFixed(1)}s buffered)`);
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
      if (v.paused || v.currentTime !== last || v.webkitCurrentPlaybackTargetIsWireless) { last = v.currentTime; stalled = 0; return; }
      stalled += 2;
      if (stalled >= 20) this.recover(token, 'stream stalled');
    }, 2000);
  }

  recover(token, reason) {
    if (token !== this.token) return;
    // Films resume where they were; live streams rejoin the live edge.
    if (this.live) this.resumeAt = 0;
    else if (this.video.duration && Number.isFinite(this.video.duration)) this.resumeAt = this.video.currentTime;
    clearInterval(this.watchdog);
    this.log(`↻ ${reason} after playing (reconnect ${this.reconnects + 1} of 3)`);
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
        maxBufferLength: bufferLevel.hls,
        maxMaxBufferLength: Math.max(120, bufferLevel.hls),
        maxBufferSize: 200e6,
        liveSyncDurationCount: 5,
        liveMaxLatencyDurationCount: Infinity, // don't skip ahead after a stall
        startFragPrefetch: true,
        // Segments through the proxy sometimes take a long time to first byte; the 10s default
        // gave up and stalled playback even though the average download speed was fine.
        fragLoadPolicy: {
          default: {
            maxTimeToFirstByteMs: 30000,
            maxLoadTimeMs: 120000,
            timeoutRetry: { maxNumRetry: 4, retryDelayMs: 0, maxRetryDelayMs: 0 },
            errorRetry: { maxNumRetry: 6, retryDelayMs: 1000, maxRetryDelayMs: 8000 },
          },
        },
        // A live stream re-reads its playlist every few seconds. Through the proxy one of those reads sometimes fails
        // (a timeout, a refused connection, a 401 while the provider counts connections); two failures in a row used to
        // be fatal and restart the channel. Keep trying for about half a minute instead, playing from the buffer.
        playlistLoadPolicy: {
          default: {
            maxTimeToFirstByteMs: 10000,
            maxLoadTimeMs: 20000,
            timeoutRetry: { maxNumRetry: 4, retryDelayMs: 500, maxRetryDelayMs: 4000 },
            errorRetry: { maxNumRetry: 6, retryDelayMs: 1000, maxRetryDelayMs: 8000 },
          },
        },
        // Fail fast on the first playlist: other sources are waiting their turn.
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
      let inPlace = []; // times of in-place network recoveries (see ERROR below)
      hls.on(Hls.Events.MANIFEST_LOADED, () => this.progress(token, 'Channel found, loading video'));
      hls.on(Hls.Events.FRAG_LOADED, (_, data) => {
        bytes += data.payload?.byteLength || 0;
        const st = data.frag?.stats;
        // stats.loaded: the payload itself may already be handed to hls.js's worker (0 bytes here).
        if (st?.loading) this.health.fragment(st.loaded || st.total || 0, st.loading.end - st.loading.start, data.frag.duration);
        if (this.video.paused) this.progress(token, 'Buffering', mb(bytes), this.bufferedAhead() / 3);
      });
      hls.on(Hls.Events.MANIFEST_PARSED, () => { ready = true; resolve(); });
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (!data.fatal) {
          if (ready && token === this.token) this.health.note(`hls.js: ${data.details}${data.response?.code ? ` (HTTP ${data.response.code})` : ''}`);
          return;
        }
        if (!ready) return reject(new Error(`${data.details}${data.response?.code ? ` (HTTP ${data.response.code})` : ''}`));
        if (token !== this.token) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) { hls.recoverMediaError(); return; }
        // A network error that outlasted the retries above. Pick up again in place first: the buffer and the position
        // stay, so the picture doesn't blank and jump back the way a full reconnect does. Three tries a minute, then
        // the full reconnect.
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          const now = Date.now();
          inPlace = inPlace.filter((t) => now - t < 60000);
          if (inPlace.length < 3) {
            inPlace.push(now);
            const wait = 1000 * 2 ** (inPlace.length - 1);
            this.log(`↻ ${data.details}${data.response?.code ? ` (HTTP ${data.response.code})` : ''}: picking up again in place in ${wait / 1000}s (${this.bufferedAhead().toFixed(1)}s buffered)`);
            setTimeout(() => { if (token === this.token && this.hls === hls) hls.startLoad(-1); }, wait);
            return;
          }
        }
        this.recover(token, data.details);
      });
      hls.loadSource(url);
      hls.attachMedia(this.video);
    });
  }

  // Reloads what is playing with one engine, from `at` seconds (e.g. the MKV remuxer, which can convert audio the
  // built-in player cannot decode). Resolves true if that engine took it.
  async switchEngine(engine, at = 0, { forceTranscode = false } = {}) {
    if (!this.sources) return false;
    this.log(`↻ switching to ${ENGINE_NAMES[engine] || engine} at ${Math.round(at)} s${forceTranscode ? ' (converting audio)' : ''}`);
    return this.load(this.sources, { startAt: at, keepReport: true, engine, forceTranscode, live: this.live });
  }

  // Remuxes MKV to fragmented MP4 in the browser (js/mkv), for Safari and anything else
  // that can't open Matroska itself.
  async mkv(url, token) {
    const { MkvPlayer } = await import('./mkv/player.js');
    if (token !== this.token) throw new Error('cancelled');
    const p = new MkvPlayer(this.video, url, {
      onWarn: (m) => { this.log(`⚠ ${m}`); this.onWarn(m); },
      onNote: (m) => { this.log(`ℹ ${m}`); this.onNote(m); },
      onProgress: (m) => this.progress(token, m),
      onLog: (m) => this.log(m),
      onFatal: (err) => this.recover(token, `MKV: ${err.message}`),
      startAt: this.resumeAt || 0,
      forceTranscode: !!this.sticky?.force,
      ahead: bufferLevel.ahead,
      preroll: bufferLevel.preroll,
    });
    this.mkvp = p;
    await p.start();
  }

  native(url) {
    return new Promise((resolve, reject) => {
      const v = this.video;
      const ok = () => {
        cleanup();
        if (this.resumeAt > 0 && this.resumeAt < v.duration - 5) v.currentTime = this.resumeAt; // before the first frame shows
        resolve();
      };
      // MediaError codes: 2 network, 3 decode, 4 source not supported; Safari adds a message.
      const bad = () => {
        cleanup();
        const e = v.error;
        reject(new Error(`native playback failed${e ? ` (${['', 'aborted', 'network error', 'decode error', 'format not supported'][e.code] || `code ${e.code}`}${e.message ? `: ${e.message}` : ''})` : ''}`));
      };
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
        if (s.speed) this.health.speed(s.speed * 1024);
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
  const mkvErr = text.match(/✗ mkv[^\n]*?: ([^\n]+)/);
  if (mkvErr && !/HTTP \d/.test(mkvErr[1])) return `Couldn’t play this MKV in the browser: ${mkvErr[1]}. Use one of the player apps below.`;
  if (/Matroska \(MKV\)[^\n]*⚠ this browser can’t play MKV/.test(text) || /✗ unsupported format/.test(text)) {
    return 'This movie is an MKV file, which this browser can’t play. Use one of the player apps below instead.';
  }
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
  const refusedAs = text.match(/(?:provider answered|HTTP) (401|403|406|451|456|458)\b/);
  if (refusedAs) return `The provider answered HTTP ${refusedAs[1]} for this stream.`; // main.js follows up with what it can establish
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

const IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
function canContainer(path) {
  const v = document.createElement('video');
  return path.endsWith('.mkv') ? !!(v.canPlayType('video/x-matroska') || v.canPlayType('video/webm')) && !IOS : false;
}

// True when no engine in this browser can even try the file (e.g. MKV in Safari).
export function unsupportedFormat(url) {
  return orderEngines(url).length === 0;
}

const ENGINE_NAMES = { hlsjs: 'HLS', mpegts: 'MPEG-TS', native: 'built-in player', mkv: 'MKV remux' };

// Playback health for the log: every stall with its length and the buffer it ran down from,
// and every 30 s the buffer, resolution, download speed vs bitrate, and dropped frames.
class Health {
  constructor(video, log, onSlow) {
    this.video = video;
    this.log = log;
    this.onSlow = onSlow;
    this.onWaiting = () => {
      if (this.stallStart) return;
      this.stallStart = performance.now();
      this.stalls++;
    };
    this.onPlaying = () => {
      if (!this.stallStart) return;
      const secs = (performance.now() - this.stallStart) / 1000;
      this.stallStart = 0;
      this.stallTime += secs;
      if (secs >= 0.3) this.log(`⏸ buffering ${secs.toFixed(1)}s (stall #${this.stalls}${this.rateText()})`);
      // Three stalls adding up to 8 s: the connection isn't keeping up, so say so once.
      if (!this.slowSaid && this.stalls >= 3 && this.stallTime >= 8) { this.slowSaid = true; this.onSlow(); }
    };
  }

  start(engine, player) {
    this.stop();
    Object.assign(this, { engine, player, stalls: 0, stallTime: 0, slowSaid: false, stallStart: 0, bytes: 0, loadMs: 0, media: 0, lastSpeed: 0, bufMark: null, notes: new Map(), began: performance.now() });
    this.video.addEventListener('waiting', this.onWaiting);
    this.video.addEventListener('playing', this.onPlaying);
    this.timer = setInterval(() => this.report(), 30000);
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = 0;
    this.video.removeEventListener('waiting', this.onWaiting);
    this.video.removeEventListener('playing', this.onPlaying);
  }

  // A downloaded segment: bytes, milliseconds it took, seconds of media it holds.
  fragment(bytes, ms, mediaSecs) {
    this.bytes += bytes;
    this.loadMs += ms;
    this.media += mediaSecs || 0;
  }

  speed(bytesPerSec) { this.lastSpeed = bytesPerSec; }

  // Non-fatal engine trouble: logged once per kind per report period, with a count.
  note(what) { this.notes.set(what, (this.notes.get(what) || 0) + 1); }

  rateText() {
    if (this.loadMs && this.media && this.bytes) {
      const speed = (this.bytes * 8) / (this.loadMs / 1000);
      const bitrate = (this.bytes * 8) / this.media;
      return ` · download ${mbps(speed)} for a ${mbps(bitrate)} stream (${(speed / bitrate).toFixed(1)}× real time)`;
    }
    if (this.lastSpeed) return ` · download ${mbps(this.lastSpeed * 8)}`;
    // The built-in player hides its downloads, so measure how fast the buffered end moves:
    // below 1× real time, the connection can't keep up with the file's bitrate.
    const v = this.video, b = v.buffered;
    let end = 0;
    for (let i = 0; i < b.length; i++) if (b.start(i) <= v.currentTime + 1 && b.end(i) > end) end = b.end(i);
    const now = performance.now(), prev = this.bufMark;
    this.bufMark = { end, at: now };
    if (!prev || end < prev.end || now - prev.at < 2000) return '';
    return ` · downloading at ${((end - prev.end) / ((now - prev.at) / 1000)).toFixed(1)}× real time`;
  }

  report() {
    const v = this.video;
    const q = v.getVideoPlaybackQuality?.();
    const dropped = q && q.totalVideoFrames ? ` · dropped frames ${q.droppedVideoFrames}/${q.totalVideoFrames} (${((q.droppedVideoFrames / q.totalVideoFrames) * 100).toFixed(1)}%)` : '';
    const mins = (performance.now() - this.began) / 60000;
    this.log(`ℹ ${ENGINE_NAMES[this.engine]} · ${v.videoWidth}×${v.videoHeight} · buffer ${this.player.bufferedAhead().toFixed(1)}s · ${this.stalls} stall(s), ${this.stallTime.toFixed(1)}s in ${mins.toFixed(1)} min${this.rateText()}${dropped}`);
    for (const [what, n] of this.notes) this.log(`  ${what}${n > 1 ? ` ×${n}` : ''}`);
    this.notes.clear();
    this.bytes = 0; this.loadMs = 0; this.media = 0; // speeds per period
  }
}

const mbps = (bps) => `${(bps / 1e6).toFixed(1)} Mbit/s`;
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

function withTimeout(promise, ms, message) {
  let t;
  return Promise.race([promise, new Promise((_, reject) => { t = setTimeout(() => reject(new Error(message)), ms); })])
    .finally(() => clearTimeout(t));
}

function orderEngines(url) {
  const path = url.split('?')[0].toLowerCase();
  // Don't fall back to MSE during AirPlay: it can appear to work while sending audio only.
  if (airPlay) return ['native'];
  const canNativeHls = document.createElement('video').canPlayType('application/vnd.apple.mpegurl');
  if (path.endsWith('.m3u8') || path.endsWith('.m3u') || url.includes('m3u8')) {
    const hlsjs = !!(window.Hls && Hls.isSupported());
    // hls.js first wherever it runs (its buffering is tuned for slow proxied segments);
    // Safari's own player is the fallback, or first if chosen in Sources → Display. On iPhone
    // and iPad it's first by default: only it can be sent to an Apple TV over AirPlay.
    const apple = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (canNativeHls && (hlsPreference === 'native' || !hlsjs || (apple && hlsPreference === 'auto'))) return ['native', 'hlsjs'];
    return ['hlsjs', 'native', 'mpegts'];
  }
  if (path.endsWith('.ts') || path.endsWith('.flv')) return ['mpegts', 'native'];
  // MKV/AVI only when the browser says it might cope (Chrome often can; Safari never does):
  // a doomed attempt would still cost a connection against the account.
  const mse = !!(window.ManagedMediaSource || window.MediaSource);
  if (path.endsWith('.mkv')) return canContainer(path) ? ['native', ...(mse ? ['mkv'] : [])] : mse ? ['mkv'] : [];
  if (path.endsWith('.avi')) return canContainer(path) ? ['native'] : [];
  if (/\.(mp4|webm|mov|m4v|ogv)$/.test(path)) return ['native'];
  // Extension-less IPTV URLs (e.g. Xtream /user/pass/123) are usually raw MPEG-TS.
  return ['mpegts', 'hlsjs'];
}
