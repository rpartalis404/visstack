import { BeatDetector } from './beatDetector';
import type { AudioFrame } from './types';

/**
 * Owns the audio pipeline: an <audio> element → MediaElementAudioSourceNode
 * → AnalyserNode → destination. Exposes the AnalyserNode (for libraries like
 * Butterchurn that want to connect themselves) and produces AudioFrame
 * objects on demand via getCurrentFrame().
 *
 * The VisualizerHost owns the rAF loop and calls getCurrentFrame(nowMs)
 * once per frame. Keeps ownership of the tick loop in one place.
 */
export class AudioEngine {
  readonly ctx: AudioContext;
  readonly audioEl: HTMLAudioElement;
  readonly analyser: AnalyserNode;

  /** Created lazily on first setSourceUrl/setSourceFile. Connects audioEl
   *  to the analyser. createMediaElementSource can only be called ONCE per
   *  HTMLAudioElement, so we cache it. */
  private elementSource: MediaElementAudioSourceNode | null = null;
  /** Created on captureSystemAudio. Wraps a MediaStream (e.g. from
   *  getDisplayMedia) and feeds it to the analyser. Discarded when capture
   *  ends or the user switches back to a URL/file source. */
  private streamSource: MediaStreamAudioSourceNode | null = null;
  /** Held so we can stop all tracks on cleanup / source switch. */
  private currentStream: MediaStream | null = null;

  // TS 5.7+ narrows Uint8Array by its underlying buffer type; Web Audio
  // getByte* methods expect Uint8Array<ArrayBuffer> specifically.
  private readonly fftBuf: Uint8Array<ArrayBuffer>;
  private readonly waveBuf: Uint8Array<ArrayBuffer>;
  private readonly beatDetector = new BeatDetector();

  private startedMs: number | null = null;
  private lastFrameMs = 0;
  /** Re-used object to avoid allocating 60× per second. */
  private readonly frame: AudioFrame;

  constructor() {
    this.ctx = new AudioContext();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.8;

    // Explicit ArrayBuffer construction so TS 5.7+ narrows to Uint8Array<ArrayBuffer>
    // (the exact type getByteFrequencyData / getByteTimeDomainData expect).
    this.fftBuf = new Uint8Array(new ArrayBuffer(this.analyser.frequencyBinCount));
    this.waveBuf = new Uint8Array(new ArrayBuffer(this.analyser.fftSize));

    this.audioEl = document.createElement('audio');
    this.audioEl.crossOrigin = 'anonymous';
    this.audioEl.preload = 'auto';
    // Mutation to body is avoided; the element plays without being in the DOM.

    this.frame = {
      fft: this.fftBuf,
      waveform: this.waveBuf,
      sampleRate: this.ctx.sampleRate,
      bass: 0,
      mid: 0,
      treble: 0,
      energy: 0,
      beat: false,
      bpm: 0,
      t: 0,
      dt: 0,
    };
  }

  /**
   * Resume the AudioContext, throwing if Chrome's autoplay policy blocks us.
   *
   * Chrome does NOT reject `ctx.resume()` when autoplay is blocked — it
   * returns a Promise that stays pending indefinitely until a user gesture
   * lets the context transition to `running`. A plain `await resume()`
   * therefore hangs forever, which means callers relying on rejection to
   * show a "click to enable audio" UI never get the chance.
   *
   * Workaround: race resume() against a short timeout, then assert the
   * state actually transitioned. Callers catch and show UI if it didn't.
   */
  async ensureRunning(): Promise<void> {
    // Read via a getter each time — `state` mutates asynchronously during
    // the await below, but TS can't see that through control-flow analysis.
    const state = (): AudioContextState => this.ctx.state;

    if (state() === 'running') return;

    await Promise.race([
      this.ctx.resume(),
      new Promise<void>((resolve) => setTimeout(resolve, 150)),
    ]);

    if (state() !== 'running') {
      throw new Error('AudioContext blocked — needs user gesture');
    }
  }

