/**
 * Content script entry point.
 *
 * Injected on demand by the background service worker when the user clicks
 * the extension icon. Listens for a SOUNDSTACK_ACTIVATE message carrying
 * a tabCapture streamId, then bootstraps the visualizer in one of two
 * contexts depending on the host page:
 *
 *   - live365.com/station/* : replace the hero image with an inline visualizer
 *   - any other page       : show a floating full-viewport overlay
 *
 * The visualizer itself runs inside a Shadow DOM so host-page CSS can't
 * leak into our overlay (and vice versa).
 */

import type { VizRoot } from './mount';

// Marker so repeated activations don't stack multiple overlays. `any` is
// intentional — we're monkey-patching window to communicate across
// re-injections of this script.
declare global {
  interface Window {
    __soundstack?: {
      root: VizRoot;
      cleanup: () => void;
    };
  }
}

/**
 * Defensively swallow Vite's preload-error events.
 *
 * When the content script dynamic-imports a chunk, Vite also tries to
 * preload any CSS that chunk depends on. In a content-script context the
 * preload URL gets resolved against the host page's origin (e.g. live365)
 * rather than the chrome-extension:// origin, so the preload 404s. The
 * failed preload rejects the dynamic import and aborts activation.
 *
 * Vite dispatches `vite:preloadError` before throwing — calling
 * preventDefault() tells it to skip the throw. The real JS chunk load
 * uses crxjs's URL rewriting and works fine; only the CSS preload path
 * fails. Since we don't ship any CSS in the dynamic chunks today (all
 * styles are inline), this is defense-in-depth for future changes.
 */
window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault();
  console.warn(
    '[Soundstack] suppressed vite:preloadError (harmless in content scripts):',
    (event as unknown as { payload?: Error }).payload,
  );
});

type ActivateMessage = {
  type: 'SOUNDSTACK_ACTIVATE';
  streamId: string;
};

chrome.runtime.onMessage.addListener(
  (msg: unknown, _sender, _sendResponse) => {
    if (!isActivateMessage(msg)) return;
    void activate(msg.streamId);
    return false;
  },
);

function isActivateMessage(m: unknown): m is ActivateMessage {
  return (
    typeof m === 'object' &&
    m !== null &&
    (m as { type?: unknown }).type === 'SOUNDSTACK_ACTIVATE' &&
    typeof (m as { streamId?: unknown }).streamId === 'string'
  );
}

async function activate(streamId: string): Promise<void> {
  // If already mounted, treat this invocation as a toggle-off.
  if (window.__soundstack) {
    window.__soundstack.cleanup();
    window.__soundstack = undefined;
    return;
  }

  // Dynamic import keeps the content bundle small on the first inject.
  // Everything heavy (three.js, butterchurn, plugins) lives behind this.
  const { mountVisualizer } = await import('./mount');
  const inst = await mountVisualizer(streamId);
  window.__soundstack = {
    root: inst,
    cleanup: () => inst.destroy(),
  };
}
