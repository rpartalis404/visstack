/**
 * Sandboxed visualizer page — loaded in an <iframe> by the content script.
 *
 * # Why sandboxed?
 *   The butterchurn plugins (Astral Projection, Tide Pool, etc.)
 *   compile MilkDrop preset expressions with new Function() at
 *   runtime. MV3 forbids unsafe-eval
 *   in content scripts and in normal extension pages, but pages declared
 *   in manifest.sandbox.pages are served with a relaxed CSP that allows
 *   it. Rendering every plugin here keeps the architecture uniform.
 *
 * # No audio here
 *   The *real* AudioContext lives in the content script — it's created
 *   synchronously inside the user's start click, which guarantees it
 *   starts in the "running" state. Audio plays there. Each animation
 *   frame the content script computes an `AudioFrame` (FFT + waveform +
 *   bass/mid/treble/beat/etc.) and postMessages it into this iframe.
 *
 *   We still create a local AudioContext here, *but purely so butterchurn
 *   can read its `sampleRate`*. No audio flows through it; it stays
 *   suspended for the lifetime of the session. The plugin's Analyser
 *   reference passed to it is equally unused — butterchurn gets its
 *   samples from `render({ audioLevels })` (the non-graph path), fed
 *   from the incoming AudioFrames. See the butterchurn plugin
 *   factory (`src/visualizations/butterchurn/plugin.ts`) for details.
 *
 * # Why all this complexity?
 *   Prior iterations used WebRTC loopback to push the audio track into
 *   this iframe, then created an AudioContext here and called resume().
 *   `AudioContext.resume()` in a sandboxed/cross-origin iframe doesn't
 *   reliably honor `allow="autoplay"` — it stays pending indefinitely
 *   and audio never starts. Moving the AudioContext to the content
 *   script sidesteps that entirely. No WebRTC, no iframe-side
 *   activation required.
 *
 * # Lifecycle
 *   boot() → post VIZ_READY → parent replies with SET_ACTIVE_VIZ →
 *   wait for the first AUDIO_FRAME (= user clicked Start in parent) →
 *   create the local AudioContext + analyser → mount the React tree.
 *   Every subsequent AUDIO_FRAME updates `latestFrame`, which our
 *   adapter returns from `getCurrentFrame()` on every rAF tick.
 */
import { createRoot } from 'react-dom/client';
import { StrictMode, useEffect, useState } from 'react';
import { ExtensionOverlay } from './content/ExtensionOverlay';
import { VISUALIZATIONS, getPluginById } from '../src/visualizations/registry';
import {
  defaultParamValues,
  type ParamValues,
  type VisualizationPlugin,
} from '../src/visualizations/types';
import type { AudioFrame, VisualizerEngine } from '../src/audio/types';

type OutboundMessage =
  | { type: 'VIZ_READY' }
  | { type: 'VIZ_CLOSE' }
  | { type: 'ENGINE_ERROR'; message: string };

type InboundMessage =
  | { type: 'SET_ACTIVE_VIZ'; id: string; params?: ParamValues }
  | { type: 'SET_PARAMS'; params: ParamValues }
  | { type: 'AUDIO_FRAME'; frame: AudioFrame };

function postToParent(msg: OutboundMessage): void {
  // Parent origin is the host page; authenticate by sender identity
  // (event.source === window.parent) rather than origin.
  window.parent.postMessage(msg, '*');
}

