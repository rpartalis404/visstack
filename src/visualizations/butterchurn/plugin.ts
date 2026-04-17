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

/**
 * Shared butterchurn plugin factory.
 *
 * Each MilkDrop preset in the `butterchurn-presets` package is surfaced
 * as its own entry in the visualization switcher (rather than hiding
 * behind a dropdown on a single "Classic Trip" plugin). The logic is
 * identical for every preset — only the loaded preset differs — so we
 * share one factory and pass a config per plugin.
 *
 * See `./presets.ts` for the curated preset-key → display-name list,
 * and `../registry.ts` for how those plugins get ordered.
 */

type ButterchurnAudioLevels = {
  timeByteArray: Uint8Array;
  timeByteArrayL: Uint8Array;
  timeByteArrayR: Uint8Array;
};

type ButterchurnRenderArg = {
  audioLevels?: ButterchurnAudioLevels;
  elapsedTime?: number;
};

type ButterchurnVisualizer = {
  loadPreset(preset: unknown, blendTime: number): void;
  setRendererSize(w: number, h: number): void;
  /**
   * Butterchurn has two audio-input paths:
   *   (a) `connectAudio(analyser)` + `render()` — pulls samples from
   *       the analyser through its own audio graph. Requires the
   *       analyser's AudioContext to be running with a source.
   *   (b) `render({ audioLevels })` — takes time-domain byte arrays
   *       directly and runs butterchurn's own FFT. No audio graph
   *       required.
   *
   * We use (b). It works in both the webapp (samples come from a live
   * analyser) and in the extension (samples are postMessage'd in from
   * the content-script frame where the AudioContext actually runs —
   * the sandboxed viz iframe has no stream to feed).
   */
  render(arg?: ButterchurnRenderArg): void;
};

const ALL_PRESETS = butterchurnPresets.getPresets() as Record<string, unknown>;

class ButterchurnMounted implements MountedViz {
  private readonly canvas: HTMLCanvasElement;
  private readonly visualizer: ButterchurnVisualizer;

  /** Audio sensitivity — scales sample deltas around 128 before handing
   *  them to butterchurn's updateAudio. 1.0 = neutral. */
  private sensitivity = 1;
  /** Current CSS filter string applied to the canvas. Cached so we
   *  only write `canvas.style.filter` when it actually changes. */
  private canvasFilter = '';

  constructor(
    private readonly container: HTMLElement,
    ctx: VisualizerContext,
    presetKey: string,
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

    this.visualizer = butterchurn.createVisualizer(
      ctx.audioContext,
      this.canvas,
      {
        width,
        height,
        pixelRatio: window.devicePixelRatio,
        textureRatio: 1,
      },
    ) as ButterchurnVisualizer;

    // NOTE: intentionally NOT calling `visualizer.connectAudio(ctx.analyser)`.
    // We feed samples to butterchurn via the `render({ audioLevels })`
    // path below; that avoids needing a running AudioContext in the
    // sandboxed extension iframe, where audio actually flows in the
    // parent frame and arrives here as postMessage'd AudioFrames.

    const preset = ALL_PRESETS[presetKey];
    if (preset) {
      // Load with 0 blend on boot for a snappy first render.
      this.visualizer.loadPreset(preset, 0);
    } else {
      // Surface typos / missing presets so plugin configs stay aligned
      // with whatever butterchurn-presets ships.
      console.warn(
        `[viz] butterchurn preset not found: "${presetKey}"`,
      );
    }
  }

