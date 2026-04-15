import { useEffect, useRef } from 'react';
import type { AudioEngine } from '../audio/AudioEngine';
import type {
  MountedViz,
  ParamValues,
  VisualizationPlugin,
} from '../visualizations/types';

/**
 * Inline style for the canvas container. Previously this used a CSS module
 * (App.module.css → .stageCanvas), but that caused Vite to emit a CSS chunk
 * for this component, which in turn tripped up the Chrome extension build
 * (the content script dynamic-import would try to preload the chunk CSS
 * from the host page's origin and fail). Inlining eliminates the chunk
 * entirely with no behavior change.
 */
const STAGE_STYLE: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  display: 'block',
};

interface Props {
  engine: AudioEngine;
  plugin: VisualizationPlugin;
  params: ParamValues;
  /** Called once per frame with BPM + beat for the status pill to render. */
  onStatus?: (status: { bpm: number; beat: boolean }) => void;
}

/**
 * Owns the <div> container for the active visualization plugin, mounts the
 * plugin into it, and drives the rAF loop that polls the AudioEngine and
 * calls plugin.render(frame, params).
 *
 * Plugin lifecycle:
 *   - mount(container, ctx) when props.plugin changes
 *   - destroy() on unmount or plugin swap
 *
 * Param lifecycle:
 *   - setParams(params) is called whenever props.params changes
 */
export function VisualizerHost({ engine, plugin, params, onStatus }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef<MountedViz | null>(null);
  const paramsRef = useRef<ParamValues>(params);
  const statusRef = useRef(onStatus);

  // Keep fresh references available to the rAF loop without re-subscribing it
  paramsRef.current = params;
  statusRef.current = onStatus;

  // Mount / unmount the plugin when it changes
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const mounted = plugin.mount(container, {
      audioContext: engine.ctx,
      analyser: engine.analyser,
    });
    mountedRef.current = mounted;
    mounted.setParams(paramsRef.current);

    // Initial size
    const rect = container.getBoundingClientRect();
    mounted.resize(Math.max(1, rect.width), Math.max(1, rect.height));

    return () => {
      mountedRef.current = null;
      mounted.destroy();
    };
  }, [plugin, engine]);

  // Push new params to the mounted plugin when they change
  useEffect(() => {
    mountedRef.current?.setParams(params);
  }, [params]);

  // Resize observer
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        mountedRef.current?.resize(Math.max(1, width), Math.max(1, height));
      }
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  // The rAF loop — one loop, single source of time.
  useEffect(() => {
    let raf = 0;
    const tick = (nowMs: number) => {
      const frame = engine.getCurrentFrame(nowMs);
      const mv = mountedRef.current;
      if (mv) {
        mv.render(frame, paramsRef.current, frame.dt);
      }
      statusRef.current?.({ bpm: frame.bpm, beat: frame.beat });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [engine]);

  return <div ref={containerRef} style={STAGE_STYLE} />;
}
