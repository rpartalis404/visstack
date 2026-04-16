// @ts-expect-error - butterchurn has no type declarations
import butterchurn from 'butterchurn';
// @ts-expect-error - butterchurn-presets has no type declarations
import butterchurnPresets from 'butterchurn-presets';
import type { AudioFrame } from '../../audio/types';
import type {
  MountedViz,
  ParamValues,
  VisualizationPlugin,
  VisualizerContext,
} from '../types';

type ButterchurnVisualizer = {
  connectAudio(node: AudioNode): void;
  loadPreset(preset: unknown, blendTime: number): void;
  setRendererSize(w: number, h: number): void;
  render(): void;
};

/**
 * Pick a curated default list of preset names from whatever the installed
 * butterchurn-presets package exposes. We don't hand-curate the full list —
 * we just prioritize preset authors known for fractal/psychedelic work
 * (Flexi, Geiss, Martin) and pad with alphabetical picks to reach N.
 */
function buildPresetList(all: Record<string, unknown>): string[] {
  const names = Object.keys(all);
  const preferred = names.filter((n) =>
    /(flexi|geiss|martin|fractal|psych|swirl|plasma|tunnel)/i.test(n),
  );
  const remaining = names.filter((n) => !preferred.includes(n));
  // Prefer the author-keyword matches first, then alphabetical fills
  const list = [...preferred, ...remaining.sort()].slice(0, 14);
  return list;
}

// Load once at module scope so the plugin definition can know the options
const allPresets = butterchurnPresets.getPresets() as Record<string, unknown>;
const PRESET_NAMES: readonly string[] = buildPresetList(allPresets);

class ClassicTripMounted implements MountedViz {
  private readonly canvas: HTMLCanvasElement;
  private readonly visualizer: ButterchurnVisualizer;
  private currentPreset = '';

  constructor(
    private container: HTMLElement,
    ctx: VisualizerContext,
  ) {
    const rect = container.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width * window.devicePixelRatio));
    const height = Math.max(1, Math.floor(rect.height * window.devicePixelRatio));

    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.canvas.style.position = 'absolute';
    this.canvas.style.inset = '0';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    container.appendChild(this.canvas);

    this.visualizer = butterchurn.createVisualizer(ctx.audioContext, this.canvas, {
      width,
      height,
      pixelRatio: window.devicePixelRatio,
      textureRatio: 1,
    }) as ButterchurnVisualizer;

    // Tap our analyser — Butterchurn will receive the stream's samples through it.
    this.visualizer.connectAudio(ctx.analyser);

    // Start on the first preset immediately (no blend time on boot)
    if (PRESET_NAMES.length > 0) {
      this.loadPresetByName(PRESET_NAMES[0], 0);
    }
  }

  setParams(p: ParamValues): void {
    const wantedPreset = String(p.preset ?? PRESET_NAMES[0] ?? '');
    const wantedBlend = Math.max(0, Math.min(8, Number(p.blendTime ?? 2)));
    if (wantedPreset && wantedPreset !== this.currentPreset) {
      this.loadPresetByName(wantedPreset, wantedBlend);
    }
  }

  resize(w: number, h: number): void {
    const dpr = window.devicePixelRatio;
    const pw = Math.max(1, Math.floor(w * dpr));
    const ph = Math.max(1, Math.floor(h * dpr));
    this.canvas.width = pw;
    this.canvas.height = ph;
    this.visualizer.setRendererSize(pw, ph);
  }

  render(_frame: AudioFrame, _params: ParamValues, _dt: number): void {
    this.visualizer.render();
  }

  destroy(): void {
    if (this.canvas.parentElement === this.container) {
      this.container.removeChild(this.canvas);
    }
    // Butterchurn has no explicit destroy; dropping refs is enough for GC
  }

  private loadPresetByName(name: string, blend: number): void {
    const preset = allPresets[name];
    if (!preset) return;
    this.visualizer.loadPreset(preset, blend);
    this.currentPreset = name;
  }
}

export const classicTripPlugin: VisualizationPlugin = {
  id: 'classic-trip',
  name: 'Classic Trip',
  description: 'MilkDrop-style fluid psychedelia (Butterchurn presets).',
  // Butterchurn compiles MilkDrop preset expressions via new Function(),
  // which violates strict-CSP pages like live365. In the extension this
  // plugin runs inside a sandboxed iframe (manifest.sandbox.pages) whose
  // CSP allows unsafe-eval; the flag is kept as metadata in case future
  // hosts need to know.
  evalRequired: true,
  params: {
    preset: {
      type: 'select',
      label: 'Preset',
      options: PRESET_NAMES,
      default: PRESET_NAMES[0] ?? '',
    },
    blendTime: {
      type: 'number',
      label: 'Blend seconds',
      min: 0,
      max: 8,
      step: 0.5,
      default: 2,
    },
  },
  mount(container, ctx) {
    return new ClassicTripMounted(container, ctx);
  },
};

export default classicTripPlugin;
