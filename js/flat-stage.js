// Flat player for phones and tablets: the <video> element itself, with the system's own
// controls (full screen, picture-in-picture, AirPlay), instead of the WebGL theater.
// It has the same surface as Theater, so the rest of the app doesn't need to care which
// one it's talking to; the 3D-only calls do nothing here.

export class FlatStage {
  constructor(video) {
    this.video = video;
    this.root = document.createElement('div');
    this.root.id = 'flatStage';
    this.overlay = document.createElement('div');
    this.overlay.className = 'flat-overlay';
    this.overlay.innerHTML = '<div class="flat-title"></div><div class="flat-sub"></div>';
    video.removeAttribute('style');
    video.controls = true;
    video.setAttribute('x-webkit-airplay', 'allow');
    // No WebGL here, so the video needn't be CORS-clean: direct streams play without the proxy.
    video.removeAttribute('crossorigin');
    this.root.append(video, this.overlay);
    document.body.append(this.root);

    this.screen = { set() {}, get: () => 0 };
    this.renderer = { xr: { isPresenting: false, getSession: () => null } };
    this.ambientOn = false;
    this.setPlaceholder('Pick a channel');
  }

  setVideoActive(active) {
    this.overlay.classList.toggle('hidden', active);
  }

  setPlaceholder(title, subtitle = '') {
    this.overlay.querySelector('.flat-title').textContent = title;
    this.overlay.querySelector('.flat-sub').textContent = subtitle;
    this.overlay.classList.remove('hidden');
  }

  setView() {}
  setScreen() {}
  setEnvironment() {}
  setAspect() {}
  onFrame() {}
  async enterXR() { throw new Error('VR isn’t available on this device'); }
}
