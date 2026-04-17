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
 * Inkblot — a Rorschach plate, morphing with the music.
 *
 * Multi-octave value noise drives a soft threshold that gets rendered
 * as "ink" on a paper background. Everything is folded across the X
 * axis for classic bilateral symmetry (the signature "face-like" look);
 * kaleidoscope mode also folds Y for 4-way radial symmetry.
 *
 * Unlike most vizzes in this collection, the base color is LIGHT — the
 * ink is dark against cream paper. That inversion is what sells the
 * Rorschach reference. On beats and loud passages, the ink gains color
 * bleed from the palette so the plate stays psychedelic rather than
 * clinical.
 *
 * Audio reactivity:
 *   - bass widens the ink (lowers the noise threshold → more area
 *     crosses into "ink" territory)
 *   - mid drives a slow domain warp that morphs the blob shapes
 *   - beats + bass control how much colored bleed seeps into the ink
 *   - treble advances the color cycle used for bleed
 */
class InkblotMounted extends FractalBase {
  constructor(container: HTMLElement, ctx: VisualizerContext) {
    super(container, ctx, {
      fragmentShader: FRAGMENT_SHADER,
      extraUniforms: {
        uSymmetry: { value: 0 }, // 0=bilateral, 1=kaleidoscope
        uInkOpacity: { value: 0.9 },
        uBleed: { value: 0.6 },
        uDetail: { value: 4 },
        uBass: { value: 0 },
        uMid: { value: 0 },
        uPaperMode: { value: 0 }, // 0=cream, 1=gray, 2=inverted(black)
      },
    });
  }

  setParams(p: ParamValues): void {
    super.setParams(p);
    const symmetry = String(p.symmetry ?? 'bilateral');
    this.material.uniforms.uSymmetry.value =
      symmetry === 'kaleidoscope' ? 1 : 0;
    this.material.uniforms.uInkOpacity.value = clampNum(
      p.inkOpacity,
      0.3,
      1,
      0.9,
    );
    this.material.uniforms.uBleed.value = clampNum(p.bleed, 0, 1.5, 0.6);
    this.material.uniforms.uDetail.value = Math.round(
      clampNum(p.detail, 3, 6, 4),
    );
    const paper = String(p.paperTone ?? 'cream');
    this.material.uniforms.uPaperMode.value =
      paper === 'gray' ? 1 : paper === 'inverted' ? 2 : 0;
  }

  render(frame: AudioFrame, _p: ParamValues, dt: number): void {
    const { bass, mid, beatPulse } = this.updateCommon(frame, dt);
    this.material.uniforms.uBass.value = bass;
    this.material.uniforms.uMid.value = mid;
    this.material.uniforms.uBeat.value = beatPulse;
    this.renderer.render(this.scene, this.camera);
  }
}

