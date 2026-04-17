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
 * Newton fractal — petal-shaped basins of convergence.
 *
 * For each pixel we iterate Newton's method on f(z) = z^n − 1:
 *   z ← z − α · f(z) / f'(z)
 *
 * The iteration converges to one of the n-th roots of unity; each root
 * claims a petal-shaped "basin". Coloring by which root wins, shaded
 * by how fast the pixel converged, produces the signature pinwheel
 * bloom.
 *
 * Audio reactivity:
 *   - bass pulses the relaxation α (how aggressively to step), which
 *     morphs the basin boundaries in real time
 *   - mid nudges the exponent n slightly (3.0 + mid·0.3), making the
 *     whole bloom breathe in/out
 *   - treble advances the color cycle
 *   - beats punch a soft flash on every basin
 */
class NewtonMounted extends FractalBase {
  private exponent = 3;
  private relaxation = 1;

  constructor(container: HTMLElement, ctx: VisualizerContext) {
    super(container, ctx, {
      fragmentShader: FRAGMENT_SHADER,
      extraUniforms: {
        uExponent: { value: 3 },
        uRelax: { value: 1 },
        uRotation: { value: 0 },
      },
    });
  }

  setParams(p: ParamValues): void {
    super.setParams(p);
    this.exponent = clampNum(p.exponent, 3, 7, 3);
    this.relaxation = clampNum(p.relaxation, 0.5, 1.5, 1);
    // Newton usually converges quickly; cap iterations low for speed.
    const iter = clampNum(p.iterations, 16, 80, 32);
    this.iterations = iter;
    this.material.uniforms.uIter.value = iter;
  }

  render(frame: AudioFrame, _p: ParamValues, dt: number): void {
    const { bass, mid, beatPulse } = this.updateCommon(frame, dt);

    // Audio-morphed exponent: integer root count ± a small continuous
    // perturbation. The fractional part warps the petal boundaries
    // without breaking the overall n-fold symmetry.
    const breathE = mid * 0.35 * Math.sin(this.t * 0.4);
    this.material.uniforms.uExponent.value = this.exponent + breathE;

    // Bass rides α — ~0.7 to ~1.2 around the user-chosen base.
    const alphaPulse = 0.9 + bass * 0.3;
    this.material.uniforms.uRelax.value = this.relaxation * alphaPulse;

    // Slow rotation of the whole bloom — hypnotic.
    this.material.uniforms.uRotation.value = this.t * 0.12;

    this.material.uniforms.uBeat.value = beatPulse;

    this.renderer.render(this.scene, this.camera);
  }
}

