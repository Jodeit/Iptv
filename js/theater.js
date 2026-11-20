// The 3D theater: renderer, environments, the XR3D screen, desktop stereo output
// (anaglyph / side-by-side) and WebXR session handling.

import * as THREE from 'three';
import { XR3DScreen } from './xr3d.js';

const DUBOIS_LEFT = new THREE.Matrix3().fromArray([
  0.456100, -0.0400822, -0.0152161, 0.500484, -0.0378246, -0.0205971, 0.176381, -0.0157589, -0.00546856,
]);
const DUBOIS_RIGHT = new THREE.Matrix3().fromArray([
  -0.0434706, 0.378476, -0.0721527, -0.0879388, 0.73364, -0.112961, -0.00155529, -0.0184503, 1.2264,
]);

export class Theater {
  constructor(container, video) {
    this.container = container;
    this.video = video;
    this.view = 'mono';
    this.ambientOn = true;
    this.frameHooks = [];
    this.xrMode = null;
    // Outside VR the screen fills the window by default: the camera moves to just the distance where the whole
    // picture fits, with no room or black border around it. VR keeps the seat and the screen settings.
    this.fitWindow = true;
    this.curve = 0;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(innerWidth, innerHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType('local-floor');
    // Native resolution: 1.2x meant ~44% more pixels per eye, too much for a headset GPU
    // that's also decoding video.
    renderer.xr.setFramebufferScaleFactor(1.0);
    renderer.xr.setFoveation(1);
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 200);
    this.camera.position.set(0, 1.6, 0.6);

    // The seat is fixed, facing the screen: no dragging, tilting or zooming the view. Size, distance and height
    // are settings (Playback → Screen).

    // Desktop stereo rig: same layer convention as WebXR (left=1, right=2).
    this.stereo = new THREE.StereoCamera();
    this.stereo.eyeSep = 0.064;
    this.stereo.cameraL.layers.enable(1);
    this.stereo.cameraR.layers.enable(2);
    this.rtL = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
    this.rtR = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
    this.anaglyph = this.makeAnaglyphPass();

    // Textures
    this.videoTexture = new THREE.VideoTexture(video);
    this.videoTexture.colorSpace = THREE.SRGBColorSpace;
    this.videoTexture.generateMipmaps = false;
    this.placeholderCanvas = document.createElement('canvas');
    this.placeholderCanvas.width = 1280;
    this.placeholderCanvas.height = 720;
    this.placeholderTexture = new THREE.CanvasTexture(this.placeholderCanvas);
    this.placeholderTexture.colorSpace = THREE.SRGBColorSpace;
    this.setPlaceholder('Pick a channel');

    // Screen
    this.screen = new XR3DScreen(this.placeholderTexture);
    this.screenRig = new THREE.Group();
    this.screenRig.add(this.screen.group);
    this.scene.add(this.screenRig);
    this.aspect = 16 / 9;

    this.buildEnvironments();
    this.buildAmbientSampler();
    this.setScreen({ width: 6, distance: 5, height: 1.8, curve: 0.15 });
    this.setEnvironment('cinema');

    addEventListener('resize', () => this.resize());
    this.resize();

    renderer.xr.addEventListener('sessionstart', () => {
      this.screen.setStereo(true);
      this.placeCamera(); // the screen's curve comes back
      if (this.xrMode === 'immersive-ar') { this.scene.background = null; this.envRoot.visible = false; }
    });
    renderer.xr.addEventListener('sessionend', () => {
      this.xrMode = null;
      this.screen.setStereo(false);
      this.resize(); // places the camera again
      this.setEnvironment(this.envName);
      this.onXREnd?.();
    });

    this.clock = new THREE.Clock();
    renderer.setAnimationLoop((t, frame) => this.tick(t, frame));
  }

