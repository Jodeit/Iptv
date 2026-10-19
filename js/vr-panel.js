// In-headset channel browser and controls, drawn to a canvas texture and driven by
// controller/hand ray pointing. Squeeze (grip) toggles the panel; thumbstick pages.

import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';

const W = 768, H = 1024, ROWS = 9;
const C = {
  bg: 'rgba(14,16,24,0.94)', line: 'rgba(255,255,255,0.10)', text: '#e8eaf2', muted: '#8a90a6',
  accent: '#3de0ff', accent2: '#ff3d7f', hover: 'rgba(255,255,255,0.10)', active: 'rgba(61,224,255,0.20)',
};

export class VRPanel {
  constructor(theater, app) {
    this.theater = theater;
    this.app = app;
    this.page = 0;
    this.regions = [];
    this.hoverKey = null;
    this.stickCooldown = 0;

    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;

    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.75, 0.75 * H / W),
      new THREE.MeshBasicMaterial({ map: this.texture, transparent: true }),
    );
    this.mesh.position.set(-1.25, 1.25, -1.5);
    this.mesh.lookAt(0, 1.4, 0);
    this.mesh.visible = false;
    theater.scene.add(this.mesh);

    this.raycaster = new THREE.Raycaster();
    this.tmp = new THREE.Matrix4();
    this.setupControllers();

    const xr = theater.renderer.xr;
    xr.addEventListener('sessionstart', () => { this.mesh.visible = true; this.focusCurrent(); this.draw(); });
    xr.addEventListener('sessionend', () => { this.mesh.visible = false; });
    theater.onFrame((dt, frame) => this.update(dt, frame));
    this.draw();
  }

  setupControllers() {
    const { renderer, scene } = this.theater;
    const factory = new XRControllerModelFactory();
    const rayGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
    this.controllers = [0, 1].map((i) => {
      const controller = renderer.xr.getController(i);
      const ray = new THREE.Line(rayGeo, new THREE.LineBasicMaterial({ color: 0x3de0ff, transparent: true, opacity: 0.7 }));
      ray.scale.z = 5;
      controller.add(ray);
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.008), new THREE.MeshBasicMaterial({ color: 0xffffff }));
      dot.visible = false;
      scene.add(dot);
      controller.userData = { ray, dot, region: null };
      controller.addEventListener('selectstart', () => this.click(controller));
      controller.addEventListener('squeezestart', () => { this.mesh.visible = !this.mesh.visible; });
      scene.add(controller);

      const grip = renderer.xr.getControllerGrip(i);
      grip.add(factory.createControllerModel(grip));
      scene.add(grip);
      return controller;
    });
  }

  // ---------- Interaction ----------
  update(dt, frame) {
    if (!frame) return;
    let hoverKey = null;
    for (const c of this.controllers) {
      const { ray, dot } = c.userData;
      c.userData.region = null;
      dot.visible = false;
      ray.scale.z = 5;
      if (!this.mesh.visible) continue;

      this.tmp.identity().extractRotation(c.matrixWorld);
      this.raycaster.ray.origin.setFromMatrixPosition(c.matrixWorld);
      this.raycaster.ray.direction.set(0, 0, -1).applyMatrix4(this.tmp);
      const hit = this.raycaster.intersectObject(this.mesh, false)[0];
      if (!hit) continue;
      ray.scale.z = hit.distance;
      dot.position.copy(hit.point);
      dot.visible = true;
      const x = hit.uv.x * W, y = (1 - hit.uv.y) * H;
      const region = this.regions.find((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
      c.userData.region = region || null;
      if (region) hoverKey = region.key;
    }
    if (hoverKey !== this.hoverKey) { this.hoverKey = hoverKey; this.draw(); }

    // B/Y brings the panel back (it may have been hidden with the grip).
    for (const src of frame.session.inputSources) {
      const pressed = !!src.gamepad?.buttons?.[5]?.pressed;
      const key = `by:${src.handedness}`;
      if (pressed && !this[key]) { this.mesh.visible = true; this.draw(); }
      this[key] = pressed;
    }

    // Thumbstick up/down pages through channels.
    this.stickCooldown -= dt;
    if (this.stickCooldown <= 0 && this.mesh.visible) {
      for (const src of frame.session.inputSources) {
        const y = src.gamepad?.axes?.[3] ?? 0;
        if (Math.abs(y) > 0.7) { this.turnPage(y > 0 ? 1 : -1); this.stickCooldown = 0.35; break; }
      }
    }
  }

  click(controller) {
    const r = controller.userData.region;
    if (!r) return;
    r.action();
    this.draw();
  }

  turnPage(dir) {
    const pages = Math.max(1, Math.ceil(this.app.channels().length / ROWS));
    this.page = (this.page + dir + pages) % pages;
    this.draw();
  }

  focusCurrent() {
    const list = this.app.channels();
    const i = list.indexOf(this.app.current());
    if (i >= 0) this.page = Math.floor(i / ROWS);
  }

  // ---------- Drawing ----------
  draw() {
    const ctx = this.ctx;
    const app = this.app;
    this.regions = [];
    ctx.clearRect(0, 0, W, H);
    roundRect(ctx, 0, 0, W, H, 36);
    ctx.fillStyle = C.bg;
    ctx.fill();
    ctx.strokeStyle = C.line;
    ctx.lineWidth = 2;
    ctx.stroke();

    // Header
    const grad = ctx.createLinearGradient(32, 0, 92, 0);
    grad.addColorStop(0, C.accent2);
    grad.addColorStop(1, C.accent);
    roundRect(ctx, 32, 28, 56, 56, 12);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.fillStyle = '#000';
    ctx.font = '800 28px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('o3', 60, 57);
    ctx.textAlign = 'left';
    ctx.fillStyle = C.text;
    ctx.font = '600 30px system-ui, sans-serif';
    const cur = app.current();
    ctx.fillText(fit(ctx, cur ? cur.name : 'XR IPTV', W - 140), 108, 46);
    ctx.fillStyle = C.muted;
    ctx.font = '400 22px system-ui, sans-serif';
    ctx.fillText(fit(ctx, app.status(), W - 140), 108, 76);

    // Group selector
    const groups = app.groups();
    const g = app.group();
    this.button(32, 108, 64, 52, '◀', 'grp-', () => { app.setGroup(cycle(groups, g, -1)); this.page = 0; });
    this.button(W - 96, 108, 64, 52, '▶', 'grp+', () => { app.setGroup(cycle(groups, g, 1)); this.page = 0; });
    ctx.fillStyle = C.text;
    ctx.font = '500 24px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(fit(ctx, g || 'All groups', W - 240), W / 2, 134);
    ctx.textAlign = 'left';

    // Channel list
    const list = app.channels();
    const pages = Math.max(1, Math.ceil(list.length / ROWS));
    this.page = Math.min(this.page, pages - 1);
    const top = 176, rowH = 62;
    for (let i = 0; i < ROWS; i++) {
      const ch = list[this.page * ROWS + i];
      if (!ch) break;
      const y = top + i * rowH;
      const key = `ch:${ch.id}`;
      const playing = ch === cur;
      if (playing || this.hoverKey === key) {
        roundRect(ctx, 24, y, W - 48, rowH - 6, 10);
        ctx.fillStyle = playing ? C.active : C.hover;
        ctx.fill();
      }
      ctx.fillStyle = C.muted;
      ctx.font = '400 20px system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(String(ch.num), 88, y + 28);
      ctx.textAlign = 'left';
      ctx.fillStyle = playing ? C.accent : C.text;
      ctx.font = '500 25px system-ui, sans-serif';
      ctx.fillText(fit(ctx, ch.name, W - 160), 108, y + 20);
      ctx.fillStyle = C.muted;
      ctx.font = '400 18px system-ui, sans-serif';
      ctx.fillText(fit(ctx, ch.group, W - 160), 108, y + 42);
      this.regions.push({ key, x: 24, y, w: W - 48, h: rowH - 6, action: () => app.play(ch) });
    }
    if (!list.length) {
      ctx.fillStyle = C.muted;
      ctx.font = '400 24px system-ui, sans-serif';
      ctx.fillText('No channels — load a playlist on the desktop panel.', 40, top + 30);
    }

    // Paging
    const py = top + ROWS * rowH + 6;
    this.button(32, py, 180, 52, '◀ Prev', 'pg-', () => this.turnPage(-1));
    this.button(W - 212, py, 180, 52, 'Next ▶', 'pg+', () => this.turnPage(1));
    ctx.fillStyle = C.muted;
    ctx.font = '400 22px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${this.page + 1} / ${pages}`, W / 2, py + 27);
    ctx.textAlign = 'left';

    // Controls
    const cy = py + 66, bw = (W - 64 - 3 * 12) / 4;
    const mode = app.mode() || '2d';
    this.button(32, cy, bw, 56, mode.toUpperCase(), 'mode', () => app.cycleMode(), true);
    this.button(32 + (bw + 12), cy, bw, 56, '⏮', 'prev', () => app.prev());
    this.button(32 + (bw + 12) * 2, cy, bw, 56, app.playing() ? '⏸' : '▶', 'play', () => app.togglePlay());
    this.button(32 + (bw + 12) * 3, cy, bw, 56, '⏭', 'next', () => app.next());
    const cy2 = cy + 68;
    this.button(32, cy2, bw, 56, 'Depth −', 'rel-', () => app.adjust('relief', -0.03));
    this.button(32 + (bw + 12), cy2, bw, 56, 'Depth +', 'rel+', () => app.adjust('relief', 0.03));
    this.button(32 + (bw + 12) * 2, cy2, bw, 56, 'Pop −', 'pop-', () => app.adjust('parallax', -0.1));
    this.button(32 + (bw + 12) * 3, cy2, bw, 56, 'Pop +', 'pop+', () => app.adjust('parallax', 0.1));
    const cy3 = cy2 + 68, half = (W - 64 - 12) / 2;
    this.button(32, cy3, half, 56, 'Hide panel (B/Y shows it)', 'hide', () => { this.mesh.visible = false; });
    this.button(32 + half + 12, cy3, half, 56, 'Exit VR', 'exit', () => app.exitVR(), true);

    this.texture.needsUpdate = true;
  }

  button(x, y, w, h, label, key, action, accent = false) {
    const ctx = this.ctx;
    roundRect(ctx, x, y, w, h, 12);
    ctx.fillStyle = this.hoverKey === key ? 'rgba(61,224,255,0.28)' : accent ? C.active : 'rgba(255,255,255,0.06)';
    ctx.fill();
    ctx.strokeStyle = accent ? C.accent : C.line;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = accent ? C.accent : C.text;
    ctx.font = '600 22px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(label, x + w / 2, y + h / 2 + 1);
    ctx.textAlign = 'left';
    this.regions.push({ key, x, y, w, h, action });
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function fit(ctx, text, max) {
  if (ctx.measureText(text).width <= max) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + '…').width > max) s = s.slice(0, -1);
  return s + '…';
}

function cycle(list, value, dir) {
  const all = ['', ...list];
  const i = all.indexOf(value);
  return all[(i + dir + all.length) % all.length];
}
