import * as THREE from 'three';
import type { AudioFrame } from '../../audio/types';
import type {
  ParamValues,
  VisualizationPlugin,
  VisualizerContext,
} from '../types';
import { PALETTE_NAMES } from '../common/palettes';
import {
  COMMON_UNIFORMS_GLSL,
  FractalBase,
  PALETTE_SAMPLER_GLSL,
  clampNum,
} from '../common/fractal-base';

/**
 * Mandelbrot set — the iconic "infinity fractal".
 *
 * For each pixel we let c = pixel position (in complex space) and
 * iterate z = z² + c starting from z₀ = 0. Pixels that escape |z| > 2
 * get colored by iteration count; the bounded "main body" stays dark
 * with a faint beat-driven glow so it doesn't feel dead at silence.
 *
 * The default view centers on Seahorse Valley (−0.75 + 0.1i) — the
 * richest detail zone. A slow Lissajous drift pushes the view center
 * around so the visible detail cross-section shifts over time; bass
 * zooms in and treble jitters the drift for extra motion.
 */

// "Interesting" centers we rotate through. Each has famously dense
// structure. Zoom-in ratios are hand-picked so the view frames each
// zone nicely at zoom=1.
const POIS: Array<{ center: [number, number]; scale: number }> = [
  // Seahorse Valley
  { center: [-0.75, 0.1], scale: 0.6 },
  // Elephant Valley
  { center: [0.275, 0.0], scale: 0.8 },
  // Triple Spiral
  { center: [-0.088, 0.655], scale: 0.5 },
  // Default wide view
  { center: [-0.5, 0.0], scale: 1.4 },
];

class MandelbrotMounted extends FractalBase {
  private poiIndex = 0;
  private poiBlend = 1; // 0..1 — smoothly transitions between POIs
  private poiHoldTimer = 0;
  private bassZoom = 1;

  constructor(container: HTMLElement, ctx: VisualizerContext) {
    super(container, ctx, {
      fragmentShader: FRAGMENT_SHADER,
      extraUniforms: {
        uCenter: { value: new THREE.Vector2(-0.5, 0) },
        uViewScale: { value: 1.4 },
      },
    });
  }

  setParams(p: ParamValues): void {
    super.setParams(p);
    // Mandelbrot benefits from more iterations for crisp boundaries.
    // Override the base clamp min.
    const iter = clampNum(p.iterations, 64, 256, 160);
    this.iterations = iter;
    this.material.uniforms.uIter.value = iter;
  }

  render(frame: AudioFrame, _p: ParamValues, dt: number): void {
    const { bass, treble, beatPulse } = this.updateCommon(frame, dt);

    // Advance through POIs. Each holds for ~12 seconds then crossfades
    // over ~3 seconds. Beat bumps can skip early if the blend is done.
    this.poiHoldTimer += dt;
    if (this.poiHoldTimer > 12 && this.poiBlend >= 1) {
      this.poiHoldTimer = 0;
      this.poiBlend = 0;
      this.poiIndex = (this.poiIndex + 1) % POIS.length;
    }
    this.poiBlend = Math.min(1, this.poiBlend + dt / 3);

    const prev = POIS[(this.poiIndex + POIS.length - 1) % POIS.length];
    const curr = POIS[this.poiIndex];
    const k = smoothstep(this.poiBlend);
    const cx = lerp(prev.center[0], curr.center[0], k);
    const cy = lerp(prev.center[1], curr.center[1], k);
    const baseScale = lerp(prev.scale, curr.scale, k);

    // Bass-driven zoom pulse. We low-pass it a bit more than the
    // smoother already does, since zoom jitter is very noticeable.
    this.bassZoom = this.bassZoom * 0.92 + (1 - bass * 0.55) * 0.08;

    // Treble adds a tiny jitter to center for "shimmer"
    const jitterX = Math.sin(this.t * 4.3) * treble * 0.02;
    const jitterY = Math.cos(this.t * 4.7) * treble * 0.02;

    this.material.uniforms.uCenter.value.set(cx + jitterX, cy + jitterY);
    this.material.uniforms.uViewScale.value = baseScale * this.bassZoom;

    // Beat adds a subtle radial punch — visible mostly on the bounded
    // set interior.
    this.material.uniforms.uBeat.value = beatPulse;

    this.renderer.render(this.scene, this.camera);
  }
}

function smoothstep(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

const FRAGMENT_SHADER = /* glsl */ `
  ${COMMON_UNIFORMS_GLSL}
  ${PALETTE_SAMPLER_GLSL}
  uniform vec2 uCenter;
  uniform float uViewScale;

  void main() {
    // Map UV to complex plane, aspect-corrected. uCenter picks which
    // region of the set to frame; uViewScale is the half-width of that
    // region. uZoom is a user-controlled multiplier on top.
    vec2 uv = (vUv - 0.5) * 2.0;
    uv.x *= uAspect;
    vec2 c = uv * (uViewScale / uZoom) + uCenter;

    // Optional domain warp — swimming texture on the escape bands.
    if (uWarp > 0.001) {
      c += vec2(
        sin(uTime * 0.3 + c.y * 3.0),
        cos(uTime * 0.27 + c.x * 3.0)
      ) * uWarp * 0.01;
    }

    vec2 z = vec2(0.0);
    float i = 0.0;
    float escaped = 0.0;
    for (int n = 0; n < 256; n++) {
      if (float(n) >= uIter) break;
      z = vec2(z.x*z.x - z.y*z.y, 2.0*z.x*z.y) + c;
      if (dot(z, z) > 16.0) {
        escaped = 1.0;
        break;
      }
      i += 1.0;
    }

    vec3 col;
    if (escaped < 0.5) {
      // Inside the set — near-black with a beat-driven glow.
      col = mix(vec3(0.0), uPalette0 * 0.35, uBeat * 0.6);
    } else {
      // Smooth iteration count for continuous color banding.
      float smoothI = i - log2(log2(dot(z, z))) + 4.0;
      float t = smoothI * 0.025 + uColorShift;
      col = samplePalette(t);
      // Shimmer bands that pulse with the beat.
      col *= 0.75 + 0.35 * sin(smoothI * 0.4 + uTime * 0.5)
           + uBeat * 0.2;
    }

    gl_FragColor = vec4(col, 1.0);
  }
`;

export const mandelbrotPlugin: VisualizationPlugin = {
  id: 'mandelbrot',
  name: 'Mandelbrot',
  description:
    'The iconic infinity fractal — drifts through detail-rich valleys as bass pulses the zoom.',
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
      min: 64,
      max: 256,
      step: 8,
      default: 160,
    },
    morphSpeed: {
      type: 'number',
      label: 'Drift speed',
      min: 0.1,
      max: 3,
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
      default: 0.3,
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
    return new MandelbrotMounted(container, ctx);
  },
};

export default mandelbrotPlugin;
