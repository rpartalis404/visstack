import type { AudioFrame } from '../../audio/types';
import type {
  MountedViz,
  ParamValues,
  VisualizationPlugin,
  VisualizerContext,
} from '../types';

/**
 * Circuit Traces — a glowing printed-circuit-board where pulses race
 * between nodes on every beat.
 *
 * Layout: a jittered grid of nodes with orthogonal L-shaped traces
 * between adjacent pairs (some random culling for that sparse
 * hand-routed PCB look). Pulses spawn on beats and travel along random
 * traces; when a pulse reaches its destination node, that node flares
 * and decays — so the scene always has a visible "memory" of recent
 * activity without spamming the canvas.
 *
 * Pure 2D canvas (no WebGL), which is plenty for this effect and keeps
 * it cheap inside the sandboxed extension iframe.
 *
 * Audio reactivity:
 *   - beats spawn pulses (3–9 per beat scaled by energy)
 *   - bass boosts pulse velocity
 *   - treble adds halo radius to pulses-in-flight
 *   - sensitivity scales all three together
 */

interface CircuitPalette {
  /** Canvas fade color (how quickly previous frames dim). */
  background: string;
  /** Static trace line color. */
  trace: string;
  /** Pulse core color. */
  pulseCore: string;
  /** Pulse halo color. */
  pulseGlow: string;
  /** Node halo when lit. */
  nodeGlow: string;
}

const PALETTES: Record<string, CircuitPalette> = {
  phosphor: {
    background: 'rgba(0, 0, 0, 0.18)',
    trace: 'rgba(0, 128, 64, 0.35)',
    pulseCore: '#d0ffe0',
    pulseGlow: '#50ff80',
    nodeGlow: '#c0ffd0',
  },
  amber: {
    background: 'rgba(0, 0, 0, 0.18)',
    trace: 'rgba(180, 100, 0, 0.3)',
    pulseCore: '#fff3cf',
    pulseGlow: '#ffaa22',
    nodeGlow: '#ffe6b0',
  },
  cyan: {
    background: 'rgba(0, 0, 0, 0.18)',
    trace: 'rgba(40, 130, 200, 0.3)',
    pulseCore: '#d8f6ff',
    pulseGlow: '#22ddff',
    nodeGlow: '#c8f0ff',
  },
  magenta: {
    background: 'rgba(0, 0, 0, 0.18)',
    trace: 'rgba(180, 40, 140, 0.3)',
    pulseCore: '#ffe0f2',
    pulseGlow: '#ff44aa',
    nodeGlow: '#ffc8e6',
  },
  white: {
    background: 'rgba(0, 0, 0, 0.2)',
    trace: 'rgba(110, 110, 150, 0.35)',
    pulseCore: '#ffffff',
    pulseGlow: '#aab8ff',
    nodeGlow: '#ffffff',
  },
};
const PALETTE_NAMES = Object.keys(PALETTES);

interface Node {
  x: number;
  y: number;
  /** 0..1 brightness of this node — bumped to 1 on pulse arrival, decays. */
  glow: number;
}

interface Trace {
  a: Node;
  b: Node;
  /** Single corner point giving the trace its L-shape. */
  corner: { x: number; y: number };
  /** Segment lengths for per-pulse parameterization. */
  segA: number;
  segB: number;
  total: number;
}

interface Pulse {
  trace: Trace;
  /** Distance traveled along the trace in CSS pixels. */
  dist: number;
  /** Speed in px/sec (pre-traceSpeed multiplier). */
  speed: number;
  /** Direction: 1 = a→b, -1 = b→a. */
  direction: 1 | -1;
}

class CircuitTracesMounted implements MountedViz {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  private nodes: Node[] = [];
  private traces: Trace[] = [];
  private pulses: Pulse[] = [];

  // Params
  private paletteName = 'phosphor';
  private palette: CircuitPalette = PALETTES.phosphor;
  private traceSpeedMul = 1;
  private nodeDensity = 1;
  private glowIntensity = 1;
  private sensitivity = 1;

  private widthCss = 0;
  private heightCss = 0;
  private lastBeatT = -99;
  private t = 0;

  constructor(
    private readonly container: HTMLElement,
    _ctx: VisualizerContext,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = [
      'position: absolute',
      'inset: 0',
      'width: 100%',
      'height: 100%',
      'display: block',
      'background: #000',
    ].join(';');
    container.appendChild(this.canvas);
    const cx = this.canvas.getContext('2d');
    if (!cx) throw new Error('Circuit Traces: 2D context unavailable');
    this.ctx = cx;

    const rect = container.getBoundingClientRect();
    this.resize(Math.max(1, rect.width), Math.max(1, rect.height));
  }

