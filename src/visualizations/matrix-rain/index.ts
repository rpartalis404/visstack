import type { AudioFrame } from '../../audio/types';
import type {
  MountedViz,
  ParamValues,
  VisualizationPlugin,
  VisualizerContext,
} from '../types';

/**
 * Matrix Rain — cascading glyphs in the classic cyberpunk data-stream
 * look. Columns of randomized characters fall down the frame leaving
 * phosphor-like trails; bass accelerates the fall and brightens the
 * head character.
 *
 * Pure 2D canvas (no WebGL / Three.js), so it's cheap and runs
 * identically on the webapp and inside the extension's sandboxed
 * iframe.
 */

const CHAR_SETS = {
  katakana:
    'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン',
  binary: '01',
  hex: '0123456789ABCDEF',
  ascii:
    '!@#$%^&*()_+-={}[]|:;<>,.?/~`0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
  mixed:
    'アイウエオカキクケコ0123456789ABCDEF!@#$%<>*+',
} as const;
type CharSetKey = keyof typeof CHAR_SETS;

const PALETTES: Record<string, { head: string; trail: string }> = {
  'neo green': { head: '#d8ffd0', trail: '#00ff41' },
  cyan: { head: '#d0ffff', trail: '#00e0ff' },
  magenta: { head: '#ffd8ff', trail: '#ff3cff' },
  amber: { head: '#fff3d0', trail: '#ffaa00' },
  crimson: { head: '#ffd0d0', trail: '#ff1a3c' },
};

interface Column {
  /** Head's Y position in CSS pixels. */
  y: number;
  /** Per-column speed multiplier — jitters each column. */
  speed: number;
  /** Trail length in glyphs. */
  length: number;
}

class MatrixRainMounted implements MountedViz {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private columns: Column[] = [];

  // Defaults mirror the ParamSchema below. setParams() overwrites
  // them whenever the user moves a slider.
  private fontSize = 14;
  private charSet: string = CHAR_SETS.katakana;
  private palette = PALETTES['neo green'];
  private baseSpeed = 1;
  private audioBoost = 0.6;
  private density = 1;

  /** Layout dimensions in CSS pixels. Tracked so we can re-init the
   *  column set when density changes without resizing the canvas. */
  private widthCss = 0;
  private heightCss = 0;

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

    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Matrix Rain: 2D context unavailable');
    this.ctx = ctx;

