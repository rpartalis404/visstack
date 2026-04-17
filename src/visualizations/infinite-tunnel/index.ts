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
 * Infinite Tunnel — the classic demoscene zoom.
 *
 * The trick is a trivial one-liner that looks like magic: convert pixel
 * UVs to polar coords, then use `1/radius` as the depth coordinate.
 * Because 1/r is unbounded as r → 0, every pixel near the center maps
 * to "far down the tunnel", producing the infinite-zoom illusion. Add
 * time to the depth and you're flying forward forever.
 *
 * The two texture coordinates are (depth, angle). We sample the palette
 * at `depth * c1 + angle * c2` to get rings of color running down the
 * tunnel walls, then modulate with a sine-wave band pattern on depth
 * for the signature demoscene "floor tile" feel.
 *
 * Audio reactivity:
 *   - bass speeds up forward motion (tunnel flies toward you faster)
 *   - mid adds a subtle spiral/twist around the depth axis
 *   - treble advances the palette cycle faster
 *   - beats punch a sustained brightness flash
 */
class InfiniteTunnelMounted extends FractalBase {
  constructor(container: HTMLElement, ctx: VisualizerContext) {
    super(container, ctx, {
      fragmentShader: FRAGMENT_SHADER,
      extraUniforms: {
        uSpeed: { value: 1 },
        uTwist: { value: 1 },
        uBands: { value: 8 },
        uBass: { value: 0 },
        uMid: { value: 0 },
      },
    });
  }

  setParams(p: ParamValues): void {
    super.setParams(p);
    this.material.uniforms.uSpeed.value = clampNum(p.speed, 0.1, 4, 1);
    this.material.uniforms.uTwist.value = clampNum(p.twist, 0, 3, 1);
    this.material.uniforms.uBands.value = clampNum(p.bands, 2, 30, 8);
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
  uniform float uSpeed;
  uniform float uTwist;
  uniform float uBands;
  uniform float uBass;
  uniform float uMid;

  void main() {
    // Center UVs so (0,0) is the vanishing point.
    vec2 uv = (vUv - 0.5) * 2.0;
    uv.x *= uAspect;

    // Polar coordinates. Clamp r away from 0 — the 1/r below would
    // produce infinities right at the center pixel otherwise, which
    // can flicker bright white on some drivers.
    float r = max(length(uv), 0.02);
    float a = atan(uv.y, uv.x);

    // Depth along the tunnel. The 1/r term does the magic: everything
    // near center appears far down the tunnel, everything near the
    // edges appears close. Time + bass drive the forward zoom rate.
    float zoomRate = uSpeed * (0.55 + uBass * 1.5);
    float depth = 1.0 / (r * uZoom) + uTime * zoomRate;

    // Angular coordinate, wrapped into [0,1]. Mid adds a slow twist so
    // the tunnel walls spiral subtly.
    float angle = a / 6.2831853 + uMid * 0.2 * uTime;

    // Apply user-controlled twist: a depth-dependent rotation around
    // the tunnel axis. Makes the walls spiral like a barber pole.
    angle += depth * uTwist * 0.03;

    // Optional domain warp.
    if (uWarp > 0.001) {
      depth += sin(angle * 8.0 + uTime) * uWarp * 0.3;
    }

    // Sample palette — walls are rings of color running along depth,
    // with a per-ring offset around the angular axis.
    float colT = depth * 0.06 + angle * 0.5 + uColorShift;
    vec3 col = samplePalette(colT);

    // Depth bands — sine-wave brightness variation on depth. Number of
    // bands per unit depth is the classic "floor tile" look.
    float bandFreq = uBands;
    float bands = 0.5 + 0.5 * sin(depth * bandFreq + uTime * 0.7);
    col *= 0.55 + 0.55 * bands;

    // Beat punch — sustained flash across all walls.
    col += uBeat * 0.2 * samplePalette(colT + 0.5);

    // Vignette the center so the vanishing point reads as "darkness
    // ahead" rather than a stuck-pixel hotspot.
    float centerFade = smoothstep(0.0, 0.25, r);
    col *= 0.25 + 0.75 * centerFade;

    // Edge highlight — slight brighten where we're passing "the wall"
    // close to the camera. Makes forward motion feel dimensional.
    float edge = smoothstep(0.6, 1.2, r);
    col += edge * 0.15;

    gl_FragColor = vec4(col, 1.0);
  }
`;

export const infiniteTunnelPlugin: VisualizationPlugin = {
  id: 'infinite-tunnel',
  name: 'Infinite Tunnel',
  description:
    'The classic demoscene forever-zoom — palette-cycling walls, bass accelerates.',
  params: {
    palette: {
      type: 'select',
      label: 'Palette',
      options: PALETTE_NAMES,
      default: 'neon',
    },
    speed: {
      type: 'number',
      label: 'Forward speed',
      min: 0.1,
      max: 4,
      step: 0.05,
      default: 1,
    },
    twist: {
      type: 'number',
      label: 'Spiral twist',
      min: 0,
      max: 3,
      step: 0.05,
      default: 1,
    },
    bands: {
      type: 'number',
      label: 'Depth bands',
      min: 2,
      max: 30,
      step: 1,
      default: 8,
    },
    zoom: {
      type: 'number',
      label: 'Tunnel width',
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
      label: 'Wall warp',
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
    return new InfiniteTunnelMounted(container, ctx);
  },
};

export default infiniteTunnelPlugin;
