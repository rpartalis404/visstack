/**
 * Content-script side of the visualizer.
 *
 * # Architecture
 *
 * The extension UI is split across three roles living in two frames:
 *
 *   1. **Visualization layer** (hero slot, shadow DOM → iframe →
 *      butterchurn canvas). No interactive elements; allowed to sit
 *      behind live365's overlay divs because we don't need pointer
 *      events on the canvas.
 *
 *   2. **Interaction layer** (this file, mounted at
 *      `document.documentElement` with `z-index: 2147483647`). Holds
 *      every clickable element — start button, viz switcher, close,
 *      menu. A child of <html> with max z-index sits above anything
 *      live365 stacks inside <body>, so clicks reliably reach us.
 *
 *   3. **Audio pipeline** (this file, parent frame). Owns the
 *      AudioContext, AnalyserNode, and the per-frame analysis. Created
 *      synchronously inside the user's start-click handler so Chrome
 *      associates the context with a real user gesture (no `resume()`
 *      flakiness). Each animation frame we compute an AudioFrame and
 *      postMessage it into the iframe, where butterchurn reads it via
 *      its non-graph `updateAudio` path.
 *
 * This moves the AudioContext out of the sandbox iframe, where
 * `AudioContext.resume()` was blocked by Chrome's autoplay policy even
 * with `allow="autoplay"`. Consequence: no WebRTC loopback needed; the
 * iframe is purely a rendering surface.
 *
 * # postMessage protocol
 *
 *   Parent → Iframe:
 *     SET_ACTIVE_VIZ — initial plugin id + any subsequent switches
 *     AUDIO_FRAME    — one per rAF tick, AudioFrame payload
 *
 *   Iframe → Parent:
 *     VIZ_READY     — iframe booted, ready to receive
 *     VIZ_CLOSE     — user pressed Escape inside the iframe
 *     ENGINE_ERROR  — fatal init error; surfaced in the UI
 */

import { createRoot, type Root } from 'react-dom/client';
import { StrictMode, useEffect, useMemo, useState } from 'react';
import { ExtensionControls } from './ExtensionControls';
import type { OverlayMode } from './ExtensionOverlay';
import { VISUALIZATIONS, getPluginById } from '../../src/visualizations/registry';
import {
  defaultParamValues,
  type ParamValues,
} from '../../src/visualizations/types';
import { AudioEngine } from '../../src/audio/AudioEngine';

const STORAGE_KEY = 'viz-ext-state-v1';

/** Handle returned to the content script entry for cleanup. */
export interface VizRoot {
  destroy(): void;
}

type InboundFromIframe =
  | { type: 'VIZ_READY' }
  | { type: 'VIZ_CLOSE' }
  | { type: 'ENGINE_ERROR'; message: string };

/**
 * Entry point: mount the visualizer shell (shadow host + iframe +
 * controls layer). Audio capture (via getDisplayMedia) happens later,
 * on the user's start click, since getDisplayMedia needs transient
 * user activation.
 */
