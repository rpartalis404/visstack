/**
 * Visualizer host module (content-script side).
 *
 * Creates the DOM host (either inline replacing the live365 hero image, or
 * a fixed-position overlay), builds a Shadow DOM inside it for style
 * isolation, then injects a sandboxed <iframe> that loads viz.html from
 * our extension origin.
 *
 * Why an iframe?
 *   Butterchurn uses `new Function()` / `eval()` to compile MilkDrop
 *   preset expressions. MV3 forbids `unsafe-eval` in both content scripts
 *   and regular extension pages — they cannot opt out. Pages declared in
 *   manifest.sandbox.pages get a custom CSP that CAN allow `unsafe-eval`,
 *   so that's where the heavy visualization code lives. The content
 *   script's job is now just DOM placement + lifecycle.
 */

/** Handle returned to the content script entry for cleanup. */
export interface VizRoot {
  destroy(): void;
}

type InboundMessage = { type: 'SOUNDSTACK_CLOSE' };

function isCloseMessage(v: unknown): v is InboundMessage {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as { type?: unknown }).type === 'SOUNDSTACK_CLOSE'
  );
}

/**
 * Entry point: given a tabCapture streamId, build the host element and
 * inject the viz iframe. The iframe owns audio capture, playback and
 * rendering from here on — this side just listens for a CLOSE message
 * to tear itself down.
 */
export async function mountVisualizer(streamId: string): Promise<VizRoot> {
  const context = detectContext();
  const host = buildHost(context);
  const shadow = host.shadow;

  const iframe = document.createElement('iframe');
  // Pass streamId + context mode through the hash — never the query string
  // (hashes don't hit server logs or Referer headers; not that it matters
  // on a chrome-extension:// URL, but it's the right habit).
  const src = new URL(chrome.runtime.getURL('viz.html'));
  src.hash = new URLSearchParams({
    streamId,
    mode: context.mode,
  }).toString();
  iframe.src = src.toString();
  iframe.setAttribute('title', 'Soundstack Visualizer');
  // allow= grants feature policies that sandboxed docs would otherwise
  // have denied. autoplay lets our playthrough <audio> element start
  // without a user gesture.
  iframe.setAttribute('allow', 'autoplay');
  iframe.style.cssText = [
    'position: absolute',
    'inset: 0',
    'width: 100%',
    'height: 100%',
    'border: 0',
    'display: block',
    'background: transparent',
  ].join(';');

  const reactHost = shadow.querySelector<HTMLDivElement>('[data-viz-root]');
  if (!reactHost) throw new Error('[Soundstack] viz root missing');
  reactHost.appendChild(iframe);

  // Bridge close events from the iframe. We authenticate the sender by
  // identity (event.source), not origin — sandboxed iframes have a null
  // origin, so origin checks are useless here.
  const onMessage = (event: MessageEvent) => {
    if (event.source !== iframe.contentWindow) return;
    if (isCloseMessage(event.data)) destroy();
  };
  window.addEventListener('message', onMessage);

  // Escape closes from the host page too — the iframe catches it when
  // focused, but if focus is on the host we still want the shortcut.
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') destroy();
  };
  window.addEventListener('keydown', onKey);

  let destroyed = false;
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    window.removeEventListener('message', onMessage);
    window.removeEventListener('keydown', onKey);
    iframe.remove();
    host.teardown();
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
 * Create the host element + shadow root for the visualizer iframe to live
 * inside.
 *
 * live365-hero:
 *   The original <img> is kept in the DOM but display:none'd, and a new
 *   <div> is inserted right before it. On teardown we remove the div and
 *   restore the image's display.
 *
 * overlay:
 *   A fixed-position full-viewport <div> appended to document.documentElement
 *   (so it sits above body-level stacking contexts).
 */
function buildHost(context: MountContext): HostHandle {
  const outer = document.createElement('div');
  outer.setAttribute('data-soundstack', 'host');

  if (context.mode === 'live365-hero') {
    outer.style.cssText = [
      'position: relative',
      'width: 100%',
      'height: 100%',
      'overflow: hidden',
      'isolation: isolate',
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
 * iframe mount point; styles below isolate typography from the host page.
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
    </style>
    <div class="root">
      <div data-viz-root style="position:absolute;inset:0"></div>
    </div>
  `;
}