const FRAGMENT_SHADER = /* glsl */ `
  ${COMMON_UNIFORMS_GLSL}
  ${PALETTE_SAMPLER_GLSL}
  uniform float uSymmetry;
  uniform float uInkOpacity;
  uniform float uBleed;
  uniform float uDetail;
  uniform float uBass;
  uniform float uMid;
  uniform float uPaperMode;

  // Cheap hash → value noise → fBm. No library; deterministic across
  // GPUs because the hash is pure arithmetic.
  float hash(vec2 p) {
    p = fract(p * vec2(443.8975, 397.2973));
    p += dot(p, p + 19.19);
    return fract((p.x + p.y) * p.x);
  }

  float valueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f); // smooth interpolation
    return mix(
      mix(hash(i),                hash(i + vec2(1.0, 0.0)), u.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }

  float fbm(vec2 p, int octaves) {
    float v = 0.0;
    float amp = 0.5;
    for (int i = 0; i < 8; i++) {
      if (i >= octaves) break;
      v += amp * valueNoise(p);
      p *= 2.0;
      amp *= 0.5;
    }
    return v;
  }

  void main() {
    vec2 uv = vUv - 0.5;
    uv.x *= uAspect;

    // Bilateral fold — "paint on one side, press, open the page".
    // abs() around 0 gives a seamless mirror through the X axis.
    uv.x = abs(uv.x);
    // Kaleidoscope: fold Y too for 4-way radial symmetry.
    if (uSymmetry > 0.5) {
      uv.y = abs(uv.y);
    }

    // Slow domain warp — the ink "creeps" across the plate. Mid drives
    // amplitude so the morph is audible without being manic.
    vec2 flow = vec2(
      sin(uTime * 0.2 + uv.y * 3.0),
      cos(uTime * 0.17 + uv.x * 3.0)
    ) * 0.05 * (0.5 + uMid);
    uv += flow;

    // Extra user-controlled warp on top.
    if (uWarp > 0.001) {
      uv += vec2(
        sin(uTime * 0.3 + uv.y * 2.0),
        cos(uTime * 0.27 + uv.x * 2.0)
      ) * uWarp * 0.08;
    }

    // fBm at user zoom — higher zoom = larger blobs.
    vec2 p = uv * (2.4 / uZoom);
    float n = fbm(p + uTime * 0.06, int(uDetail));

    // Soft-threshold the noise into "ink". Bass lowers the threshold
    // so loud bass hits spread the ink outward (the plate "blooms").
    float threshold = 0.55 - uBass * 0.15;
    float soft = 0.08;
    float ink = smoothstep(threshold + soft, threshold - soft, n);
    ink *= uInkOpacity;

    // Paper background.
    vec3 paper;
    if (uPaperMode < 0.5) {
      paper = vec3(0.94, 0.90, 0.82);  // cream (classic)
    } else if (uPaperMode < 1.5) {
      paper = vec3(0.82, 0.83, 0.86);  // cool gray
    } else {
      paper = vec3(0.02, 0.02, 0.04);  // inverted — dark-field
    }

    // Ink starts near-black. On beats + bass, palette color bleeds in
    // so the ink shifts between classic sumi-e black and full psychedelic
    // saturation.
    vec3 inkCore = uPaperMode > 1.5
      ? vec3(0.95, 0.93, 0.88)          // inverted: "ink" is light
      : vec3(0.03, 0.02, 0.05);
    vec3 bleedCol = samplePalette(uColorShift);
    float bleedAmt = clamp(uBleed * (uBeat * 0.7 + uBass * 0.4), 0.0, 1.0);
    vec3 inkColor = mix(inkCore, bleedCol, bleedAmt);

    vec3 col = mix(paper, inkColor, ink);

    gl_FragColor = vec4(col, 1.0);
  }
`;

export const inkblotPlugin: VisualizationPlugin = {
  id: 'inkblot',
  name: 'Inkblot',
  description:
    'Rorschach-style symmetric ink — bass spreads the blobs, beats bleed color.',
  params: {
    palette: {
      type: 'select',
      label: 'Palette',
      options: PALETTE_NAMES,
      default: 'sunset',
    },
    paperTone: {
      type: 'select',
      label: 'Paper',
      options: ['cream', 'gray', 'inverted'],
      default: 'cream',
    },
    symmetry: {
      type: 'select',
      label: 'Symmetry',
      options: ['bilateral', 'kaleidoscope'],
      default: 'bilateral',
    },
    inkOpacity: {
      type: 'number',
      label: 'Ink darkness',
      min: 0.3,
      max: 1,
      step: 0.05,
      default: 0.9,
    },
    bleed: {
      type: 'number',
      label: 'Color bleed',
      min: 0,
      max: 1.5,
      step: 0.05,
      default: 0.6,
    },
    detail: {
      type: 'number',
      label: 'Detail (octaves)',
      min: 3,
      max: 6,
      step: 1,
      default: 4,
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
    return new InkblotMounted(container, ctx);
  },
};

export default inkblotPlugin;
