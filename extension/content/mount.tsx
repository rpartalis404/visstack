/**
 * Visualizer mount module.
 *
 * Creates the DOM host (either inline replacing the live365 hero image, or
 * a floating overlay), builds a Shadow DOM inside it for style isolation,
 * wires up the audio pipeline from the captured tab stream, and renders
 * the visualizer React tree into the shadow root.
 */

import { createRoot, type Root } from 'react-dom/client';
import { StrictMode } from 'react';
import { AudioEngine } from '../../src/audio/AudioEngine';
import { ExtensionOverlay } from './ExtensionOverlay';

/** Handle returned to the content script entry for cleanup. */
export interface VizRoot {
  destroy(): void;
}

/**
 * Entry point: given a tabCapture streamId, build the host element, create
 * the audio graph, and mount the React overlay. Returns a handle for
 * teardown on subsequent activation (which toggles the viz off).
 */
export async function mountVisualizer(streamId: string): Promise<VizRoot> {
  const context = detectContext();
  const host = buildHost(context);
  const shadow = host.shadow;

  // Acquire the tab's audio MediaStream using the streamId. Content scripts
  // use the legacy `chromeMediaSource: 'tab'` constraint syntax for this.
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      // @ts-expect-error — these are Chrome-specific constraint properties
      // that aren't in the standard TypeScript lib.dom types.
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  });

  // Build the engine and route the captured stream through it. Engine is
  // the same one the webapp uses — no special-casing for the extension.
  const engine = new AudioEngine();
  engine.setSourceMediaStream(stream);
  await engine.ensureRunning();

  // IMPORTANT: tabCapture mutes the source tab's audio by default — we must
  // re-pipe the captured stream back to the system output or the user
  // hears nothing. This is unlike the getDisplayMedia case where the
  // source tab keeps playing.
  //
  // We bridge it back by playing the raw MediaStream through a hidden
  // <audio> element on the page. That element plays independently of the
  // AnalyserNode, so we get both: user hears audio + we analyze it.
  const playthrough = document.createElement('audio');
  playthrough.srcObject = stream;
  playthrough.autoplay = true;
  // Keep it out of the DOM layout — it still plays when detached
  playthrough.style.cssText = 'display:none';
  document.body.appendChild(playthrough);
  await playthrough.play().catch((e) => {
    console.warn('[Soundstack] playthrough autoplay blocked:', e);
  });

  // Mount React into the shadow root. We pass a container div so the
  // existing VisualizerHost can size itself naturally.
  const reactHost = shadow.querySelector<HTMLDivElement>('[data-viz-root]');
  if (!reactHost) throw new Error('[Soundstack] viz root missing');

  const root: Root = createRoot(reactHost);
  root.render(
    <StrictMode>
      <ExtensionOverlay
        engine={engine}
        context={context}
        onClose={() => destroy()}
      />
    </StrictMode>,
  );

  let destroyed = false;
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    try {
      root.unmount();
    } catch {
      // ignore
    }
    // Stop audio tracks so the browser drops the tab-capture indicator
    stream.getTracks().forEach((t) => t.stop());
    playthrough.pause();
    playthrough.srcObject = null;
    playthrough.remove();
    host.teardown();
    engine.destroy();
  };

  return { destroy };
}

// ---------------------------------------------------------------------------
// Page context detection
// ---------------------------------------------------------------------------

export type MountContext =
  | { mode: 'live365-hero'; imageEl: HTMLImageElement; slot: HTMLElement }
  | { mode: 'overlay' };

function detectContext(): MountContext {
  // Match /station/<slug> on any live365 subdomain/path variant
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
 * We look for an <img> whose src is on the live365 media CDN and which is
 * set to cover its parent (the hero slot). If the site layout changes this
 * selector needs updating, hence the fallback of picking the largest
 * visible live365-hosted image.
 */
function findLive365HeroImage(): HTMLImageElement | null {
  const candidates = Array.from(
    document.querySelectorAll<HTMLImageElement>(
      'img[src*="media.live365.com"]',
    ),
  );
  if (candidates.length === 0) return null;

  // Prefer images styled to fill their parent (that's the hero); fall back
  // to the largest one by on-screen area.
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
// DOM host builder
// ---------------------------------------------------------------------------

interface HostHandle {
  shadow: ShadowRoot;
  teardown: () => void;
}

/**
 * Create the host element + shadow root for the visualizer to live inside.
 *
 * live365-hero:
 *   The original <img> is kept in the DOM but display:none'd, and a new
 *   <div> is inserted right before it. On teardown we remove the div and
 *   restore the image's display. Any layout rules the live365 page has on
 *   the parent continue to apply — we just swap the visible child.
 *
 * overlay:
 *   A fixed-position full-viewport <div> appended to document.body.
 *   Highest z-index we dare use. Removed on teardown.
 */
function buildHost(context: MountContext): HostHandle {
  const outer = document.createElement('div');
  outer.setAttribute('data-soundstack', 'host');

  if (context.mode === 'live365-hero') {
    // Match the image's rendered size exactly — the shadow canvas will
    // then resize itself to fit via ResizeObserver.
    outer.style.cssText = [
      'position: relative',
      'width: 100%',
      'height: 100%',
      'overflow: hidden',
      'isolation: isolate', // new stacking context
    ].join(';');
    const prevDisplay = context.imageEl.style.display;
    context.imageEl.style.display = 'none';
    context.slot.insertBefore(outer, context.imageEl);

    const shadow = outer.attachShadow({ mode: 'open' });
    shadow.innerHTML = shadowMarkup();

    return {
      shadow,
      teardown: () => {
        outer.remove();
        context.imageEl.style.display = prevDisplay;
      },
    };
  }

  // Overlay mode
  outer.style.cssText = [
    'position: fixed',
    'inset: 0',
    'z-index: 2147483647', // max signed 32-bit int — top of everything
    'background: #000',
    'isolation: isolate',
  ].join(';');
  document.documentElement.appendChild(outer);

  const shadow = outer.attachShadow({ mode: 'open' });
  shadow.innerHTML = shadowMarkup();

  return {
    shadow,
    teardown: () => outer.remove(),
  };
}

/**
 * Static markup for the shadow root. A single full-size div acts as the
 * React mount point; styles below isolate typography from the host page.
 */
function shadowMarkup(): string {
  return `
    <style>
      :host, .root, [data-viz-root] {
        all: initial;
        display: block;
        width: 100%;
        height: 100%;
        font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
        color: #fff;
      }
      .root {
        position: relative;
        contain: strict;
      }
    </style>
    <div class="root">
      <div data-viz-root style="position:absolute;inset:0"></div>
    </div>
  `;
}
