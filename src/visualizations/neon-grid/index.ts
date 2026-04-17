import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { AudioFrame } from '../../audio/types';
import type {
  MountedViz,
  ParamValues,
  VisualizationPlugin,
  VisualizerContext,
} from '../types';
import {
  createThreeScaffold,
  type ThreeScaffold,
} from '../common/three-scaffold';
import { BandSmoother, BeatEnvelope } from '../common/reactive';

/**
 * Neon Grid — synthwave floor rushing toward the horizon.
 *
 * A glowing wireframe grid extends forward from beneath the camera;
 * the lines slide toward us at audio-modulated speed. A huge glowing
 * sun disc sits on the horizon with horizontal scan-line bands (the
 * Miami-Vice staple). Heavy bloom + gradient sky backdrop seal the
 * 80s retrofuture look.
 *
 * The scroll trick: the grid is a fixed-size mesh and we translate it
 * by `scrollZ mod gridSpacing`. Because the line pattern repeats every
 * `gridSpacing` world units, wrapping the offset produces a seamless
 * infinite loop — no need to respawn or rebuild geometry per frame.
 * Scene fog hides the far end so the wrap is imperceptible.
 *
 * Audio reactivity:
 *   - bass accelerates the scroll and brightens the grid lines
 *   - mid "breathes" the sun's scale
 *   - treble shifts the sun's hue slightly
 *   - beats flash the sun and add a sustained glow pulse
 */

interface NeonPalette {
  /** Grid line color. */
  grid: THREE.Color;
  /** Sun's hot center. */
  sunHot: THREE.Color;
  /** Sun's cool edge (horizon-dipped). */
  sunCool: THREE.Color;
  /** Sky zenith (top of frame). */
  skyTop: THREE.Color;
  /** Sky horizon (behind sun). */
  skyHorizon: THREE.Color;
}

const PALETTES: Record<string, NeonPalette> = {
  vaporwave: {
    grid: new THREE.Color('#ff2bd6'),
    sunHot: new THREE.Color('#ffe25c'),
    sunCool: new THREE.Color('#ff3c6d'),
    skyTop: new THREE.Color('#1a0a3e'),
    skyHorizon: new THREE.Color('#ff6b9f'),
  },
  outrun: {
    grid: new THREE.Color('#ff4d00'),
    sunHot: new THREE.Color('#ffe066'),
    sunCool: new THREE.Color('#ff5a1a'),
    skyTop: new THREE.Color('#1a0a10'),
    skyHorizon: new THREE.Color('#d12454'),
  },
  tron: {
    grid: new THREE.Color('#00f0ff'),
    sunHot: new THREE.Color('#ffffff'),
    sunCool: new THREE.Color('#3a9bff'),
    skyTop: new THREE.Color('#000814'),
    skyHorizon: new THREE.Color('#0a4d7a'),
  },
  acid: {
    grid: new THREE.Color('#9dff54'),
    sunHot: new THREE.Color('#f5ff66'),
    sunCool: new THREE.Color('#54ff9f'),
    skyTop: new THREE.Color('#0a2d1a'),
    skyHorizon: new THREE.Color('#3fd97a'),
  },
  ultraviolet: {
    grid: new THREE.Color('#c83cff'),
    sunHot: new THREE.Color('#e0b5ff'),
    sunCool: new THREE.Color('#6a00ff'),
    skyTop: new THREE.Color('#090215'),
    skyHorizon: new THREE.Color('#8a1e9b'),
  },
};
const PALETTE_NAMES = Object.keys(PALETTES);

/** Depth of the grid in world units — anything past this is fogged out. */
const GRID_DEPTH = 80;
/** Half-width of the grid — generous so wide aspect ratios still look good. */
const GRID_HALF_WIDTH = 40;
/** Camera height above the grid plane. */
const CAMERA_Y = 1.4;

class NeonGridMounted implements MountedViz {
  private readonly scaffold: ThreeScaffold;
  private readonly composer: EffectComposer;
  private readonly bloom: UnrealBloomPass;

  private gridGroup!: THREE.Group;
  private gridMaterial!: THREE.LineBasicMaterial;
  private sun!: THREE.Mesh;
  private sunMaterial!: THREE.ShaderMaterial;
  private sky!: THREE.Mesh;
  private skyMaterial!: THREE.ShaderMaterial;