export async function mountVisualizer(): Promise<VizRoot> {
  const context = detectContext();
  const host = buildHost(context);

  const reactHost = host.shadow.querySelector<HTMLDivElement>('[data-viz-root]');
  if (!reactHost) {
    host.teardown();
    throw new Error('[viz] viz root missing');
  }

  // Inject the sandboxed iframe. Mode passed via URL hash so the iframe
  // can render the right tooltip without a message hop.
  //
  // `allow="fullscreen"` is defensive: the iframe itself never enters
  // fullscreen (we fullscreen the shadow host instead, see
  // `toggleFullscreen` below), but some Chrome versions enforce this
  // permission at the ancestor-fullscreen boundary too.
  const iframe = document.createElement('iframe');
  const vizUrl = new URL(chrome.runtime.getURL('viz.html'));
  vizUrl.hash = new URLSearchParams({ mode: context.mode }).toString();
  iframe.src = vizUrl.toString();
  iframe.setAttribute('title', 'VisStack');
  iframe.setAttribute('allow', 'fullscreen');
  iframe.style.cssText = [
    'position: absolute',
    'inset: 0',
    'width: 100%',
    'height: 100%',
    'border: 0',
    'display: block',
    'background: transparent',
  ].join(';');
  reactHost.appendChild(iframe);

  const sendToIframe = (msg: unknown): void => {
    iframe.contentWindow?.postMessage(msg, '*');
  };

  // `destroy` is defined later but captured by several closures below.
  // All of those closures only fire after this function returns, so
  // the forward reference is safe.
  let destroyed = false;
  let destroy: () => void = () => {
    /* replaced below */
  };

  // Audio state. Everything here is null until the user clicks Start
  // (getDisplayMedia needs user activation, so we can't acquire audio
  // at mount time). `engine` drives analysis; `capturedStream` is held
  // so we can stop its tracks on teardown.
  let engine: AudioEngine | null = null;
  let capturedStream: MediaStream | null = null;
  let rafHandle = 0;

  // --- Controls layer --------------------------------------------------
  const controls = mountControls({
    vizHostEl: host.outer,
    mode: context.mode,
    initialActiveId: readPersistedActiveId(),
    onStart: () => {
      void startAudio();
    },
    onChangeViz: (id, params) => {
      persistActiveId(id);
      // Bundle params into SET_ACTIVE_VIZ so the iframe switches to
      // the new plugin with its values in one atomic update — avoids
      // a frame where the new plugin renders with the *old* plugin's
      // param values.
      sendToIframe({ type: 'SET_ACTIVE_VIZ', id, params });
    },
    onChangeParams: (params) => {
      sendToIframe({ type: 'SET_PARAMS', params });
    },
    onToggleFullscreen: () => {
      void toggleFullscreen();
    },
    onClose: () => destroy(),
  });

  // Fullscreen toggle.
  //
  // ## Why we re-parent to document.body before going fullscreen
  //
  // Host pages like live365 have `transform` (or `filter`, or
  // `will-change: transform`) on some ancestor of the hero slot. Any
  // transformed ancestor creates a new containing block even for
  // top-layer elements on some Chrome builds — so the fullscreen
  // element's `width: 100%` resolves to that ancestor's box instead of
  // the viewport. Visually: a letterbox of the original slot size,
  // centered in a black void. The grey-bars bug.
  //
  // The fix: move `host.outer` to `document.body` (no transformed
  // ancestors there) BEFORE calling requestFullscreen, then move it
  // back on exit. Spec-correct browsers don't need this — but in
  // practice on live365 it's required.
  //
  // ## About the iframe reload
  //
  // Moving a node that contains an iframe via appendChild can trigger
  // Chrome to re-navigate the iframe. That used to cause a "reverts
  // to default viz" bug: the reloaded iframe would run its boot
  // sequence, see an incoming AUDIO_FRAME before the parent's
  // SET_ACTIVE_VIZ response arrived, and mount React with the default
  // plugin. `viz.tsx`'s boot now explicitly awaits both the first
  // SET_ACTIVE_VIZ AND the first AUDIO_FRAME before mounting React,
  // so even if this move re-navigates the iframe, nothing resets.
  //
  // ## "Sharing this tab" banner
  //
  // While getDisplayMedia is active Chrome keeps the sharing banner
  // pinned, including during fullscreen. That's a browser-level
  // security indicator we cannot suppress from an extension. The only
  // way to eliminate it is a different distribution form (desktop).
  let savedParent: Node | null = null;
  let savedNextSibling: Node | null = null;

  const restoreHostLocation = (): void => {
    if (!savedParent) return;
    if (savedNextSibling && savedNextSibling.parentNode === savedParent) {
      savedParent.insertBefore(host.outer, savedNextSibling);
    } else {
      savedParent.appendChild(host.outer);
    }
    savedParent = null;
    savedNextSibling = null;
  };

  const toggleFullscreen = async (): Promise<void> => {
    if (document.fullscreenElement) {
      try {
        await document.exitFullscreen();
      } catch (err) {
        console.warn('[viz] exitFullscreen failed:', err);
      }
      return;
    }

    savedParent = host.outer.parentNode;
    savedNextSibling = host.outer.nextSibling;
    document.body.appendChild(host.outer);

    try {
      await host.outer.requestFullscreen({ navigationUI: 'hide' });
    } catch (err) {
      console.warn('[viz] requestFullscreen failed:', err);
      // Request rejected (e.g. no user activation). Put the host
      // back immediately so we don't leave it stranded at document.body.
      restoreHostLocation();
    }
  };

  // On fullscreen exit (user hits Esc, clicks our toggle, or anything
  // else that drops out of fullscreen), restore host.outer to its
  // original slot. Firing on both enter and exit; only the exit case
  // has work to do.
  const onFullscreenChange = (): void => {
    if (!document.fullscreenElement) {
      restoreHostLocation();
    }
  };
  document.addEventListener('fullscreenchange', onFullscreenChange);

  // --- Audio startup ---------------------------------------------------
  //
  // getDisplayMedia prompts Chrome's native tab picker. The user picks
  // a tab (current tab pre-suggested via preferCurrentTab) and clicks
  // "Share". We get a MediaStream that's a *copy* of the source's
  // audio — the source tab keeps playing through its own output, so
  // the user hears it naturally. No playback needed on our side.
  //
  // This is why we dropped tabCapture: it redirected the tab's audio
  // into our stream and silenced the source, forcing us to play back
  // from the same tab — which Chrome then silenced to prevent a
  // self-feedback loop. getDisplayMedia sidesteps the whole problem.
  const startAudio = async (): Promise<void> => {
    if (engine || destroyed) return;

    let stream: MediaStream;
    try {
      // `video: true` is required — Chrome currently rejects audio-only
      // getDisplayMedia. We stop the video track immediately below.
      stream = await navigator.mediaDevices.getDisplayMedia({
        audio: true,
        video: true,
        // Chrome-only hints that bias the picker toward the current tab
        // so the user can usually just click "Share".
        // @ts-expect-error — non-standard options not yet in lib.dom
        preferCurrentTab: true,
        selfBrowserSurface: 'include',
      });
    } catch (err) {
      // AbortError = user cancelled the picker. Anything else is a real
      // failure. Surface the message in the error banner either way;
      // the user can click Start again to retry.
      controls.setError(
        (err as Error).name === 'NotAllowedError' ||
          (err as Error).name === 'AbortError'
          ? 'Share cancelled — click Start to try again.'
          : `Couldn't start capture: ${(err as Error).message}`,
      );
      return;
    }

    // We only want audio. Drop video immediately so Chrome's "sharing
    // your screen" banner reflects audio-only and we don't burn
    // encoder cycles on an unused video track.
    stream.getVideoTracks().forEach((t) => t.stop());

    if (stream.getAudioTracks().length === 0) {
      stream.getTracks().forEach((t) => t.stop());
      controls.setError(
        'No audio in the shared tab. Re-share and tick "Also share tab audio".',
      );
      return;
    }

    capturedStream = stream;

    // Chrome revokes the stream when the user clicks "Stop sharing" in
    // the browser banner (or the source tab closes). Tear down cleanly
    // when that happens.
    stream.getAudioTracks().forEach((t) =>
      t.addEventListener('ended', () => destroy()),
    );

    try {
      const e = new AudioEngine();
      // routeToOutput: false — AudioContext is purely for analysis.
      // The user hears audio from the source tab's own output; we
      // don't emit anything.
      e.setSourceMediaStream(stream, { routeToOutput: false });
      await e.ensureRunning();
      engine = e;
    } catch (err) {
      controls.setError(`Failed to start audio: ${(err as Error).message}`);
      return;
    }

    // Kick off the per-frame postMessage loop. AudioEngine reuses its
    // internal buffers across ticks; postMessage's structured clone
    // snapshots the contents on each call, so the iframe gets a clean
    // copy per frame.
    const tick = (nowMs: number) => {
      if (destroyed || !engine) return;
      const frame = engine.getCurrentFrame(nowMs);
      sendToIframe({ type: 'AUDIO_FRAME', frame });
      rafHandle = requestAnimationFrame(tick);
    };
    rafHandle = requestAnimationFrame(tick);
  };

  // --- postMessage from the iframe ------------------------------------
  const onMessage = (ev: MessageEvent) => {
    if (ev.source !== iframe.contentWindow) return;
    const data = ev.data as InboundFromIframe | undefined;
    if (!data || typeof data !== 'object') return;
    switch (data.type) {
      case 'VIZ_READY':
        // Tell the iframe which plugin to prepare *and* which param
        // values to use. AudioFrames won't start flowing until the
        // user clicks Start, so the iframe stays blank until then —
        // which is the UX we want.
        sendToIframe({
          type: 'SET_ACTIVE_VIZ',
          id: controls.getActiveId(),
          params: controls.getActiveParams(),
        });
        break;
      case 'VIZ_CLOSE':
        destroy();
        break;
      case 'ENGINE_ERROR':
        controls.setError(data.message);
        break;
    }
  };
  window.addEventListener('message', onMessage);

  // Esc in the host document closes. The iframe has its own Esc
  // listener too; both converge on destroy().
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') destroy();
  };
  window.addEventListener('keydown', onKey);

  destroy = () => {
    if (destroyed) return;
    destroyed = true;
    cancelAnimationFrame(rafHandle);
    window.removeEventListener('message', onMessage);
    window.removeEventListener('keydown', onKey);
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    // Exit fullscreen if the user closes while fullscreen is active,
    // otherwise Chrome would keep the (now-disconnected) host in the
    // top layer and the page gets stuck in fullscreen briefly.
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    }
    // If we were mid-fullscreen, the fullscreenchange listener we just
    // removed won't fire to restore the location. Put host back manually.
    restoreHostLocation();
    if (capturedStream) {
      capturedStream.getTracks().forEach((t) => t.stop());
      capturedStream = null;
    }
    engine?.destroy();
    iframe.remove();
    controls.teardown();
    host.teardown();
  };

  return { destroy: () => destroy() };
}

