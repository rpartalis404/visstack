import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { AfterimagePass } from 'three/examples/jsm/postprocessing/AfterimagePass.js';
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

type ShapeKind =
  | 'icosahedron'
  | 'torusKnot'
  | 'octahedron'
  | 'box'
  | 'tetra'
  | 'dodecahedron';

const SHAPE_ORDER: ShapeKind[] = [
  'icosahedron',
  'torusKnot',
  'octahedron',
  'box',
  'tetra',
  'dodecahedron',
];

const ARRANGEMENTS = ['ring', 'spiral', 'helix', 'scatter'] as const;
type Arrangement = (typeof ARRANGEMENTS)[number];

const SHAPE_STYLES = ['solid+wire', 'solid', 'wireframe'] as const;
type ShapeStyle = (typeof SHAPE_STYLES)[number];

function makeGeometry(kind: ShapeKind): THREE.BufferGeometry {
  switch (kind) {
    case 'icosahedron':
      return new THREE.IcosahedronGeometry(1, 0);
    case 'torusKnot':
      return new THREE.TorusKnotGeometry(0.7, 0.25, 64, 8);
    case 'octahedron':
      return new THREE.OctahedronGeometry(1, 0);
    case 'box':
      return new THREE.BoxGeometry(1.4, 1.4, 1.4);
    case 'tetra':
      return new THREE.TetrahedronGeometry(1.2, 0);
    case 'dodecahedron':
      return new THREE.DodecahedronGeometry(1, 0);
  }
}

/**
 * Compute a base (centered-on-origin) position for the i-th of N shapes
 * under a given arrangement. Visualizations read this, then add per-frame
 * motion offsets on top.
 */
function basePositionFor(
  arrangement: Arrangement,
  i: number,
  n: number,
  scratch: THREE.Vector3,
): THREE.Vector3 {
  // Scale base radius with density so rings don't get visually clogged at
  // high counts. With shape diameter ~2, we want at least ~1.6 units of
  // arc length between centers.
  const densityScaled = (base: number) =>
    Math.max(base, (n * 1.5) / (2 * Math.PI));

  switch (arrangement) {
    case 'ring': {
      const angle = (i / n) * Math.PI * 2;
      const r = densityScaled(2.8);
      return scratch.set(Math.cos(angle) * r, Math.sin(angle) * r, 0);
    }
    case 'spiral': {
      // Shapes climb along Z while rotating
      const angle = i * 0.75;
      const r = densityScaled(2.2) + (i / n) * 1.5;
      const z = (i / (n - 1 || 1) - 0.5) * 7;
      return scratch.set(Math.cos(angle) * r, Math.sin(angle) * r, z);
    }
    case 'helix': {
      // Double helix: even i on one strand, odd on the other
      const angle = (i / 2) * 1.1 + (i % 2 ? Math.PI : 0);
      const r = densityScaled(2.4);
      const z = (i / (n - 1 || 1) - 0.5) * 7;
      return scratch.set(Math.cos(angle) * r, Math.sin(angle) * r, z);
    }
    case 'scatter': {
      // Deterministic pseudo-random distribution inside a shell
      const seed = i * 9301 + 49297;
      const a = (seed % 1000) / 1000;
      const b = ((seed * 13) % 1000) / 1000;
      const c = ((seed * 29) % 1000) / 1000;
      const theta = a * Math.PI * 2;
      const phi = Math.acos(2 * b - 1);
      const r = densityScaled(2.2) + c * 1.8;
      return scratch.set(
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.sin(phi) * Math.sin(theta),
        r * Math.cos(phi),
      );
    }
  }
}

interface RingMesh {
  group: THREE.Group;
  mesh: THREE.Mesh;
  wire: THREE.LineSegments;
  material: THREE.MeshStandardMaterial;
  wireMaterial: THREE.LineBasicMaterial;
  /** Base position under current arrangement (updated on rebuild). */
  basePos: THREE.Vector3;
  /** Unique per-shape phase offset so they don't all pulse in lockstep. */
  phase: number;
}

class PrismMounted implements MountedViz {
  private readonly scaffold: ThreeScaffold;
  private readonly composer: EffectComposer;
  private readonly afterimage: AfterimagePass;
  private readonly bloom: UnrealBloomPass;

