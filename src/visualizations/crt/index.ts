import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import type { AudioFrame } from '../../audio/types';
import type {
  MountedViz,
  ParamValues,
  VisualizationPlugin,
  VisualizerContext,
} from '../types';
import { PALETTE_NAMES, samplePalette } from '../common/palettes';
import { createThreeScaffold, type ThreeScaffold } from '../common/three-scaffold';
import { BeatEnvelope } from '../common/reactive';

const ARRANGEMENTS = ['linear', 'mirrored', 'circular'] as const;
type Arrangement = (typeof ARRANGEMENTS)[number];

const COLOR_MODES = ['palette', 'green-phosphor', 'amber', 'rgb-ruin'] as const;
type ColorMode = (typeof COLOR_MODES)[number];

const BASE_BAR_COUNT = 64;

/**
 * Custom post-processing pass combining the full CRT look in a single shader:
 * barrel curvature → chromatic aberration → scanlines → noise → vignette.
 * One pass is cheaper than chaining four, and it lets us animate the noise
 * seed via `uTime` without a separate FilmPass.
 */
function makeCrtShader() {
  return {
    uniforms: {
      tDiffuse: { value: null as THREE.Texture | null },
      uAberration: { value: 0.003 },
      uVignette: { value: 0.6 },
      uCurvature: { value: 0.06 },
      uScanlines: { value: 0.6 },
      uNoise: { value: 0.2 },
      uTime: { value: 0 },
      uResolution: { value: new THREE.Vector2(1, 1) },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      uniform sampler2D tDiffuse;
      uniform float uAberration;
      uniform float uVignette;
      uniform float uCurvature;
      uniform float uScanlines;
      uniform float uNoise;
      uniform float uTime;
      uniform vec2 uResolution;

      // Cheap, deterministic pseudo-random hash
      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
      }

      // Barrel-distort uv about the center
      vec2 curve(vec2 uv) {
        vec2 c = uv - 0.5;
        float r2 = dot(c, c);
        c *= 1.0 + uCurvature * r2;
        return c + 0.5;
      }

      void main() {
        vec2 uv = curve(vUv);
        if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
          gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
          return;
        }

        // Chromatic aberration
        vec2 dir = uv - 0.5;
        float r = texture2D(tDiffuse, uv - dir * uAberration).r;
        float g = texture2D(tDiffuse, uv).g;
        float b = texture2D(tDiffuse, uv + dir * uAberration).b;
        vec3 col = vec3(r, g, b);

        // Horizontal scanlines — modulate by uScanlines strength
        float scan = sin(uv.y * uResolution.y * 1.2) * 0.5 + 0.5;
        col *= mix(1.0, scan, uScanlines);

        // Animated noise
        float n = hash(uv * uResolution + uTime * 37.1);
        col += (n - 0.5) * uNoise;

        // Vignette
        float v = smoothstep(0.9, 0.2, length(dir) * 1.4);
        col *= mix(1.0 - uVignette, 1.0, v);

        gl_FragColor = vec4(col, 1.0);
      }
    `,
  };
}

class CrtMounted implements MountedViz {
  private readonly scaffold: ThreeScaffold;
  private readonly composer: EffectComposer;
  private readonly crtPass: ShaderPass;

  private bars!: THREE.InstancedMesh;
  private barCount = BASE_BAR_COUNT;
  private arrangement: Arrangement = 'mirrored';
  private colorMode: ColorMode = 'palette';
  private paletteName = 'neon';
  private sensitivity = 1;
  private smoothing = 0.7;

  private smoothed: Float32Array = new Float32Array(BASE_BAR_COUNT);
  // Beat envelope decays over ~400ms so a hit sustains visibly across
  // several frames rather than snapping on/off in a single frame.
  private readonly beatEnv = new BeatEnvelope(2.5);
  private readonly scratchMatrix = new THREE.Matrix4();
  private readonly scratchColor = new THREE.Color();
  private readonly scratchPosition = new THREE.Vector3();
  private readonly scratchScale = new THREE.Vector3();
  private readonly scratchQuat = new THREE.Quaternion();
  private hueCursor = 0;

  constructor(_ctx: VisualizerContext, container: HTMLElement) {
    this.scaffold = createThreeScaffold(container, {
      fov: 50,
      cameraZ: 12,
      clearColor: 0x000000,
    });

    // Orthographic-ish feel for a flat bar graph; keep perspective but look
    // straight at origin
    this.scaffold.camera.position.set(0, 0, 12);
    this.scaffold.camera.lookAt(0, 0, 0);

    this.composer = new EffectComposer(this.scaffold.renderer);
    this.composer.addPass(new RenderPass(this.scaffold.scene, this.scaffold.camera));

    this.crtPass = new ShaderPass(makeCrtShader());
    this.crtPass.uniforms.uResolution.value.set(
      this.scaffold.width,
      this.scaffold.height,
    );
    this.composer.addPass(this.crtPass);

    this.buildBars();
  }

  setParams(p: ParamValues): void {
    const nextCount = clampInt(p.bars, 16, 256, BASE_BAR_COUNT);
    const nextArrangement =
      (ARRANGEMENTS as readonly string[]).includes(String(p.arrangement))
        ? (p.arrangement as Arrangement)
        : 'mirrored';
    const nextColorMode =
      (COLOR_MODES as readonly string[]).includes(String(p.colorMode))
        ? (p.colorMode as ColorMode)
        : 'palette';

    this.paletteName = String(p.palette ?? 'neon');
    this.sensitivity = clampNum(p.sensitivity, 0.2, 3, 1);
    this.smoothing = clampNum(p.smoothing, 0, 0.95, 0.7);
    this.crtPass.uniforms.uScanlines.value = clampNum(p.scanlines, 0, 1.5, 0.6);
    this.crtPass.uniforms.uNoise.value = clampNum(p.noise, 0, 1, 0.2);
    this.crtPass.uniforms.uAberration.value = clampNum(p.aberration, 0, 0.02, 0.003);
    this.crtPass.uniforms.uVignette.value = clampNum(p.vignette, 0, 1, 0.6);
    this.crtPass.uniforms.uCurvature.value = clampNum(p.curvature, 0, 0.3, 0.06);

    const structureChanged =
      nextCount !== this.barCount ||
      nextArrangement !== this.arrangement ||
      nextColorMode !== this.colorMode;
    if (structureChanged) {
      this.barCount = nextCount;
      this.arrangement = nextArrangement;
      this.colorMode = nextColorMode;
      this.rebuildBars();
    }
  }

  resize(w: number, h: number): void {
    this.scaffold.resize(w, h);
    this.composer.setSize(w, h);
    this.crtPass.uniforms.uResolution.value.set(w, h);
  }

  render(frame: AudioFrame, _params: ParamValues, dt: number): void {
    const s = this.sensitivity;
    this.hueCursor += dt * (0.04 + Math.min(1, frame.treble * s) * 0.3);
    this.crtPass.uniforms.uTime.value += dt;

    // Bucket the FFT into barCount buckets, then run an asymmetric envelope
    // follower per bin: fast attack (catches transients like hi-hats and
    // cymbals as visible spikes) and slow release (decays naturally so it
    // doesn't pop). Attack speed varies across the spectrum — high bins are
    // even snappier than low bins, so cymbal hits look like crisp pops while
    // bass throbs gently.
    const fft = frame.fft;
    const buckets = this.barCount;
    const stride = Math.floor(fft.length / buckets);
    const release = this.smoothing; // user-tunable release "stickiness"
    for (let b = 0; b < buckets; b++) {
      const start = b * stride;
      let sum = 0;
      for (let k = 0; k < stride; k++) sum += fft[start + k];
      const raw = (sum / stride / 255) * s;

      // Frequency-dependent attack: 0.45 (slowish, throbby) at the lowest
      // bins → 0.05 (snappy) at the highest. Lower number = faster response.
      const attack = 0.45 - 0.4 * (b / Math.max(1, buckets - 1));
      const factor = raw > this.smoothed[b] ? attack : release;
      this.smoothed[b] = this.smoothed[b] * factor + raw * (1 - factor);
    }

    // Apply bar transforms and colors
    const halfW = this.scaffold.width / this.scaffold.height * 7; // scene half-width
    const barWorldWidth = (halfW * 2) / buckets;
    // Beat envelope no longer drives bar height (which created the "whole
    // graph bounces together" feel). It now drives an overall color brighten
    // — so the spectrum detail comes from the FFT, the rhythm cue comes
    // from the color pulse.
    const beatPulse = this.beatEnv.update(frame.beat, dt);
    const colorBoost = 0.7 + beatPulse * 0.6;

    // In mirrored mode each bin is displayed twice (once on each side of
    // center). Bar positions are already symmetric around x=0; we just need
    // the *data* to reflect too. Distance-from-edge = min(i, n-1-i) maps
    // bars 0 and n-1 to FFT bin 0 (deep bass), and center bars to the
    // highest used bin → classic Winamp-bar "bass at both edges" feel.
    const mirrored = this.arrangement === 'mirrored';
    const effectiveN = mirrored ? Math.ceil(buckets / 2) : buckets;

    for (let i = 0; i < buckets; i++) {
      const sourceIdx = mirrored ? Math.min(i, buckets - 1 - i) : i;
      // Pure FFT-driven height — beats no longer add a uniform boost, so
      // individual transient bins (hi-hats, snares) read as distinct spikes
      const val = Math.max(0.02, this.smoothed[sourceIdx]);
      const { x, y, rotZ } = this.barLayout(i, buckets, halfW, val);
      const height = 0.08 + val * 6;

      this.scratchPosition.set(x, y, 0);
      this.scratchScale.set(barWorldWidth * 0.75, height, 1);
      this.scratchQuat.setFromAxisAngle(new THREE.Vector3(0, 0, 1), rotZ);
      this.scratchMatrix.compose(
        this.scratchPosition,
        this.scratchQuat,
        this.scratchScale,
      );
      this.bars.setMatrixAt(i, this.scratchMatrix);

      // Color also uses sourceIdx + effectiveN so symmetric bars share a
      // hue (palette cycles fully across each half instead of halfway
      // across the whole mirror)
      this.colorForBar(sourceIdx, effectiveN, val, this.scratchColor);
      // Beat envelope brightens entire spectrum without changing heights —
      // visible rhythm cue without homogenizing the spectrum
      this.scratchColor.multiplyScalar(colorBoost);
      this.bars.setColorAt(i, this.scratchColor);
    }
    this.bars.instanceMatrix.needsUpdate = true;
    if (this.bars.instanceColor) this.bars.instanceColor.needsUpdate = true;

    this.composer.render();
  }

  destroy(): void {
    this.disposeBars();
    this.composer.dispose();
    this.scaffold.destroy();
  }

  // --- internals ---

  private buildBars(): void {
    const geometry = new THREE.PlaneGeometry(1, 1);
    const material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: false,
      toneMapped: false,
    });
    this.bars = new THREE.InstancedMesh(geometry, material, this.barCount);
    // Initialize per-instance colors
    const init = new THREE.Color(1, 1, 1);
    for (let i = 0; i < this.barCount; i++) this.bars.setColorAt(i, init);
    this.scaffold.scene.add(this.bars);
    this.smoothed = new Float32Array(this.barCount);
  }

  private rebuildBars(): void {
    this.disposeBars();
    this.buildBars();
  }

  private disposeBars(): void {
    if (!this.bars) return;
    this.scaffold.scene.remove(this.bars);
    this.bars.geometry.dispose();
    (this.bars.material as THREE.Material).dispose();
    this.bars.dispose();
  }

  /** Per-bar (x,y,rotation) based on arrangement. */
  private barLayout(
    i: number,
    n: number,
    halfW: number,
    _val: number,
  ): { x: number; y: number; rotZ: number } {
    if (this.arrangement === 'linear') {
      const x = -halfW + ((i + 0.5) / n) * (halfW * 2);
      return { x, y: 0, rotZ: 0 };
    }
    if (this.arrangement === 'mirrored') {
      // Symmetric: center → edges
      const half = n / 2;
      const slot = i < half ? half - i - 1 : i - half;
      const side = i < half ? -1 : 1;
      const x = side * ((slot + 0.5) / half) * halfW;
      return { x, y: 0, rotZ: 0 };
    }
    // circular: arrange around a ring, bars pointing outward
    const angle = (i / n) * Math.PI * 2;
    const r = Math.min(halfW, 6);
    return {
      x: Math.cos(angle) * r,
      y: Math.sin(angle) * r,
      rotZ: angle - Math.PI / 2,
    };
  }

  /** Pick color for bar i given its value. */
  private colorForBar(i: number, n: number, val: number, out: THREE.Color): void {
    switch (this.colorMode) {
      case 'green-phosphor':
        out.setRGB(0.1 + val * 0.4, 0.4 + val * 0.9, 0.1 + val * 0.3);
        return;
      case 'amber':
        out.setRGB(0.6 + val * 0.9, 0.3 + val * 0.5, 0.05);
        return;
      case 'rgb-ruin': {
        // Crude RGB split per bar — every third bar gets a different channel
        const hueShift = (i / n + this.hueCursor * 0.4) % 1;
        out.setHSL(hueShift, 1, Math.min(0.55, 0.15 + val * 0.6));
        return;
      }
      case 'palette':
      default:
        samplePalette(this.paletteName, this.hueCursor + i / n, out);
        // Intensify with value so taller bars pop
        out.multiplyScalar(0.5 + val * 1.2);
        return;
    }
  }
}

function clampNum(raw: unknown, min: number, max: number, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  return Math.round(clampNum(raw, min, max, fallback));
}

export const crtPlugin: VisualizationPlugin = {
  id: 'crt',
  name: 'CRT',
  description:
    'FFT bars run through a retro CRT filter — scanlines, aberration, vignette, curvature.',
  params: {
    palette: {
      type: 'select',
      label: 'Palette',
      options: PALETTE_NAMES,
      default: 'neon',
    },
    colorMode: {
      type: 'select',
      label: 'Color mode',
      options: COLOR_MODES,
      default: 'palette',
    },
    arrangement: {
      type: 'select',
      label: 'Arrangement',
      options: ARRANGEMENTS,
      default: 'mirrored',
    },
    bars: {
      type: 'number',
      label: 'Bars',
      min: 16,
      max: 256,
      step: 1,
      default: BASE_BAR_COUNT,
    },
    smoothing: {
      type: 'number',
      label: 'Release time',
      min: 0,
      max: 0.95,
      step: 0.05,
      default: 0.65,
    },
    sensitivity: {
      type: 'number',
      label: 'Sensitivity',
      min: 0.2,
      max: 3,
      step: 0.05,
      default: 1,
    },
    scanlines: {
      type: 'number',
      label: 'Scanlines',
      min: 0,
      max: 1.5,
      step: 0.05,
      default: 0.6,
    },
    noise: {
      type: 'number',
      label: 'Noise',
      min: 0,
      max: 1,
      step: 0.05,
      default: 0.2,
    },
    aberration: {
      type: 'number',
      label: 'Aberration',
      min: 0,
      max: 0.02,
      step: 0.001,
      default: 0.003,
    },
    vignette: {
      type: 'number',
      label: 'Vignette',
      min: 0,
      max: 1,
      step: 0.05,
      default: 0.6,
    },
    curvature: {
      type: 'number',
      label: 'Curvature',
      min: 0,
      max: 0.3,
      step: 0.01,
      default: 0.06,
    },
  },
  mount(container, ctx) {
    return new CrtMounted(ctx, container);
  },
};

export default crtPlugin;