// ---------------------------------------------------------------------------
// Controls layer (React root at document.documentElement, max z-index)
// ---------------------------------------------------------------------------

interface ControlsHandle {
  getActiveId: () => string;
  /** Current values for the active plugin. Read when VIZ_READY arrives. */
  getActiveParams: () => ParamValues;
  setError: (message: string) => void;
  teardown: () => void;
}

interface ControlsOptions {
  vizHostEl: HTMLElement;
  mode: OverlayMode;
  initialActiveId: string;
  onStart: () => void;
  /** Called whenever the user picks a different viz from the switcher. */
  onChangeViz: (id: string, params: ParamValues) => void;
  /** Called whenever the user tweaks a param for the currently active viz. */
  onChangeParams: (params: ParamValues) => void;
  /** Called when the user toggles fullscreen on the viz host. */
  onToggleFullscreen: () => void;
  onClose: () => void;
}

/**
 * Build the controls layer. See the file header for the stacking
 * rationale.
 */
function mountControls(opts: ControlsOptions): ControlsHandle {
  const hostEl = document.createElement('div');
  hostEl.setAttribute('data-visstack', 'controls-host');
  hostEl.style.cssText = [
    'position: fixed',
    'inset: 0',
    'z-index: 2147483647',
    'pointer-events: none',
    'margin: 0',
    'padding: 0',
  ].join(';');
  document.documentElement.appendChild(hostEl);

  // Shadow DOM for CSS isolation from the host page.
  const shadow = hostEl.attachShadow({ mode: 'open' });
  const reactMount = document.createElement('div');
  reactMount.style.cssText =
    'position:absolute;inset:0;pointer-events:none;font-family:system-ui,-apple-system,"Segoe UI",sans-serif';
  shadow.appendChild(reactMount);

  // Mirrors of the active React state — read imperatively when the
  // iframe sends VIZ_READY, so we can tell it the initial plugin id
  // plus its params in one shot.
  let activeId = opts.initialActiveId;
  let activeParams: ParamValues = defaultParamsFor(opts.initialActiveId);

  // setError is plugged in by ControlsRoot on mount — see attachSetError.
  let setError: (msg: string | null) => void = () => {
    /* attached below */
  };

  const root: Root = createRoot(reactMount);
  root.render(
    <StrictMode>
      <ControlsRoot
        vizHostEl={opts.vizHostEl}
        mode={opts.mode}
        initialActiveId={opts.initialActiveId}
        onStart={opts.onStart}
        onChangeViz={(id, params) => {
          activeId = id;
          activeParams = params;
          opts.onChangeViz(id, params);
        }}
        onChangeParams={(params) => {
          activeParams = params;
          opts.onChangeParams(params);
        }}
        onToggleFullscreen={opts.onToggleFullscreen}
        onClose={opts.onClose}
        attachSetError={(setter) => {
          setError = setter;
        }}
      />
    </StrictMode>,
  );

  return {
    getActiveId: () => activeId,
    getActiveParams: () => activeParams,
    setError: (message) => setError(message),
    teardown: () => {
      root.unmount();
      hostEl.remove();
    },
  };
}