const FRAGMENT_SHADER = /* glsl */ `
  ${COMMON_UNIFORMS_GLSL}
  ${PALETTE_SAMPLER_GLSL}
  uniform float uExponent;
  uniform float uRelax;
  uniform float uRotation;

  // Complex multiplication.
  vec2 cmul(vec2 a, vec2 b) {
    return vec2(a.x*b.x - a.y*b.y, a.x*b.y + a.y*b.x);
  }

  // Complex division.
  vec2 cdiv(vec2 a, vec2 b) {
    float d = b.x*b.x + b.y*b.y;
    return vec2(a.x*b.x + a.y*b.y, a.y*b.x - a.x*b.y) / d;
  }

  // Complex integer power (positive integer n). Used inside the inner
  // loop, so we do the repeated multiplications explicitly instead of
  // relying on pow() + angle math which is slower on some GPUs.
  vec2 cpow_int(vec2 z, int n) {
    vec2 r = vec2(1.0, 0.0);
    for (int i = 0; i < 8; i++) {
      if (i >= n) break;
      r = cmul(r, z);
    }
    return r;
  }

  void main() {
    // Sample the complex plane at ±2 with aspect correction. Newton's
    // petals are prettiest zoomed out so you can see the full wheel.
    vec2 uv = (vUv - 0.5) * 4.0;
    uv.x *= uAspect;
    uv = uv / uZoom;

    // Rotate the whole plane slowly — the fractal itself has n-fold
    // symmetry, so rotation reads as palette cycling over the wheel.
    float cr = cos(uRotation);
    float sr = sin(uRotation);
    uv = vec2(uv.x*cr - uv.y*sr, uv.x*sr + uv.y*cr);

    if (uWarp > 0.001) {
      uv += vec2(
        sin(uTime * 0.3 + uv.y * 2.0),
        cos(uTime * 0.27 + uv.x * 2.0)
      ) * uWarp * 0.05;
    }

    // Round the exponent for the power op (GLSL loops need constant
    // bounds), but keep the fractional part as an argument-space bias
    // so the boundaries animate smoothly between integer n's.
    int nInt = int(floor(uExponent + 0.5));
    if (nInt < 3) nInt = 3;
    if (nInt > 7) nInt = 7;
    float nFrac = uExponent - float(nInt);
    float nF = float(nInt);

    vec2 z = uv;
    float converged = 0.0;
    float iters = 0.0;
    // Newton's method iteration: z ← z − α · (z^n − 1) / (n · z^(n-1))
    for (int i = 0; i < 80; i++) {
      if (float(i) >= uIter) break;
      // f(z) = z^n − 1, plus a tiny fractional-n bias term that makes
      // the basin boundaries "breathe" between integer exponents.
      vec2 zn = cpow_int(z, nInt);
      vec2 fz = zn - vec2(1.0, 0.0)
              + nFrac * cmul(zn, vec2(cos(uTime * 0.3), sin(uTime * 0.3)))
                * 0.05;
      // f'(z) = n · z^(n-1)
      vec2 fpz = nF * cpow_int(z, nInt - 1);
      vec2 step = cdiv(fz, fpz);
      z -= uRelax * step;
      // Converged when the step is tiny — pixel sits on a root.
      if (dot(step, step) < 1e-6) {
        converged = 1.0;
        break;
      }
      iters += 1.0;
    }

    // Which root did we land on? atan2 of z gives an angle; nearest
    // k-th root of unity is round(angle · n / 2π). This buckets the
    // plane into n petals.
    float angle = atan(z.y, z.x);
    float rootIdx = floor(angle * nF / 6.2831853 + 0.5);
    rootIdx = mod(rootIdx, nF);
    float rootT = rootIdx / nF;

    // Final color: palette indexed by root, darkened by slow convergence.
    float shade = 1.0 - iters / max(uIter, 1.0);
    vec3 col = samplePalette(rootT + uColorShift);
    col *= 0.4 + 0.8 * shade;
    // Beat flashes — add a soft bloom across the whole petal ring.
    col += uBeat * 0.25 * samplePalette(rootT + uColorShift + 0.5);

    // Non-converged pixels (iter cap) fade toward black — rare but
    // happens near basin boundaries.
    col *= converged > 0.5 ? 1.0 : 0.35;

    gl_FragColor = vec4(col, 1.0);
  }
`;

export const newtonPlugin: VisualizationPlugin = {
  id: 'newton-bloom',
  name: 'Newton Bloom',
  description:
    'A pinwheel of convergence petals — Newton-fractal basins pulsing with the beat.',
  params: {
    palette: {
      type: 'select',
      label: 'Palette',
      options: PALETTE_NAMES,
      default: 'neon',
    },
    exponent: {
      type: 'number',
      label: 'Petals (roots)',
      min: 3,
      max: 7,
      step: 1,
      default: 3,
    },
    relaxation: {
      type: 'number',
      label: 'Convergence α',
      min: 0.5,
      max: 1.5,
      step: 0.05,
      default: 1,
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
      min: 16,
      max: 80,
      step: 4,
      default: 32,
    },
    morphSpeed: {
      type: 'number',
      label: 'Morph speed',
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
      default: 0.2,
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
    return new NewtonMounted(container, ctx);
  },
};

export default newtonPlugin;
