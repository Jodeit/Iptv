// Chromecast: Google's Cast SDK (Chrome on desktop and Android only; not iOS). The Default
// Media Receiver fetches the stream itself, so it gets an https address through the proxy:
// the Chromecast's player page is https and refuses plain http, and it can't reach this
// computer's localhost.

const SDK = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';

export class Cast {
  // onChange(state): 'unavailable' | 'idle' | 'connecting' | 'connected'.
  constructor({ onChange = () => {} } = {}) {
    this.onChange = onChange;
    this.state = 'unavailable';
    if (!/Chrome\//.test(navigator.userAgent) || /iPhone|iPad|CriOS/.test(navigator.userAgent)) return;
    window.__onGCastApiAvailable = (ok) => { if (ok) this.init(); };
    const s = document.createElement('script');
    s.src = SDK;
    s.async = true;
    document.head.append(s);
  }

  init() {
    const { cast } = window;
    const ctx = cast.framework.CastContext.getInstance();
    ctx.setOptions({
      receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
      autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
    });
    this.ctx = ctx;
    // The TV's player, for play/pause and seeking from this page while casting
    this.remote = new cast.framework.RemotePlayer();
    this.remoteCtl = new cast.framework.RemotePlayerController(this.remote);
    const map = { NO_DEVICES_AVAILABLE: 'unavailable', NOT_CONNECTED: 'idle', CONNECTING: 'connecting', CONNECTED: 'connected' };
    const update = () => { this.state = map[ctx.getCastState()] || 'idle'; this.onChange(this.state); };
    ctx.addEventListener(cast.framework.CastContextEventType.CAST_STATE_CHANGED, update);
    update();
  }

  get connected() { return this.state === 'connected'; }
  get deviceName() { return this.ctx?.getCurrentSession()?.getCastDevice()?.friendlyName || 'Chromecast'; }

  // Opens Chrome's device picker.
  async pick() { await this.ctx?.requestSession(); }

  stop() { this.ctx?.endCurrentSession(true); }

  // Where the receiver is: seconds into the current item, or 0.
  position() {
    const m = this.ctx?.getCurrentSession()?.getMediaSession();
    return m ? m.getEstimatedTime() : 0;
  }

  get paused() { return !!this.remote?.isPaused; }
  playOrPause() { if (this.remote?.isMediaLoaded) this.remoteCtl.playOrPause(); }
  // Seconds forward (or back, if negative), kept inside the item
  seekBy(seconds) {
    const r = this.remote;
    if (!r?.isMediaLoaded || !r.canSeek) return;
    const end = r.duration > 0 ? r.duration : Infinity;
    r.currentTime = Math.max(0, Math.min(end, r.currentTime + seconds));
    this.remoteCtl.seek();
  }

  // url: an https address the Chromecast can fetch. live: true for channels.
  async load({ url, title, subtitle, image, live, startAt = 0 }) {
    const session = this.ctx?.getCurrentSession();
    if (!session) throw new Error('Not connected to a Chromecast');
    const path = decodeURIComponent(url).split('?url=').pop().split('?')[0].toLowerCase();
    const type = /\.m3u8?$/.test(path) ? 'application/x-mpegurl'
      : path.endsWith('.mkv') ? 'video/x-matroska'
        : path.endsWith('.webm') ? 'video/webm'
          : path.endsWith('.ts') ? 'video/mp2t' : 'video/mp4';
    const info = new chrome.cast.media.MediaInfo(url, type);
    info.streamType = live ? chrome.cast.media.StreamType.LIVE : chrome.cast.media.StreamType.BUFFERED;
    if (type === 'application/x-mpegurl') info.hlsSegmentFormat = chrome.cast.media.HlsSegmentFormat.TS;
    const meta = new chrome.cast.media.GenericMediaMetadata();
    meta.title = title;
    if (subtitle) meta.subtitle = subtitle;
    if (image) meta.images = [new chrome.cast.Image(image)];
    info.metadata = meta;
    const req = new chrome.cast.media.LoadRequest(info);
    req.autoplay = true;
    if (!live && startAt > 0) req.currentTime = startAt;
    const err = await session.loadMedia(req);
    if (err) throw new Error(typeof err === 'string' ? err : err.code || 'load failed');
  }
}