  // ---------- Environment ----------
  buildEnvironments() {
    this.envRoot = new THREE.Group();
    this.scene.add(this.envRoot);

    this.hemi = new THREE.HemisphereLight(0x8899bb, 0x0a0a10, 0.25);
    this.scene.add(this.hemi);
    this.screenLight = new THREE.PointLight(0xffffff, 6, 18, 1.6);
    this.scene.add(this.screenLight);

    // Cinema: a dark room with a slightly glossy floor that picks up the screen light.
    const cinema = new THREE.Group();
    const roomMat = new THREE.MeshLambertMaterial({ color: 0x14151c, side: THREE.BackSide });
    const room = new THREE.Mesh(new THREE.BoxGeometry(30, 10, 34), roomMat);
    room.position.set(0, 5, -4);
    cinema.add(room);
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(30, 34),
      new THREE.MeshLambertMaterial({ color: 0x0c0d12 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, 0.001, -4);
    cinema.add(floor);
    // Stadium rows of seat silhouettes behind the viewer give the room scale.
    const seatGeo = new THREE.BoxGeometry(0.55, 0.9, 0.6);
    const seatMat = new THREE.MeshLambertMaterial({ color: 0x1d1420 });
    const seats = new THREE.InstancedMesh(seatGeo, seatMat, 5 * 12);
    const m = new THREE.Matrix4();
    let n = 0;
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 12; c++) {
        m.makeTranslation((c - 5.5) * 0.7, 0.45 + r * 0.25, 0.9 + r * 1.1);
        seats.setMatrixAt(n++, m);
      }
    }
    cinema.add(seats);
    this.envRoot.add(cinema);

    // Void: grid floor only.
    const voidEnv = new THREE.Group();
    const grid = new THREE.GridHelper(40, 40, 0x2a3550, 0x161b28);
    voidEnv.add(grid);
    this.envRoot.add(voidEnv);

