/**
 * Content-script side of the visualizer.
 *
 * Responsibilities:
 *   - Detect whether we're on a live365 station (replace hero image) or
 *     anywhere else (floating overlay).
 *   - Build the shadow-DOM host.
 *   - Acquire the tab-capture stream via getUserMedia. This MUST run in
 *     the content-script origin because chrome.tabCapture scopes its
 *     streamIds to the consumer tab's origin.
 *   - Inject a sandboxed iframe (viz.html) that does the actual
 *     rendering — butterchurn needs unsafe-eval, which only sandboxed
 *     extension pages are allowed.
 *   - Bridge the captured audio track to that iframe through a local
 *     RTCPeerConnection loopback (no STUN, no network).
 *   - Swallow click / pointer bubbling so live365's hero-image link
 *     handlers can't steal clicks from our viz-switcher.
 *   - Tear everything down on close.
 */

/** Handle returned to the content script entry for cleanup. */
export interface VizRoot {
  destroy(): void;
}

// Messages exchanged with the sandboxed viz.html iframe.
type InboundFromIframe =
  | { type: 'VIZ_READY' }
  | { type: 'ANSWER'; sdp: string; typ: RTCSdpType }
  | { type: 'ICE2'; candidate: RTCIceCandidateInit }
  | { type: 'SOUNDSTACK_CLOSE' };

/**
 * Entry point: given a tabCapture streamId, acquire the stream, spin up
 * the visualizer iframe, and bridge the audio track to it.
 */
export async function mountVisualizer(streamId: string): Promise<VizRoot> {
  const context = detectContext();
  const host = buildHost(context);
  const shadow = host.shadow;

  // Acquire the tab's audio MediaStream using the streamId. Content
  // scripts use Chrome's legacy `chromeMediaSource: 'tab'` constraint.
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      // @ts-expect-error — chromium-specific constraints not in lib.dom
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  });

  // Same-process loopback: no ICE servers needed, local candidates
  // suffice. Add the audio track before negotiation so the track is
  // there when we build the offer.
  const pc1 = new RTCPeerConnection({ iceServers: [] });
  stream.getAudioTracks().forEach((t) => pc1.addTrack(t, stream));

  // Inject the sandboxed iframe. We pass the context mode via URL hash
  // so the iframe can render the right tooltip without a message hop.
  const iframe = document.createElement('iframe');
  const vizUrl = new URL(chrome.runtime.getURL('viz.html'));
  vizUrl.hash = new URLSearchParams({ mode: context.mode }).toString();
  iframe.src = vizUrl.toString();
  iframe.setAttribute('title', 'Soundstack Visualizer');
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

  // --- WebRTC signaling via postMessage ------------------------------
  // ICE candidates from pc1 are sent down to pc2 as they're gathered.
  // Candidates from pc2 arrive via ICE2 messages below. Sandboxed
  // iframes have a null origin, so we authenticate by sender identity
  // (event.source === iframe.contentWindow) rather than event.origin.

  let vizReady = false;
  let haveRemoteDesc = false;
  const pendingIce: RTCIceCandidateInit[] = [];

  const sendToIframe = (msg: unknown): void => {
    iframe.contentWindow?.postMessage(msg, '*');
  };

  pc1.onicecandidate = (ev) => {
    if (ev.candidate) {
      sendToIframe({ type: 'ICE1', candidate: ev.candidate.toJSON() });
    }
  };

  const onMessage = async (ev: MessageEvent) => {
    if (ev.source !== iframe.contentWindow) return;
    const data = ev.data as InboundFromIframe | undefined;
    if (!data || typeof data !== 'object') return;
    try {
      switch (data.type) {
        case 'VIZ_READY': {
          if (vizReady) return;
          vizReady = true;
          // Now that the iframe is listening, build and send the offer.
          const offer = await pc1.createOffer();
          await pc1.setLocalDescription(offer);
          sendToIframe({
            type: 'OFFER',
            sdp: offer.sdp ?? '',
            typ: offer.type,
          });
          break;
        }
        case 'ANSWER':
          await pc1.setRemoteDescription({ type: data.typ, sdp: data.sdp });
          haveRemoteDesc = true;
          for (const c of pendingIce) await pc1.addIceCandidate(c);
          pendingIce.length = 0;
          break;
        case 'ICE2':
          if (haveRemoteDesc) {
            await pc1.addIceCandidate(data.candidate);
          } else {
            pendingIce.push(data.candidate);
          }
          break;
        case 'SOUNDSTACK_CLOSE':
          destroy();
          break;
      }
    } catch (err) {
      console.error('[Soundstack] signaling error:', err);
    }
  };
  window.addEventListener('message', onMessage);

  // Esc in the host document closes too. The iframe catches its own Esc
  // when it has focus, but the host usually has focus right after mount.
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') destroy();
  };
  window.addEventListener('keydown', onKey);

  // If the capture track ends unexpectedly (user closed the tab,
  // Chrome revoked capture), tear down.
  stream.getAudioTracks().forEach((t) =>
    t.addEventListener('ended', () => destroy()),
  );

  let destroyed = false;
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    window.removeEventListener('message', onMessage);
    window.removeEventListener('keydown', onKey);
    try {
      pc1.close();
    } catch {
      /* already closed */
    }
    stream.getTracks().forEach((t) => t.stop());
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

function buildHost(context: MountContext): HostHandle {
  const outer = document.createElement('div');
  outer.setAttribute('data-soundstack', 'host');

  // Swallow pointer-event bubbling to ancestors. On live365 the hero
  // slot is wrapped in a link that navigates on click — without this,
  // clicks on the viz-switcher dropdown would trigger that navigation
  // instead of opening the menu.
  const swallow = (e: Event) => e.stopPropagation();
  for (const type of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup'] as const) {
    outer.addEventListener(type, swallow);
  }

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

  outer.style.cssText = [
    'position: fixed',
    'inset: 0',
    'z-index: 2147483647',
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
 * Shadow-root markup. A single positioned div acts as the iframe mount
 * point; styles below isolate any global typography from the host page.
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
