/**
 * Sandboxed visualizer page — loaded in an <iframe> by the content script.
 *
 * Why sandboxed?
 *   Butterchurn (the "classic-trip" plugin) compiles MilkDrop preset
 *   expressions with new Function() at runtime. MV3 forbids unsafe-eval
 *   in content scripts and in normal extension pages, but pages declared
 *   in manifest.sandbox.pages are served with a relaxed CSP that allows
 *   it. Rendering every plugin here too keeps the architecture uniform.
 *
 * Why WebRTC loopback for audio?
 *   chrome.tabCapture scopes the streamId to the consumer tab's origin
 *   (live365.com). This iframe runs at a null origin, so it cannot call
 *   getUserMedia with the streamId directly — Chrome rejects with
 *   "Invalid security origin". Workaround: the content script acquires
 *   the stream in its own (matching) origin, sends the audio track to
 *   this iframe through a same-process RTCPeerConnection pair. No STUN,
 *   no network, finishes in a few hundred ms.
 */
import { createRoot } from 'react-dom/client';
import { StrictMode } from 'react';
import { AudioEngine } from '../src/audio/AudioEngine';
import { ExtensionOverlay, type OverlayMode } from './content/ExtensionOverlay';

type OutboundMessage =
  | { type: 'VIZ_READY' }
  | { type: 'ANSWER'; sdp: string; typ: RTCSdpType }
  | { type: 'ICE2'; candidate: RTCIceCandidateInit }
  | { type: 'SOUNDSTACK_CLOSE' };

type InboundMessage =
  | { type: 'OFFER'; sdp: string; typ: RTCSdpType }
  | { type: 'ICE1'; candidate: RTCIceCandidateInit };

function postToParent(msg: OutboundMessage): void {
  // Parent origin is live365 (or whatever host page); we authenticate
  // sender identity via event.source, not origin, so targetOrigin '*'
  // is acceptable. No secrets in outbound payloads.
  window.parent.postMessage(msg, '*');
}

async function boot(): Promise<void> {
  // Read static context (hero vs overlay) from the URL hash — the
  // content script sets this when creating the iframe. Avoids a
  // message round-trip before we can render.
  const params = new URLSearchParams(window.location.hash.slice(1));
  const mode: OverlayMode =
    params.get('mode') === 'live365-hero' ? 'live365-hero' : 'overlay';

  // Same-device loopback peer — no ICE servers needed, local candidates
  // are sufficient when both ends share the same process.
  const pc2 = new RTCPeerConnection({ iceServers: [] });
  let engineStarted = false;
  // ICE candidates from pc1 can arrive before we finish setRemoteDescription.
  // Buffer them until the remote description is set, otherwise
  // addIceCandidate rejects.
  const pendingIce: RTCIceCandidateInit[] = [];
  let haveRemoteDesc = false;

  pc2.onicecandidate = (ev) => {
    if (ev.candidate) {
      postToParent({ type: 'ICE2', candidate: ev.candidate.toJSON() });
    }
  };

  pc2.ontrack = (ev) => {
    if (engineStarted) return;
    engineStarted = true;
    const [remoteStream] = ev.streams;
    if (!remoteStream) {
      fatal('peer connection ontrack fired without a stream');
      return;
    }
    void startEngine(remoteStream);
  };

  window.addEventListener('message', async (ev) => {
    if (ev.source !== window.parent) return;
    const data = ev.data as InboundMessage | undefined;
    if (!data || typeof data !== 'object') return;
    try {
      if (data.type === 'OFFER') {
        await pc2.setRemoteDescription({ type: data.typ, sdp: data.sdp });
        haveRemoteDesc = true;
        for (const c of pendingIce) {
          await pc2.addIceCandidate(c);
        }
        pendingIce.length = 0;
        const answer = await pc2.createAnswer();
        await pc2.setLocalDescription(answer);
        postToParent({ type: 'ANSWER', sdp: answer.sdp ?? '', typ: answer.type });
      } else if (data.type === 'ICE1') {
        if (haveRemoteDesc) {
          await pc2.addIceCandidate(data.candidate);
        } else {
          pendingIce.push(data.candidate);
        }
      }
    } catch (err) {
      console.error('[Soundstack viz] signaling error:', err);
    }
  });

  async function startEngine(stream: MediaStream): Promise<void> {
    const engine = new AudioEngine();
    // routeToOutput: true — connect analyser to ctx.destination so audio
    // actually plays back to the user's speakers.
    engine.setSourceMediaStream(stream, { routeToOutput: true });

    // AudioContext.resume() requires user activation. The toolbar-icon
    // click grants activation to the content-script frame (which is why
    // getUserMedia up there worked), but it doesn't propagate into this
    // sandboxed iframe — it runs at a null origin. Try resume anyway in
    // case a gesture is somehow available, and fall back to a one-shot
    // click-to-start overlay when Chrome blocks us.
    try {
      await engine.ensureRunning();
    } catch (err) {
      console.warn('[Soundstack viz] initial resume blocked, awaiting click:', err);
      await waitForUserClickToStart();
      try {
        await engine.ensureRunning();
      } catch (err2) {
        fatal(`audio context refused to start: ${(err2 as Error).message}`);
        return;
      }
    }

    const [track] = stream.getAudioTracks();
    if (track) {
      // If Chrome tears down the capture (user clicks away / closes tab)
      // the track ends — tell the parent to destroy us.
      track.addEventListener('ended', () =>
        postToParent({ type: 'SOUNDSTACK_CLOSE' }),
      );
    }

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
          context={{ mode }}
          onClose={() => postToParent({ type: 'SOUNDSTACK_CLOSE' })}
        />
      </StrictMode>,
    );

    // Best-effort cleanup on iframe unload. Not critical — the parent
    // will also stop the stream's tracks on its side when it tears us
    // down — but drops the tab-capture indicator more promptly.
    window.addEventListener('pagehide', () => {
      stream.getTracks().forEach((t) => t.stop());
      engine.destroy();
      try {
        pc2.close();
      } catch {
        /* already closed */
      }
    });
  }

  // Let the parent know we're ready to negotiate.
  postToParent({ type: 'VIZ_READY' });
}

/**
 * Render a centered "click to enable audio" overlay and resolve once the
 * user clicks. Used when Chrome's autoplay policy blocks our first
 * attempt to resume the AudioContext.
 */
function waitForUserClickToStart(): Promise<void> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.setAttribute('data-soundstack', 'start-overlay');
    overlay.style.cssText = [
      'position: absolute',
      'inset: 0',
      'display: flex',
      'align-items: center',
      'justify-content: center',
      'background: rgba(14,14,21,0.85)',
      'color: #fff',
      "font: 14px/1.4 system-ui, -apple-system, 'Segoe UI', sans-serif",
      'cursor: pointer',
      'z-index: 9999',
      '-webkit-backdrop-filter: blur(8px)',
      'backdrop-filter: blur(8px)',
    ].join(';');
    overlay.innerHTML = `
      <div style="padding: 14px 20px; border: 1px solid rgba(255,255,255,0.12);
                  border-radius: 8px; background: rgba(10,10,16,0.65);
                  text-align: center;">
        <div style="font-weight: 500; margin-bottom: 4px;">
          Click to enable audio
        </div>
        <div style="opacity: 0.65; font-size: 12px;">
          Chrome blocks autoplay across sandboxed frames
        </div>
      </div>
    `;
    overlay.addEventListener(
      'click',
      () => {
        overlay.remove();
        resolve();
      },
      { once: true },
    );
    document.body.appendChild(overlay);
  });
}

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
