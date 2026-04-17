import * as THREE from 'three';
import type { AudioFrame } from '../../audio/types';
import type { MountedViz, ParamValues, VisualizerContext } from '../types';
import { PALETTES } from './palettes';
import { BandSmoother, BeatEnvelope } from './reactive';

/**
 * Shared base for fullscreen-quad fractal plugins.
 *
 * Handles the Three.js boilerplate, common uniforms, audio smoothers,
 * and the resize / destroy lifecycle. Subclasses only provide:
 *   - a fragment shader
 *   - (optional) extra uniforms
 *   - (optional) extra params in `setParams`
 *   - a `render()` method that calls `this.updateCommon(frame, dt)` to
 *     advance the shared state and then writes any plugin-specific
 *     uniforms before `this.renderer.render(...)`.
 *
 * The Julia plugin predates this base and is intentionally not
 * migrated — it works, and the refactor would risk regression without
 * real payoff since it's just one plugin. The three fractals introduced
 * later (Mandelbrot, Burning Ship, Newton) all share this base.
 */
export interface FractalBaseOptions {
  fragmentShader: string;
  /** Uniforms beyond the common set below. Names should start with `u_` or `u`. */
  extraUniforms?: Record<string, THREE.IUniform>;
}

export abstract class FractalBase implements MountedViz {
  protected readonly renderer: THREE.WebGLRenderer;
  protected readonly scene = new THREE.Scene();
  protected readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  protected readonly material: THREE.ShaderMaterial;
  protected readonly mesh: THREE.Mesh;

  // Common tunable params. Subclasses are free to extend with their own.
  protected paletteName = 'neon';
  protected zoom = 1;
  protected iterations = 120;
  protected morphSpeed = 1;
  protected sensitivity = 1;
  protected warp = 0.3;
  protected colorCycle = 1;

  // Audio smoothers — fractals look terrible when they jitter.
  protected readonly bassSmooth = new BandSmoother(0.3, 0.08);
  protected readonly midSmooth = new BandSmoother(0.35, 0.1);
  protected readonly trebleSmooth = new BandSmoother(0.45, 0.12);
  protected readonly beatEnv = new BeatEnvelope(2.5);

  /** Global time, advanced by dt × morphSpeed each frame. */
  protected t = 0;
  /** Palette scroll position. Advances continuously + treble bursts. */
  protected hueCursor = 0;

  constructor(
    protected readonly container: HTMLElement,
    _ctx: VisualizerContext,
    opts: FractalBaseOptions,
  ) {
    const rect = container.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);

    this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    container.appendChild(this.renderer.domElement);

    const pal = paletteVecs(this.paletteName);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uZoom: { value: 1 },
        uOffset: { value: new THREE.Vector2(0, 0) },
        uIter: { value: this.iterations },
        uColorShift: { value: 0 },
        uBeat: { value: 0 },
        uWarp: { value: 0 },
        uTime: { value: 0 },
        uPalette0: { value: pal[0] },
        uPalette1: { value: pal[1] },
        uPalette2: { value: pal[2] },
        uPalette3: { value: pal[3] },
        uAspect: { value: w / h },
        ...(opts.extraUniforms ?? {}),
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: opts.fragmentShader,
    });

    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.scene.add(this.mesh);
  }

  /**
   * Set common params. Subclasses should call `super.setParams(p)` then
   * read their own extra params from `p`.
   */
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

    this.zoom = clampNum(p.zoom, 0.3, 8, 1);
    this.iterations = clampInt(p.iterations, 32, 256, 120);
    this.morphSpeed = clampNum(p.morphSpeed, 0.1, 3, 1);
    this.sensitivity = clampNum(p.sensitivity, 0.3, 3, 1);
    this.warp = clampNum(p.warp, 0, 1.5, 0.3);
    this.colorCycle = clampNum(p.colorCycle, 0, 3, 1);

    this.material.uniforms.uIter.value = this.iterations;
    this.material.uniforms.uZoom.value = this.zoom;
  }

  resize(w: number, h: number): void {
    this.renderer.setSize(w, h);
    this.material.uniforms.uAspect.value = w / h;
  }

  /**
   * Advance common time/smoother state and write uBeat / uTime /
   * uColorShift / uWarp. Returns the smoothed band values so subclasses
   * can read them for plugin-specific uniforms.
   */
  protected updateCommon(frame: AudioFrame, dt: number): {
    bass: number;
    mid: number;
    treble: number;
    beatPulse: number;
  } {
    const s = this.sensitivity;
    const bass = this.bassSmooth.update(Math.min(1, frame.bass * s));
    const mid = this.midSmooth.update(Math.min(1, frame.mid * s));
    const treble = this.trebleSmooth.update(Math.min(1, frame.treble * s));
    const beatPulse = this.beatEnv.update(frame.beat, dt);

    this.t += dt * this.morphSpeed;
    this.hueCursor += dt * this.colorCycle * (0.06 + treble * 0.4);

    this.material.uniforms.uColorShift.value =
      this.hueCursor + beatPulse * 0.18;
    this.material.uniforms.uBeat.value = beatPulse;
    this.material.uniforms.uTime.value = this.t;
    this.material.uniforms.uWarp.value = this.warp * (0.4 + bass * 0.6);

    return { bass, mid, treble, beatPulse };
  }

  abstract render(
    frame: AudioFrame,
    params: ParamValues,
    dt: number,
  ): void;

  destroy(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
    this.renderer.dispose();
  }
}

// --- Shared helpers ----------------------------------------------------------

export function paletteVecs(name: string): THREE.Vector3[] {
  const palette = PALETTES[name] ?? PALETTES.neon;
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < 4; i++) {
    const c = palette[i % palette.length];
    out.push(new THREE.Vector3(c.r, c.g, c.b));
  }
  return out;
}

export function clampNum(
  raw: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function clampInt(
  raw: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  return Math.round(clampNum(raw, min, max, fallback));
}

// --- Shared GLSL -------------------------------------------------------------

export const VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position, 1.0);
  }
`;

/**
 * Palette sampler to be interpolated into fragment shaders. Declares the
 * four palette uniforms and a `samplePalette(float t)` helper that
 * smoothly interpolates between them cyclically.
 */
export const PALETTE_SAMPLER_GLSL = /* glsl */ `
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
`;

/**
 * Common "header" uniforms block for fragment shaders. Keeps declarations
 * consistent across plugins. Follow with your own uniform declarations
 * and main().
 */
export const COMMON_UNIFORMS_GLSL = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform float uZoom;
  uniform vec2 uOffset;
  uniform float uIter;
  uniform float uColorShift;
  uniform float uBeat;
  uniform float uWarp;
  uniform float uTime;
  uniform float uAspect;
`;
