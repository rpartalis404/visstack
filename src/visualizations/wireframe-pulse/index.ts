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
import {
  createThreeScaffold,
  type ThreeScaffold,
} from '../common/three-scaffold';
import { BandSmoother, BeatEnvelope } from '../common/reactive';

/**
 * Wireframe Pulse — one glowing polyhedron at the center of the frame,
 * its vertices rippling and breathing with the music.
 *
 * Each vertex is displaced along its surface normal by a smooth
 * sin-of-position-and-time signal, scaled by bass + mid. The shape
 * appears to inhale on loud passages and settle back at silence. A
 * slow baseline rotation keeps it alive even in quiet sections.
 *
 * Differs from "Prism" (which arranges multiple shapes in orbits): this
 * plugin is a single central shape, wireframe-only, tuned for the
 * hypnotic "object is alive" feeling rather than Prism's busy ensemble.
 *
 * Pure wireframe rendering via `MeshBasicMaterial({ wireframe: true })`
 * means every triangle edge is drawn, so the deformed surface is fully
 * visible through the mesh. Heavy additive bloom on top seals the
 * neon-outline aesthetic.
 */

type Shape =
  | 'icosphere'
  | 'torusKnot'
  | 'sphere'
  | 'octahedron'
  | 'dodecahedron';

const SHAPES: Shape[] = [
  'icosphere',
  'torusKnot',
  'sphere',
  'octahedron',
  'dodecahedron',
];

function makeGeometry(kind: Shape): THREE.BufferGeometry {
  switch (kind) {
    case 'icosphere':
      // Detail 4 → ~642 vertices, dense enough for smooth ripples.
      return new THREE.IcosahedronGeometry(1.4, 4);
    case 'torusKnot':
      return new THREE.TorusKnotGeometry(0.9, 0.32, 128, 20);
    case 'sphere':
      return new THREE.SphereGeometry(1.4, 64, 40);
    case 'octahedron':
      return new THREE.OctahedronGeometry(1.5, 4);
    case 'dodecahedron':
      return new THREE.DodecahedronGeometry(1.4, 2);
  }
}

class WireframePulseMounted implements MountedViz {
  private readonly scaffold: ThreeScaffold;
  private readonly composer: EffectComposer;
  private readonly bloom: UnrealBloomPass;

  private mesh!: THREE.Mesh;
  private geometry!: THREE.BufferGeometry;
  private material!: THREE.MeshBasicMaterial;

  /** Original vertex positions — the un-deformed baseline. */
  private origPositions!: Float32Array;
  /** Per-vertex surface normal — direction we displace along. */
  private origNormals!: Float32Array;

  private shapeIndex = 0;
  /** 'auto' = cycle on beats; otherwise pinned to one shape. */
  private shapeMode: string = 'auto';
  private lastSwapT = -99;

  // Params
  private paletteName = 'neon';
  private sensitivity = 1;
  private rotationSpeed = 1;
  private deformAmount = 1;
  private noiseFreq = 2.2;

  private hueCursor = 0;

  private readonly bassSmooth = new BandSmoother(0.4, 0.08);
  private readonly midSmooth = new BandSmoother(0.45, 0.12);
  private readonly trebleSmooth = new BandSmoother(0.5, 0.15);
  private readonly beatEnv = new BeatEnvelope(2);

  private readonly scratchColor = new THREE.Color();

  constructor(_ctx: VisualizerContext, container: HTMLElement) {
    this.scaffold = createThreeScaffold(container, {
      fov: 55,
      cameraZ: 5,
      clearColor: 0x02020a,
    });

    this.composer = new EffectComposer(this.scaffold.renderer);
    this.composer.addPass(
      new RenderPass(this.scaffold.scene, this.scaffold.camera),
    );
    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(this.scaffold.width, this.scaffold.height),
      1.4,
      0.9,
      0.0,
    );
    this.composer.addPass(this.bloom);

