// Flat player for phones and tablets: the <video> element itself, with the system's own
// controls (full screen, picture-in-picture, AirPlay), instead of the WebGL theater.
// It has the same surface as Theater, so the rest of the app doesn't need to care which
// one it's talking to; the 3D-only calls do nothing here.

export class FlatStage {
  constructor(video, { nativeControls = false } = {}) {
    this.video = video;
    this.nativeControls = nativeControls;
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
    // Pop-out lives in the corner instead of the controls' overflow menu.
    video.disablePictureInPicture = true;
    this.pip = document.createElement('button');
    this.pip.className = 'icon-btn pip-btn stage-pip';
    this.pip.title = 'Pop out into its own window';
    this.pip.textContent = '⧉';
    this.controls = document.createElement('div');
    this.controls.className = 'flat-controls hidden';
    this.controls.innerHTML = `
      <div class="flat-controls-title"></div>
      <div class="flat-controls-seek">
        <span class="flat-controls-current"></span>
        <input type="range" min="0" max="1000" value="0" aria-label="Seek">
        <span class="flat-controls-duration"></span>
      </div>
      <div class="flat-controls-buttons">
        <button type="button" data-action="back" aria-label="Back 10 seconds">−10</button>
        <button type="button" data-action="play" aria-label="Pause">Ⅱ</button>
        <button type="button" data-action="forward" aria-label="Forward 30 seconds">+30</button>
        <button type="button" data-action="close" aria-label="Hide controls">✕</button>
      </div>`;
    this.root.append(video, this.overlay, ...(nativeControls ? [] : [this.controls]), this.pip);
    document.body.append(this.root);
    this.controlsTimer = 0;
    this.controlsTick = 0;
    this.seekInput = this.controls.querySelector('input[type="range"]');
    this.controls.addEventListener('click', (e) => e.stopPropagation());
    this.root.addEventListener('click', (e) => {
      if (!this.nativeControls && e.target === video) this.toggleControls();
    });
    this.controls.querySelector('[data-action="play"]').onclick = () => {
      if (video.paused) video.play().catch((err) => console.warn('Could not resume video:', err));
      else video.pause();
      this.showControls();
    };
    this.controls.querySelector('[data-action="back"]').onclick = () => this.seekBy(-10);
    this.controls.querySelector('[data-action="forward"]').onclick = () => this.seekBy(30);
    this.controls.querySelector('[data-action="close"]').onclick = () => this.hideControls();
    this.seekInput.oninput = () => {
      const range = this.seekRange();
      if (range) video.currentTime = range[0] + (range[1] - range[0]) * (+this.seekInput.value / 1000);
      this.paintControls();
      this.showControls();
    };
    for (const event of ['timeupdate', 'durationchange', 'loadedmetadata', 'progress', 'seeking']) {
      video.addEventListener(event, () => this.paintControls());
    }
    video.addEventListener('play', () => {
      this.paintControls();
      if (!this.controls.classList.contains('hidden')) this.showControls();
    });
    video.addEventListener('pause', () => {
      clearTimeout(this.controlsTimer);
      clearInterval(this.controlsTick);
      this.paintControls();
    });

    this.screen = { set() {}, get: () => 0 };
    this.renderer = { xr: { isPresenting: false, getSession: () => null } };
    this.ambientOn = false;
    this.setPlaceholder('Pick a channel');
  }

  setVideoActive(active) {
    this.overlay.classList.toggle('hidden', active);
    if (!active) this.hideControls();
  }

  seekRange() {
    const { video } = this;
    if (video.seekable?.length) return [video.seekable.start(0), video.seekable.end(video.seekable.length - 1)];
    if (Number.isFinite(video.duration) && video.duration > 0) return [0, video.duration];
    return null;
  }

  seekBy(seconds) {
    const range = this.seekRange();
    if (!range) return;
    this.video.currentTime = Math.max(range[0], Math.min(range[1], this.video.currentTime + seconds));
    this.paintControls();
    this.showControls();
  }

  toggleControls() {
    if (this.controls.classList.contains('hidden')) this.showControls();
    else this.hideControls();
  }

  showControls() {
    if (!this.overlay.classList.contains('hidden')) return;
    this.controls.classList.remove('hidden');
    this.paintControls();
    clearTimeout(this.controlsTimer);
    clearInterval(this.controlsTick);
    if (!this.video.paused) {
      this.controlsTimer = setTimeout(() => this.hideControls(), 5000);
      this.controlsTick = setInterval(() => this.paintControls(), 500);
    }
  }

  hideControls() {
    clearTimeout(this.controlsTimer);
    clearInterval(this.controlsTick);
    this.controls.classList.add('hidden');
  }

  paintControls() {
    if (this.controls.classList.contains('hidden')) return;
    const { video } = this;
    const range = this.seekRange();
    const position = range ? Math.max(0, Math.min(1, (video.currentTime - range[0]) / (range[1] - range[0]))) : 0;
    this.seekInput.value = String(Math.round(position * 1000));
    this.seekInput.disabled = !range;
    this.controls.querySelector('.flat-controls-current').textContent = this.formatTime(video.currentTime);
    this.controls.querySelector('.flat-controls-duration').textContent = range ? this.formatTime(range[1]) : '';
    const playButton = this.controls.querySelector('[data-action="play"]');
    playButton.textContent = video.paused ? '▶' : 'Ⅱ';
    playButton.setAttribute('aria-label', video.paused ? 'Play' : 'Pause');
    this.controls.querySelector('[data-action="back"]').disabled = !range;
    this.controls.querySelector('[data-action="forward"]').disabled = !range;
  }

  formatTime(seconds) {
    if (!Number.isFinite(seconds)) return '';
    const total = Math.max(0, Math.floor(seconds));
    return `${Math.floor(total / 3600) ? `${Math.floor(total / 3600)}:` : ''}${String(Math.floor(total / 60) % 60).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  }

  setPlaceholder(title, subtitle = '') {
    this.overlay.querySelector('.flat-title').textContent = title;
    this.overlay.querySelector('.flat-sub').textContent = subtitle;
    this.controls.querySelector('.flat-controls-title').textContent = title;
    this.overlay.classList.remove('hidden');
  }

  setView() {}
  setScreen() {}
  setEnvironment() {}
  setAspect() {}
  onFrame() {}
  async enterXR() { throw new Error('VR isn’t available on this device'); }
}
