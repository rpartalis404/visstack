import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AudioEngine } from './audio/AudioEngine';
import { CURATED_PRESETS, MAX_RECENTS, type StreamPreset } from './audio/presets';
import { VISUALIZATIONS, getPluginById } from './visualizations/registry';
import { defaultParamValues, type ParamValues } from './visualizations/types';
import { VisualizerHost } from './ui/VisualizerHost';
import { Switcher } from './ui/Switcher';
import { ParamPanel } from './ui/ParamPanel';
import { AudioSourceBar } from './ui/AudioSourceBar';
import { SourcePanel } from './ui/SourcePanel';
import styles from './App.module.css';
import uiStyles from './ui/ui.module.css';

const STORAGE_KEY = 'viz-state-v1';
const WELCOME_KEY = 'viz-welcome-dismissed-v1';

interface PersistedState {
  activeId: string;
  paramsByPlugin: Record<string, ParamValues>;
  lastUrl: string;
  recentUrls: string[];
}

function loadPersisted(): Partial<PersistedState> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as PersistedState) : {};
  } catch {
    return {};
  }
}

function savePersisted(s: PersistedState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // storage full / disabled — ignore silently
  }
}

export function App() {
  // AudioEngine is a singleton per App — instantiate lazily on first render
  const engineRef = useRef<AudioEngine | null>(null);
  if (engineRef.current === null) engineRef.current = new AudioEngine();
  const engine = engineRef.current;
  // Dev-only debug handle. Lets us poke at the engine from the console.
  if (import.meta.env.DEV) {
    (window as unknown as { __engine: AudioEngine }).__engine = engine;
  }

  // Persisted state
  const persisted = useMemo(loadPersisted, []);

  const [activeId, setActiveId] = useState<string>(() => {
    const id = persisted.activeId;
    return id && getPluginById(id) ? id : VISUALIZATIONS[0].id;
  });

  const [paramsByPlugin, setParamsByPlugin] = useState<Record<string, ParamValues>>(
    () => {
      const loaded = persisted.paramsByPlugin ?? {};
      // Fill in defaults for any missing plugin
      const out: Record<string, ParamValues> = {};
      for (const plugin of VISUALIZATIONS) {
        const defaults = defaultParamValues(plugin.params);
        out[plugin.id] = { ...defaults, ...(loaded[plugin.id] ?? {}) };
      }
      return out;
    },
  );

  const [sourceLabel, setSourceLabel] = useState<string>('');
  const [currentUrl, setCurrentUrl] = useState<string>('');
  const [isPlaying, setIsPlaying] = useState(false);
  const [status, setStatus] = useState({ bpm: 0, beat: false });
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  // First-visit welcome overlay. Dismissed either explicitly via the
  // "Got it" button or implicitly when the user opens a source. Sticky
  // across sessions via localStorage.
  const [welcomeDismissed, setWelcomeDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(WELCOME_KEY) === '1';
    } catch {
      return true; // storage disabled → don't badger the user
    }
  });
  const dismissWelcome = useCallback(() => {
    setWelcomeDismissed(true);
    try {
      localStorage.setItem(WELCOME_KEY, '1');
    } catch {
      /* storage disabled — fine, just won't persist */
    }
  }, []);
  const stageRef = useRef<HTMLDivElement>(null);
  /** Track the active capture's audio track so we can stop it on unmount
   *  and listen for it ending (user clicks "Stop sharing" in the browser
   *  banner). */
  const captureTrackRef = useRef<MediaStreamTrack | null>(null);

  // Recent URLs — capped, deduped, oldest-out
  const [recentUrls, setRecentUrls] = useState<string[]>(() => {
    const list = persisted.recentUrls;
    return Array.isArray(list) ? list.slice(0, MAX_RECENTS) : [];
  });

  // Recents materialized as StreamPreset[] for the dropdown
  const recentPresets = useMemo<StreamPreset[]>(() => {
    return recentUrls.map((url, idx) => {
      // If the URL matches a curated preset, surface its nice name
      const curated = CURATED_PRESETS.find((p) => p.url === url);
      if (curated) return curated;
      return {
        id: `recent-${idx}-${url.slice(0, 24)}`,
        name: 'Recent',
        description: url.length > 60 ? url.slice(0, 60) + '…' : url,
        url,
      };
    });
  }, [recentUrls]);

  const pushRecent = useCallback((url: string) => {
    setRecentUrls((prev) => {
      const filtered = prev.filter((u) => u !== url);
      return [url, ...filtered].slice(0, MAX_RECENTS);
    });
  }, []);

  // Mirror audioEl's play/pause state into React
  useEffect(() => {
    const el = engine.audioEl;
    const onPlay = () => {
      setIsPlaying(true);
      setErrorMsg('');
    };
    const onPause = () => setIsPlaying(false);
    const onEnded = () => setIsPlaying(false);
    el.addEventListener('play', onPlay);
    el.addEventListener('pause', onPause);
    el.addEventListener('ended', onEnded);
    const unsubErr = engine.onError((msg) => setErrorMsg(`Audio error: ${msg}`));
    return () => {
      el.removeEventListener('play', onPlay);
      el.removeEventListener('pause', onPause);
      el.removeEventListener('ended', onEnded);
      unsubErr();
    };
  }, [engine]);

  // NOTE: we deliberately do NOT destroy the AudioEngine on effect cleanup.
  // React StrictMode runs mount → unmount → mount in dev, and the engine is
  // stored in a module-lifetime ref shared across those cycles. Closing the
  // AudioContext in the synthetic unmount leaves the re-mounted app with a
  // zombie closed context (InvalidStateError: Cannot resume a closed
  // AudioContext). The AudioContext lives for the app's lifetime; the browser
  // reclaims its resources when the tab closes.

  // Persist on change (debounced implicitly by React's batched updates)
  useEffect(() => {
    savePersisted({
      activeId,
      paramsByPlugin,
      lastUrl: currentUrl,
      recentUrls,
    });
  }, [activeId, paramsByPlugin, currentUrl, recentUrls]);

  const activePlugin = getPluginById(activeId) ?? VISUALIZATIONS[0];
  const activeParams = paramsByPlugin[activePlugin.id];

  const handleParamChange = useCallback(
    (next: ParamValues) => {
      setParamsByPlugin((prev) => ({ ...prev, [activePlugin.id]: next }));
    },
    [activePlugin.id],
  );

  const handleLoadUrl = useCallback(
    async (url: string) => {
      setErrorMsg('');
      dismissWelcome();
      engine.setSourceUrl(url);
      setSourceLabel(url);
      setCurrentUrl(url);
      try {
        await engine.play();
        // Only push to recents on a successful play — avoids littering the
        // dropdown with URLs that errored out
        pushRecent(url);
      } catch (err) {
        setErrorMsg(`Playback blocked: ${(err as Error).message}`);
      }
    },
    [engine, pushRecent, dismissWelcome],
  );

  const handleLoadFile = useCallback(
    async (file: File) => {
      setErrorMsg('');
      dismissWelcome();
      engine.setSourceFile(file);
      setSourceLabel(file.name);
      // Local files don't go into recents — they'd be unloadable next session
      setCurrentUrl('');
      try {
        await engine.play();
      } catch (err) {
        setErrorMsg(`Playback blocked: ${(err as Error).message}`);
      }
    },
    [engine, dismissWelcome],
  );

  const handleBookmarkCurrent = useCallback(() => {
    if (currentUrl) pushRecent(currentUrl);
  }, [currentUrl, pushRecent]);

  const handleStopCapture = useCallback(() => {
    if (captureTrackRef.current) {
      captureTrackRef.current.stop();
      captureTrackRef.current = null;
    }
    setIsCapturing(false);
    setSourceLabel('');
  }, []);

  const handleCaptureSystemAudio = useCallback(async () => {
    setErrorMsg('');
    // Clicking Capture (even if the user later cancels the picker) counts
    // as acknowledging the welcome — no need to show it again next visit.
    dismissWelcome();
    try {
      // Must request video too — Chrome's getDisplayMedia requires it to
      // show the screen-share picker. We discard the video track immediately.
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });

      // Stop video — we never need it
      stream.getVideoTracks().forEach((t) => t.stop());

      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length === 0) {
        // User dismissed the audio checkbox — close & error
        stream.getTracks().forEach((t) => t.stop());
        setErrorMsg(
          'No audio in the share. Re-pick the source and check "Share tab audio" / "Share system audio".',
        );
        return;
      }

      // Build an audio-only stream and hand to the engine
      const audioStream = new MediaStream(audioTracks);
      const track = engine.setSourceMediaStream(audioStream);
      captureTrackRef.current = track;
      setIsCapturing(true);
      setCurrentUrl('');
      const sourceName = track.label || 'System audio capture';
      setSourceLabel(`🎙 ${sourceName}`);

      // User clicks "Stop sharing" in the browser banner → reset
      track.addEventListener('ended', () => {
        captureTrackRef.current = null;
        setIsCapturing(false);
        setSourceLabel('');
      });

      await engine.ensureRunning();
    } catch (err) {
      const e = err as Error;
      // NotAllowedError = user dismissed the picker; not actually a fault
      if (e.name !== 'NotAllowedError' && e.name !== 'AbortError') {
        setErrorMsg(`Capture failed: ${e.message}`);
      }
    }
  }, [engine, dismissWelcome]);

  // Stop the capture track on unmount (prevents zombie streams)
  useEffect(() => {
    return () => {
      if (captureTrackRef.current) {
        captureTrackRef.current.stop();
        captureTrackRef.current = null;
      }
    };
  }, []);

  const handlePlayPause = useCallback(async () => {
    if (engine.isPlaying) {
      engine.pause();
    } else {
      try {
        await engine.play();
      } catch (err) {
        setErrorMsg(`Playback blocked: ${(err as Error).message}`);
      }
    }
  }, [engine]);

  const handleToggleFullscreen = useCallback(async () => {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else if (stageRef.current) {
      // Put just the stage into fullscreen so the visualization fills the
      // whole screen without the side panel competing
      try {
        await stageRef.current.requestFullscreen();
      } catch (err) {
        setErrorMsg(`Fullscreen blocked: ${(err as Error).message}`);
      }
    }
  }, []);

  // Track browser-driven fullscreen state (Esc, F11, etc.)
  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // 'F' keyboard shortcut for fullscreen (ignored while typing in an input)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'f' && e.key !== 'F') return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      e.preventDefault();
      void handleToggleFullscreen();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleToggleFullscreen]);

  // Beat indicator pulse — drive via transient class from status callback
  const [beatFlash, setBeatFlash] = useState(false);
  useEffect(() => {
    if (!status.beat) return;
    setBeatFlash(true);
    const t = setTimeout(() => setBeatFlash(false), 90);
    return () => clearTimeout(t);
  }, [status.beat]);

  return (
    <div className={styles.root}>
      <div className={styles.topbar}>
        <AudioSourceBar
          onLoadUrl={handleLoadUrl}
          onLoadFile={handleLoadFile}
          onPlayPause={handlePlayPause}
          onToggleFullscreen={handleToggleFullscreen}
          onBookmarkCurrent={handleBookmarkCurrent}
          onCaptureSystemAudio={handleCaptureSystemAudio}
          onStopCapture={handleStopCapture}
          isPlaying={isPlaying}
          isFullscreen={isFullscreen}
          isCapturing={isCapturing}
          currentLabel={sourceLabel}
          currentUrl={currentUrl}
          curatedPresets={CURATED_PRESETS}
          recentPresets={recentPresets}
          // URL input + presets require the Vite dev proxy for cross-origin
          // CORS. GitHub Pages has no server-side proxy, so hide the URL
          // paths in production — visitors are funneled to the Capture +
          // Load File flows which work on any static host.
          showUrlInput={import.meta.env.DEV}
        />
      </div>

      <div className={styles.sidebar}>
        <SourcePanel
          isCapturing={isCapturing}
          sourceLabel={sourceLabel}
          onCapture={handleCaptureSystemAudio}
          onLoadFile={handleLoadFile}
          onStopCapture={handleStopCapture}
        />
        <Switcher
          visualizations={VISUALIZATIONS}
          activeId={activePlugin.id}
          onChange={setActiveId}
        />
        <ParamPanel
          schema={activePlugin.params}
          values={activeParams}
          onChange={handleParamChange}
        />
      </div>

      <div className={styles.stage} ref={stageRef}>
        <VisualizerHost
          engine={engine}
          plugin={activePlugin}
          params={activeParams}
          onStatus={setStatus}
        />
        <div className={styles.statusPill}>
          <div
            className={
              beatFlash
                ? `${styles.beatDot} ${styles.beatDotActive}`
                : styles.beatDot
            }
          />
          <span>{status.bpm > 0 ? `${status.bpm} BPM` : '—'}</span>
        </div>
        {errorMsg && (
          <div className={styles.errorBanner} role="alert">
            {errorMsg}
          </div>
        )}
        {/* First-visit welcome overlay. Shown only when no source is
            loaded AND the user hasn't acknowledged it before. */}
        {!sourceLabel && !welcomeDismissed && (
          <div className={uiStyles.welcomeOverlay}>
            <div className={uiStyles.welcomeCard}>
              <div className={uiStyles.welcomeLogo} aria-hidden />
              <h2 className={uiStyles.welcomeTitle}>Welcome to VisStack</h2>
              <p className={uiStyles.welcomeBody}>
                32 audio-reactive visualizations for any tab playing audio.
                Hit <strong>Capture tab audio</strong> on the left to pick
                a source and start visualizing.
              </p>
              <button
                type="button"
                className={uiStyles.welcomeDismiss}
                onClick={dismissWelcome}
              >
                Got it
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
