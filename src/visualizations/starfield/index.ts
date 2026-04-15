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
import { PALETTE_NAMES, samplePalette } from '../common/palettes';
import { createThreeScaffold, type ThreeScaffold } from '../common/three-scaffold';
import { BandSmoother, BeatEnvelope } from '../common/reactive';

const MODES = ['warp', 'drift', 'vortex'] as const;
type Mode = (typeof MODES)[number];

/** Far plane for stars; also the recycle distance when they leave frame. */
const FAR_Z = 60;
/** Camera sits at z=0 looking into negative Z — stars spawn negative and
 *  travel positive toward the camera. */
const NEAR_Z = -0.5;

class StarfieldMounted implements MountedViz {
  private readonly scaffold: ThreeScaffold;
  private readonly composer: EffectComposer;
  private readonly bloom: UnrealBloomPass;

  private points!: THREE.Points;
  private positions!: Float32Array;
  private speeds!: Float32Array;
  private colors!: Float32Array;
  private sizes!: Float32Array;

  // Param mirrors
  private count = 2500;
  private baseSpeed = 1;
  private sensitivity = 1;
  private paletteName = 'neon';
  private mode: Mode = 'warp';
  private spread = 14;

  private readonly scratchColor = new THREE.Color();
  private hueCursor = 0;

  // Smoothing so jazz transients don't produce 1-frame pops in star speed.
  // Attack is moderately fast, release is slow — transients feel present
  // but the star field doesn't "snap back" jarringly between hits.
  private readonly bassSmooth = new BandSmoother(0.35, 0.08);
  private readonly midSmooth = new BandSmoother(0.4, 0.1);
  private readonly trebleSmooth = new BandSmoother(0.5, 0.15);
  private readonly energySmooth = new BandSmoother(0.3, 0.08);
  private readonly beatEnv = new BeatEnvelope(3.5);

  constructor(_ctx: VisualizerContext, container: HTMLElement) {
    this.scaffold = createThreeScaffold(container, {
      fov: 70,
      cameraZ: 0,
      clearColor: 0x02020a,
      far: 200,
    });
    // Camera looks into -Z
    this.scaffold.camera.lookAt(0, 0, -1);

    this.composer = new EffectComposer(this.scaffold.renderer);
    this.composer.addPass(new RenderPass(this.scaffold.scene, this.scaffold.camera));
    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(this.scaffold.width, this.scaffold.height),
      0.7, // strength
      0.9, // radius
      0.05, // threshold
    );
    this.composer.addPass(this.bloom);