  setParams(p: ParamValues): void {
    this.paletteName = String(p.palette ?? 'phosphor');
    this.palette = PALETTES[this.paletteName] ?? PALETTES.phosphor;
    this.traceSpeedMul = clamp(Number(p.traceSpeed ?? 1), 0.2, 3);
    this.glowIntensity = clamp(Number(p.glowIntensity ?? 1), 0, 2);
    this.sensitivity = clamp(Number(p.sensitivity ?? 1), 0.3, 3);

    const nextDensity = clamp(Number(p.nodeDensity ?? 1), 0.5, 2);
    if (Math.abs(nextDensity - this.nodeDensity) > 0.01) {
      this.nodeDensity = nextDensity;
      this.rebuildGrid();
    }
  }

  resize(w: number, h: number): void {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.floor(w * dpr));
    this.canvas.height = Math.max(1, Math.floor(h * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.widthCss = w;
    this.heightCss = h;
    this.rebuildGrid();
  }

  render(frame: AudioFrame, _p: ParamValues, dt: number): void {
    this.t += dt;
    const s = this.sensitivity;
    const bass = Math.min(1, frame.bass * s);
    const treble = Math.min(1, frame.treble * s);
    const energy = Math.min(1, frame.energy * s);

    // Phosphor fade — the whole frame darkens each tick, so old pulse
    // tracks linger as glow before vanishing.
    this.ctx.fillStyle = this.palette.background;
    this.ctx.fillRect(0, 0, this.widthCss, this.heightCss);

    // Static trace layer — one big path, stroked once.
    this.ctx.strokeStyle = this.palette.trace;
    this.ctx.lineWidth = 1.1;
    this.ctx.lineCap = 'square';
    this.ctx.beginPath();
    for (const tr of this.traces) {
      this.ctx.moveTo(tr.a.x, tr.a.y);
      this.ctx.lineTo(tr.corner.x, tr.corner.y);
      this.ctx.lineTo(tr.b.x, tr.b.y);
    }
    this.ctx.stroke();

    // Nodes — a tiny dot always; lit nodes flare around them.
    for (const n of this.nodes) {
      if (n.glow > 0.02) {
        // Outer halo: soft-alpha big circle, bright color.
        this.ctx.globalAlpha = 0.35 * n.glow * this.glowIntensity;
        this.ctx.fillStyle = this.palette.nodeGlow;
        this.ctx.beginPath();
        this.ctx.arc(n.x, n.y, 4 + n.glow * 8, 0, Math.PI * 2);
        this.ctx.fill();
      }
      // Inner dot — always visible so unlit nodes aren't invisible.
      this.ctx.globalAlpha = 0.35 + n.glow * 0.6;
      this.ctx.fillStyle =
        n.glow > 0.3 ? this.palette.nodeGlow : this.palette.trace;
      this.ctx.beginPath();
      this.ctx.arc(n.x, n.y, 1.8, 0, Math.PI * 2);
      this.ctx.fill();
      // Decay for next frame.
      n.glow = Math.max(0, n.glow - dt * 2.2);
    }
    this.ctx.globalAlpha = 1;

    // Spawn pulses on beats — throttled to avoid spam from over-sensitive
    // beat detection (jazz ghost notes trigger multiple beats per 100ms).
    if (
      frame.beat &&
      this.t - this.lastBeatT > 0.12 &&
      this.traces.length > 0
    ) {
      this.lastBeatT = this.t;
      const count = 3 + Math.floor(energy * 6);
      for (let k = 0; k < count; k++) {
        const tr = this.traces[
          Math.floor(Math.random() * this.traces.length)
        ];
        this.pulses.push({
          trace: tr,
          dist: 0,
          speed: 160 + Math.random() * 220 + bass * 280,
          direction: Math.random() > 0.5 ? 1 : -1,
        });
      }
      // Keep pulse pool bounded — at high beat rates this stops us from
      // falling behind rendering.
      const MAX_PULSES = 140;
      if (this.pulses.length > MAX_PULSES) {
        this.pulses.splice(0, this.pulses.length - MAX_PULSES);
      }
    }

    // Advance pulses and draw as glow + core.
    for (let i = this.pulses.length - 1; i >= 0; i--) {
      const p = this.pulses[i];
      p.dist += p.speed * this.traceSpeedMul * dt;

      if (p.dist >= p.trace.total) {
        // Arrived — light up the destination node, pulse is done.
        const destNode = p.direction === 1 ? p.trace.b : p.trace.a;
        destNode.glow = 1;
        this.pulses.splice(i, 1);
        continue;
      }

      const pt = this.pointOnTrace(p.trace, p.dist, p.direction);
      const haloR = 5 + treble * 4;

      // Halo — soft larger circle for bloom feel.
      this.ctx.globalAlpha = 0.35 * this.glowIntensity;
      this.ctx.fillStyle = this.palette.pulseGlow;
      this.ctx.beginPath();
      this.ctx.arc(pt.x, pt.y, haloR, 0, Math.PI * 2);
      this.ctx.fill();

      // Core — bright small dot for the head.
      this.ctx.globalAlpha = 0.95;
      this.ctx.fillStyle = this.palette.pulseCore;
      this.ctx.beginPath();
      this.ctx.arc(pt.x, pt.y, 2, 0, Math.PI * 2);
      this.ctx.fill();
    }
    this.ctx.globalAlpha = 1;
  }

  destroy(): void {
    if (this.canvas.parentElement === this.container) {
      this.container.removeChild(this.canvas);
    }
  }

  // --- grid construction ----------------------------------------------------

  private rebuildGrid(): void {
    if (this.widthCss < 2 || this.heightCss < 2) return;

    const spacing = 80 / this.nodeDensity;
    const cols = Math.max(3, Math.ceil(this.widthCss / spacing) + 1);
    const rows = Math.max(3, Math.ceil(this.heightCss / spacing) + 1);
    const totalX = (cols - 1) * spacing;
    const totalY = (rows - 1) * spacing;
    // Center the grid so thin aspect ratios still look balanced.
    const offX = (this.widthCss - totalX) / 2;
    const offY = (this.heightCss - totalY) / 2;

    this.nodes = [];
    const grid: Node[][] = [];
    for (let j = 0; j < rows; j++) {
      grid[j] = [];
      for (let i = 0; i < cols; i++) {
        // Jitter each node ~15% of a cell so lines aren't aliased to a
        // perfectly-regular grid — hides the repetition.
        const jx = (Math.random() - 0.5) * spacing * 0.18;
        const jy = (Math.random() - 0.5) * spacing * 0.18;
        const node: Node = {
          x: offX + i * spacing + jx,
          y: offY + j * spacing + jy,
          glow: 0,
        };
        grid[j][i] = node;
        this.nodes.push(node);
      }
    }

    // Build traces. Right-and-down only so we don't double-count pairs.
    // Each potential edge has a ~70% chance — ~30% culling gives the PCB
    // its "hand-routed" look instead of a dense graph paper feel.
    this.traces = [];
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const n = grid[j][i];
        if (i < cols - 1 && Math.random() > 0.3) {
          this.addTrace(n, grid[j][i + 1]);
        }
        if (j < rows - 1 && Math.random() > 0.3) {
          this.addTrace(n, grid[j + 1][i]);
        }
        // Occasional long diagonal jump across 2 cells for visual interest.
        if (
          i < cols - 1 &&
          j < rows - 1 &&
          Math.random() > 0.85
        ) {
          this.addTrace(n, grid[j + 1][i + 1]);
        }
      }
    }

