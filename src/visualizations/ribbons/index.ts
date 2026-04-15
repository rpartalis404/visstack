import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
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

type Band = 'bass' | 'mid' | 'treble' | 'energy';

/**
 * One flowing ribbon: a line strip whose head moves through 3D space on a
 * Lissajous-style trajectory modulated by an audio band. The body of the
 * ribbon is the tail of recent head positions. Thin lines + additive
 * blending + bloom reads as a thick glowing trail.
 */
interface Ribbon {
  line: Line2;
  geometry: LineGeometry;
  material: LineMaterial;
  /** Flat XYZ buffer, length = trailLength * 3. Reused across frames; set
   *  on the LineGeometry via setPositions() each tick. */
  positions: Float32Array;
  /** Flat RGB buffer, length = trailLength * 3. */
  colors: Float32Array;
  /** Lissajous frequency constants — irrational-ish ratios so no repeats. */
  a: number;
  b: number;
  c: number;
  /** Starting phase offset so ribbons don't lockstep. */
  phase: number;
  /** Which audio band drives this ribbon's amplitude. */
  band: Band;
}

const BANDS: Band[] = ['bass', 'mid', 'treble', 'energy'];

class RibbonsMounted implements MountedViz {
  private readonly scaffold: ThreeScaffold;
  private readonly composer: EffectComposer;
  private readonly bloom: UnrealBloomPass;

  private ribbons: Ribbon[] = [];
  private count = 5;
  private trailLength = 90;
  private speed = 1;
  private sensitivity = 1;
  private paletteName = 'neon';
  private cameraOrbit = true;
  private scale = 2;
  private cameraZoom = 1;
  private thickness = 5;

  // Smoothers so the lead-point motion isn't jittery
  private readonly bassSmooth = new BandSmoother(0.4, 0.1);
  private readonly midSmooth = new BandSmoother(0.45, 0.12);
  private readonly trebleSmooth = new BandSmoother(0.5, 0.15);
  private readonly energySmooth = new BandSmoother(0.35, 0.1);
  private readonly beatEnv = new BeatEnvelope(3);

  private t = 0;
  private cameraAngle = 0;
  private hueCursor = 0;

  private readonly scratchColor = new THREE.Color();

  constructor(_ctx: VisualizerContext, container: HTMLElement) {
    this.scaffold = createThreeScaffold(container, {
      fov: 55,
      cameraZ: 9,
      clearColor: 0x040408,
      far: 100,
    });

    this.composer = new EffectComposer(this.scaffold.renderer);
    this.composer.addPass(new RenderPass(this.scaffold.scene, this.scaffold.camera));
    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(this.scaffold.width, this.scaffold.height),
      1.2, // strength — bloom does the heavy lifting for "thickness"
      0.7,
      0.0,
    );
    this.composer.addPass(this.bloom);

