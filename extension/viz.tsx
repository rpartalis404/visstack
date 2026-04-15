/**
 * Sandboxed visualizer page — loaded inside an <iframe> that the content
 * script injects into the host tab. Why sandboxed?
 *
 *   MV3 forbids `unsafe-eval` in regular extension pages AND in content
 *   scripts. Butterchurn compiles MilkDrop preset expressions with
 *   new Function() / eval at runtime, so it cannot run in either of those
 *   contexts. Pages declared in manifest.sandbox.pages are served with a
 *   relaxed CSP of our choosing (see manifest.json) and run in a unique
 *   null-origin — perfect for letting butterchurn do its thing without
 *   polluting the extension's normal security posture.
 *
 * The tradeoff: sandboxed pages cannot access chrome.* APIs. So the stream
 * must be set up via `navigator.mediaDevices.getUserMedia` right here in
 * the iframe, using the streamId passed through the URL hash. Any other
 * coordination with the content script happens through window.postMessage.
 */
import { createRoot } from 'react-dom/client';
import { StrictMode } from 'react';
import { AudioEngine } from '../src/audio/AudioEngine';
import { ExtensionOverlay } from './content/ExtensionOverlay';

// The iframe lives inside the host tab (tab.id matches the content script's
// tab). It's a null-origin context — postMessage targets 'parent' and we
// signal lifecycle events upward this way.
type OutboundMessage = { type: 'SOUNDSTACK_CLOSE' };

function postToParent(msg: OutboundMessage): void {
  // `*` is safe here because the only sender we authenticate is parent, and
  // we never expose secrets in the payloads. The parent validates with
  // `event.source === iframe.contentWindow` before acting on any message.
  window.parent.postMessage(msg, '*');
}

async function boot(): Promise<void> {
  // Pull the streamId from the hash. We deliberately use hash (not query)
  // so the value never hits server logs / Referer headers.
  const params = new URLSearchParams(window.location.hash.slice(1));
  const streamId = params.get('streamId');
  const mode = (params.get('mode') === 'live365-hero' ? 'live365-hero' : 'overlay') as
    | 'live365-hero'
    | 'overlay';

  if (!streamId) {
    fatal('missing streamId in viz.html#... — refusing to start');
    return;
  }

  // Clear the hash before anyone else can observe it. Doesn't change the
  // iframe's document, just cleans the URL bar for debugging. At the
  // sandbox page's null origin, replaceState may throw — not worth
  // aborting over.
  try {
    history.replaceState(null, '', location.pathname);
  } catch {
    // sandboxed null-origin context — cosmetic only, ignore
  }

  // Acquire the tab's audio. Content scripts use this legacy constraint
  // syntax for tabCapture — same story here since the iframe is just
  // another getUserMedia consumer in the same tab.
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // @ts-expect-error — chromium-specific constraints not in lib.dom
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      },
      video: false,
    });
  } catch (err) {
    fatal(`getUserMedia failed: ${(err as Error).message}`);
    return;
  }

  // Wire the captured stream through the shared AudioEngine — same class
  // the webapp uses, no special-casing here.
  const engine = new AudioEngine();
  engine.setSourceMediaStream(stream);
  await engine.ensureRunning();

  // tabCapture mutes the source tab's audio. Replay the captured stream
  // through a hidden <audio> element so the user hears what's being
  // visualized. The element plays independently of the AnalyserNode, so
  // both audio output and analysis see the same data.
  const playthrough = document.createElement('audio');
  playthrough.srcObject = stream;
  playthrough.autoplay = true;
  playthrough.style.cssText = 'display:none';
  document.body.appendChild(playthrough);
  await playthrough.play().catch((e) => {
    console.warn('[Soundstack viz] playthrough autoplay blocked:', e);
  });

  // If the user clicks "Stop sharing" in the browser capture banner, or
  // the track ends for any other reason, tear ourselves down.
  const [audioTrack] = stream.getAudioTracks();
  if (audioTrack) {
    audioTrack.addEventListener('ended', () => postToParent({ type: 'SOUNDSTACK_CLOSE' }));
  }

  // Render the React overlay. onClose posts up to the parent, which will
  // remove the iframe + restore the host's DOM. We do NOT tear down here —
  // the parent owns lifecycle and will unload the iframe.
  const rootEl = document.getElementById('root');
  if (!rootEl) {
    fatal('#root element missing in viz.html');
    return;
  }
  const root = createRoot(rootEl);
  root.render(
    <StrictMode>
      <ExtensionOverlay
        engine={engine}
        context={mode === 'live365-hero' ? { mode: 'live365-hero' } : { mode: 'overlay' }}
        onClose={() => postToParent({ type: 'SOUNDSTACK_CLOSE' })}
      />
    </StrictMode>,
  );

  // On hard reload / iframe unload, stop the tracks so Chrome drops the
  // tab-capture indicator promptly.
  window.addEventListener('pagehide', () => {
    stream.getTracks().forEach((t) => t.stop());
    engine.destroy();
  });
}

/**
 * Render a human-readable error into the iframe body. Because this page is
 * sandboxed we can't use console logs that the host-page devtools picks up
 * cleanly — surfacing errors visibly makes debugging from the live365 tab
 * much easier.
 */
function fatal(message: string): void {
  const msg = `[Soundstack viz] ${message}`;
  console.error(msg);
  document.body.innerHTML = `
    <div style="position:absolute;inset:0;display:flex;align-items:center;
                justify-content:center;padding:16px;box-sizing:border-box;
                font:13px/1.4 system-ui,-apple-system,'Segoe UI',sans-serif;
                color:#fff;background:rgba(24,18,32,0.82);text-align:center;">
      ${escapeHtml(msg)}
    </div>
  `;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

void boot();