    const rect = container.getBoundingClientRect();
    this.resize(Math.max(1, rect.width), Math.max(1, rect.height));
  }

  setParams(p: ParamValues): void {
    const palKey = String(p.palette ?? 'neo green');
    this.palette = PALETTES[palKey] ?? PALETTES['neo green'];

    const csKey = String(p.charSet ?? 'katakana') as CharSetKey;
    this.charSet = CHAR_SETS[csKey] ?? CHAR_SETS.katakana;

    this.baseSpeed = clamp(Number(p.speed ?? 1), 0.2, 3);
    this.audioBoost = clamp(Number(p.audioBoost ?? 0.6), 0, 1.5);

    const nextDensity = clamp(Number(p.density ?? 1), 0.3, 2.5);
    const nextFont = clamp(Math.round(Number(p.fontSize ?? 14)), 8, 28);
    if (
      Math.abs(nextDensity - this.density) > 0.01 ||
      nextFont !== this.fontSize
    ) {
      this.density = nextDensity;
      this.fontSize = nextFont;
      this.initColumns();
    }
  }

  resize(w: number, h: number): void {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.floor(w * dpr));
    this.canvas.height = Math.max(1, Math.floor(h * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.widthCss = w;
    this.heightCss = h;
    this.initColumns();
  }

  private initColumns(): void {
    // Columns are evenly spaced across the frame. Density scales the
    // column count; higher density = more columns packed tighter.
    const baseCols = Math.max(1, Math.floor(this.widthCss / this.fontSize));
    const count = Math.max(1, Math.floor(baseCols * this.density));
    const prev = this.columns;
    this.columns = Array.from({ length: count }, (_, i) => {
      // Re-use Y from previous columns where possible so a density
      // tweak doesn't reset the whole scene.
      const old = prev[i];
      return {
        y: old ? old.y : Math.random() * this.heightCss,
        speed: 0.5 + Math.random() * 0.7,
        length: 8 + Math.floor(Math.random() * 22),
      };
    });
  }

  render(frame: AudioFrame, _p: ParamValues, dt: number): void {
    const { widthCss: w, heightCss: h } = this;

    // Fade previous frame to build the phosphor trail. The alpha
    // controls trail length — higher = snappier, lower = ghostier.
    this.ctx.fillStyle = 'rgba(0, 0, 0, 0.09)';
    this.ctx.fillRect(0, 0, w, h);

    this.ctx.font = `${this.fontSize}px ui-monospace, "SF Mono", Consolas, monospace`;
    this.ctx.textBaseline = 'top';

    // Bass spikes the fall speed. dt-based so behavior is frame-rate
    // independent.
    const speedPxPerSec =
      this.fontSize * 60 * this.baseSpeed * (1 + frame.bass * this.audioBoost * 3);

    const colStep = w / this.columns.length;

    for (let i = 0; i < this.columns.length; i++) {
      const col = this.columns[i];
      const x = i * colStep + colStep / 2;

      // Draw the head glyph (brightest).
      this.ctx.fillStyle = this.palette.head;
      this.ctx.fillText(randChar(this.charSet), x, col.y);

      // Draw the trail. Alpha ramps down toward the tail; the browser
      // composites over the faded background so old glyphs persist a
      // bit even after this pass.
      this.ctx.fillStyle = this.palette.trail;
      for (let j = 1; j < col.length; j++) {
        const ty = col.y - j * this.fontSize;
        if (ty < -this.fontSize) break;
        this.ctx.globalAlpha = 1 - j / col.length;
        this.ctx.fillText(randChar(this.charSet), x, ty);
      }
      this.ctx.globalAlpha = 1;

      // Advance head. dt is in seconds, speedPxPerSec is px/sec.
      col.y += col.speed * speedPxPerSec * dt;

      // Wrap once the trail has fully left the bottom. Randomize the
      // restart so columns stay out of sync.
      if (col.y - col.length * this.fontSize > h) {
        col.y = -Math.random() * h * 0.5;
        col.length = 8 + Math.floor(Math.random() * 22);
        col.speed = 0.5 + Math.random() * 0.7;
      }
    }
  }

  destroy(): void {
    if (this.canvas.parentElement === this.container) {
      this.container.removeChild(this.canvas);
    }
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

function randChar(set: string): string {
  return set[Math.floor(Math.random() * set.length)];
}

export const matrixRainPlugin: VisualizationPlugin = {
  id: 'matrix-rain',
  name: 'Matrix Rain',
  description:
    'Cascading glyphs in the classic cyberpunk data-stream style — bass accelerates the downpour.',
  params: {
    palette: {
      type: 'select',
      label: 'Palette',
      options: ['neo green', 'cyan', 'magenta', 'amber', 'crimson'],
      default: 'neo green',
    },
    charSet: {
      type: 'select',
      label: 'Characters',
      options: ['katakana', 'binary', 'hex', 'ascii', 'mixed'],
      default: 'katakana',
    },
    speed: {
      type: 'number',
      label: 'Fall speed',
      min: 0.2,
      max: 3,
      step: 0.1,
      default: 1,
    },
    density: {
      type: 'number',
      label: 'Column density',
      min: 0.3,
      max: 2.5,
      step: 0.1,
      default: 1,
    },
    fontSize: {
      type: 'number',
      label: 'Glyph size',
      min: 8,
      max: 28,
      step: 1,
      default: 14,
    },
    audioBoost: {
      type: 'number',
      label: 'Bass boost',
      min: 0,
      max: 1.5,
      step: 0.1,
      default: 0.6,
    },
  },
  mount(container, ctx) {
    return new MatrixRainMounted(container, ctx);
  },
};

export default matrixRainPlugin;
