import type { AudioFrame } from '../audio/types';

/** A single tunable parameter definition on a visualization. */
export type ParamDef =
  | {
      type: 'number';
      label: string;
      min: number;
      max: number;
      step?: number;
      default: number;
    }
  | {
      type: 'boolean';
      label: string;
      default: boolean;
    }
  | {
      type: 'select';
      label: string;
      options: readonly string[];
      default: string;
    };

/** Declarative schema: keyed by param id. */
export type ParamSchema = Record<string, ParamDef>;

/** Concrete values keyed by the same ids as the schema. */
export type ParamValues = Record<string, number | boolean | string>;

/** Shared runtime context passed to plugin.mount(). */
export interface VisualizerContext {
  audioContext: AudioContext;
  analyser: AnalyserNode;
}

/** A mounted (live) visualization instance. */
export interface MountedViz {
  render(frame: AudioFrame, params: ParamValues, dt: number): void;
  setParams(params: ParamValues): void;
  resize(width: number, height: number): void;
  destroy(): void;
}

/** A visualization plugin definition. */
export interface VisualizationPlugin {
  id: string;
  name: string;
  description: string;
  params: ParamSchema;
  /**
   * Set to `true` for plugins whose runtime compiles code via eval() /
   * new Function() — e.g. anything wrapping Butterchurn's MilkDrop preset
   * engine. These cannot run in the Chrome extension context because
   * live365 and most hosts enforce a strict CSP without 'unsafe-eval',
   * so ExtensionOverlay filters them out of the switcher.
   */
  evalRequired?: boolean;
  mount(container: HTMLElement, ctx: VisualizerContext): MountedViz;
}

/** Derive a default ParamValues object from a ParamSchema. */
export function defaultParamValues(schema: ParamSchema): ParamValues {
  const out: ParamValues = {};
  for (const [key, def] of Object.entries(schema)) {
    out[key] = def.default;
  }
  return out;
}