    // Stars: point cloud shell.
    const stars = new THREE.Group();
    const N = 3000;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(60 + Math.random() * 40);
      pos.set([v.x, Math.abs(v.y) * 0.9 + 1, v.z], i * 3);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    stars.add(new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffffff, size: 0.25, sizeAttenuation: true })));
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(8, 64),
      new THREE.MeshLambertMaterial({ color: 0x0b0d14 }),
    );
    disc.rotation.x = -Math.PI / 2;
    stars.add(disc);
    this.envRoot.add(stars);

    this.envs = { cinema, void: voidEnv, stars };

    // Glow halo behind the screen, tinted by the video's average colour.
    const g = document.createElement('canvas');
    g.width = g.height = 256;
    const ctx = g.getContext('2d');
    const grad = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
    grad.addColorStop(0, 'rgba(255,255,255,0.9)');
    grad.addColorStop(0.45, 'rgba(255,255,255,0.25)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 256, 256);
    this.glow = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: new THREE.CanvasTexture(g), transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending, opacity: 0.35,
      }),
    );
    this.glow.position.z = -0.3;
    this.screenRig.add(this.glow);
  }

  setEnvironment(name) {
    this.envName = name;
    for (const [k, g] of Object.entries(this.envs)) g.visible = k === name;
    this.envRoot.visible = true;
    this.scene.background = new THREE.Color(name === 'stars' ? 0x020308 : 0x050608);
    this.hemi.intensity = name === 'cinema' ? 0.25 : 0.12;
  }

  // ---------- Ambient light ----------
  buildAmbientSampler() {
    this.sampleCanvas = document.createElement('canvas');
    this.sampleCanvas.width = 16;
    this.sampleCanvas.height = 9;
    this.sampleCtx = this.sampleCanvas.getContext('2d', { willReadFrequently: true });
    this.ambientTarget = new THREE.Color(0x334466);
    this.ambientColor = new THREE.Color(0x334466);
    this.lastSample = 0;
  }

  sampleAmbient(now) {
    // Reading a video frame back from the GPU is costly, especially on a headset where
    // it competes with video decoding; the light only needs to drift, not track every cut.
    const interval = this.renderer.xr.isPresenting ? 1000 : 400;
    if (now - this.lastSample < interval) return;
    this.lastSample = now;
    if (!this.ambientOn || !this.videoActive || this.video.readyState < 2) {
      this.ambientTarget.set(this.videoActive ? 0x223344 : 0x334466);
      return;
    }
    try {
      this.sampleCtx.drawImage(this.video, 0, 0, 16, 9);
      const d = this.sampleCtx.getImageData(0, 0, 16, 9).data;
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
      const n = d.length / 4 * 255;
      this.ambientTarget.setRGB(r / n, g / n, b / n, THREE.SRGBColorSpace);
    } catch {
      this.ambientOn = false; // cross-origin frame we can't read
    }
  }

  // ---------- Screen ----------
  setScreen({ width, distance, height, curve }) {
    if (width !== undefined) this.screenWidth = width;
    if (distance !== undefined) this.screenDistance = distance;
    if (height !== undefined) this.screenHeight = height;
    if (curve !== undefined) this.curve = curve;
    this.screen.setSize(this.screenWidth, this.aspect);
    this.screenRig.position.set(0, this.screenHeight, -this.screenDistance);
    this.glow.scale.set(this.screenWidth * 1.7, (this.screenWidth / this.aspect) * 1.9, 1);
    this.screenLight.position.set(0, this.screenHeight, -this.screenDistance + 1.5);
    this.placeCamera();
  }

  setFitWindow(on) {
    this.fitWindow = !!on;
    this.placeCamera();
  }

  // The 2D view's seat. Fill: as close as the whole picture still fits, with the screen flat (a curve seen from that
  // close bulges past the window's edges). Otherwise the cinema seat. In VR the screen keeps its curve.
  placeCamera() {
    const fill = this.fitWindow && !this.renderer.xr.isPresenting;
    this.screen.set('uCurve', fill ? 0 : this.curve);
    if (this.renderer.xr.isPresenting || this.screenWidth === undefined) return;
    const sy = this.screenHeight, sz = -this.screenDistance;
    if (!fill) {
      this.camera.position.set(0, 1.6, 0.6);
    } else {
      const t = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
      const w = this.screenWidth, h = w / this.aspect;
      this.camera.position.set(0, sy, sz + Math.max(h / (2 * t), w / (2 * t * this.camera.aspect)));
    }
    this.camera.lookAt(0, sy, sz);
  }

  setAspect(aspect) {
    if (!isFinite(aspect) || aspect <= 0) return;
    this.aspect = aspect;
    this.setScreen({});
  }

  setVideoActive(active) {
    this.videoActive = active;
    this.screen.set('uMap', active ? this.videoTexture : this.placeholderTexture);
  }

  setPlaceholder(title, subtitle = 'Tuner · XR3D') {
    const c = this.placeholderCanvas;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, c.width, c.height);
    g.addColorStop(0, '#12051a');
    g.addColorStop(1, '#03141c');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, c.width, c.height);
    // Concentric rings give XR3D's depth estimator something to work with.
    for (let i = 12; i > 0; i--) {
      ctx.beginPath();
      ctx.arc(c.width / 2, c.height / 2 + 40, i * 34, 0, Math.PI * 2);
      ctx.fillStyle = i % 2 ? `rgba(61,224,255,${0.02 + (12 - i) * 0.012})` : `rgba(255,61,127,${0.02 + (12 - i) * 0.01})`;
      ctx.fill();
    }
    ctx.fillStyle = '#e8eaf2';
    ctx.textAlign = 'center';
    ctx.font = '700 64px system-ui, sans-serif';
    ctx.fillText(title, c.width / 2, c.height / 2 - 10);
    ctx.fillStyle = '#8a90a6';
    ctx.font = '400 32px system-ui, sans-serif';
    ctx.fillText(subtitle, c.width / 2, c.height / 2 + 50);
    this.placeholderTexture.needsUpdate = true;
  }

  // ---------- Desktop stereo output ----------
  makeAnaglyphPass() {
    const material = new THREE.ShaderMaterial({
      uniforms: {
        tLeft: { value: this.rtL.texture },
        tRight: { value: this.rtR.texture },
        mLeft: { value: DUBOIS_LEFT },
        mRight: { value: DUBOIS_RIGHT },
      },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: /* glsl */`
        uniform sampler2D tLeft; uniform sampler2D tRight; uniform mat3 mLeft; uniform mat3 mRight;
        varying vec2 vUv;
        vec3 toSRGB(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
        vec3 toLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
        void main() {
          // Dubois matrices are defined on gamma-encoded values.
          vec3 l = toSRGB(clamp(texture2D(tLeft, vUv).rgb, 0.0, 1.0));
          vec3 r = toSRGB(clamp(texture2D(tRight, vUv).rgb, 0.0, 1.0));
          gl_FragColor = vec4(toLinear(clamp(mLeft * l + mRight * r, 0.0, 1.0)), 1.0);
          #include <colorspace_fragment>
        }
      `,
      depthTest: false,
      depthWrite: false,
    });
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));
    return { scene, camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1) };
  }

  setView(view) {
    this.view = view;
    this.resize();
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = this.view === 'sbs' ? (w / 2) / h : w / h;
    this.camera.updateProjectionMatrix();
    this.placeCamera();
    const pr = this.renderer.getPixelRatio();
    this.rtL.setSize(w * pr, h * pr);
    this.rtR.setSize(w * pr, h * pr);
  }

  renderDesktop() {
    const { renderer, scene, camera, stereo } = this;
    if (this.view === 'mono') {
      this.screen.setStereo(false);
      renderer.render(scene, camera);
      return;
    }
    this.screen.setStereo(true);
    camera.updateMatrixWorld();
    stereo.update(camera);
    if (this.view === 'sbs') {
      const w = innerWidth, h = innerHeight;
      renderer.setScissorTest(true);
      renderer.setScissor(0, 0, w / 2, h); renderer.setViewport(0, 0, w / 2, h);
      renderer.render(scene, stereo.cameraL);
      renderer.setScissor(w / 2, 0, w / 2, h); renderer.setViewport(w / 2, 0, w / 2, h);
      renderer.render(scene, stereo.cameraR);
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, w, h);
    } else {
      renderer.setRenderTarget(this.rtL); renderer.clear(); renderer.render(scene, stereo.cameraL);
      renderer.setRenderTarget(this.rtR); renderer.clear(); renderer.render(scene, stereo.cameraR);
      renderer.setRenderTarget(null);
      renderer.render(this.anaglyph.scene, this.anaglyph.camera);
    }
  }

  // ---------- Loop ----------
  onFrame(fn) { this.frameHooks.push(fn); }

  tick(t, frame) {
    const dt = this.clock.getDelta();
    this.sampleAmbient(t);
    this.ambientColor.lerp(this.ambientTarget, Math.min(1, dt * 2));
    this.screenLight.color.copy(this.ambientColor);
    this.glow.material.color.copy(this.ambientColor);

    for (const fn of this.frameHooks) fn(dt, frame);
    this.screen.updateDepth(this.renderer); // only does work when the video has a new frame

    if (this.renderer.xr.isPresenting) {
      this.renderer.render(this.scene, this.camera);
    } else {
      this.renderDesktop();
    }
  }

  // ---------- WebXR ----------
  static async support() {
    const xr = navigator.xr;
    if (!xr) return { vr: false, ar: false };
    const [vr, ar] = await Promise.all([
      xr.isSessionSupported('immersive-vr').catch(() => false),
      xr.isSessionSupported('immersive-ar').catch(() => false),
    ]);
    return { vr, ar };
  }

  async enterXR(mode = 'immersive-vr') {
    if (this.renderer.xr.isPresenting) {
      await this.renderer.xr.getSession().end();
      return;
    }
    const session = await navigator.xr.requestSession(mode, {
      optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'],
    });
    this.xrMode = mode;
    await this.renderer.xr.setSession(session);
  }
}
