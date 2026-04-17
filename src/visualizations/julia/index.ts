import * as THREE from 'three';
import type { AudioFrame } from '../../audio/types';
import type {
  MountedViz,
  ParamValues,
  VisualizationPlugin,
  VisualizerContext,
} from '../types';
import { PALETTES, PALETTE_NAMES } from '../common/palettes';
import { BandSmoother, BeatEnvelope } from '../common/reactive';

/**
 * Audio-reactive Julia set fractal.
 *
 * The shader iterates z = z² + c on a fullscreen quad. The "c" constant
 * wanders slowly through complex space (Lissajous drift), and audio bands
 * push it sideways — bass nudges the real axis, mid the imaginary, treble
 * adds high-frequency wobble. Beats trigger a momentary palette shift.
 *
 * Color cycling is independent of audio so the scene breathes even at
 * silence — true new-age psychedelia: continuous morphing, vivid palette,
 * organic boundaries.
 */
class JuliaMounted implements MountedViz {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly material: THREE.ShaderMaterial;
  private readonly mesh: THREE.Mesh;
  private readonly container: HTMLElement;

  // Param mirrors
  private paletteName = 'neon';
  private zoom = 1;
  private iterations = 120;
  private morphSpeed = 1;
  private bassDrive = 1;
  private trebleDrive = 1;
  private colorCycle = 1;
  private warp = 0.4;
  private sensitivity = 1;

  // Smoothers — fractal morphology should never feel jittery
  private readonly bassSmooth = new BandSmoother(0.3, 0.08);
  private readonly midSmooth = new BandSmoother(0.35, 0.1);
  private readonly trebleSmooth = new BandSmoother(0.45, 0.12);
  private readonly beatEnv = new BeatEnvelope(2.5);

  private t = 0;
  private hueCursor = 0;

  constructor(_ctx: VisualizerContext, container: HTMLElement) {
    this.container = container;
    const rect = container.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);

    this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height);
    container.appendChild(this.renderer.domElement);

    // Build palette uniform values from the active palette
    const initialPalette = paletteVecs(this.paletteName);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uC: { value: new THREE.Vector2(0, 0) },
        uZoom: { value: 1 },
        uOffset: { value: new THREE.Vector2(0, 0) },
        uIter: { value: 120 },
        uColorShift: { value: 0 },
        uBeat: { value: 0 },
        uWarp: { value: 0 },
        uTime: { value: 0 },
        uPalette0: { value: initialPalette[0] },
        uPalette1: { value: initialPalette[1] },
        uPalette2: { value: initialPalette[2] },
        uPalette3: { value: initialPalette[3] },
        uAspect: { value: width / height },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
    });

    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.scene.add(this.mesh);
  }

  setParams(p: ParamValues): void {
    const nextPalette = String(p.palette ?? 'neon');
    if (nextPalette !== this.paletteName) {
      this.paletteName = nextPalette;
      const vecs = paletteVecs(this.paletteName);
      this.material.uniforms.uPalette0.value = vecs[0];
      this.material.uniforms.uPalette1.value = vecs[1];
      this.material.uniforms.uPalette2.value = vecs[2];
      this.material.uniforms.uPalette3.value = vecs[3];
    }

    this.zoom = clampNum(p.zoom, 0.3, 4, 1);
    this.iterations = clampInt(p.iterations, 32, 256, 120);
    this.morphSpeed = clampNum(p.morphSpeed, 0.1, 3, 1);
    this.bassDrive = clampNum(p.bassDrive, 0, 2, 1);
    this.trebleDrive = clampNum(p.trebleDrive, 0, 2, 1);
    this.colorCycle = clampNum(p.colorCycle, 0, 3, 1);
    this.warp = clampNum(p.warp, 0, 1.5, 0.4);
    this.sensitivity = clampNum(p.sensitivity, 0.3, 3, 1);

    this.material.uniforms.uIter.value = this.iterations;
    this.material.uniforms.uZoom.value = this.zoom;
  }

  resize(w: number, h: number): void {
    this.renderer.setSize(w, h);
    this.material.uniforms.uAspect.value = w / h;
  }

  render(frame: AudioFrame, _params: ParamValues, dt: number): void {
    const s = this.sensitivity;
    const bass = this.bassSmooth.update(Math.min(1, frame.bass * s));
    const mid = this.midSmooth.update(Math.min(1, frame.mid * s));
    const treble = this.trebleSmooth.update(Math.min(1, frame.treble * s));
    const beatPulse = this.beatEnv.update(frame.beat, dt);

    this.t += dt * this.morphSpeed;

    // C parameter: a slow Lissajous drift (always-on baseline) plus audio
    // pushes. Range stays inside the "interesting" Julia zone (|c| ~< 0.8).
    // The base curve uses irrational ratios so the fractal never repeats.
    const baseCx = 0.36 * Math.sin(this.t * 0.07);
    const baseCy = 0.38 * Math.cos(this.t * 0.053);
    const cx =
      baseCx +
      bass * 0.18 * this.bassDrive +
      treble * 0.06 * this.trebleDrive * Math.sin(this.t * 4.7);
    const cy =
      baseCy +
      mid * 0.16 * this.bassDrive +
      treble * 0.06 * this.trebleDrive * Math.cos(this.t * 5.3);
    this.material.uniforms.uC.value.set(cx, cy);

    // Color cursor advances continuously, faster on treble. Beat adds a
    // momentary palette shift that decays naturally.
    this.hueCursor += dt * this.colorCycle * (0.06 + treble * 0.4);
    this.material.uniforms.uColorShift.value =
      this.hueCursor + beatPulse * 0.18;

    // Domain warp — bends the UV slightly, gives the boundary that
    // "swimming" liquid feel
    this.material.uniforms.uWarp.value = this.warp * (0.4 + bass * 0.6);
    this.material.uniforms.uBeat.value = beatPulse;
    this.material.uniforms.uTime.value = this.t;

    this.renderer.render(this.scene, this.camera);
  }

  destroy(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
    this.renderer.dispose();
  }
}