function defaultParamsFor(id: string): ParamValues {
  const plugin = getPluginById(id) ?? VISUALIZATIONS[0];
  return defaultParamValues(plugin.params);
}

interface ControlsRootProps {
  vizHostEl: HTMLElement;
  mode: OverlayMode;
  initialActiveId: string;
  onStart: () => void;
  onChangeViz: (id: string, params: ParamValues) => void;
  onChangeParams: (params: ParamValues) => void;
  onToggleFullscreen: () => void;
  onClose: () => void;
  /** Called once on mount to expose the error setter upward. */
  attachSetError: (setter: (msg: string | null) => void) => void;
}

function ControlsRoot({
  vizHostEl,
  mode,
  initialActiveId,
  onStart,
  onChangeViz,
  onChangeParams,
  onToggleFullscreen,
  onClose,
  attachSetError,
}: ControlsRootProps) {
  const [anchor, setAnchor] = useState(() => vizHostEl.getBoundingClientRect());
  const [started, setStarted] = useState(false);
  const [activeId, setActiveId] = useState(initialActiveId);
  const [error, setError] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(
    () => document.fullscreenElement !== null,
  );

  // Per-plugin param state. Each plugin gets its own values so a user
  // who tweaks Julia and then switches to Prism doesn't lose Julia's
  // settings when they come back. Lazy-initialised with each plugin's
  // declared defaults.
  const [paramsByPlugin, setParamsByPlugin] = useState<
    Record<string, ParamValues>
  >(() => ({ [initialActiveId]: defaultParamsFor(initialActiveId) }));

  const currentParams: ParamValues = useMemo(() => {
    return paramsByPlugin[activeId] ?? defaultParamsFor(activeId);
  }, [paramsByPlugin, activeId]);

  // Expose setError upward so the content script can surface engine
  // errors from the iframe (or from audio startup) in this UI.
  useEffect(() => {
    attachSetError(setError);
  }, [attachSetError]);

  // Track the viz area's rect so the controls stay glued to the hero
  // slot as live365 reflows / scrolls.
  useEffect(() => {
    const update = () => setAnchor(vizHostEl.getBoundingClientRect());
    const ro = new ResizeObserver(update);
    ro.observe(vizHostEl);
    window.addEventListener('scroll', update, { passive: true, capture: true });
    window.addEventListener('resize', update);
    return () => {
      ro.disconnect();
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [vizHostEl]);

  // Keep isFullscreen in sync with the browser — covers programmatic
  // toggles from our button, Esc-to-exit, and any other exit paths
  // (e.g. the user hits F11 or the browser revokes fullscreen).
  useEffect(() => {
    const onChange = () =>
      setIsFullscreen(document.fullscreenElement !== null);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const handleStart = () => {
    if (started || error) return;
    setStarted(true);
    onStart();
  };

  const handleChangeViz = (id: string) => {
    if (!getPluginById(id)) return;
    const params = paramsByPlugin[id] ?? defaultParamsFor(id);
    if (!paramsByPlugin[id]) {
      setParamsByPlugin((prev) => ({ ...prev, [id]: params }));
    }
    setActiveId(id);
    onChangeViz(id, params);
  };

  const handleChangeParams = (next: ParamValues) => {
    setParamsByPlugin((prev) => ({ ...prev, [activeId]: next }));
    onChangeParams(next);
  };

  return (
    <ExtensionControls
      anchor={anchor}
      activeId={activeId}
      params={currentParams}
      started={started}
      mode={mode}
      isFullscreen={isFullscreen}
      error={error}
      onStart={handleStart}
      onChangeViz={handleChangeViz}
      onChangeParams={handleChangeParams}
      onToggleFullscreen={onToggleFullscreen}
      onClose={onClose}
    />
  );
}

function readPersistedActiveId(): string {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return VISUALIZATIONS[0].id;
    const parsed = JSON.parse(raw) as { activeId?: string };
    const id = parsed.activeId;
    return id && getPluginById(id) ? id : VISUALIZATIONS[0].id;
  } catch {
    return VISUALIZATIONS[0].id;
  }
}

function persistActiveId(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ activeId: id }));
  } catch {
    /* storage disabled — no-op */
  }
}

