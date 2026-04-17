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
 * Oil Slick — iridescent thin-film interference over a flowing liquid
 * surface.
 *
 * Physically, rainbow films (oil on water, soap bubbles, gasoline
 * puddles) get their color from constructive/destructive interference
 * between light reflected off the film's top and bottom surfaces. The
 * dominant wavelength — and therefore the perceived color — depends on
 * the film's local thickness.
 *
 * We fake that here by treating an fBm noise field as a "thickness map"
 * and mapping thickness through a periodic RGB function (cosines at
 * offset phases) to get the interference color. Domain-warping the
 * noise coordinates makes the film "flow" like real liquid, and audio
 * bias on thickness drives the color sweep on beats.
 *
 * Audio reactivity:
 *   - bass shifts the base film thickness, sweeping the entire slick
 *     through the color gradient (whole-image rainbow pan)
 *   - mid speeds up the flow/warp motion
 *   - treble adds fine-grained shimmer (high-octave noise amplitude)
 *   - beats flash the specular highlight
 */
class OilSlickMounted extends FractalBase {
  constructor(container: HTMLElement, ctx: VisualizerContext) {
    super(container, ctx, {
      fragmentShader: FRAGMENT_SHADER,
      extraUniforms: {
        uFlowSpeed: { value: 1 },
        uThickness: { value: 1 },
        uIridescence: { value: 1 },
        uRipples: { value: 1 },
        uBass: { value: 0 },
        uMid: { value: 0 },
        uTreble: { value: 0 },
      },
    });
  }

  setParams(p: ParamValues): void {
    super.setParams(p);
    this.material.uniforms.uFlowSpeed.value = clampNum(
      p.flowSpeed,
      0.1,
      3,
      1,
    );
    this.material.uniforms.uThickness.value = clampNum(
      p.thickness,
      0.3,
      3,
      1,
    );
    this.material.uniforms.uIridescence.value = clampNum(
      p.iridescence,
      0.2,
      2,
      1,
    );
    this.material.uniforms.uRipples.value = clampNum(p.ripples, 0.5, 4, 1);
  }

  render(frame: AudioFrame, _p: ParamValues, dt: number): void {
    const { bass, mid, treble, beatPulse } = this.updateCommon(frame, dt);
    this.material.uniforms.uBass.value = bass;
    this.material.uniforms.uMid.value = mid;
    this.material.uniforms.uTreble.value = treble;
    this.material.uniforms.uBeat.value = beatPulse;
    this.renderer.render(this.scene, this.camera);
  }
}