    this.buildMesh();
  }

  setParams(p: ParamValues): void {
    this.paletteName = String(p.palette ?? 'neon');
    this.sensitivity = clampNum(p.sensitivity, 0.3, 3, 1);
    this.rotationSpeed = clampNum(p.rotationSpeed, 0, 3, 1);
    this.deformAmount = clampNum(p.deformAmount, 0, 2, 1);
    this.noiseFreq = clampNum(p.ripple, 0.5, 6, 2.2);
    const glow = clampNum(p.glow, 0, 3, 1);
    this.bloom.strength = 0.4 + glow * 1.6;

    const nextShape = String(p.shape ?? 'auto');
    if (nextShape !== this.shapeMode) {
      this.shapeMode = nextShape;
      // Pinning to a specific shape? Swap immediately. Auto mode leaves
      // the current shape in place until the next beat.
      if (nextShape !== 'auto' && SHAPES.includes(nextShape as Shape)) {
        const idx = SHAPES.indexOf(nextShape as Shape);
        if (idx !== this.shapeIndex) {
          this.shapeIndex = idx;
          this.rebuildMesh();
        }
      }
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

    this.hueCursor += dt * (0.06 + treble * 0.35);

    // Auto-cycle shapes on beats (throttled so dense jazz beat-detect
    // doesn't flip shapes every 200ms).
    if (
      this.shapeMode === 'auto' &&
      frame.beat &&
      frame.t - this.lastSwapT > 2.5
    ) {
      this.lastSwapT = frame.t;
      this.shapeIndex = (this.shapeIndex + 1) % SHAPES.length;
      this.rebuildMesh();
    }

    // Always-on baseline rotation — scene never dies at silence.
    this.mesh.rotation.x += dt * this.rotationSpeed * 0.25;
    this.mesh.rotation.y += dt * this.rotationSpeed * 0.4;
    // Z wobble driven by mid for a little extra organic motion.
    this.mesh.rotation.z += dt * this.rotationSpeed * 0.15 * mid;

    // Vertex deformation: displace along original normal by a smooth
    // pseudo-noise term. sin-product-of-positions gives a deterministic,
    // cheap 3D noise with no library dependency. Frequency/amount are
    // tuned so the shape "breathes" on quiet bass and "shatters" on
    // loud peaks without self-intersecting grotesquely.
    const amount =
      this.deformAmount *
      (0.1 + bass * 0.55 + mid * 0.2 + beatPulse * 0.2);
    const posAttr = this.geometry.getAttribute(
      'position',
    ) as THREE.BufferAttribute;
    const positions = posAttr.array as Float32Array;
    const t = frame.t;
    const freq = this.noiseFreq;

    for (let i = 0; i < positions.length; i += 3) {
      const ox = this.origPositions[i];
      const oy = this.origPositions[i + 1];
      const oz = this.origPositions[i + 2];
      // 3D sin-product noise. Each axis uses a different time rate so
      // the pattern doesn't repeat on a visible period.
      const noise =
        Math.sin(ox * freq + t * 0.9) *
        Math.sin(oy * freq * 1.1 + t * 0.7) *
        Math.sin(oz * freq * 0.9 + t * 1.1);
      const disp = noise * amount;
      positions[i] = ox + this.origNormals[i] * disp;
      positions[i + 1] = oy + this.origNormals[i + 1] * disp;
      positions[i + 2] = oz + this.origNormals[i + 2] * disp;
    }
    posAttr.needsUpdate = true;

    // Color: palette sample brightened by bass + treble + beat.
    samplePalette(this.paletteName, this.hueCursor, this.scratchColor);
    const bright = 0.65 + bass * 0.4 + beatPulse * 0.3 + treble * 0.2;
    this.material.color.copy(this.scratchColor).multiplyScalar(bright);

    this.composer.render();
  }

  destroy(): void {
    this.disposeMesh();
    this.composer.dispose();
    this.scaffold.destroy();
  }

  // --- mesh lifecycle -------------------------------------------------------

  private buildMesh(): void {
    this.geometry = makeGeometry(SHAPES[this.shapeIndex]);
    this.geometry.computeVertexNormals();

    const posAttr = this.geometry.getAttribute(
      'position',
    ) as THREE.BufferAttribute;
    this.origPositions = new Float32Array(posAttr.array as Float32Array);

    const normAttr = this.geometry.getAttribute(
      'normal',
    ) as THREE.BufferAttribute;
    this.origNormals = new Float32Array(normAttr.array as Float32Array);

    this.material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      wireframe: true,
      transparent: true,
      opacity: 0.92,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.scaffold.scene.add(this.mesh);
  }

  private rebuildMesh(): void {
    const prevRot = this.mesh
      ? this.mesh.rotation.clone()
      : new THREE.Euler();
    this.disposeMesh();
    this.buildMesh();
    // Carry rotation across rebuilds so the shape doesn't snap back to
    // identity on every swap.
    this.mesh.rotation.copy(prevRot);
  }

  private disposeMesh(): void {
    if (!this.mesh) return;
    this.scaffold.scene.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
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

export const wireframePulsePlugin: VisualizationPlugin = {
  id: 'wireframe-pulse',
  name: 'Wireframe Pulse',
  description:
    'A glowing polyhedron breathing and rippling — vertices displaced along their normals by the bass.',
  params: {
    palette: {
      type: 'select',
      label: 'Palette',
      options: PALETTE_NAMES,
      default: 'neon',
    },
    shape: {
      type: 'select',
      label: 'Shape',
      options: ['auto', ...SHAPES],
      default: 'auto',
    },
    rotationSpeed: {
      type: 'number',
      label: 'Rotation speed',
      min: 0,
      max: 3,
      step: 0.05,
      default: 1,
    },
    deformAmount: {
      type: 'number',
      label: 'Deform amount',
      min: 0,
      max: 2,
      step: 0.05,
      default: 1,
    },
    ripple: {
      type: 'number',
      label: 'Ripple frequency',
      min: 0.5,
      max: 6,
      step: 0.1,
      default: 2.2,
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
    return new WireframePulseMounted(ctx, container);
  },
};

export default wireframePulsePlugin;
