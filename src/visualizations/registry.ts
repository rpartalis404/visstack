import type { VisualizationPlugin } from './types';
import classicTripPlugin from './classic-trip';
import juliaPlugin from './julia';
import prismPlugin from './prism';
import starfieldPlugin from './starfield';
import crtPlugin from './crt';
import ribbonsPlugin from './ribbons';

/**
 * Ordered registry of available visualizations. Switcher UI shows them
 * in this order; VISUALIZATIONS[0] is the default for new sessions.
 *
 * Adding a new one: import it here and append to the array. Nothing else.
 */
export const VISUALIZATIONS: readonly VisualizationPlugin[] = [
  classicTripPlugin,
  juliaPlugin,
  ribbonsPlugin,
  starfieldPlugin,
  crtPlugin,
  prismPlugin,
];

export function getPluginById(id: string): VisualizationPlugin | undefined {
  return VISUALIZATIONS.find((p) => p.id === id);
}