// ---------------------------------------------------------------------------
// Page context detection
// ---------------------------------------------------------------------------

export type MountContext =
  | { mode: 'live365-hero'; imageEl: HTMLImageElement; slot: HTMLElement }
  | { mode: 'overlay' };

function detectContext(): MountContext {
  const isLive365Station =
    /(^|\.)live365\.com$/.test(location.host) &&
    /\/station\//.test(location.pathname);

  if (isLive365Station) {
    const imageEl = findLive365HeroImage();
    if (imageEl) {
      const slot = imageEl.parentElement;
      if (slot instanceof HTMLElement) {
        return { mode: 'live365-hero', imageEl, slot };
      }
    }
  }
  return { mode: 'overlay' };
}

/**
 * Find the live365 hero image element. The page markup the user shared:
 *   <img crossorigin="anonymous" alt="" src="https://media.live365.com/..."
 *        style="object-fit: cover; height: 100%; width: 100%;">
 *
 * We look for an <img> whose src is on the live365 media CDN and which
 * fills its parent (the hero slot). Fallback: pick the largest visible
 * live365-hosted image.
 */
function findLive365HeroImage(): HTMLImageElement | null {
  const candidates = Array.from(
    document.querySelectorAll<HTMLImageElement>(
      'img[src*="media.live365.com"]',
    ),
  );
  if (candidates.length === 0) return null;

  const filler = candidates.find((img) => {
    const cs = getComputedStyle(img);
    return cs.objectFit === 'cover' && cs.width.length > 0 && cs.height.length > 0;
  });
  if (filler) return filler;

  let best: HTMLImageElement | null = null;
  let bestArea = 0;
  for (const img of candidates) {
    const r = img.getBoundingClientRect();
    const a = r.width * r.height;
    if (a > bestArea) {
      bestArea = a;
      best = img;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Visualization host builder
// ---------------------------------------------------------------------------

interface HostHandle {
  /** The mounted host div — used by the controls layer to track position. */
  outer: HTMLDivElement;
  shadow: ShadowRoot;
  teardown: () => void;
}

function buildHost(context: MountContext): HostHandle {
  const outer = document.createElement('div');
  outer.setAttribute('data-visstack', 'viz-host');

  if (context.mode === 'live365-hero') {
    outer.style.cssText = [
      'position: relative',
      'width: 100%',
      'height: 100%',
      'overflow: hidden',
      'isolation: isolate',
      // Pointer events off so live365's overlays behave normally for
      // the user — *our* interactive UI lives in the separate controls
      // layer at document.documentElement, not here.
      'pointer-events: none',
    ].join(';');
    const prevDisplay = context.imageEl.style.display;
    context.imageEl.style.display = 'none';
    context.slot.insertBefore(outer, context.imageEl);

    const shadow = outer.attachShadow({ mode: 'open' });
    shadow.innerHTML = shadowMarkup();

    return {
      outer,
      shadow,
      teardown: () => {
        outer.remove();
        context.imageEl.style.display = prevDisplay;
      },
    };
  }

  outer.style.cssText = [
    'position: fixed',
    'inset: 0',
    // One notch below the controls layer — the visualization is
    // allowed to sit below any host-page overlays; clicks are handled
    // by the separate controls layer which is stacked above it.
    'z-index: 2147483646',
    'background: #000',
    'isolation: isolate',
    'pointer-events: none',
  ].join(';');
  document.documentElement.appendChild(outer);

  const shadow = outer.attachShadow({ mode: 'open' });
  shadow.innerHTML = shadowMarkup();

  return {
    outer,
    shadow,
    teardown: () => outer.remove(),
  };
}

/**
 * Shadow-root markup. A single positioned div hosts the iframe; styles
 * reset everything so host-page CSS can't bleed in.
 *
 * The `:host(:fullscreen)` block is the real fix for the "grey bars on
 * wide monitors" problem. Chrome's User Agent stylesheet applies a
 * `*:fullscreen { object-fit: contain !important; width/height: 100%
 * !important; ... }` rule. For an iframe, `object-fit: contain` uses
 * the iframe's intrinsic ratio (default 300×150) and letterboxes the
 * display to it — which is exactly the grey-bar pillar-boxing we see.
 *
 * By fullscreening the shadow *host* (a plain div) and forcing its
 * dimensions to `100vw × 100vh` with !important inside the shadow's
 * own stylesheet, we guarantee the host fills the screen. The `.root`
 * div and the iframe inside inherit via their `width/height: 100%`
 * declarations and then we explicitly clear any `object-fit` the UA
 * might try to apply to the iframe too, so nothing pillar-boxes.
 */
function shadowMarkup(): string {
  return `
    <style>
      :host, .root, [data-viz-root] {
        all: initial;
        display: block;
        width: 100%;
        height: 100%;
      }
      .root {
        position: relative;
        contain: strict;
      }
      [data-viz-root] {
        position: absolute;
        inset: 0;
      }

      /* Fullscreen overrides — see the comment above this block. */
      :host(:fullscreen) {
        width: 100vw !important;
        height: 100vh !important;
        max-width: none !important;
        max-height: none !important;
        background: #000 !important;
      }
      :host(:fullscreen) .root,
      :host(:fullscreen) [data-viz-root] {
        width: 100% !important;
        height: 100% !important;
      }
      :host(:fullscreen) iframe {
        width: 100% !important;
        height: 100% !important;
        object-fit: fill !important;
      }
    </style>
    <div class="root">
      <div data-viz-root></div>
    </div>
  `;
}