    this.buildRibbons();
  }

  setParams(p: ParamValues): void {
    const nextCount = clampInt(p.ribbons, 2, 10, 5);
    const nextLen = clampInt(p.length, 20, 200, 90);

    this.speed = clampNum(p.speed, 0.2, 3, 1);
    this.sensitivity = clampNum(p.sensitivity, 0.3, 3, 1);
    this.paletteName = String(p.palette ?? 'neon');
    this.cameraOrbit = Boolean(p.cameraOrbit ?? true);
    this.scale = clampNum(p.scale, 0.5, 5, 2);
    this.cameraZoom = clampNum(p.cameraZoom, 0.4, 3, 1);
    const nextThickness = clampNum(p.thickness, 1, 25, 5);
    this.thickness = nextThickness;
    // Push the new linewidth to every ribbon's material — pixel units, so
    // it stays visually consistent regardless of camera distance
    for (const r of this.ribbons) {
      r.material.linewidth = nextThickness;
    }
    const glow = clampNum(p.glow, 0, 3, 1.2);
    this.bloom.strength = 0.4 + glow * 1.1;

    if (nextCount !== this.count || nextLen !== this.trailLength) {
      this.count = nextCount;
      this.trailLength = nextLen;
      this.rebuildRibbons();
    }
  }

  resize(w: number, h: number): void {
    this.scaffold.resize(w, h);
    this.composer.setSize(w, h);
    this.bloom.setSize(w, h);
    // LineMaterial uses pixel-width lines, which requires knowing the
    // viewport dimensions in its `resolution` uniform
    for (const r of this.ribbons) {
      r.material.resolution.set(w, h);
    }
  }

  render(frame: AudioFrame, _params: ParamValues, dt: number): void {
    const s = this.sensitivity;
    const bass = this.bassSmooth.update(Math.min(1, frame.bass * s));
    const mid = this.midSmooth.update(Math.min(1, frame.mid * s));
    const treble = this.trebleSmooth.update(Math.min(1, frame.treble * s));
    const energy = this.energySmooth.update(Math.min(1, frame.energy * s));
    const beatPulse = this.beatEnv.update(frame.beat, dt);

    // Always-on time advance, scaled by speed + energy
    this.t += dt * this.speed * (0.5 + energy * 0.5);
    this.hueCursor += dt * (0.03 + treble * 0.3);

    // Always-on camera orbit (independent of audio for a baseline feel).
    // Distance scales with both the user's zoom dial AND the geometry scale,
    // so cranking up scale doesn't push ribbons out of frame.
    if (this.cameraOrbit) {
      this.cameraAngle += dt * this.speed * 0.12;
      const baseR = (8 + this.scale * 1.5) * this.cameraZoom;
      const R = baseR + beatPulse * 0.6;
      const cam = this.scaffold.camera;
      cam.position.set(
        Math.cos(this.cameraAngle) * R,
        Math.sin(this.cameraAngle * 0.41) * 2.5,
        Math.sin(this.cameraAngle) * R,
      );
      cam.lookAt(0, 0, 0);
    } else {
      // Static camera: still respect zoom so the dial works
      const cam = this.scaffold.camera;
      const R = (8 + this.scale * 1.5) * this.cameraZoom;
      cam.position.set(0, 0, R);
      cam.lookAt(0, 0, 0);
    }

    const bandValue = (b: Band): number => {
      switch (b) {
        case 'bass': return bass;
        case 'mid': return mid;
        case 'treble': return treble;
        case 'energy': return energy;
      }
    };

    for (let r = 0; r < this.ribbons.length; r++) {
      const ribbon = this.ribbons[r];
      // Geometry amplitude scales with the user's Scale dial — bigger
      // ribbons feel more present
      const amp = (1.5 + bandValue(ribbon.band) * 3.5 + beatPulse * 0.5) * this.scale;
      const t = this.t + ribbon.phase;

      // New head position on a Lissajous curve in 3D
      const x = Math.cos(t * ribbon.a) * amp;
      const y = Math.sin(t * ribbon.b + ribbon.phase * 0.3) * amp;
      const z = Math.cos(t * ribbon.c + ribbon.phase * 0.7) * amp * 0.7;

      // Shift all existing positions one slot toward the tail (fading end),
      // then write the new head at index 0
      const positions = ribbon.positions;
      const colors = ribbon.colors;
      for (let i = (this.trailLength - 1) * 3; i >= 3; i -= 3) {
        positions[i] = positions[i - 3];
        positions[i + 1] = positions[i - 2];
        positions[i + 2] = positions[i - 1];
      }
      positions[0] = x;
      positions[1] = y;
      positions[2] = z;

      // Color: head bright, decays toward tail. Palette cursor shifts over
      // time so ribbons change color gradually.
      samplePalette(this.paletteName, this.hueCursor + r * 0.17, this.scratchColor);
      const baseR = this.scratchColor.r;
      const baseG = this.scratchColor.g;
      const baseB = this.scratchColor.b;
      for (let i = 0; i < this.trailLength; i++) {
        // i=0 is head (brightest), i=trailLength-1 is tail (near black)
        const age = i / (this.trailLength - 1);
        const fade = Math.pow(1 - age, 1.8);
        const i3 = i * 3;
        colors[i3] = baseR * fade;
        colors[i3 + 1] = baseG * fade;
        colors[i3 + 2] = baseB * fade;
      }

      // LineGeometry rebuilds its internal instanced buffers when we call
      // setPositions / setColors. For our 90-200 vertex trails the cost
      // is negligible and gets us proper variable-thickness lines.
      ribbon.geometry.setPositions(ribbon.positions);
      ribbon.geometry.setColors(ribbon.colors);
    }

    this.composer.render();
  }

  destroy(): void {
    this.disposeRibbons();
    this.composer.dispose();
    this.scaffold.destroy();
  }

  // --- internals ---

  private buildRibbons(): void {
    for (let r = 0; r < this.count; r++) {
      // Irrational-ish ratios so the Lissajous curves don't repeat trivially
      const a = 0.31 + r * 0.07;
      const b = 0.43 + r * 0.11;
      const c = 0.23 + r * 0.05;
      const phase = r * 1.61803398;
      const band = BANDS[r % BANDS.length];

      const positions = new Float32Array(this.trailLength * 3);
      const colors = new Float32Array(this.trailLength * 3);

      // Line2 with proper thick-line rendering. LineGeometry takes flat
      // position / color arrays the same shape as BufferGeometry but
      // internally builds an InstancedBufferGeometry of segment quads.
      const geometry = new LineGeometry();
      geometry.setPositions(positions);
      geometry.setColors(colors);

      const material = new LineMaterial({
        vertexColors: true,
        linewidth: this.thickness,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        worldUnits: false,
      });
      material.resolution.set(this.scaffold.width, this.scaffold.height);

      const line = new Line2(geometry, material);
      // Line2 needs an explicit computed bounds; otherwise frustum culling
      // can drop it the first frame
      line.computeLineDistances();
      line.frustumCulled = false;
      this.scaffold.scene.add(line);
      this.ribbons.push({
        line,
        geometry,
        material,
        positions,
        colors,
        a,
        b,
        c,
        phase,
        band,
      });
    }
  }

  private rebuildRibbons(): void {
    this.disposeRibbons();
    this.buildRibbons();
  }

  private disposeRibbons(): void {
    for (const r of this.ribbons) {
      this.scaffold.scene.remove(r.line);
      r.geometry.dispose();
      r.material.dispose();
    }
    this.ribbons = [];
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

export const ribbonsPlugin: VisualizationPlugin = {
  id: 'ribbons',
  name: 'Ribbons',
  description:
    'Flowing 3D ribbons that trace Lissajous paths modulated by audio bands.',
  params: {
    palette: {
      type: 'select',
      label: 'Palette',
      options: PALETTE_NAMES,
      default: 'neon',
    },
    ribbons: {
      type: 'number',
      label: 'Ribbons',
      min: 2,
      max: 10,
      step: 1,
      default: 5,
    },
    length: {
      type: 'number',
      label: 'Trail length',
      min: 20,
      max: 200,
      step: 5,
      default: 90,
    },
    scale: {
      type: 'number',
      label: 'Scale',
      min: 0.5,
      max: 5,
      step: 0.05,
      default: 2.4,
    },
    thickness: {
      type: 'number',
      label: 'Thickness',
      min: 1,
      max: 25,
      step: 0.5,
      default: 6,
    },
    cameraZoom: {
      type: 'number',
      label: 'Camera zoom',
      min: 0.4,
      max: 3,
      step: 0.05,
      default: 1,
    },
    speed: {
      type: 'number',
      label: 'Speed',
      min: 0.2,
      max: 3,
      step: 0.05,
      default: 1,
    },
    glow: {
      type: 'number',
      label: 'Glow',
      min: 0,
      max: 3,
      step: 0.05,
      default: 1.2,
    },
    sensitivity: {
      type: 'number',
      label: 'Sensitivity',
      min: 0.3,
      max: 3,
      step: 0.05,
      default: 1,
    },
    cameraOrbit: {
      type: 'boolean',
      label: 'Camera orbit',
      default: true,
    },
  },
  mount(container, ctx) {
    return new RibbonsMounted(ctx, container);
  },
};

export default ribbonsPlugin;