  setParams(p: ParamValues): void {
    // Audio sensitivity — clamped so we don't explode the byte range.
    this.sensitivity = clamp(Number(p.sensitivity ?? 1), 0.2, 3);

    // Color filters — applied via a single CSS filter string on the
    // canvas. Each transform is GPU-accelerated by the browser, so
    // it's essentially free at runtime (no per-frame JS work).
    const hue = Number(p.hueShift ?? 0);
    const sat = clamp(Number(p.saturation ?? 1), 0, 3);
    const bri = clamp(Number(p.brightness ?? 1), 0.2, 2);
    const parts: string[] = [];
    if (hue !== 0) parts.push(`hue-rotate(${hue}deg)`);
    if (sat !== 1) parts.push(`saturate(${sat})`);
    if (bri !== 1) parts.push(`brightness(${bri})`);
    const next = parts.join(' ');
    if (next !== this.canvasFilter) {
      this.canvas.style.filter = next;
      this.canvasFilter = next;
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

  render(frame: AudioFrame, _p: ParamValues, _dt: number): void {
    // Butterchurn's internal audio path wants 1024 time-domain bytes
    // per channel (its fftSize is 1024, hardcoded). Our analyser uses
    // fftSize = 2048, so frame.waveform has 2048 bytes — take the
    // most recent 1024 (the tail, since the buffer is ordered
    // oldest→newest).
    //
    // Sensitivity scales the signed delta around 128. At 1.0 we pass
    // raw bytes through as a view (zero copy). Any other value builds
    // a scaled copy; the cost is ~1024 integer ops per frame, trivial.
    //
    // L and R get the same mono data. True stereo would need extra
    // channel-split analysers upstream; for the few presets that care
    // about stereo separation, the tradeoff is acceptable.
    const raw = frame.waveform.subarray(frame.waveform.length - 1024);
    let samples: Uint8Array;
    if (this.sensitivity === 1) {
      samples = raw;
    } else {
      samples = new Uint8Array(1024);
      for (let i = 0; i < 1024; i++) {
        const delta = (raw[i] - 128) * this.sensitivity;
        samples[i] = clamp(Math.round(delta + 128), 0, 255);
      }
    }
    this.visualizer.render({
      audioLevels: {
        timeByteArray: samples,
        timeByteArrayL: samples,
        timeByteArrayR: samples,
      },
    });
  }

  destroy(): void {
    if (this.canvas.parentElement === this.container) {
      this.container.removeChild(this.canvas);
    }
    // Butterchurn has no explicit destroy; dropping refs is enough
    // for GC.
  }
}

export interface ButterchurnPluginConfig {
  /** Stable slug — used in URLs / localStorage. */
  id: string;
  /** User-facing name shown in the viz switcher. */
  name: string;
  /** One-liner shown in the switcher dropdown. */
  description: string;
  /** Exact key in the `butterchurn-presets` package. */
  presetKey: string;
}

/**
 * Turn a preset config into a `VisualizationPlugin`. Every butterchurn
 * plugin gets `evalRequired: true` — butterchurn compiles preset
 * expressions with `new Function()`, which requires an `unsafe-eval`
 * CSP. In the extension that's only allowed inside the sandboxed viz
 * iframe (manifest `sandbox.pages`).
 */
function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

export function makeButterchurnPlugin(
  config: ButterchurnPluginConfig,
): VisualizationPlugin {
  return {
    id: config.id,
    name: config.name,
    description: config.description,
    evalRequired: true,
    params: {
      // Every butterchurn plugin gets the same four dials. They tweak
      // *how* the preset responds without altering the preset itself,
      // so you can take any preset from subtle ambient to aggressive
      // rave without writing custom MilkDrop code.
      sensitivity: {
        type: 'number',
        label: 'Sensitivity',
        min: 0.2,
        max: 3,
        step: 0.1,
        default: 1,
      },
      hueShift: {
        type: 'number',
        label: 'Hue Shift',
        min: -180,
        max: 180,
        step: 5,
        default: 0,
      },
      saturation: {
        type: 'number',
        label: 'Saturation',
        min: 0,
        max: 2.5,
        step: 0.1,
        default: 1,
      },
      brightness: {
        type: 'number',
        label: 'Brightness',
        min: 0.3,
        max: 1.8,
        step: 0.1,
        default: 1,
      },
    },
    mount(container, ctx) {
      return new ButterchurnMounted(container, ctx, config.presetKey);
    },
  };
}
