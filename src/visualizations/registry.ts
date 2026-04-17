import type { VisualizationPlugin } from './types';
import { BUTTERCHURN_PLUGINS } from './butterchurn/presets';
import juliaPlugin from './julia';
import mandelbrotPlugin from './mandelbrot';
import burningShipPlugin from './burning-ship';
import newtonPlugin from './newton';
import prismPlugin from './prism';
import starfieldPlugin from './starfield';
import crtPlugin from './crt';
import ribbonsPlugin from './ribbons';
import matrixRainPlugin from './matrix-rain';
import neonGridPlugin from './neon-grid';
import wireframePulsePlugin from './wireframe-pulse';
import circuitTracesPlugin from './circuit-traces';
import inkblotPlugin from './inkblot';
import flowFieldsPlugin from './flow-fields';
import infiniteTunnelPlugin from './infinite-tunnel';
import oilSlickPlugin from './oil-slick';

/**
 * Ordered registry of available visualizations.
 *
 * The switcher UI shows them in this order; `VISUALIZATIONS[0]` is the
 * default for new sessions.
 *
 * Grouping (roughly):
 *   - MilkDrop-style butterchurn plugins (shared "fluid psychedelia"
 *     visual vocabulary)
 *   - Hand-written fractals (Julia, Mandelbrot, Burning Ship, Newton)
 *   - Three.js generative plugins (Ribbons, Starfield, Prism, Neon Grid,
 *     Wireframe Pulse)
 *   - Shader-driven "trippy" plugins (Infinite Tunnel, Oil Slick,
 *     Inkblot) — all fullscreen-quad fragment shaders on FractalBase
 *   - 2D canvas stylized effects (Matrix Rain, Circuit Traces,
 *     Flow Fields, Vibrant Equalizer)
 *
 * Adding a new butterchurn preset: edit `./butterchurn/presets.ts`.
 * Adding a new hand-written plugin: import it here and append.
 */
export const VISUALIZATIONS: readonly VisualizationPlugin[] = [
  ...BUTTERCHURN_PLUGINS,
  juliaPlugin,
  mandelbrotPlugin,
  burningShipPlugin,
  newtonPlugin,
  ribbonsPlugin,
  starfieldPlugin,
  prismPlugin,
  neonGridPlugin,
  wireframePulsePlugin,
  infiniteTunnelPlugin,
  oilSlickPlugin,
  inkblotPlugin,
  matrixRainPlugin,
  circuitTracesPlugin,
  flowFieldsPlugin,
  crtPlugin,
];

export function getPluginById(id: string): VisualizationPlugin | undefined {
  return VISUALIZATIONS.find((p) => p.id === id);
}