  /**
   * Set audio source URL. Cross-origin stream URLs are auto-routed through
   * the Vite dev proxy at /stream?url=... so the AnalyserNode can read the
   * samples (same-origin after the proxy). Same-origin URLs and blob URLs
   * pass through unchanged.
   */
  setSourceUrl(url: string): void {
    this.activateElementSource();
    this.audioEl.src = this.maybeProxy(url);
  }

  /** Set audio source from a local File (e.g. drag-drop / file picker). */
  setSourceFile(file: File): void {
    this.activateElementSource();
    const url = URL.createObjectURL(file);
    this.audioEl.src = url;
  }

  /**
   * Wire a MediaStream (e.g. from `navigator.mediaDevices.getDisplayMedia`
   * or `chrome.tabCapture`) as the audio source. Audio flows:
   *   stream → MediaStreamSource → analyser
   *
   * The caller decides whether the analyser should also drive the audio
   * destination (speakers):
   *
   *   - getDisplayMedia (webapp): `routeToOutput: false` (default). The
   *     source tab/screen is already playing through system output; a
   *     destination connection here would duplicate it (echo, feedback).
   *
   *   - tabCapture (extension): `routeToOutput: true`. Chrome mutes the
   *     source tab's speaker output while the tabCapture stream is being
   *     consumed, so without a destination connection the user gets
   *     silence. Routing the analyser to destination restores playback.
   *     Relying on a hidden `<audio srcObject>` playthrough here is
   *     unreliable because Chrome's autoplay policy may block `.play()`
   *     by the time the async activation hops finish.
   *
   * Returns the audio MediaStreamTrack so the caller can listen for
   * `ended` (e.g. user clicks "Stop sharing" in the browser banner).
   */
  setSourceMediaStream(
    stream: MediaStream,
    options: { routeToOutput?: boolean } = {},
  ): MediaStreamTrack {
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      throw new Error(
        'No audio track in stream — make sure to enable "Share tab audio" / "Share system audio"',
      );
    }

    this.deactivateAllSources();

    this.currentStream = stream;
    this.streamSource = this.ctx.createMediaStreamSource(stream);
    this.streamSource.connect(this.analyser);
    if (options.routeToOutput) {
      this.analyser.connect(this.ctx.destination);
    }

