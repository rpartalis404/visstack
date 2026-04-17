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
 * Burning Ship fractal.
 *
 * Same iteration as Mandelbrot (z = z² + c) but with `z = |z|` applied
 * before each squaring step. The absolute-value fold produces jagged,
 * mirror-symmetric coastlines and — famously — a silhouette that looks
 * like a burning ship at the canonical (−1.7, −0.03) viewing frame.
 *
 * The escape-time coloring feels more angular and metallic than
 * Mandelbrot's organic smoothness. Bass pumps the zoom; a slow drift
 * tours different alien coastlines.
 */

const POIS: Array<{ center: [number, number]; scale: number }> = [
  // The "ship" itself (classic view)
  { center: [-1.765, -0.03], scale: 0.04 },
  // Armada / lesser ship cluster
  { center: [-1.62, -0.0175], scale: 0.03 },
  // Larger overview — shows the set's silhouette
  { center: [-0.4, -0.5], scale: 1.8 },
  // Upper antenna structure
  { center: [-1.755, -0.028], scale: 0.015 },
];

class BurningShipMounted extends FractalBase {
  private poiIndex = 0;
  private poiBlend = 1;
  private poiHoldTimer = 0;
  private bassZoom = 1;

  constructor(container: HTMLElement, ctx: VisualizerContext) {
    super(container, ctx, {
      fragmentShader: FRAGMENT_SHADER,
      extraUniforms: {
        uCenter: { value: new THREE.Vector2(-1.765, -0.03) },
        uViewScale: { value: 0.04 },
      },
    });
  }

  setParams(p: ParamValues): void {
    super.setParams(p);
    // Higher iteration floor — fine detail at deep zooms needs it.
    const iter = clampNum(p.iterations, 96, 256, 200);
    this.iterations = iter;
    this.material.uniforms.uIter.value = iter;
  }

  render(frame: AudioFrame, _p: ParamValues, dt: number): void {
    const { bass, treble, beatPulse } = this.updateCommon(frame, dt);

    // Hold each POI a bit longer than Mandelbrot — the dense structure
    // rewards longer looking. ~15s hold, ~4s crossfade.
    this.poiHoldTimer += dt;
    if (this.poiHoldTimer > 15 && this.poiBlend >= 1) {
      this.poiHoldTimer = 0;
      this.poiBlend = 0;
      this.poiIndex = (this.poiIndex + 1) % POIS.length;
    }
    this.poiBlend = Math.min(1, this.poiBlend + dt / 4);

    const prev = POIS[(this.poiIndex + POIS.length - 1) % POIS.length];
    const curr = POIS[this.poiIndex];
    const k = smoothstep(this.poiBlend);
    // Interpolate scale geometrically — linear zoom blends between
    // very-close and very-wide POIs produce ugly dolly-zoom artifacts.
    const logScale =
      lerp(Math.log(prev.scale), Math.log(curr.scale), k);
    const baseScale = Math.exp(logScale);
    const cx = lerp(prev.center[0], curr.center[0], k);
    const cy = lerp(prev.center[1], curr.center[1], k);

    this.bassZoom = this.bassZoom * 0.92 + (1 - bass * 0.6) * 0.08;

    const jitterX = Math.sin(this.t * 3.7) * treble * 0.015;
    const jitterY = Math.cos(this.t * 4.1) * treble * 0.015;

    this.material.uniforms.uCenter.value.set(cx + jitterX, cy + jitterY);
    this.material.uniforms.uViewScale.value = baseScale * this.bassZoom;
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
    vec2 uv = (vUv - 0.5) * 2.0;
    uv.x *= uAspect;
    // Flip Y so the "ship" is right-side up at the canonical view.
    // (The classic Burning Ship rendering is flipped vs. mathematical
    // convention — without this the ship appears upside down.)
    uv.y = -uv.y;
    vec2 c = uv * (uViewScale / uZoom) + uCenter;

    if (uWarp > 0.001) {
      c += vec2(
        sin(uTime * 0.3 + c.y * 4.0),
        cos(uTime * 0.27 + c.x * 4.0)
      ) * uWarp * 0.003;
    }

    vec2 z = vec2(0.0);
    float i = 0.0;
    float escaped = 0.0;
    for (int n = 0; n < 256; n++) {
      if (float(n) >= uIter) break;
      // Burning Ship's secret sauce: absolute value before squaring.
      // The fold turns Mandelbrot's curves into hard, mirrored edges.
      z = abs(z);
      z = vec2(z.x*z.x - z.y*z.y, 2.0*z.x*z.y) + c;
      if (dot(z, z) > 16.0) {
        escaped = 1.0;
        break;
      }
      i += 1.0;
    }

    vec3 col;
    if (escaped < 0.5) {
      // The "hull" — near-black with a subtle ember glow on beats.
      col = mix(
        vec3(0.01, 0.0, 0.02),
        uPalette3 * 0.3,
        uBeat * 0.5
      );
    } else {
      float smoothI = i - log2(log2(dot(z, z))) + 4.0;
      float t = smoothI * 0.03 + uColorShift;
      col = samplePalette(t);
      // Metallic banding — sharper than Mandelbrot's smooth sine.
      float band = 0.6 + 0.5 * sin(smoothI * 0.8 + uTime * 0.7);
      col *= band + uBeat * 0.25;
    }

    gl_FragColor = vec4(col, 1.0);
  }
`;

export const burningShipPlugin: VisualizationPlugin = {
  id: 'burning-ship',
  name: 'Burning Ship',
  description:
    'Jagged, mirror-symmetric coastlines from an absolute-value fractal — alien geometry in motion.',
  params: {
    palette: {
      type: 'select',
      label: 'Palette',
      options: PALETTE_NAMES,
      default: 'sunset',
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
      min: 96,
      max: 256,
      step: 8,
      default: 200,
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
    return new BurningShipMounted(container, ctx);
  },
};

export default burningShipPlugin;