    // Reset pulses since their trace pointers are now stale.
    this.pulses = [];
  }

  private addTrace(a: Node, b: Node): void {
    // L-shape: randomize which axis the elbow breaks toward so the board
    // doesn't have a visible "always vertical-first" bias.
    const horizFirst = Math.random() > 0.5;
    const corner = horizFirst
      ? { x: b.x, y: a.y }
      : { x: a.x, y: b.y };
    const segA = Math.hypot(corner.x - a.x, corner.y - a.y);
    const segB = Math.hypot(b.x - corner.x, b.y - corner.y);
    this.traces.push({ a, b, corner, segA, segB, total: segA + segB });
  }

  /** Interpolate (x,y) along an L-shaped trace at a given distance. */
  private pointOnTrace(
    tr: Trace,
    dist: number,
    direction: 1 | -1,
  ): { x: number; y: number } {
    // For reverse direction, flip the distance so a→corner→b traversal
    // reads as b→corner→a visually.
    const d = direction === 1 ? dist : tr.total - dist;
    if (d < tr.segA) {
      const u = d / tr.segA;
      return {
        x: tr.a.x + (tr.corner.x - tr.a.x) * u,
        y: tr.a.y + (tr.corner.y - tr.a.y) * u,
      };
    }
    const u = (d - tr.segA) / tr.segB;
    return {
      x: tr.corner.x + (tr.b.x - tr.corner.x) * u,
      y: tr.corner.y + (tr.b.y - tr.corner.y) * u,
    };
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

export const circuitTracesPlugin: VisualizationPlugin = {
  id: 'circuit-traces',
  name: 'Circuit Traces',
  description:
    'A glowing PCB — pulses race along traces and nodes flare on every beat.',
  params: {
    palette: {
      type: 'select',
      label: 'Palette',
      options: PALETTE_NAMES,
      default: 'phosphor',
    },
    traceSpeed: {
      type: 'number',
      label: 'Pulse speed',
      min: 0.2,
      max: 3,
      step: 0.05,
      default: 1,
    },
    nodeDensity: {
      type: 'number',
      label: 'Node density',
      min: 0.5,
      max: 2,
      step: 0.05,
      default: 1,
    },
    glowIntensity: {
      type: 'number',
      label: 'Glow intensity',
      min: 0,
      max: 2,
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
    return new CircuitTracesMounted(container, ctx);
  },
};

export default circuitTracesPlugin;
