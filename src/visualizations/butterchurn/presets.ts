import type { VisualizationPlugin } from '../types';
import { makeButterchurnPlugin } from './plugin';

/**
 * Curated butterchurn-preset catalog.
 *
 * Each entry becomes its own visualization in the switcher. `presetKey`
 * is the exact key from `butterchurn-presets/getPresets()`; if that
 * package ever updates and renames a preset, the factory logs a warn
 * and the plugin just renders a black canvas — easy to spot and fix.
 *
 * Names/descriptions are hand-written for end-user friendliness (the
 * upstream keys are like "Flexi + Martin - astral projection", which
 * is fine for preset authors but not for a music-visualizer UI).
 *
 * Order here is the order they appear in the switcher.
 */
export const BUTTERCHURN_PLUGINS: readonly VisualizationPlugin[] = [
  makeButterchurnPlugin({
    id: 'astral-projection',
    name: 'Astral Projection',
    description:
      'Deep-space drift with pulsing astral geometries and warping light.',
    presetKey: 'Flexi + Martin - astral projection',
  }),
  makeButterchurnPlugin({
    id: 'tide-pool',
    name: 'Tide Pool',
    description:
      'Translucent sea life weaving through a bioluminescent underwater pool.',
    presetKey: 'Flexi - alien fish pond',
  }),
  makeButterchurnPlugin({
    id: 'area-51',
    name: 'Area 51',
    description:
      'Strange geometries pulsing like alien signal intelligence.',
    presetKey: 'Flexi - area 51',
  }),
  makeButterchurnPlugin({
    id: 'mindblob',
    name: 'Mindblob',
    description:
      'Soft organic blobs morphing like liquid thoughts.',
    presetKey: 'Flexi - mindblob mix',
  }),
  makeButterchurnPlugin({
    id: 'spiral-dance',
    name: 'Spiral Dance',
    description:
      'Dueling spirals chasing each other in hypnotic orbit.',
    presetKey: 'Flexi - predator-prey-spirals',
  }),
  makeButterchurnPlugin({
    id: 'acid-etching',
    name: 'Acid Etching',
    description:
      'Sharp fractal lines etched across a shifting iridescent canvas.',
    presetKey: 'Flexi - smashing fractals [acid etching mix]',
  }),
  makeButterchurnPlugin({
    id: 'jelly-parade',
    name: 'Jelly Parade',
    description:
      'Wobbling gel shapes parading through the frame to the beat.',
    presetKey: 'Flexi + stahlregen - jelly showoff parade',
  }),
  makeButterchurnPlugin({
    id: 'cell-bloom',
    name: 'Cell Bloom',
    description:
      'Turing-pattern cells blooming and dissolving with the music.',
    presetKey: 'Geiss - Reaction Diffusion 2',
  }),
  makeButterchurnPlugin({
    id: 'liquid-arrows',
    name: 'Liquid Arrows',
    description:
      'Molten arrows racing through a kaleidoscopic tunnel.',
    presetKey: 'Martin - liquid arrows',
  }),
  makeButterchurnPlugin({
    id: 'tokamak',
    name: 'Tokamak',
    description:
      'Plasma swirls and magnetic arcs inside a fusion-reactor core.',
    presetKey: 'Flexi, fishbrain, Geiss + Martin - tokamak witchery',
  }),
  makeButterchurnPlugin({
    id: 'artifact',
    name: 'Artifact',
    description:
      'Glitchy angular shards pulsing through layers of interference.',
    presetKey: '_Geiss - Artifact 01',
  }),
  makeButterchurnPlugin({
    id: 'desert-rose',
    name: 'Desert Rose',
    description:
      'Petal-like geometries blooming in warm saturated light.',
    presetKey: '_Geiss - Desert Rose 2',
  }),
  makeButterchurnPlugin({
    id: 'hurricane',
    name: 'Hurricane',
    description:
      'A posterized storm of color spiraling around a central eye.',
    presetKey: '_Rovastar + Geiss - Hurricane Nightmare (Posterize Mix)',
  }),
  makeButterchurnPlugin({
    id: 'witchcraft',
    name: 'Witchcraft',
    description:
      'Arcane runes and ether-smoke swirling through a midnight ritual.',
    presetKey: 'fiShbRaiN + Flexi - witchcraft 2.0',
  }),
  makeButterchurnPlugin({
    id: 'neon-graffiti',
    name: 'Neon Graffiti',
    description:
      'Spray-painted glyphs in electric colors, smeared across the frame.',
    presetKey: 'flexi + fishbrain - neon mindblob grafitti',
  }),
  makeButterchurnPlugin({
    id: 'liquid-fire',
    name: 'Liquid Fire',
    description:
      'A neverending explosion of red liquid fire, bass-driven and primal.',
    presetKey: 'Cope - The Neverending Explosion of Red Liquid Fire',
  }),
];
