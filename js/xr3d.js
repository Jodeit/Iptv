// XR3D: turns a flat 2D video into stereoscopic 3D in real time.
//
// 1. Depth estimation: each vertex of a dense screen mesh estimates scene depth from
//    the video frame with monocular cues: brightness, saturation, the "lower in frame is
//    nearer" ground-plane prior and a centre bias. The result is blurred with a Gaussian kernel.
// 2. Relief: vertices are displaced toward the viewer by that depth, so the screen is
//    real 3D geometry that shows motion parallax when you move your head.
// 3. Stereo pop: each eye gets its own mesh (WebXR layers 1/2), and the fragment
//    shader shifts the image horizontally by depth relative to the convergence plane,
//    which creates binocular disparity on top of the geometric relief.
//
// Native SBS/TAB 3D sources are handled by sampling the correct half per eye.

import * as THREE from 'three';

export const LAYOUT = { mono: 0, sbs: 1, tab: 2 };
export const EYE = { mono: 0, left: -1, right: 1 };

const vertexShader = /* glsl */`
  uniform sampler2D uMap;
  uniform int uLayout;
  uniform float uDepthOn;
  uniform float uRelief;
  uniform float uContrast;
  uniform float uBlur;
  uniform float uInvert;
  uniform float uWidth;
  uniform float uHeight;
  uniform float uCurve;

  varying vec2 vUv;
  varying float vDepth;

  // Depth is always estimated from the left/mono view so both eyes agree.
  vec2 baseUV(vec2 uv) {
    if (uLayout == 1) return vec2(uv.x * 0.5, uv.y);
    if (uLayout == 2) return vec2(uv.x, uv.y * 0.5 + 0.5);
    return uv;
  }

  float cue(vec3 c) {
    float l = dot(c, vec3(0.299, 0.587, 0.114));
    float mx = max(c.r, max(c.g, c.b));
    float mn = min(c.r, min(c.g, c.b));
    float sat = mx > 0.0 ? (mx - mn) / mx : 0.0;
    return 0.65 * l + 0.35 * sat;
  }

  float estimateDepth(vec2 uv) {
    float acc = 0.0;
    float wsum = 0.0;
    for (int i = -2; i <= 2; i++) {
      for (int j = -2; j <= 2; j++) {
        vec2 o = vec2(float(i), float(j)) * uBlur;
        float w = exp(-float(i * i + j * j) / 4.0);
        acc += w * cue(texture2D(uMap, baseUV(clamp(uv + o, 0.001, 0.999))).rgb);
        wsum += w;
      }
    }
    float d = acc / wsum;
    float ground = 1.0 - uv.y;
    float centre = 1.0 - clamp(length((uv - 0.5) * vec2(1.0, 1.4)), 0.0, 1.0);
    d = mix(d, 0.55 * ground + 0.45 * centre, 0.4);
    if (uInvert > 0.5) d = 1.0 - d;
    return clamp((d - 0.5) * uContrast + 0.5, 0.0, 1.0);
  }

  void main() {
    vUv = uv;
    float d = uDepthOn > 0.5 ? estimateDepth(uv) : 0.5;
    vDepth = d;

    float x = (uv.x - 0.5) * uWidth;
    float y = (uv.y - 0.5) * uHeight;
    float z = (d - 0.5) * uRelief * uHeight * uDepthOn;

    vec3 p = vec3(x, y, z);
    if (uCurve > 0.001) {
      // Wrap around a cylinder centred on the viewer; up to 120 degrees of arc.
      float R = uWidth / (uCurve * 2.0944);
      float a = x / R;
      float r = R - z;
      p = vec3(r * sin(a), y, R - r * cos(a));
    }
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const fragmentShader = /* glsl */`
  uniform sampler2D uMap;
  uniform int uLayout;
  uniform float uEye;
  uniform float uSwap;
  uniform float uDepthOn;
  uniform float uParallax;
  uniform float uConvergence;
  uniform float uBrightness;
  uniform float uShowDepth;

  varying vec2 vUv;
  varying float vDepth;

  vec2 eyeUV(vec2 uv, float eye) {
    float e = uSwap > 0.5 ? -eye : eye;
    if (uLayout == 1) return vec2(uv.x * 0.5 + (e > 0.5 ? 0.5 : 0.0), uv.y);
    if (uLayout == 2) return vec2(uv.x, uv.y * 0.5 + (e > 0.5 ? 0.0 : 0.5));
    return uv;
  }

  void main() {
    if (uShowDepth > 0.5) {
      gl_FragColor = vec4(vec3(vDepth), 1.0);
      return;
    }
    vec2 uv = vUv;
    // Crossed disparity: near content moves right in the left eye and left in the right eye.
    float eye = uSwap > 0.5 ? -uEye : uEye;
    uv.x += eye * uParallax * 0.012 * (vDepth - uConvergence) * uDepthOn;

    vec3 col = texture2D(uMap, eyeUV(clamp(uv, 0.0, 1.0), uEye)).rgb * uBrightness;

    // Soft fade at the very edge hides the stretched pixels the shift drags in.
    vec2 e = smoothstep(0.0, 0.006, vUv) * smoothstep(0.0, 0.006, 1.0 - vUv);
    gl_FragColor = vec4(col * e.x * e.y, 1.0);
    #include <colorspace_fragment>
  }
`;

// One mesh per view: mono (layer 0, desktop), left eye (layer 1), right eye (layer 2).
// The eyes share every uniform except uEye.
export class XR3DScreen {
  constructor(texture) {
    this.group = new THREE.Group();
    this.shared = {
      uMap: { value: texture },
      uLayout: { value: LAYOUT.mono },
      uDepthOn: { value: 1 },
      uRelief: { value: 0.18 },
      uContrast: { value: 1.4 },
      uBlur: { value: 0.006 },
      uInvert: { value: 0 },
      uWidth: { value: 6 },
      uHeight: { value: 6 * 9 / 16 },
      uCurve: { value: 0.15 },
      uSwap: { value: 0 },
      uParallax: { value: 0.8 },
      uConvergence: { value: 0.5 },
      uBrightness: { value: 1 },
      uShowDepth: { value: 0 },
    };

    // Dense grid so per-vertex depth has enough resolution; 192x108 = ~21k verts.
    const geometry = new THREE.PlaneGeometry(1, 1, 192, 108);
    const make = (eye, layer) => {
      const material = new THREE.ShaderMaterial({
        uniforms: { ...this.shared, uEye: { value: eye } },
        vertexShader,
        fragmentShader,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.layers.set(layer);
      mesh.frustumCulled = false; // vertices move in the shader
      this.group.add(mesh);
      return mesh;
    };
    this.mono = make(EYE.mono, 0);
    this.left = make(EYE.left, 1);
    this.right = make(EYE.right, 2);
    this.setStereo(false);
  }

  // When stereo is on, the mono mesh hides so per-eye cameras see only their own mesh.
  setStereo(on) {
    this.mono.visible = !on;
    this.left.visible = on;
    this.right.visible = on;
  }

  set(name, value) { this.shared[name].value = value; }
  get(name) { return this.shared[name].value; }

  setSize(width, aspect) {
    this.shared.uWidth.value = width;
    this.shared.uHeight.value = width / aspect;
  }
}
