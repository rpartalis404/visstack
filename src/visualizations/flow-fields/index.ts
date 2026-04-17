import * as THREE from 'three';
import type { AudioFrame } from '../../audio/types';
import type {
  MountedViz,
  ParamValues,
  VisualizationPlugin,
  VisualizerContext,
} from '../types';
import { PALETTE_NAMES, samplePalette } from '../common/palettes';

/**
 * Flow Fields — a particle swarm drifting through a smooth vector
 * field, tracing the field's currents.
 *
 * Each particle samples a position-and-time-dependent 2D field at its
 * current location to get a velocity direction, advances in that
 * direction, and leaves a colored trail. Over time the visible pattern
 * reveals the "streamlines" of the field — long, swirling strokes that
 * evoke wind maps, ocean currents, or smoke trails.
 *
 * The field itself is a pair of sin/cos products (cheap, smooth,
 * deterministic), modulated by audio:
 *   - bass warps the field frequency (tight swirls on loud bass)
 *   - mid rotates the field slowly, making the whole scene turn
 *   - treble accelerates particle speed, giving a kinetic "rush"
 *   - beats bump the fade rate, briefly revealing older trail history
 *
 * Pure 2D canvas — no WebGL — so it's cheap and identical between the
 * webapp and the sandboxed extension iframe.
 */

interface Particle {
  x: number;
  y: number;
  /** Life counter — respawns at 0 or when off-screen. */
  life: number;
  /** Per-particle color phase on the palette LUT (0..1). */
  hue: number;
  /** Low-passed velocity for smooth trails (no per-frame direction jitter). */
  vx: number;
  vy: number;
}

class FlowFieldsMounted implements MountedViz {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private particles: Particle[] = [];

  /** RGB strings pre-baked from the active palette — cheap to look up
   *  every particle per frame vs. re-formatting rgb() strings each time. */
  private paletteLUT: string[] = [];

  // Params
  private paletteName = 'neon';
  private count = 1500;
  private noiseScale = 1;
  private baseSpeed = 1;
  private fadeRate = 0.05;
  private sensitivity = 1;
  private lineWidth = 1;

  private widthCss = 0;
  private heightCss = 0;
  private t = 0;

  private readonly scratchColor = new THREE.Color();

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
    if (!cx) throw new Error('Flow Fields: 2D context unavailable');
    this.ctx = cx;