  private meshes: RingMesh[] = [];
  private shapeIndex = 0;

  // Mirrors of the current params (cached to avoid Number/String conversions
  // in the render hot path).
  private paletteName = 'neon';
  private sensitivity = 1;
  private density = 6;
  private motion = 1;
  private orbit = true;
  private pushOut = true;
  private arrangement: Arrangement = 'ring';
  private shapeStyle: ShapeStyle = 'solid+wire';
  private speed = 1;
  private cameraZoom = 1;

  private hueCursor = 0;
  private cameraAngle = 0;
  /** Throttle shape cycling — jazz triggers many beats per second so we
   *  only swap every ~1.2s minimum to avoid a visually chaotic cycle. */
  private lastShapeSwapT = 0;

  // Smoothers — tame transient pops into a visually musical response
  private readonly bassSmooth = new BandSmoother(0.4, 0.1);
  private readonly midSmooth = new BandSmoother(0.45, 0.12);
  private readonly trebleSmooth = new BandSmoother(0.5, 0.15);
  private readonly energySmooth = new BandSmoother(0.35, 0.1);
  private readonly beatEnv = new BeatEnvelope(3);

  /** Reusable scratches to avoid allocations in render(). */
  private readonly scratchColor = new THREE.Color();
  private readonly scratchVec = new THREE.Vector3();

  constructor(_ctx: VisualizerContext, container: HTMLElement) {
    this.scaffold = createThreeScaffold(container, {
      fov: 60,
      cameraZ: 7,
      clearColor: 0x06060b,
    });

    // Lighting — low ambient + a couple of colored point lights for depth
    this.scaffold.scene.add(new THREE.AmbientLight(0xffffff, 0.15));
    const l1 = new THREE.PointLight(0xff4d9f, 1.2, 30);
    l1.position.set(6, 4, 6);
    this.scaffold.scene.add(l1);
    const l2 = new THREE.PointLight(0x4dc9ff, 1.0, 30);
    l2.position.set(-6, -4, 6);
    this.scaffold.scene.add(l2);

    this.composer = new EffectComposer(this.scaffold.renderer);
    this.composer.addPass(new RenderPass(this.scaffold.scene, this.scaffold.camera));

    this.afterimage = new AfterimagePass(0.88);
    this.composer.addPass(this.afterimage);

    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(this.scaffold.width, this.scaffold.height),
      0.9,
      0.6,
      0.15,
    );
    this.composer.addPass(this.bloom);