const FRAGMENT_SHADER = /* glsl */ `
  ${COMMON_UNIFORMS_GLSL}
  ${PALETTE_SAMPLER_GLSL}
  uniform float uFlowSpeed;
  uniform float uThickness;
  uniform float uIridescence;
  uniform float uRipples;
  uniform float uBass;
  uniform float uMid;
  uniform float uTreble;

  // Hash + value noise + fBm — same small library as Inkblot. Inlined
  // rather than shared so each plugin stays self-contained.
  float hash(vec2 p) {
    p = fract(p * vec2(443.8975, 397.2973));
    p += dot(p, p + 19.19);
    return fract((p.x + p.y) * p.x);
  }
  float valueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i),                hash(i + vec2(1.0, 0.0)), u.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }
  float fbm(vec2 p) {
    float v = 0.0, amp = 0.5;
    for (int i = 0; i < 5; i++) {
      v += amp * valueNoise(p);
      p *= 2.0;
      amp *= 0.5;
    }
    return v;
  }

  /**
   * Cosine-based iridescent color. Three RGB channels oscillate through
   * the gradient at the same frequency but offset by ~120 degrees each,
   * so sweeping t walks through every spectrum color in order.
   *
   * This is a cheap stand-in for the real thin-film spectral response
   * — faithful enough to read as "oil on water" without the complexity
   * of a proper blackbody / reflectance computation.
   */
  vec3 iridescent(float t) {
    return vec3(
      0.5 + 0.5 * cos(t * 6.2831853 + 0.0),
      0.5 + 0.5 * cos(t * 6.2831853 + 2.094),
      0.5 + 0.5 * cos(t * 6.2831853 + 4.188)
    );
  }

  void main() {
    vec2 uv = vUv - 0.5;
    uv.x *= uAspect;
    uv *= 2.0 / uZoom;

    float t = uTime * uFlowSpeed * (0.7 + uMid * 0.5);

    // Two-layer domain warp — the coarse warp swirls the film around
    // slowly; the fine warp ripples the surface at higher frequency.
    // Mid accelerates both so the slick "boils" on busy mids.
    vec2 coarseWarp = vec2(
      sin(uv.y * 2.2 + t * 0.6),
      cos(uv.x * 2.2 + t * 0.5)
    ) * 0.2;
    vec2 fineWarp = vec2(
      cos(uv.y * 5.5 + t * 1.1),
      sin(uv.x * 5.5 + t * 1.3)
    ) * 0.08 * uRipples;
    vec2 flowed = uv + coarseWarp + fineWarp;

    // Extra user-controlled warp (from the FractalBase common warp pot).
    if (uWarp > 0.001) {
      flowed += vec2(
        sin(uTime * 0.3 + flowed.y * 2.0),
        cos(uTime * 0.27 + flowed.x * 2.0)
      ) * uWarp * 0.15;
    }

    // Thickness field. fBm gives smooth, organic variation across the
    // slick. The scale is tuned so the biggest features span ~1/3 of
    // the viewport — any tighter and it looks noisy; any wider and the
    // slick loses its signature "marbled" micro-structure.
    float thickness = fbm(flowed * (1.5 * uRipples) + t * 0.1);
    // Treble injects a little high-frequency shimmer — samples an
    // additional noise octave with strong variation.
    thickness += (fbm(flowed * 8.0 + t * 0.5) - 0.5) * uTreble * 0.15;

    // Bass shifts the thickness DC offset. Visually this sweeps the
    // entire image through the rainbow every bass pump.
    thickness = thickness * uThickness + uBass * 0.7;

    // Convert thickness → iridescent color. uIridescence scales the
    // thickness-to-spectrum mapping; low = lazy color sweeps, high =
    // rapid color bands.
    vec3 irid = iridescent(thickness * uIridescence + uColorShift * 0.3);

    // Mix in a palette-based tint so the plugin respects the user's
    // chosen palette rather than being stuck on rainbow.
    vec3 paletteCol = samplePalette(thickness * 0.5 + uColorShift);
    vec3 col = mix(irid, paletteCol, 0.35);

    // Dark-water base. Oil slicks sit over something — the surface of
    // dark water reads as "depth" underneath the film.
    vec3 base = vec3(0.03, 0.02, 0.06);
    col = base + col * (0.55 + 0.35 * thickness);

    // Specular-ish highlight on beats — a bright non-colored flash
    // that catches the eye like a direct light reflection.
    col += uBeat * 0.18 * vec3(1.0, 0.98, 0.95);

    // Subtle vignette so the edges feel like a bounded puddle rather
    // than an infinite rainbow plane.
    float vign = smoothstep(1.6, 0.3, length(uv));
    col *= 0.65 + 0.45 * vign;

    gl_FragColor = vec4(col, 1.0);
  }
`;

export const oilSlickPlugin: VisualizationPlugin = {
  id: 'oil-slick',
  name: 'Oil Slick',
  description:
    'Iridescent rainbow film flowing on dark water — bass sweeps the spectrum.',
  params: {
    palette: {
      type: 'select',
      label: 'Palette',
      options: PALETTE_NAMES,
      default: 'neon',
    },
    flowSpeed: {
      type: 'number',
      label: 'Flow speed',
      min: 0.1,
      max: 3,
      step: 0.05,
      default: 1,
    },
    thickness: {
      type: 'number',
      label: 'Film thickness',
      min: 0.3,
      max: 3,
      step: 0.05,
      default: 1,
    },
    iridescence: {
      type: 'number',
      label: 'Iridescence',
      min: 0.2,
      max: 2,
      step: 0.05,
      default: 1,
    },
    ripples: {
      type: 'number',
      label: 'Ripple scale',
      min: 0.5,
      max: 4,
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
      label: 'Color cycle',
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
    return new OilSlickMounted(container, ctx);
  },
};

export default oilSlickPlugin;
