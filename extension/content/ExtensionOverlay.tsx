import type { VisualizerEngine } from '../../src/audio/types';
import type {
  ParamValues,
  VisualizationPlugin,
} from '../../src/visualizations/types';
import { VisualizerHost } from '../../src/ui/VisualizerHost';

/**
 * The overlay mode determines only the close-button tooltip text in the
 * controls (rendered in the parent frame, not here). It's kept on this
 * module as the canonical export so viz.tsx and mount.tsx can share it.
 */
export type OverlayMode = 'live365-hero' | 'overlay';

interface Props {
  engine: VisualizerEngine;
  plugin: VisualizationPlugin;
  /**
   * Current param values for this plugin. Owned by the parent frame
   * (the controls layer) and forwarded in via postMessage, so tweaks
   * in the settings panel flow live into `plugin.setParams()` without
   * remounting the visualization.
   */
  params: ParamValues;
}

/**
 * Canvas-only renderer inside the sandboxed viz iframe.
 *
 * Controls (start button, viz switcher, settings, close) are rendered
 * in the parent frame via `ExtensionControls` — see the architecture
 * note at the top of `mount.tsx`. This component is purely the stage:
 * a VisualizerHost driving the active plugin with the parent-supplied
 * params.
 */
export function ExtensionOverlay({ engine, plugin, params }: Props) {
  return (
    <div style={rootStyle}>
      <VisualizerHost engine={engine} plugin={plugin} params={params} />
    </div>
  );
}

const rootStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  overflow: 'hidden',
};
