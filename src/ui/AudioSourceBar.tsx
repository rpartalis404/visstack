import { useEffect, useRef, useState } from 'react';
import styles from './ui.module.css';
import type { StreamPreset } from '../audio/presets';
import { shortLabelFromUrl } from '../audio/presets';

interface Props {
  onLoadUrl: (url: string) => void;
  onLoadFile: (file: File) => void;
  onPlayPause: () => void;
  onToggleFullscreen: () => void;
  onBookmarkCurrent: () => void;
  onCaptureSystemAudio: () => void;
  onStopCapture: () => void;
  isPlaying: boolean;
  isFullscreen: boolean;
  isCapturing: boolean;
  currentLabel: string;
  /** Currently-loaded URL — used by the bookmark button. Empty if none. */
  currentUrl: string;
  curatedPresets: readonly StreamPreset[];
  recentPresets: readonly StreamPreset[];
}

export function AudioSourceBar({
  onLoadUrl,
  onLoadFile,
  onPlayPause,
  onToggleFullscreen,
  onBookmarkCurrent,
  onCaptureSystemAudio,
  onStopCapture,
  isPlaying,
  isFullscreen,
  isCapturing,
  currentLabel,
  currentUrl,
  curatedPresets,
  recentPresets,
}: Props) {
  const [url, setUrl] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside the input or dropdown
  useEffect(() => {
    if (!showDropdown) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (dropdownRef.current?.contains(target)) return;
      if (inputRef.current?.contains(target)) return;
      setShowDropdown(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [showDropdown]);

  const pickPreset = (preset: StreamPreset) => {
    setUrl(preset.url);
    setShowDropdown(false);
    onLoadUrl(preset.url);
  };

  const submitUrl = () => {
    const u = url.trim();
    if (!u) return;
    onLoadUrl(u);
    setShowDropdown(false);
  };

  const isCurrentBookmarkable =
    Boolean(currentUrl) &&
    !curatedPresets.some((p) => p.url === currentUrl) &&
    !recentPresets.some((p) => p.url === currentUrl);

  return (
    <div className={styles.sourceBar}>
      {isCapturing ? (
        <button
          type="button"
          className={`${styles.playButton} ${styles.captureActiveButton}`}
          onClick={onStopCapture}
          title="Stop capturing system audio"
          aria-label="Stop capturing system audio"
        >
          ■
        </button>
      ) : (
        <button
          type="button"
          className={styles.playButton}
          onClick={onPlayPause}
          aria-label={isPlaying ? 'Pause' : 'Play'}
        >
          {isPlaying ? '❚❚' : '▶'}
        </button>
      )}

      <div className={styles.urlWrap}>
        <input
          ref={inputRef}
          type="text"
          className={styles.urlInput}
          placeholder="Stream or file URL — click for presets"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onFocus={() => setShowDropdown(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submitUrl();
            } else if (e.key === 'Escape') {
              setShowDropdown(false);
            }
          }}
        />
        {showDropdown && (
          <div className={styles.urlDropdown} ref={dropdownRef} role="listbox">
            {recentPresets.length > 0 && (
              <>
                <div className={styles.dropdownLabel}>Recent</div>
                {recentPresets.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={styles.dropdownItem}
                    onClick={() => pickPreset(p)}
                  >
                    <span className={styles.dropdownItemName}>{p.name}</span>
                    <span className={styles.dropdownItemDesc}>{p.description}</span>
                  </button>
                ))}
              </>
            )}
            <div className={styles.dropdownLabel}>Curated streams</div>
            {curatedPresets.map((p) => (
              <button
                key={p.id}
                type="button"
                className={styles.dropdownItem}
                onClick={() => pickPreset(p)}
              >
                <span className={styles.dropdownItemName}>{p.name}</span>
                <span className={styles.dropdownItemDesc}>{p.description}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <button
        type="button"
        className={styles.secondaryButton}
        onClick={submitUrl}
      >
        Load URL
      </button>

      <label className={styles.fileButton}>
        Load File
        <input
          type="file"
          accept="audio/*"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onLoadFile(f);
            e.target.value = '';
          }}
        />
      </label>

      <button
        type="button"
        className={
          isCapturing
            ? `${styles.secondaryButton} ${styles.captureActive}`
            : styles.secondaryButton
        }
        onClick={isCapturing ? onStopCapture : onCaptureSystemAudio}
        title={
          isCapturing
            ? 'Stop capturing'
            : 'Pick a Chrome tab playing audio (or, on Windows, the entire screen with system audio) — visualize what it plays'
        }
      >
        {isCapturing ? '■ Stop' : '🎙 Capture'}
      </button>

      {isCurrentBookmarkable && (
        <button
          type="button"
          className={styles.iconButton}
          onClick={onBookmarkCurrent}
          aria-label="Bookmark current URL"
          title="Save current URL to recents"
        >
          ★
        </button>
      )}

      <div className={styles.sourceLabel} title={currentLabel}>
        {currentLabel ? shortLabelFromUrl(currentLabel) : '—'}
      </div>

      <button
        type="button"
        className={styles.iconButton}
        onClick={onToggleFullscreen}
        aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
        title={isFullscreen ? 'Exit fullscreen (Esc or F)' : 'Fullscreen (F)'}
      >
        {isFullscreen ? '⤡' : '⤢'}
      </button>
    </div>
  );
}