/** Convert a palette name to four THREE.Vector3 RGB values for the shader. */
function paletteVecs(name: string): THREE.Vector3[] {
  const palette = PALETTES[name] ?? PALETTES.neon;
  // We always pass exactly four colors; sample evenly if palette has more
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < 4; i++) {
    const c = palette[i % palette.length];
    out.push(new THREE.Vector3(c.r, c.g, c.b));
  }
  return out;
}

function clampNum(raw: unknown, min: number, max: number, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  return Math.round(clampNum(raw, min, max, fallback));
}

const VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position, 1.0);
  }
`;

// `uIter` cannot be a runtime loop bound in WebGL1; we cap at 256 iterations
// in the shader and use uIter as an early-exit threshold.
const FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform vec2 uC;
  uniform float uZoom;
  uniform vec2 uOffset;
  uniform float uIter;
  uniform float uColorShift;
  uniform float uBeat;
  uniform float uWarp;
  uniform float uTime;
  uniform float uAspect;
  uniform vec3 uPalette0;
  uniform vec3 uPalette1;
  uniform vec3 uPalette2;
  uniform vec3 uPalette3;

  vec3 samplePalette(float t) {
    t = fract(t) * 4.0;
    int i = int(t);
    float f = t - float(i);
    if (i == 0) return mix(uPalette0, uPalette1, f);
    if (i == 1) return mix(uPalette1, uPalette2, f);
    if (i == 2) return mix(uPalette2, uPalette3, f);
    return mix(uPalette3, uPalette0, f);
  }

  void main() {
    // Map UV to complex plane, account for aspect ratio
    vec2 uv = (vUv - 0.5) * 2.0;
    uv.x *= uAspect;
    uv = uv / uZoom + uOffset;

    // Domain warp — small swirling perturbation. Strength = uWarp.
    if (uWarp > 0.001) {
      float s = sin(uTime * 0.3 + uv.y * 2.0);
      float c = cos(uTime * 0.27 + uv.x * 2.0);
      uv += vec2(s, c) * uWarp * 0.06;
    }

    vec2 z = uv;
    float i = 0.0;
    float escaped = 0.0;
    // Hard cap at 256; uIter controls effective iteration via early exit
    for (int n = 0; n < 256; n++) {
      if (float(n) >= uIter) break;
      z = vec2(z.x*z.x - z.y*z.y, 2.0*z.x*z.y) + uC;
      if (dot(z, z) > 16.0) {
        escaped = 1.0;
        break;
      }
      i += 1.0;
    }

    vec3 col;
    if (escaped < 0.5) {
      // Inside the set — let it dissolve slightly toward palette[0] on beats
      // so even the "interior" feels alive
      col = mix(vec3(0.0), uPalette0 * 0.3, uBeat * 0.6);
    } else {
      // Smooth iteration count for continuous coloring
      float smoothI = i - log2(log2(dot(z, z))) + 4.0;
      float t = smoothI * 0.04 + uColorShift;
      col = samplePalette(t);
      // Add a subtle banding pulse that breathes with the beat
      col *= 0.8 + 0.4 * sin(smoothI * 0.6 + uTime * 0.5) + uBeat * 0.2;
    }

    gl_FragColor = vec4(col, 1.0);
  }
`;

export const juliaPlugin: VisualizationPlugin = {
  id: 'julia',
  name: 'Julia Fractal',
  description:
    'Animated Julia-set fractal — morphs and breathes with the music. New-age psychedelia.',
  params: {
    palette: {
      type: 'select',
      label: 'Palette',
      options: PALETTE_NAMES,
      default: 'neon',
    },
    zoom: {
      type: 'number',
      label: 'Zoom',
      min: 0.3,
      max: 4,
      step: 0.05,
      default: 1,
    },
    iterations: {
      type: 'number',
      label: 'Detail (iterations)',
      min: 32,
      max: 256,
      step: 8,
      default: 120,
    },
    morphSpeed: {
      type: 'number',
      label: 'Morph speed',
      min: 0.1,
      max: 3,
      step: 0.05,
      default: 1,
    },
    bassDrive: {
      type: 'number',
      label: 'Bass drive',
      min: 0,
      max: 2,
      step: 0.05,
      default: 1,
    },
    trebleDrive: {
      type: 'number',
      label: 'Treble wobble',
      min: 0,
      max: 2,
      step: 0.05,
      default: 1,
    },
    colorCycle: {
      type: 'number',
      label: 'Color cycle speed',
      min: 0,
      max: 3,
      step: 0.05,
      default: 1,
    },
    warp: {
      type: 'number',
      label: 'Domain warp',
      min: 0,
      max: 1.5,
      step: 0.05,
      default: 0.4,
    },
    sensitivity: {
      type: 'number',
      label: 'Sensitivity',
      min: 0.3,
      max: 3,
      step: 0.05,
      default: 1,
    },
  },
  mount(container, ctx) {
    return new JuliaMounted(ctx, container);
  },
};

export default juliaPlugin;