    this.buildShapes();
  }

  setParams(p: ParamValues): void {
    const nextPalette = String(p.palette ?? 'neon');
    const nextDensity = clampInt(p.density, 3, 16, 6);
    const nextTrails = Boolean(p.trails ?? true);
    const nextSens = clampNum(p.sensitivity, 0.1, 3, 1);
    const nextMotion = clampNum(p.motion, 0, 2.5, 1);
    const nextOrbit = Boolean(p.cameraOrbit ?? true);
    const nextPush = Boolean(p.bassPush ?? true);
    const nextGlow = clampNum(p.glow, 0, 3, 1);
    const nextSpeed = clampNum(p.speed, 0.2, 3, 1);
    const nextZoom = clampNum(p.cameraZoom, 0.5, 3, 1);
    const nextArrangement =
      (ARRANGEMENTS as readonly string[]).includes(String(p.arrangement))
        ? (p.arrangement as Arrangement)
        : 'ring';
    const nextStyle =
      (SHAPE_STYLES as readonly string[]).includes(String(p.shapeStyle))
        ? (p.shapeStyle as ShapeStyle)
        : 'solid+wire';

    this.paletteName = nextPalette;
    this.sensitivity = nextSens;
    this.motion = nextMotion;
    this.orbit = nextOrbit;
    this.pushOut = nextPush;
    this.speed = nextSpeed;
    this.cameraZoom = nextZoom;
    this.bloom.strength = 0.3 + nextGlow * 1.1; // 0..3 → 0.3..3.6

    // Afterimage damping: higher = longer trails. Flip off = no trails.
    this.afterimage.uniforms.damp.value = nextTrails ? 0.88 : 0;

    const structureChanged =
      nextDensity !== this.density ||
      nextArrangement !== this.arrangement ||
      nextStyle !== this.shapeStyle;
    if (structureChanged) {
      this.density = nextDensity;
      this.arrangement = nextArrangement;
      this.shapeStyle = nextStyle;
      this.rebuild();
    }
  }

  resize(w: number, h: number): void {
    this.scaffold.resize(w, h);
    this.composer.setSize(w, h);
    this.bloom.setSize(w, h);
  }

  render(frame: AudioFrame, _params: ParamValues, dt: number): void {
    const s = this.sensitivity;
    const bass = this.bassSmooth.update(Math.min(1, frame.bass * s));
    const mid = this.midSmooth.update(Math.min(1, frame.mid * s));
    const treble = this.trebleSmooth.update(Math.min(1, frame.treble * s));
    const energy = this.energySmooth.update(Math.min(1, frame.energy * s));
    const beatPulse = this.beatEnv.update(frame.beat, dt);

    // Always-on baseline animation: hue cursor + camera orbit. These run
    // even at silence so the scene never feels dead.
    this.hueCursor += dt * this.speed * (0.06 + treble * 0.35);
    if (this.orbit) {
      this.cameraAngle += dt * this.speed * (0.15 + energy * 0.4);
      // Camera distance scales with arrangement size AND user zoom dial.
      // Default base is generous so the user sees the whole scene; the
      // energy dolly is subtle so loud passages don't feel claustrophobic.
      const arrangementSize = Math.max(9, this.density * 0.85);
      const R = (arrangementSize - energy * 0.4) * this.cameraZoom;
      const cam = this.scaffold.camera;
      cam.position.set(
        Math.cos(this.cameraAngle) * R,
        Math.sin(this.cameraAngle * 0.37) * 1.5,
        Math.sin(this.cameraAngle) * R,
      );
      cam.lookAt(0, 0, 0);
    } else {
      // Static camera: still respect zoom so the dial is meaningful when
      // orbit is off
      const arrangementSize = Math.max(9, this.density * 0.85);
      const cam = this.scaffold.camera;
      cam.position.set(0, 0, arrangementSize * this.cameraZoom);
      cam.lookAt(0, 0, 0);
    }

    // Beat → cycle shape, but throttled to avoid a chaotic swap cascade
    // on dense beat-detect output (jazz/ghost notes). 1.2s minimum gap.
    if (frame.beat && frame.t - this.lastShapeSwapT > 1.2) {
      this.lastShapeSwapT = frame.t;
      this.shapeIndex = (this.shapeIndex + 1) % SHAPE_ORDER.length;
      this.swapGeometry(SHAPE_ORDER[this.shapeIndex]);
    }

    for (let i = 0; i < this.meshes.length; i++) {
      const m = this.meshes[i];

      // Per-mesh rotation — mix of baseline + mid-driven
      const rot = dt * this.speed * (0.4 + mid * 2.5);
      m.group.rotation.y += rot;
      m.group.rotation.x += rot * 0.55;

      // Position = basePos + motion orbit + bass radial push
      const t = frame.t * this.speed;
      const orbitX = Math.cos(t * 0.9 + m.phase) * 0.35 * this.motion;
      const orbitY = Math.sin(t * 0.7 + m.phase * 1.3) * 0.35 * this.motion;
      const orbitZ = Math.sin(t * 0.55 + m.phase) * 0.25 * this.motion;

      this.scratchVec.copy(m.basePos);
      if (this.pushOut) {
        const push = 1 + bass * 0.7;
        this.scratchVec.multiplyScalar(push);
      }
      m.group.position.set(
        this.scratchVec.x + orbitX,
        this.scratchVec.y + orbitY,
        this.scratchVec.z + orbitZ,
      );

      // Per-shape scale = small bass pulse + phase jitter
      const pulse = 1 + bass * 0.35;
      const phaseJitter = Math.sin(t * 1.2 + i) * 0.08;
      m.group.scale.setScalar(pulse + phaseJitter);

      // Material color — sampled at a per-mesh offset on the palette cursor
      const cursor = this.hueCursor + i * 0.13;
      samplePalette(this.paletteName, cursor, this.scratchColor);

      m.material.color.copy(this.scratchColor);
      // Emissive drives most of the "glow" feel; beat envelope adds a
      // sustained brightening rather than a 1-frame pop
      m.material.emissive.copy(this.scratchColor).multiplyScalar(
        0.2 + bass * 0.55 + beatPulse * 0.25,
      );
      m.material.emissiveIntensity = 0.6 + treble * 1.2 + beatPulse * 0.4;

      m.wireMaterial.color.copy(this.scratchColor).multiplyScalar(0.6 + treble * 0.5);
      m.wireMaterial.opacity = 0.25 + treble * 0.6;
    }

    this.composer.render();
  }

  destroy(): void {
    this.disposeShapes();
    this.composer.dispose();
    this.scaffold.destroy();
  }

  // --- internals ---

  private buildShapes(): void {
    const geometry = makeGeometry(SHAPE_ORDER[this.shapeIndex]);
    const edges = new THREE.EdgesGeometry(geometry);
    const showSolid = this.shapeStyle !== 'wireframe';
    const showWire = this.shapeStyle !== 'solid';

    for (let i = 0; i < this.density; i++) {
      const group = new THREE.Group();
      const basePos = basePositionFor(
        this.arrangement,
        i,
        this.density,
        new THREE.Vector3(),
      );
      group.position.copy(basePos);

      const material = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        metalness: 0.3,
        roughness: 0.35,
        emissive: 0x000000,
        emissiveIntensity: 0.6,
        transparent: !showSolid,
        opacity: showSolid ? 1 : 0,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.visible = showSolid;
      group.add(mesh);

      const wireMaterial = new THREE.LineBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: showWire ? 0.4 : 0,
      });
      const wire = new THREE.LineSegments(edges, wireMaterial);
      wire.visible = showWire;
      group.add(wire);

      this.scaffold.scene.add(group);
      this.meshes.push({
        group,
        mesh,
        wire,
        material,
        wireMaterial,
        basePos,
        // Deterministic phase spread so shapes oscillate out of sync
        phase: (i * 1.61803398) % (Math.PI * 2),
      });
    }
  }

  private rebuild(): void {
    this.disposeShapes();
    this.buildShapes();
  }

  private swapGeometry(kind: ShapeKind): void {
    const geometry = makeGeometry(kind);
    const edges = new THREE.EdgesGeometry(geometry);
    for (const m of this.meshes) {
      m.mesh.geometry.dispose();
      m.mesh.geometry = geometry;
      m.wire.geometry.dispose();
      m.wire.geometry = edges;
    }
  }

  private disposeShapes(): void {
    for (const m of this.meshes) {
      this.scaffold.scene.remove(m.group);
      m.mesh.geometry.dispose();
      m.material.dispose();
      m.wire.geometry.dispose();
      m.wireMaterial.dispose();
    }
    this.meshes = [];
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

export const prismPlugin: VisualizationPlugin = {
  id: 'prism',
  name: 'Prism',
  description:
    'Geometric shapes in configurable arrangements with always-on camera orbit.',
  params: {
    palette: {
      type: 'select',
      label: 'Palette',
      options: PALETTE_NAMES,
      default: 'neon',
    },
    arrangement: {
      type: 'select',
      label: 'Arrangement',
      options: ARRANGEMENTS,
      default: 'ring',
    },
    shapeStyle: {
      type: 'select',
      label: 'Shape style',
      options: SHAPE_STYLES,
      default: 'solid+wire',
    },
    density: {
      type: 'number',
      label: 'Density',
      min: 3,
      max: 16,
      step: 1,
      default: 6,
    },
    motion: {
      type: 'number',
      label: 'Motion',
      min: 0,
      max: 2.5,
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
    cameraZoom: {
      type: 'number',
      label: 'Camera zoom',
      min: 0.5,
      max: 3,
      step: 0.05,
      default: 1.1,
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
      max: 2.5,
      step: 0.05,
      default: 1,
    },
    cameraOrbit: { type: 'boolean', label: 'Camera orbit', default: true },
    bassPush: { type: 'boolean', label: 'Bass push outward', default: true },
    trails: { type: 'boolean', label: 'Trails', default: true },
  },
  mount(container, ctx) {
    return new PrismMounted(ctx, container);
  },
};

export default prismPlugin;