  /** Scroll offset within one grid-spacing period. */
  private scrollZ = 0;

  // Params
  private paletteName = 'vaporwave';
  private palette: NeonPalette = PALETTES.vaporwave;
  private baseSpeed = 1;
  private gridDensity = 1;
  private gridSpacing = 2.5;
  private sensitivity = 1;

  private readonly bassSmooth = new BandSmoother(0.4, 0.1);
  private readonly midSmooth = new BandSmoother(0.45, 0.12);
  private readonly trebleSmooth = new BandSmoother(0.5, 0.15);
  private readonly beatEnv = new BeatEnvelope(2);

  private readonly scratchColor = new THREE.Color();

  constructor(_ctx: VisualizerContext, container: HTMLElement) {
    this.scaffold = createThreeScaffold(container, {
      fov: 75,
      near: 0.1,
      far: 200,
      cameraZ: 3,
      clearColor: 0x05020e,
    });
    this.scaffold.camera.position.set(0, CAMERA_Y, 3);
    this.scaffold.camera.lookAt(0, 0.4, -10);

    // Fog hides the grid's far edge — any wrap-pop is invisible inside it.
    this.scaffold.scene.fog = new THREE.Fog(0x05020e, 15, 65);

    this.composer = new EffectComposer(this.scaffold.renderer);
    this.composer.addPass(
      new RenderPass(this.scaffold.scene, this.scaffold.camera),
    );
    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(this.scaffold.width, this.scaffold.height),
      1.35, // strength — heavy bloom is the whole aesthetic
      0.85, // radius
      0.0, // threshold — bloom everything (sun, grid, sky-horizon)
    );
    this.composer.addPass(this.bloom);

