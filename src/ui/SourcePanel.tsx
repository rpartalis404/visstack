import { useRef } from 'react';
import styles from './ui.module.css';

/**
 * Sidebar "Source" section.
 *
 * Two visual states:
 *
 *   1. **Idle** — renders a prominent gradient-bordered CTA card inviting
 *      the user to tap Capture to share a tab's audio, plus a subtle
 *      secondary link to load an audio file from disk. This is the
 *      primary "how to get started" affordance on the webapp, since the
 *      production build hides the dev-only URL input and new visitors
 *      otherwise see a blank canvas with no clear next step.
 *
 *   2. **Active** — the CTA is replaced with a compact "now playing"
 *      status card showing the current source label and a stop button
 *      (while capturing; file playback persists until the user replaces
 *      it).
 *
 * The top-bar AudioSourceBar still provides the same controls for users
 * who prefer compact toolbar flow; this panel is the prominent, obvious
 * path specifically for first-time visitors.
 */
interface Props {
  isCapturing: boolean;
  /** Non-empty when any source (capture or file) is loaded. */
  sourceLabel: string;
  onCapture: () => void;
  onLoadFile: (file: File) => void;
  onStopCapture: () => void;
}

export function SourcePanel({
  isCapturing,
  sourceLabel,
  onCapture,
  onLoadFile,
  onStopCapture,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Active state — some source is loaded.
  if (sourceLabel || isCapturing) {
    return (
      <div className={styles.sourcePanel}>
        <div className={styles.sectionLabel}>Source</div>
        <div className={styles.sourcePanelActive}>
          <div className={styles.sourcePanelActiveIcon} aria-hidden>
            <span className={styles.sourcePanelEq}>
              <span />
              <span />
              <span />
            </span>
          </div>
          <div className={styles.sourcePanelActiveText}>
            <div className={styles.sourcePanelActiveStatus}>
              {isCapturing ? 'Capturing' : 'Playing'}
            </div>
            <div
              className={styles.sourcePanelActiveLabel}
              title={sourceLabel}
            >
              {cleanLabel(sourceLabel)}
            </div>
          </div>
          {isCapturing && (
            <button
              type="button"
              className={styles.sourcePanelStop}
              onClick={onStopCapture}
              aria-label="Stop capture"
              title="Stop capture"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                <rect width="10" height="10" rx="1.5" fill="currentColor" />
              </svg>
            </button>
          )}
        </div>
      </div>
    );
  }

  // Idle state — prominent CTA.
  return (
    <div className={styles.sourcePanel}>
      <div className={styles.sectionLabel}>Get started</div>
      <button
        type="button"
        className={styles.captureCta}
        onClick={onCapture}
      >
        <span className={styles.captureCtaIcon} aria-hidden>
          <MicIcon />
        </span>
        <span className={styles.captureCtaText}>
          <span className={styles.captureCtaTitle}>Capture tab audio</span>
          <span className={styles.captureCtaDesc}>
            Pick a tab playing music — VisStack visualizes it live.
          </span>
        </span>
      </button>
      <button
        type="button"
        className={styles.fileLink}
        onClick={() => fileInputRef.current?.click()}
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden
        >
          <path
            d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9l-6-6Z"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M13 3v6h6"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        or load an audio file
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onLoadFile(f);
          // Reset so selecting the same file twice still fires change.
          e.target.value = '';
        }}
      />
    </div>
  );
}

/** Strip the leading mic emoji we prepend to capture labels elsewhere. */
function cleanLabel(s: string): string {
  return s.replace(/^🎙\s*/, '').trim();
}

function MicIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect
        x="9"
        y="2.5"
        width="6"
        height="11"
        rx="3"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="M5 11a7 7 0 0 0 14 0M12 18v3M8.5 21h7"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