    this.buildPaletteLUT();
    const rect = container.getBoundingClientRect();
    this.resize(Math.max(1, rect.width), Math.max(1, rect.height));
  }

  setParams(p: ParamValues): void {
    const nextPalette = String(p.palette ?? 'neon');
    if (nextPalette !== this.paletteName) {
      this.paletteName = nextPalette;
      this.buildPaletteLUT();
    }
    this.noiseScale = clamp(Number(p.noiseScale ?? 1), 0.3, 3);
    this.baseSpeed = clamp(Number(p.speed ?? 1), 0.2, 3);
    this.fadeRate = clamp(Number(p.fadeRate ?? 0.05), 0.01, 0.25);
    this.sensitivity = clamp(Number(p.sensitivity ?? 1), 0.3, 3);
    this.lineWidth = clamp(Number(p.lineWidth ?? 1), 0.5, 4);

    const nextCount = Math.round(clamp(Number(p.count ?? 1500), 300, 4000));
    if (nextCount !== this.count) {
      this.count = nextCount;
      this.respawnAll();
    }
  }

  resize(w: number, h: number): void {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.floor(w * dpr));
    this.canvas.height = Math.max(1, Math.floor(h * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.widthCss = w;
    this.heightCss = h;
    // Clear previous frame entirely on resize — old trails would be at
    // the wrong positions after a dimension change.
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, w, h);
    this.respawnAll();
  }

  render(frame: AudioFrame, _p: ParamValues, dt: number): void {
    this.t += dt;
    const s = this.sensitivity;
    const bass = Math.min(1, frame.bass * s);
    const mid = Math.min(1, frame.mid * s);
    const treble = Math.min(1, frame.treble * s);

    // Fade the canvas — higher fadeRate = shorter visible trails. Beats
    // briefly thin the fade (less opacity each tick) so a flash of
    // history becomes visible.
    const beatBoost = frame.beat ? 0.6 : 1.0;
    const fade = this.fadeRate * beatBoost;
    this.ctx.fillStyle = `rgba(0, 0, 0, ${fade})`;
    this.ctx.fillRect(0, 0, this.widthCss, this.heightCss);

    // Field parameters: bass tightens the spatial frequency; mid rotates
    // the whole field; treble drives speed.
    const fieldFreq = 0.0025 * this.noiseScale * (1 + bass * 0.8);
    const fieldRot = this.t * 0.15 + mid * 2;
    const cosR = Math.cos(fieldRot);
    const sinR = Math.sin(fieldRot);
    const speedPx = 120 * this.baseSpeed * (1 + treble * 1.2 + bass * 0.6);

    this.ctx.lineWidth = this.lineWidth;
    this.ctx.lineCap = 'round';

    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];

      // Sample the field at this particle's position.
      // Two orthogonal sin/cos terms give a smooth 2D vector field
      // that evolves over time. Rotating by `fieldRot` turns the whole
      // field — much cheaper than recomputing per-particle rotation.
      const sx = p.x * fieldFreq;
      const sy = p.y * fieldFreq;
      const tt = this.t * 0.35;
      const rx =
        Math.sin(sx + tt) * Math.cos(sy * 1.3 + tt * 0.7) +
        Math.sin(sy * 0.8 + tt * 1.2) * 0.4;
      const ry =
        Math.cos(sy + tt * 0.9) * Math.sin(sx * 1.2 + tt * 0.6) +
        Math.cos(sx * 0.7 + tt * 1.1) * 0.4;
      // Rotate the sampled vector by fieldRot.
      const dx = rx * cosR - ry * sinR;
      const dy = rx * sinR + ry * cosR;

      // Low-pass the velocity — prevents the path from zig-zagging on
      // every frame (field can change rapidly across space).
      p.vx = p.vx * 0.82 + dx * 0.18;
      p.vy = p.vy * 0.82 + dy * 0.18;

      const prevX = p.x;
      const prevY = p.y;
      p.x += p.vx * speedPx * dt;
      p.y += p.vy * speedPx * dt;
      p.life -= dt;

      // Recycle particles that went off-screen or timed out. Random
      // respawn anywhere — clustering would make some spots empty.
      if (
        p.life <= 0 ||
        p.x < -20 ||
        p.x > this.widthCss + 20 ||
        p.y < -20 ||
        p.y > this.heightCss + 20
      ) {
        p.x = Math.random() * this.widthCss;
        p.y = Math.random() * this.heightCss;
        p.vx = 0;
        p.vy = 0;
        p.life = 2 + Math.random() * 6;
        p.hue = Math.random();
        continue;
      }

      // Draw a short line segment from previous to current position.
      // Segments compose into long curvy trails over many frames.
      const hue = (p.hue + this.t * 0.04) % 1;
      const idx = Math.floor(hue * 256) & 255;
      this.ctx.strokeStyle = this.paletteLUT[idx];
      this.ctx.beginPath();
      this.ctx.moveTo(prevX, prevY);
      this.ctx.lineTo(p.x, p.y);
      this.ctx.stroke();
    }
  }

  destroy(): void {
    if (this.canvas.parentElement === this.container) {
      this.container.removeChild(this.canvas);
    }
  }

  // --- internals ------------------------------------------------------------

  private buildPaletteLUT(): void {
    // 256-entry precomputed rgb-string lookup. Built once per palette
    // change; cheap per-particle read in the hot loop.
    const col = this.scratchColor;
    this.paletteLUT = new Array(256);
    for (let i = 0; i < 256; i++) {
      samplePalette(this.paletteName, i / 256, col);
      const r = Math.round(col.r * 255);
      const g = Math.round(col.g * 255);
      const b = Math.round(col.b * 255);
      this.paletteLUT[i] = `rgb(${r},${g},${b})`;
    }
  }

  private respawnAll(): void {
    this.particles = new Array(this.count);
    for (let i = 0; i < this.count; i++) {
      this.particles[i] = {
        x: Math.random() * this.widthCss,
        y: Math.random() * this.heightCss,
        life: Math.random() * 6,
        hue: Math.random(),
        vx: 0,
        vy: 0,
      };
    }
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

export const flowFieldsPlugin: VisualizationPlugin = {
  id: 'flow-fields',
  name: 'Flow Fields',
  description:
    'A particle swarm tracing the currents of a smooth audio-modulated vector field.',
  params: {
    palette: {
      type: 'select',
      label: 'Palette',
      options: PALETTE_NAMES,
      default: 'neon',
    },
    count: {
      type: 'number',
      label: 'Particle count',
      min: 300,
      max: 4000,
      step: 50,
      default: 1500,
    },
    speed: {
      type: 'number',
      label: 'Speed',
      min: 0.2,
      max: 3,
      step: 0.05,
      default: 1,
    },
    noiseScale: {
      type: 'number',
      label: 'Field scale',
      min: 0.3,
      max: 3,
      step: 0.05,
      default: 1,
    },
    fadeRate: {
      type: 'number',
      label: 'Trail fade',
      min: 0.01,
      max: 0.25,
      step: 0.005,
      default: 0.05,
    },
    lineWidth: {
      type: 'number',
      label: 'Line width',
      min: 0.5,
      max: 4,
      step: 0.1,
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
    return new FlowFieldsMounted(container, ctx);
  },
};

export default flowFieldsPlugin;