    return audioTracks[0];
  }

  /**
   * Subscribe to audio load/playback errors. Returns an unsubscribe fn.
   * Callers get the original user-entered URL so error messages stay clear.
   */
  onError(listener: (message: string) => void): () => void {
    const handler = (ev: Event) => {
      const err = this.audioEl.error;
      // MediaError codes: 1=ABORTED 2=NETWORK 3=DECODE 4=SRC_NOT_SUPPORTED
      const codeNames: Record<number, string> = {
        1: 'aborted',
        2: 'network',
        3: 'decode',
        4: 'source not supported',
      };
      const detail = err
        ? `${codeNames[err.code] ?? `code ${err.code}`}${err.message ? `: ${err.message}` : ''}`
        : (ev.type ?? 'unknown');
      listener(detail);
    };
    this.audioEl.addEventListener('error', handler);
    return () => this.audioEl.removeEventListener('error', handler);
  }

  async play(): Promise<void> {
    await this.ensureRunning();
    await this.audioEl.play();
  }

  pause(): void {
    this.audioEl.pause();
  }

  get isPlaying(): boolean {
    return !this.audioEl.paused && !this.audioEl.ended;
  }

  /**
   * Compute and return the current audio frame.
   * Call once per rAF tick from the visualizer host.
   */
  getCurrentFrame(nowMs: number): AudioFrame {
    if (this.startedMs === null) this.startedMs = nowMs;
    const dtSec = this.lastFrameMs === 0 ? 0 : (nowMs - this.lastFrameMs) / 1000;
    this.lastFrameMs = nowMs;

    this.analyser.getByteFrequencyData(this.fftBuf);
    this.analyser.getByteTimeDomainData(this.waveBuf);

    const { bass, mid, treble, energy } = this.computeBands(
      this.fftBuf,
      this.ctx.sampleRate,
      this.analyser.fftSize,
    );

    const { beat, bpm } = this.beatDetector.update(bass, nowMs);

    this.frame.sampleRate = this.ctx.sampleRate;
    this.frame.bass = bass;
    this.frame.mid = mid;
    this.frame.treble = treble;
    this.frame.energy = energy;
    this.frame.beat = beat;
    this.frame.bpm = bpm;
    this.frame.t = (nowMs - this.startedMs) / 1000;
    this.frame.dt = dtSec;
    return this.frame;
  }

  /** True if a MediaStream (e.g. system-audio capture) is the active source. */
  get isCapturingStream(): boolean {
    return this.streamSource !== null;
  }

  destroy(): void {
    this.deactivateAllSources();
    this.audioEl.removeAttribute('src');
    this.audioEl.load();
    void this.ctx.close();
  }

  // --- internals ---

  /**
   * Activate the <audio> element as the source. createMediaElementSource
   * can only be called ONCE per element, so we cache it after first use.
   * On re-activation we just rewire it to the analyser.
   */
  private activateElementSource(): void {
    // If a stream was captured, tear it down first
    if (this.streamSource) {
      this.streamSource.disconnect();
      this.streamSource = null;
    }
    if (this.currentStream) {
      this.currentStream.getTracks().forEach((t) => t.stop());
      this.currentStream = null;
    }

    if (!this.elementSource) {
      this.elementSource = this.ctx.createMediaElementSource(this.audioEl);
    }
    // Reconnecting an already-connected node is a no-op in Web Audio
    this.elementSource.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
  }

  /**
   * Tear down whichever source is currently active and pause the element.
   * Called when switching modes or destroying.
   */
  private deactivateAllSources(): void {
    if (this.streamSource) {
      this.streamSource.disconnect();
      this.streamSource = null;
    }
    if (this.currentStream) {
      this.currentStream.getTracks().forEach((t) => t.stop());
      this.currentStream = null;
    }
    if (this.elementSource) {
      try {
        this.elementSource.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    try {
      this.analyser.disconnect(this.ctx.destination);
    } catch {
      /* not currently connected */
    }
    this.audioEl.pause();
  }

  /**
   * Route cross-origin HTTP(S) stream URLs through our same-origin dev
   * proxy. Leave blob: / file: / same-origin URLs alone.
   */
  private maybeProxy(rawUrl: string): string {
    try {
      const u = new URL(rawUrl, window.location.href);
      if (u.protocol === 'blob:' || u.protocol === 'file:') return rawUrl;
      if (u.origin === window.location.origin) return rawUrl;
      return `/stream?url=${encodeURIComponent(rawUrl)}`;
    } catch {
      // Not a parseable URL — let the <audio> element reject it normally
      return rawUrl;
    }
  }

  /**
   * Bucket FFT bins into bass/mid/treble bands and compute normalized 0..1
   * averages. Also returns an overall energy value.
   */
  private computeBands(
    fft: Uint8Array,
    sampleRate: number,
    fftSize: number,
  ): { bass: number; mid: number; treble: number; energy: number } {
    const nyquist = sampleRate / 2;
    const binHz = nyquist / fft.length;

    const bassEnd = Math.floor(250 / binHz);
    const midEnd = Math.floor(4000 / binHz);

    let bassSum = 0;
    let midSum = 0;
    let trebleSum = 0;
    let totalSum = 0;

    for (let i = 0; i < fft.length; i++) {
      const v = fft[i];
      totalSum += v;
      if (i < bassEnd) bassSum += v;
      else if (i < midEnd) midSum += v;
      else trebleSum += v;
    }

    const bassN = Math.max(1, bassEnd);
    const midN = Math.max(1, midEnd - bassEnd);
    const trebleN = Math.max(1, fft.length - midEnd);

    // Each band averaged then normalized (0..1). A quiet perceptual floor
    // is subtracted so silence → 0 instead of ~0.1 from noise floor.
    const norm = (sum: number, n: number) => {
      const avg = sum / n / 255;
      return Math.max(0, (avg - 0.03) / 0.97);
    };

    // `fftSize` unused in sums but accepted for future smoothing / mel curves
    void fftSize;

    return {
      bass: norm(bassSum, bassN),
      mid: norm(midSum, midN),
      treble: norm(trebleSum, trebleN),
      energy: norm(totalSum, fft.length),
    };
  }
}