    this.buildPoints();
  }

  setParams(p: ParamValues): void {
    const nextCount = clampInt(p.count, 500, 10000, 2500);
    const nextMode =
      (MODES as readonly string[]).includes(String(p.mode))
        ? (p.mode as Mode)
        : 'warp';

    this.baseSpeed = clampNum(p.speed, 0.1, 5, 1);
    this.sensitivity = clampNum(p.sensitivity, 0.2, 3, 1);
    this.paletteName = String(p.palette ?? 'neon');
    this.spread = clampNum(p.spread, 4, 30, 14);
    const glow = clampNum(p.glow, 0, 3, 1);
    this.bloom.strength = 0.2 + glow * 1.2;

    // FOV controls how zoomed the warp feels — wide = expansive,
    // narrow = tunnel/focused
    const nextFov = clampNum(p.fov, 30, 110, 70);
    if (Math.abs(nextFov - this.scaffold.camera.fov) > 0.5) {
      this.scaffold.camera.fov = nextFov;
      this.scaffold.camera.updateProjectionMatrix();
    }

    const rebuild = nextCount !== this.count || nextMode !== this.mode;
    if (rebuild) {
      this.count = nextCount;
      this.mode = nextMode;
      this.rebuildPoints();
    }
  }

  resize(w: number, h: number): void {
    this.scaffold.resize(w, h);
    this.composer.setSize(w, h);
    this.bloom.setSize(w, h);
  }

  render(frame: AudioFrame, _params: ParamValues, dt: number): void {
    const s = this.sensitivity;
    // Smooth the incoming bands so single-frame spikes from sharp hits
    // don't produce visible pops in star speed / brightness
    const bass = this.bassSmooth.update(Math.min(1, frame.bass * s));
    const mid = this.midSmooth.update(Math.min(1, frame.mid * s));
    const treble = this.trebleSmooth.update(Math.min(1, frame.treble * s));
    const energy = this.energySmooth.update(Math.min(1, frame.energy * s));
    const beatPulse = this.beatEnv.update(frame.beat, dt);

    this.hueCursor += dt * (0.04 + treble * 0.4);

    // Speed multiplier: softer additive contributions (peaks around ~2.1×
    // rather than the previous ~5× which felt overwhelming on loud jazz)
    const speedMul =
      this.baseSpeed * (0.7 + bass * 0.9 + energy * 0.35 + beatPulse * 0.5);

    const positions = this.positions;
    const speeds = this.speeds;
    const colors = this.colors;

    // Vortex spin rate driven by mid energy
    const twist = this.mode === 'vortex' ? dt * (0.3 + mid * 3) : 0;
    const cosT = Math.cos(twist);
    const sinT = Math.sin(twist);

    for (let i = 0; i < this.count; i++) {
      const i3 = i * 3;

      // Travel: advance Z toward camera at per-star speed * mul
      let x = positions[i3];
      let y = positions[i3 + 1];
      let z = positions[i3 + 2];

      z += speeds[i] * speedMul * dt * 10;

      // Vortex mode: rotate XY around origin each frame
      if (twist !== 0) {
        const nx = x * cosT - y * sinT;
        const ny = x * sinT + y * cosT;
        x = nx;
        y = ny;
      }

      // Drift mode: subtle sideways sway based on bass/mid
      if (this.mode === 'drift') {
        x += (mid - 0.5) * dt * 2;
        y += (bass - 0.5) * dt * 2;
      }

      // Recycle stars that passed the camera
      if (z > NEAR_Z) {
        const p = randomSpawn(this.spread);
        x = p.x;
        y = p.y;
        z = -FAR_Z + Math.random() * 3;
        speeds[i] = 0.5 + Math.random() * 1.5;
      }

      positions[i3] = x;
      positions[i3 + 1] = y;
      positions[i3 + 2] = z;

      // Color per-star: palette sampled at hueCursor + per-star phase, tinted
      // brighter on treble + beat
      const phase = (i * 0.00137) % 1;
      samplePalette(this.paletteName, this.hueCursor + phase, this.scratchColor);
      const brightness = 0.45 + treble * 0.5 + beatPulse * 0.25;
      colors[i3] = this.scratchColor.r * brightness;
      colors[i3 + 1] = this.scratchColor.g * brightness;
      colors[i3 + 2] = this.scratchColor.b * brightness;
    }

    const geom = this.points.geometry;
    const posAttr = geom.getAttribute('position') as THREE.BufferAttribute;
    const colAttr = geom.getAttribute('color') as THREE.BufferAttribute;
    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;

    // Overall point material size breathes with energy (smoothed, so it
    // doesn't chatter on every transient)
    const mat = this.points.material as THREE.PointsMaterial;
    mat.size = 0.04 + energy * 0.08 + beatPulse * 0.03;

    this.composer.render();
  }

  destroy(): void {
    this.disposePoints();
    this.composer.dispose();
    this.scaffold.destroy();
  }

  // --- internals ---

  private buildPoints(): void {
    this.positions = new Float32Array(this.count * 3);
    this.speeds = new Float32Array(this.count);
    this.colors = new Float32Array(this.count * 3);
    this.sizes = new Float32Array(this.count);

    for (let i = 0; i < this.count; i++) {
      const p = randomSpawn(this.spread);
      this.positions[i * 3] = p.x;
      this.positions[i * 3 + 1] = p.y;
      // Distribute initial depth across the full range so we don't start
      // with a single wall of stars
      this.positions[i * 3 + 2] = -FAR_Z + Math.random() * (FAR_Z + NEAR_Z);
      this.speeds[i] = 0.5 + Math.random() * 1.5;
      this.colors[i * 3] = 1;
      this.colors[i * 3 + 1] = 1;
      this.colors[i * 3 + 2] = 1;
      this.sizes[i] = 1;
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));

    const mat = new THREE.PointsMaterial({
      size: 0.08,
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    });

    this.points = new THREE.Points(geom, mat);
    this.scaffold.scene.add(this.points);
  }

  private rebuildPoints(): void {
    this.disposePoints();
    this.buildPoints();
  }

  private disposePoints(): void {
    if (!this.points) return;
    this.scaffold.scene.remove(this.points);
    this.points.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}

/** Uniform-ish spawn of a star in a box ahead of the camera. */
function randomSpawn(spread: number): { x: number; y: number } {
  // Uniform disc so density looks right regardless of aspect ratio
  const r = Math.sqrt(Math.random()) * spread;
  const a = Math.random() * Math.PI * 2;
  return { x: Math.cos(a) * r, y: Math.sin(a) * r };
}

function clampNum(raw: unknown, min: number, max: number, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  return Math.round(clampNum(raw, min, max, fallback));
}

export const starfieldPlugin: VisualizationPlugin = {
  id: 'starfield',
  name: 'Starfield',
  description:
    'Warp-speed particle field — stars fly toward camera, react to bass and beats.',
  params: {
    palette: {
      type: 'select',
      label: 'Palette',
      options: PALETTE_NAMES,
      default: 'neon',
    },
    mode: {
      type: 'select',
      label: 'Mode',
      options: MODES,
      default: 'warp',
    },
    count: {
      type: 'number',
      label: 'Star count',
      min: 500,
      max: 10000,
      step: 100,
      default: 2500,
    },
    speed: {
      type: 'number',
      label: 'Speed',
      min: 0.1,
      max: 5,
      step: 0.1,
      default: 1,
    },
    spread: {
      type: 'number',
      label: 'Spread',
      min: 4,
      max: 30,
      step: 0.5,
      default: 14,
    },
    fov: {
      type: 'number',
      label: 'Field of view',
      min: 30,
      max: 110,
      step: 1,
      default: 70,
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
      min: 0.2,
      max: 3,
      step: 0.05,
      default: 1,
    },
  },
  mount(container, ctx) {
    return new StarfieldMounted(ctx, container);
  },
};

export default starfieldPlugin;