async function boot(): Promise<void> {
  // Latest AudioFrame received from the parent — updated on each
  // AUDIO_FRAME message, read on each rAF tick by VisualizerHost.
  let latestFrame: AudioFrame | null = null;

  // SET_ACTIVE_VIZ / SET_PARAMS can arrive before React has mounted
  // (in response to VIZ_READY). We buffer both so the initial React
  // mount uses the right plugin + values. Once React is mounted, we
  // plug in live setters.
  let pendingActiveId = VISUALIZATIONS[0].id;
  let pendingParams: ParamValues = defaultParamValues(
    (getPluginById(pendingActiveId) ?? VISUALIZATIONS[0]).params,
  );
  let activeIdSetter: ((id: string) => void) | null = null;
  let paramsSetter: ((p: ParamValues) => void) | null = null;

  // Gate the React mount on TWO signals:
  //   1. the first SET_ACTIVE_VIZ (the parent's response to our
  //      VIZ_READY), so `pendingActiveId` is the user's chosen plugin
  //      and not the VISUALIZATIONS[0] default;
  //   2. the first AUDIO_FRAME, so the local AudioContext can be
  //      created at the parent's actual sampleRate and so we stay
  //      blank until the user has clicked Start.
  //
  // Historically the mount was gated on AUDIO_FRAME alone. That
  // produced a subtle race whenever the iframe booted while the parent
  // was already streaming frames (e.g. after any event that reloads
  // the iframe): an AUDIO_FRAME could arrive in the same task queue
  // tick as VIZ_READY's round-trip, resolve the frame promise, and let
  // boot() mount React with the default plugin before SET_ACTIVE_VIZ
  // ever reached us. Gating on both closes the race.
  let resolveFirstFrame: (frame: AudioFrame) => void = () => undefined;
  const firstFramePromise = new Promise<AudioFrame>((resolve) => {
    resolveFirstFrame = resolve;
  });

  let resolveActiveVizReady: () => void = () => undefined;
  const activeVizReadyPromise = new Promise<void>((resolve) => {
    resolveActiveVizReady = resolve;
  });

  window.addEventListener('message', (ev) => {
    if (ev.source !== window.parent) return;
    const data = ev.data as InboundMessage | undefined;
    if (!data || typeof data !== 'object') return;
    switch (data.type) {
      case 'SET_ACTIVE_VIZ':
        // Always update the pending buffer first — if a message races
        // past React's mount-side setter wiring, pendingActiveId still
        // reflects the latest truth and any subsequent mount reads it.
        pendingActiveId = data.id;
        if (data.params !== undefined) pendingParams = data.params;
        if (activeIdSetter) activeIdSetter(data.id);
        if (data.params !== undefined && paramsSetter) {
          paramsSetter(data.params);
        }
        // Resolving an already-resolved Promise is a no-op, so it's
        // safe to call this unconditionally on every SET_ACTIVE_VIZ.
        resolveActiveVizReady();
        break;
      case 'SET_PARAMS':
        pendingParams = data.params;
        if (paramsSetter) paramsSetter(data.params);
        break;
      case 'AUDIO_FRAME': {
        const wasNull = latestFrame === null;
        latestFrame = data.frame;
        if (wasNull) resolveFirstFrame(data.frame);
        break;
      }
    }
  });

  postToParent({ type: 'VIZ_READY' });

  // Wait for both signals. SET_ACTIVE_VIZ arrives fast (parent replies
  // to VIZ_READY synchronously in its message handler). AUDIO_FRAME
  // only arrives after the user clicks Start — which is the gate we
  // actually want to hold the blank iframe behind.
  await activeVizReadyPromise;
  const firstFrame = await firstFramePromise;

  // Build a local AudioContext and AnalyserNode. Neither processes any
  // audio — butterchurn just needs them to exist (for sampleRate and
  // its constructor's internal delay/analyser graph). The AnalyserNode
  // is passed through the plugin context but not actually read by
  // butterchurn, since we've switched it to the `updateAudio` path
  // that takes time-domain byte arrays directly (see the butterchurn
  // plugin factory).
  let ctx: AudioContext;
  let analyser: AnalyserNode;
  try {
    // Try to match the parent's sampleRate so butterchurn's frequency
    // bucket math lines up with the real audio. Fall back to the
    // browser default if the rate isn't supported here.
    try {
      ctx = new AudioContext({ sampleRate: firstFrame.sampleRate });
    } catch {
      ctx = new AudioContext();
    }
    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
  } catch (err) {
    postToParent({
      type: 'ENGINE_ERROR',
      message: `Failed to create local AudioContext: ${(err as Error).message}`,
    });
    return;
  }

  // Lightweight adapter matching VisualizerEngine. getCurrentFrame()
  // returns the most recent frame the parent sent us; on the rare
  // chance of a race (tick fires between firstFrame and the next
  // AUDIO_FRAME clobbering latestFrame), we fall back to firstFrame.
  const engine: VisualizerEngine = {
    ctx,
    analyser,
    getCurrentFrame(_nowMs: number): AudioFrame {
      return latestFrame ?? firstFrame;
    },
  };

  const rootEl = document.getElementById('root');
  if (!rootEl) {
    postToParent({ type: 'ENGINE_ERROR', message: '#root missing in viz.html' });
    return;
  }

  createRoot(rootEl).render(
    <StrictMode>
      <VizApp
        engine={engine}
        initialActiveId={pendingActiveId}
        initialParams={pendingParams}
        attachSetActiveId={(setter) => {
          activeIdSetter = setter;
        }}
        attachSetParams={(setter) => {
          paramsSetter = setter;
        }}
      />
    </StrictMode>,
  );

  // Best-effort cleanup on iframe unload. The parent tears us down
  // authoritatively via destroy(); this just closes the local context
  // promptly so no "tab is using audio" indicator lingers.
  window.addEventListener('pagehide', () => {
    try {
      void ctx.close();
    } catch {
      /* already closed */
    }
  });
}

interface VizAppProps {
  engine: VisualizerEngine;
  initialActiveId: string;
  initialParams: ParamValues;
  attachSetActiveId: (setter: (id: string) => void) => void;
  attachSetParams: (setter: (p: ParamValues) => void) => void;
}

/**
 * Thin wrapper holding the activeId + current params in React state so
 * incoming SET_ACTIVE_VIZ / SET_PARAMS messages can swap plugins and
 * tweak values without remounting the engine. Also listens for Escape
 * in the iframe's own document, since the parent's keydown listener
 * doesn't see keys when the iframe has focus (rare, but possible via
 * Tab navigation).
 */
function VizApp({
  engine,
  initialActiveId,
  initialParams,
  attachSetActiveId,
  attachSetParams,
}: VizAppProps) {
  const [activeId, setActiveId] = useState(initialActiveId);
  const [params, setParams] = useState<ParamValues>(initialParams);

  useEffect(() => {
    attachSetActiveId(setActiveId);
  }, [attachSetActiveId]);

  useEffect(() => {
    attachSetParams(setParams);
  }, [attachSetParams]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') postToParent({ type: 'VIZ_CLOSE' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const plugin: VisualizationPlugin =
    getPluginById(activeId) ?? VISUALIZATIONS[0];

  return <ExtensionOverlay engine={engine} plugin={plugin} params={params} />;
}

void boot();