    this.buildSky();
    this.buildSun();
    this.buildGrid();
    this.applyPalette();
  }

  setParams(p: ParamValues): void {
    const nextPalette = String(p.palette ?? 'vaporwave');
    const nextDensity = clampNum(p.gridDensity, 0.5, 2, 1);
    this.baseSpeed = clampNum(p.speed, 0.1, 3, 1);
    this.sensitivity = clampNum(p.sensitivity, 0.3, 3, 1);
    const glow = clampNum(p.glow, 0, 3, 1);
    this.bloom.strength = 0.5 + glow * 1.4;

    if (nextPalette !== this.paletteName) {
      this.paletteName = nextPalette;
      this.palette = PALETTES[nextPalette] ?? PALETTES.vaporwave;
      this.applyPalette();
    }
    if (Math.abs(nextDensity - this.gridDensity) > 0.01) {
      this.gridDensity = nextDensity;
      this.rebuildGrid();
    }
  }

  resize(w: number, h: number): void {
    this.scaffold.resize(w, h);
    this.composer.setSize(w, h);
    this.bloom.setSize(w, h);
  }

  render(frame: AudioFrame, _p: ParamValues, dt: number): void {
    const s = this.sensitivity;
    const bass = this.bassSmooth.update(Math.min(1, frame.bass * s));
    const mid = this.midSmooth.update(Math.min(1, frame.mid * s));
    const treble = this.trebleSmooth.update(Math.min(1, frame.treble * s));
    const beatPulse = this.beatEnv.update(frame.beat, dt);

    // Scroll the grid. Modulo gridSpacing so the loop is seamless (the
    // line pattern is spacing-periodic — see the file header).
    const speed = this.baseSpeed * (4 + bass * 10);
    this.scrollZ = (this.scrollZ + speed * dt) % this.gridSpacing;
    this.gridGroup.position.z = this.scrollZ;

    // Grid color: palette tinted up by bass + beats.
    this.scratchColor.copy(this.palette.grid);
    this.scratchColor.multiplyScalar(
      0.55 + bass * 0.55 + beatPulse * 0.35,
    );
    this.gridMaterial.color.copy(this.scratchColor);

    // Sun: beat pulse shifts hot/cool mix, treble nudges color shift,
    // mid "breathes" its scale.
    const sunU = this.sunMaterial.uniforms;
    sunU.uPulse.value = beatPulse;
    sunU.uHueShift.value = treble * 0.25;
    const sunScale = 1 + mid * 0.12 + beatPulse * 0.08;
    this.sun.scale.setScalar(sunScale);

    this.composer.render();
  }

  destroy(): void {
    this.disposeGrid();
    this.sun.geometry.dispose();
    this.sunMaterial.dispose();
    this.sky.geometry.dispose();
    this.skyMaterial.dispose();
    this.composer.dispose();
    this.scaffold.destroy();
  }

  // --- scene construction ---------------------------------------------------

  private buildGrid(): void {
    // Line spacing shrinks as density grows (more lines per unit area).
    this.gridSpacing = 2.5 / this.gridDensity;
    const spacing = this.gridSpacing;

    // Horizontal lines (perpendicular to travel): one at each z step.
    // Z range spans from a little in front of the camera (z=+spacing) to
    // -GRID_DEPTH so we always have lines entering from behind us as the
    // group translates forward.
    const hCount = Math.ceil(GRID_DEPTH / spacing) + 2;
    const hPositions = new Float32Array(hCount * 6);
    for (let i = 0; i < hCount; i++) {
      const z = -i * spacing + spacing; // [+spacing, +spacing - (hCount-1)*s]
      hPositions[i * 6 + 0] = -GRID_HALF_WIDTH;
      hPositions[i * 6 + 1] = 0;
      hPositions[i * 6 + 2] = z;
      hPositions[i * 6 + 3] = GRID_HALF_WIDTH;
      hPositions[i * 6 + 4] = 0;
      hPositions[i * 6 + 5] = z;
    }
    const hGeom = new THREE.BufferGeometry();
    hGeom.setAttribute('position', new THREE.BufferAttribute(hPositions, 3));

    // Vertical lines (parallel to travel): static rails running into the
    // distance. These don't need to scroll — they look identical at every
    // depth along their length.
    const vCount = Math.ceil((GRID_HALF_WIDTH * 2) / spacing) + 1;
    const vPositions = new Float32Array(vCount * 6);
    for (let i = 0; i < vCount; i++) {
      const x = -GRID_HALF_WIDTH + i * spacing;
      vPositions[i * 6 + 0] = x;
      vPositions[i * 6 + 1] = 0;
      vPositions[i * 6 + 2] = spacing;
      vPositions[i * 6 + 3] = x;
      vPositions[i * 6 + 4] = 0;
      vPositions[i * 6 + 5] = -GRID_DEPTH;
    }
    const vGeom = new THREE.BufferGeometry();
    vGeom.setAttribute('position', new THREE.BufferAttribute(vPositions, 3));

    this.gridMaterial = new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.95,
      fog: true,
    });
    this.gridGroup = new THREE.Group();
    this.gridGroup.add(new THREE.LineSegments(hGeom, this.gridMaterial));
    this.gridGroup.add(new THREE.LineSegments(vGeom, this.gridMaterial));
    this.scaffold.scene.add(this.gridGroup);
  }

  private buildSun(): void {
    // Huge sun disc far back — behind the grid, inside the skybox.
    const geom = new THREE.CircleGeometry(9, 64);
    this.sunMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uHot: { value: new THREE.Color() },
        uCool: { value: new THREE.Color() },
        uPulse: { value: 0 },
        uHueShift: { value: 0 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 uHot;
        uniform vec3 uCool;
        uniform float uPulse;
        uniform float uHueShift;
        varying vec2 vUv;

        // HSV↔RGB helpers so we can nudge the hue on treble without
        // writing new palette uniforms.
        vec3 rgb2hsv(vec3 c) {
          vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0);
          vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
          vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
          float d = q.x - min(q.w, q.y);
          float e = 1.0e-10;
          return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)),
                      d / (q.x + e), q.x);
        }
        vec3 hsv2rgb(vec3 c) {
          vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
          vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
          return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
        }

        void main() {
          vec2 uv = vUv - 0.5;
          float r = length(uv) * 2.0;  // 0 at center, 1 at edge

          // Top→bottom vertical gradient, hot on top.
          float t = clamp(1.0 - vUv.y, 0.0, 1.0);
          vec3 col = mix(uHot, uCool, t);

          // Miami-Vice scan-line bands cut into the lower half of the sun.
          // Bands get taller toward the bottom so the silhouette reads as
          // "reflecting on water" even though there's no water here.
          float bandT = clamp((0.5 - vUv.y) * 2.0, 0.0, 1.0);
          float bandFreq = 28.0;
          float bandWidth = 0.35 - bandT * 0.12; // thicker bands lower down
          float band = step(bandWidth, fract(vUv.y * bandFreq));
          col *= mix(1.0, band, bandT);

          // Pulse on beats — sustained bright flash.
          col *= 1.0 + uPulse * 0.6;

          // Hue shift from treble.
          if (uHueShift > 0.001) {
            vec3 hsv = rgb2hsv(col);
            hsv.x = fract(hsv.x + uHueShift * 0.15);
            col = hsv2rgb(hsv);
          }

          // Soft edge falloff so the disc doesn't have an aliased outline.
          float edge = smoothstep(1.0, 0.96, r);
          gl_FragColor = vec4(col * edge, edge);
        }
      `,
      transparent: true,
      // No fog — we want the sun to punch through on the horizon.
      fog: false,
      depthWrite: false,
    });
    this.sun = new THREE.Mesh(geom, this.sunMaterial);
    this.sun.position.set(0, 3.2, -60);
    this.scaffold.scene.add(this.sun);
  }

  private buildSky(): void {
    this.skyMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTop: { value: new THREE.Color() },
        uHorizon: { value: new THREE.Color() },
      },
      vertexShader: `
        varying vec3 vPos;
        void main() {
          vPos = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 uTop;
        uniform vec3 uHorizon;
        varying vec3 vPos;
        void main() {
          // Gradient purely along world-space Y.
          float t = smoothstep(-10.0, 30.0, vPos.y);
          gl_FragColor = vec4(mix(uHorizon, uTop, t), 1.0);
        }
      `,
      side: THREE.BackSide,
      fog: false,
      depthWrite: false,
    });
    const geom = new THREE.SphereGeometry(120, 32, 32);
    this.sky = new THREE.Mesh(geom, this.skyMaterial);
    this.scaffold.scene.add(this.sky);
  }

  private applyPalette(): void {
    this.sunMaterial.uniforms.uHot.value.copy(this.palette.sunHot);
    this.sunMaterial.uniforms.uCool.value.copy(this.palette.sunCool);
    this.skyMaterial.uniforms.uTop.value.copy(this.palette.skyTop);
    this.skyMaterial.uniforms.uHorizon.value.copy(this.palette.skyHorizon);

    // Fog color tracks the sky-top so the grid recedes into the "night".
    const fog = this.scaffold.scene.fog as THREE.Fog | null;
    if (fog) fog.color.copy(this.palette.skyTop);
    this.scaffold.renderer.setClearColor(
      this.palette.skyTop.getHex(),
      1,
    );
  }

  private rebuildGrid(): void {
    this.disposeGrid();
    this.buildGrid();
  }

  private disposeGrid(): void {
    if (!this.gridGroup) return;
    this.scaffold.scene.remove(this.gridGroup);
    for (const child of this.gridGroup.children) {
      if (child instanceof THREE.LineSegments) {
        child.geometry.dispose();
      }
    }
    this.gridMaterial.dispose();
  }
}

function clampNum(
  raw: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export const neonGridPlugin: VisualizationPlugin = {
  id: 'neon-grid',
  name: 'Neon Grid',
  description:
    'Synthwave floor rushing toward a scan-line sun — 80s retrofuture on tap.',
  params: {
    palette: {
      type: 'select',
      label: 'Palette',
      options: PALETTE_NAMES,
      default: 'vaporwave',
    },
    speed: {
      type: 'number',
      label: 'Scroll speed',
      min: 0.1,
      max: 3,
      step: 0.05,
      default: 1,
    },
    gridDensity: {
      type: 'number',
      label: 'Grid density',
      min: 0.5,
      max: 2,
      step: 0.05,
      default: 1,
    },
    glow: {
      type: 'number',
      label: 'Glow',
      min: 0,
      max: 3,
      step: 0.05,
      default: 1,
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
    return new NeonGridMounted(ctx, container);
  },
};

export default neonGridPlugin;
