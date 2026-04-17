import { useEffect, useState, type CSSProperties } from 'react';
import { VISUALIZATIONS, getPluginById } from '../../src/visualizations/registry';
import type { ParamValues } from '../../src/visualizations/types';
import { ParamsPanel } from './ParamsPanel';
import type { OverlayMode } from './ExtensionOverlay';

/**
 * Top-layer interactive UI for the extension.
 *
 * Rendered into a React root that lives in its own Shadow-DOM host
 * appended to `document.documentElement` with `position: fixed;
 * z-index: 2147483647`. That placement puts every interactive element
 * above anything the host page (e.g. live365) stacks inside `document
 * .body`, which is the whole point of this split: the visualization
 * canvas can live behind the host page's overlays (it doesn't need
 * pointer events), while these controls are guaranteed to receive
 * clicks.
 *
 * ## Styling
 *
 * All visual styling lives in a single `<style>` block rendered by
 * `<GlobalStyles />` at the top of the tree. Because this component
 * mounts inside a Shadow DOM, those rules are fully encapsulated —
 * they can't leak out onto the host page, and the host page's CSS
 * can't leak in. Inside the block we define a small set of design
 * tokens (colors, easing, shadows) on `.ss-root` that cascade into
 * every element, and the component tree uses semantic class names
 * throughout. Inline styles are reserved for runtime-computed values
 * only (the anchor rect).
 */

interface Props {
  /**
   * Bounding rect of the visualization area (the shadow-DOM host), in
   * viewport coordinates. Used to align the start prompt and the
   * control strip with the viz. Recomputed on scroll/resize.
   */
  anchor: DOMRect;
  activeId: string;
  /** Current param values for the active viz. */
  params: ParamValues;
  started: boolean;
  mode: OverlayMode;
  /** True while the viz host is in browser fullscreen. */
  isFullscreen: boolean;
  onStart: () => void;
  onChangeViz: (id: string) => void;
  onChangeParams: (next: ParamValues) => void;
  onToggleFullscreen: () => void;
  onClose: () => void;
  /** If non-null, a fatal-error banner renders in place of the UI. */
  error: string | null;
}

export function ExtensionControls({
  anchor,
  activeId,
  params,
  started,
  mode,
  isFullscreen,
  onStart,
  onChangeViz,
  onChangeParams,
  onToggleFullscreen,
  onClose,
  error,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [paramsOpen, setParamsOpen] = useState(false);

  const activePlugin = getPluginById(activeId) ?? VISUALIZATIONS[0];

  // Collapse both menus on teardown / error.
  useEffect(() => {
    if (!started) {
      setMenuOpen(false);
      setParamsOpen(false);
    }
  }, [started]);

  // Menus are mutually exclusive — opening one closes the other so
  // they don't overlap in the corner.
  const toggleMenu = () => {
    setMenuOpen((v) => !v);
    setParamsOpen(false);
  };
  const toggleParams = () => {
    setParamsOpen((v) => !v);
    setMenuOpen(false);
  };

  // Positioned wrapper that tracks the viz area's rect. Children use
  // absolute positioning within this box, so the UI stays glued to the
  // hero slot even as live365 reflows or scrolls.
  //
  // `pointer-events: auto` is important: this div absorbs every click
  // inside the viz area, which stops clicks from falling through to
  // live365's "click to replay audio" overlay (or the hero link that
  // wraps the image) when the user clicks empty canvas space. Areas
  // *outside* this rect stay interactive for the host page because
  // the parent controls-host still has `pointer-events: none`.
  const frameStyle: CSSProperties = {
    position: 'absolute',
    left: `${anchor.left}px`,
    top: `${anchor.top}px`,
    width: `${anchor.width}px`,
    height: `${anchor.height}px`,
    pointerEvents: 'auto',
  };

  if (error) {
    return (
      <div className="ss-root" style={frameStyle}>
        <GlobalStyles />
        <div className="ss-error-card" role="alert">
          <div className="ss-error-icon" aria-hidden>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <path
                d="M12 8v5m0 3.5h.01M12 3l10 18H2L12 3Z"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <div className="ss-error-title">Couldn't start the visualizer</div>
          <div className="ss-error-message">{error}</div>
          <button
            type="button"
            className="ss-btn ss-btn--ghost"
            onClick={onClose}
          >
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  if (!started) {
    return (
      <div className="ss-root" style={frameStyle}>
        <GlobalStyles />
        <button
          type="button"
          className="ss-start-card"
          onClick={onStart}
          aria-label="Start VisStack"
        >
          <div className="ss-start-logo" aria-hidden>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
              <path
                d="M8 5.5v13a1 1 0 0 0 1.52.86l10.48-6.5a1 1 0 0 0 0-1.72L9.52 4.64A1 1 0 0 0 8 5.5Z"
                fill="#fff"
              />
            </svg>
          </div>
          <div className="ss-start-title">VisStack</div>
          <div className="ss-start-subtitle">Tap to start</div>
        </button>
      </div>
    );
  }

  return (
    <div className="ss-root" style={frameStyle}>
      <GlobalStyles />
      <div className="ss-strip" role="toolbar" aria-label="Visualizer controls">
        <button
          type="button"
          className="ss-btn ss-btn--primary"
          onClick={toggleMenu}
          aria-label="Choose visualization"
          title="Choose visualization"
          aria-expanded={menuOpen}
        >
          <span className="ss-btn-label">{activePlugin.name}</span>
          <svg
            className="ss-chevron"
            width="10"
            height="6"
            viewBox="0 0 10 6"
            aria-hidden
          >
            <path
              d="M1 1l4 4 4-4"
              stroke="currentColor"
              strokeWidth="1.6"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <button
          type="button"
          className="ss-btn ss-btn--icon"
          onClick={toggleParams}
          aria-label="Visualization parameters"
          title="Visualization parameters"
          aria-expanded={paramsOpen}
        >
          <GearIcon />
        </button>
        <button
          type="button"
          className="ss-btn ss-btn--icon"
          onClick={onToggleFullscreen}
          aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
          title={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
          aria-pressed={isFullscreen}
        >
          {isFullscreen ? <ExitFullscreenIcon /> : <EnterFullscreenIcon />}
        </button>
        <button
          type="button"
          className="ss-btn ss-btn--icon ss-btn--close"
          onClick={onClose}
          aria-label="Stop visualizer"
          title={
            mode === 'live365-hero'
              ? 'Stop visualizer and restore the album image'
              : 'Close visualizer'
          }
        >
          <CloseIcon />
        </button>
      </div>

      {menuOpen && (
        <div className="ss-menu" role="menu">
          {VISUALIZATIONS.map((viz) => {
            const isActive = viz.id === activePlugin.id;
            return (
              <button
                key={viz.id}
                type="button"
                role="menuitem"
                title={viz.description}
                className={
                  isActive
                    ? 'ss-menu-item ss-menu-item--active'
                    : 'ss-menu-item'
                }
                onClick={() => {
                  onChangeViz(viz.id);
                  setMenuOpen(false);
                }}
              >
                {isActive ? (
                  <span className="ss-eq" aria-hidden>
                    <span />
                    <span />
                    <span />
                  </span>
                ) : (
                  <span className="ss-eq ss-eq--placeholder" aria-hidden />
                )}
                <span className="ss-menu-item-label">{viz.name}</span>
              </button>
            );
          })}
        </div>
      )}

      {paramsOpen && (
        <div className="ss-params-dock">
          <ParamsPanel
            schema={activePlugin.params}
            values={params}
            onChange={onChangeParams}
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Icons — small stateless components; each inherits currentColor so button
// hover states can recolor them without extra wiring.
// ---------------------------------------------------------------------------

function GearIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2.07 2.07 0 1 1-2.93 2.93l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.55V21a2.07 2.07 0 1 1-4.14 0v-.09a1.7 1.7 0 0 0-1.11-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06A2.07 2.07 0 1 1 3.8 16.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1.03H2.5a2.07 2.07 0 1 1 0-4.14h.09A1.7 1.7 0 0 0 4.14 8.6a1.7 1.7 0 0 0-.34-1.87l-.06-.06A2.07 2.07 0 1 1 6.67 3.74l.06.06a1.7 1.7 0 0 0 1.87.34h.08a1.7 1.7 0 0 0 1.03-1.55V2.5a2.07 2.07 0 1 1 4.14 0v.09a1.7 1.7 0 0 0 1.03 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2.07 2.07 0 1 1 2.93 2.93l-.06.06a1.7 1.7 0 0 0-.34 1.87v.08c.21.55.7.95 1.29 1.03H21a2.07 2.07 0 1 1 0 4.14h-.09a1.7 1.7 0 0 0-1.55 1.03Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function EnterFullscreenIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 9V6a2 2 0 0 1 2-2h3M20 9V6a2 2 0 0 0-2-2h-3M4 15v3a2 2 0 0 0 2 2h3M20 15v3a2 2 0 0 1-2 2h-3"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ExitFullscreenIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M9 4v3a2 2 0 0 1-2 2H4M15 4v3a2 2 0 0 0 2 2h3M9 20v-3a2 2 0 0 0-2-2H4M15 20v-3a2 2 0 0 1 2-2h3"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M6 6l12 12M18 6L6 18"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Global styles — scoped to this component's Shadow DOM. The `.ss-root`
// selector carries the design tokens; everything below it inherits them.
//
// Everything here is keyed off CSS custom properties so a future dark/light
// theme or user-tunable accent stays a one-line change. ParamsPanel renders
// inside the same shadow root and uses these same tokens and classes, so
// we don't duplicate the stylesheet for it.
// ---------------------------------------------------------------------------

function GlobalStyles() {
  return <style>{CSS}</style>;
}

const CSS = `
.ss-root {
  /* Surfaces — near-black translucent, meant to read as "glass over audio
     content" rather than a solid chrome. Stack from bottom (surface-1)
     to top (surface-3) for hover / active / emphasis layers. */
  --ss-surface-1: rgba(255, 255, 255, 0.035);
  --ss-surface-2: rgba(255, 255, 255, 0.07);
  --ss-surface-3: rgba(255, 255, 255, 0.12);

  --ss-border: rgba(255, 255, 255, 0.08);
  --ss-border-strong: rgba(255, 255, 255, 0.16);

  --ss-text-primary: #f5f5f7;
  --ss-text-secondary: rgba(245, 245, 247, 0.64);
  --ss-text-tertiary: rgba(245, 245, 247, 0.4);

  /* Accent: soft violet. Matches the "neon" palette used by most plugins
     without being aggressive — more Apple Music purple than club flyer. */
  --ss-accent: #a78bfa;
  --ss-accent-hot: #c4b5fd;
  --ss-accent-soft: rgba(167, 139, 250, 0.18);
  --ss-accent-line: rgba(167, 139, 250, 0.55);

  --ss-danger: #ff6b6b;
  --ss-danger-soft: rgba(255, 107, 107, 0.15);
  --ss-danger-line: rgba(255, 107, 107, 0.35);

  /* Apple's ease-out curve — feels natural for entrances / hovers. */
  --ss-ease: cubic-bezier(0.4, 0, 0.2, 1);
  --ss-ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1);

  /* Layered shadows — a small one for contact and a big one for depth. */
  --ss-shadow-lg: 0 24px 64px rgba(0, 0, 0, 0.5), 0 4px 12px rgba(0, 0, 0, 0.3);
  --ss-shadow-md: 0 12px 32px rgba(0, 0, 0, 0.4), 0 2px 8px rgba(0, 0, 0, 0.28);

  --ss-radius-sm: 8px;
  --ss-radius-md: 12px;
  --ss-radius-lg: 16px;

  font: 500 13px/1.42 -apple-system, BlinkMacSystemFont, "SF Pro Text",
        "Inter", "Segoe UI Variable", "Segoe UI", Roboto, system-ui, sans-serif;
  letter-spacing: -0.005em;
  color: var(--ss-text-primary);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

/* ==== Start card ======================================================== */

.ss-start-card {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  padding: 28px 34px 30px;
  min-width: 260px;
  background: rgba(12, 12, 20, 0.72);
  backdrop-filter: blur(32px) saturate(1.5);
  -webkit-backdrop-filter: blur(32px) saturate(1.5);
  border: 1px solid var(--ss-border);
  border-radius: var(--ss-radius-lg);
  box-shadow: var(--ss-shadow-lg);
  color: inherit;
  font: inherit;
  text-align: center;
  cursor: pointer;
  pointer-events: auto;
  appearance: none;
  transition: transform 240ms var(--ss-ease-out-expo),
              border-color 240ms var(--ss-ease),
              box-shadow 240ms var(--ss-ease);
  animation: ss-fade-up 320ms var(--ss-ease-out-expo);
}
.ss-start-card:hover {
  transform: translate(-50%, calc(-50% - 2px));
  border-color: var(--ss-border-strong);
  box-shadow: var(--ss-shadow-lg), 0 0 60px rgba(167, 139, 250, 0.18);
}
.ss-start-card:active {
  transform: translate(-50%, -50%) scale(0.98);
  transition-duration: 120ms;
}

.ss-start-logo {
  width: 52px;
  height: 52px;
  margin: 0 auto 18px;
  border-radius: 14px;
  background: linear-gradient(135deg, #a78bfa 0%, #f472b6 52%, #22d3ee 100%);
  display: grid;
  place-items: center;
  box-shadow:
    0 10px 28px rgba(167, 139, 250, 0.35),
    inset 0 1px 0 rgba(255, 255, 255, 0.3);
}
.ss-start-title {
  font-size: 17px;
  font-weight: 600;
  letter-spacing: -0.02em;
  margin-bottom: 4px;
}
.ss-start-subtitle {
  color: var(--ss-text-secondary);
  font-size: 12.5px;
  font-weight: 400;
}

@keyframes ss-fade-up {
  from { opacity: 0; transform: translate(-50%, calc(-50% + 10px)); }
  to   { opacity: 1; transform: translate(-50%, -50%); }
}

/* ==== Error card ======================================================== */

.ss-error-card {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  padding: 22px 26px 20px;
  min-width: 280px;
  max-width: 360px;
  text-align: center;
  background: rgba(22, 12, 14, 0.82);
  backdrop-filter: blur(32px) saturate(1.5);
  -webkit-backdrop-filter: blur(32px) saturate(1.5);
  border: 1px solid var(--ss-danger-line);
  border-radius: var(--ss-radius-lg);
  box-shadow: var(--ss-shadow-lg);
  pointer-events: auto;
  animation: ss-fade-up 320ms var(--ss-ease-out-expo);
}
.ss-error-icon {
  width: 42px;
  height: 42px;
  margin: 0 auto 12px;
  border-radius: 12px;
  background: var(--ss-danger-soft);
  color: var(--ss-danger);
  display: grid;
  place-items: center;
}
.ss-error-title {
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.01em;
  margin-bottom: 6px;
}
.ss-error-message {
  color: var(--ss-text-secondary);
  font-size: 12.5px;
  font-weight: 400;
  line-height: 1.45;
  margin-bottom: 16px;
}

/* ==== Control strip ===================================================== */

.ss-strip {
  position: absolute;
  top: 12px;
  right: 12px;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px;
  background: rgba(10, 10, 18, 0.58);
  backdrop-filter: blur(24px) saturate(1.5);
  -webkit-backdrop-filter: blur(24px) saturate(1.5);
  border: 1px solid var(--ss-border);
  border-radius: 999px;
  box-shadow: var(--ss-shadow-md);
  pointer-events: auto;
  animation: ss-fade-in 220ms var(--ss-ease);
}

@keyframes ss-fade-in {
  from { opacity: 0; transform: translateY(-4px); }
  to   { opacity: 1; transform: translateY(0); }
}

/* ==== Buttons =========================================================== */

/* Base button — extended by the modifiers below. Note: appearance:none
   is required inside the shadow DOM or Firefox reintroduces a native look. */
.ss-btn {
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--ss-text-primary);
  cursor: pointer;
  font: inherit;
  font-size: 12.5px;
  font-weight: 500;
  letter-spacing: -0.005em;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 32px;
  padding: 0 12px;
  border-radius: 999px;
  gap: 6px;
  pointer-events: auto;
  transition: background 150ms var(--ss-ease),
              color 150ms var(--ss-ease),
              transform 150ms var(--ss-ease);
}
.ss-btn:hover { background: var(--ss-surface-2); }
.ss-btn:active { transform: scale(0.94); transition-duration: 80ms; }
.ss-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px rgba(10, 10, 18, 0.9),
              0 0 0 4px var(--ss-accent-line);
}

.ss-btn--icon {
  width: 32px;
  padding: 0;
  color: var(--ss-text-secondary);
}
.ss-btn--icon:hover { color: var(--ss-text-primary); }
.ss-btn--icon svg { display: block; }

.ss-btn--primary {
  padding: 0 8px 0 14px;
  color: var(--ss-text-primary);
}
.ss-btn--primary[aria-expanded="true"] {
  background: var(--ss-accent-soft);
  color: var(--ss-accent-hot);
}
.ss-btn--icon[aria-expanded="true"] {
  background: var(--ss-accent-soft);
  color: var(--ss-accent-hot);
}

.ss-btn--close:hover {
  background: var(--ss-danger-soft);
  color: var(--ss-danger);
}

.ss-btn--ghost {
  background: var(--ss-surface-1);
  border: 1px solid var(--ss-border);
  color: var(--ss-text-primary);
  padding: 0 18px;
  height: 34px;
}
.ss-btn--ghost:hover {
  background: var(--ss-surface-2);
  border-color: var(--ss-border-strong);
}

.ss-btn-label {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ss-chevron {
  transition: transform 220ms var(--ss-ease);
  opacity: 0.65;
}
[aria-expanded="true"] > .ss-chevron {
  transform: rotate(180deg);
  opacity: 1;
}

/* ==== Viz menu ========================================================== */

.ss-menu {
  position: absolute;
  top: 54px;
  right: 12px;
  width: min(400px, calc(100vw - 24px));
  max-height: min(70vh, 560px);
  overflow-y: auto;
  padding: 6px;
  background: rgba(12, 12, 20, 0.92);
  backdrop-filter: blur(30px) saturate(1.5);
  -webkit-backdrop-filter: blur(30px) saturate(1.5);
  border: 1px solid var(--ss-border);
  border-radius: var(--ss-radius-lg);
  box-shadow: var(--ss-shadow-lg);
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 2px;
  pointer-events: auto;
  animation: ss-pop 200ms var(--ss-ease-out-expo);

  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.18) transparent;
}
.ss-menu::-webkit-scrollbar { width: 10px; }
.ss-menu::-webkit-scrollbar-track { background: transparent; }
.ss-menu::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.12);
  border-radius: 6px;
  border: 3px solid transparent;
  background-clip: padding-box;
}
.ss-menu::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.2);
  background-clip: padding-box;
  border: 3px solid transparent;
}

@keyframes ss-pop {
  from { opacity: 0; transform: translateY(-6px) scale(0.98); }
  to   { opacity: 1; transform: translateY(0)    scale(1); }
}

.ss-menu-item {
  appearance: none;
  background: transparent;
  color: var(--ss-text-primary);
  border: 1px solid transparent;
  border-radius: var(--ss-radius-sm);
  cursor: pointer;
  font: inherit;
  font-size: 12.5px;
  font-weight: 500;
  letter-spacing: -0.005em;
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 40px;
  padding: 8px 12px;
  text-align: left;
  overflow: hidden;
  pointer-events: auto;
  transition: background 140ms var(--ss-ease),
              border-color 140ms var(--ss-ease),
              color 140ms var(--ss-ease);
}
.ss-menu-item:hover { background: var(--ss-surface-2); }
.ss-menu-item:focus-visible {
  outline: none;
  border-color: var(--ss-accent-line);
}
.ss-menu-item-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ss-menu-item--active {
  background: var(--ss-accent-soft);
  border-color: var(--ss-accent-line);
  color: #fff;
}
.ss-menu-item--active:hover { background: rgba(167, 139, 250, 0.26); }

/* ==== Animated "now playing" equalizer indicator ======================= */

.ss-eq {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  width: 12px;
  height: 12px;
  flex-shrink: 0;
}
.ss-eq > span {
  width: 2px;
  background: var(--ss-accent-hot);
  border-radius: 1px;
  animation: ss-eq-bar 1s ease-in-out infinite;
  transform-origin: bottom;
}
.ss-eq > span:nth-child(1) { animation-delay: 0ms; }
.ss-eq > span:nth-child(2) { animation-delay: 150ms; }
.ss-eq > span:nth-child(3) { animation-delay: 300ms; }

@keyframes ss-eq-bar {
  0%, 100% { height: 30%; }
  50%      { height: 100%; }
}

/* Zero-size placeholder preserving the left indent on inactive rows so
   active / inactive items align to the same baseline. */
.ss-eq--placeholder { width: 12px; height: 12px; }

/* ==== Params dock ====================================================== */

.ss-params-dock {
  position: absolute;
  top: 54px;
  right: 12px;
  pointer-events: auto;
}

/* ==== Params panel (styles consumed by ParamsPanel.tsx) ================ */

.ss-params {
  width: 320px;
  max-height: min(72vh, 560px);
  overflow-y: auto;
  padding: 14px 16px 16px;
  background: rgba(12, 12, 20, 0.92);
  backdrop-filter: blur(30px) saturate(1.5);
  -webkit-backdrop-filter: blur(30px) saturate(1.5);
  border: 1px solid var(--ss-border);
  border-radius: var(--ss-radius-lg);
  box-shadow: var(--ss-shadow-lg);
  pointer-events: auto;
  animation: ss-pop 200ms var(--ss-ease-out-expo);

  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.18) transparent;
}
.ss-params::-webkit-scrollbar { width: 10px; }
.ss-params::-webkit-scrollbar-track { background: transparent; }
.ss-params::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.12);
  border-radius: 6px;
  border: 3px solid transparent;
  background-clip: padding-box;
}

.ss-params-heading {
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ss-text-tertiary);
  margin: 2px 0 10px;
}

.ss-params-empty {
  color: var(--ss-text-secondary);
  font-size: 12px;
  padding: 6px 0 2px;
}

.ss-row {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 0;
  border-top: 1px solid var(--ss-border);
}
.ss-row:first-of-type { border-top: 0; padding-top: 4px; }

.ss-row-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.ss-row-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--ss-text-primary);
}
.ss-row-value {
  font-size: 11.5px;
  font-weight: 500;
  color: var(--ss-text-secondary);
  font-variant-numeric: tabular-nums;
  padding: 2px 8px;
  background: var(--ss-surface-1);
  border-radius: 6px;
  min-width: 44px;
  text-align: center;
}

/* ---- Range slider (live progress fill via --pct) ---------------------- */

.ss-range {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 22px;
  background: transparent;
  cursor: pointer;
  margin: 0;
  padding: 0;
  --pct: 50%;
}
.ss-range::-webkit-slider-runnable-track {
  height: 3px;
  border-radius: 999px;
  background: linear-gradient(
    to right,
    var(--ss-accent) 0%,
    var(--ss-accent) var(--pct),
    var(--ss-border-strong) var(--pct),
    var(--ss-border-strong) 100%
  );
  transition: background 120ms linear;
}
.ss-range::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 14px;
  height: 14px;
  margin-top: -5.5px;
  border: 0;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.45),
              0 0 0 0 var(--ss-accent-soft);
  transition: transform 160ms var(--ss-ease),
              box-shadow 160ms var(--ss-ease);
  cursor: grab;
}
.ss-range:hover::-webkit-slider-thumb {
  transform: scale(1.15);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.45),
              0 0 0 6px var(--ss-accent-soft);
}
.ss-range:active::-webkit-slider-thumb {
  transform: scale(1.08);
  cursor: grabbing;
}
.ss-range:focus-visible::-webkit-slider-thumb {
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.45),
              0 0 0 4px var(--ss-accent-line);
}

/* Firefox equivalents */
.ss-range::-moz-range-track {
  height: 3px;
  border-radius: 999px;
  background: var(--ss-border-strong);
}
.ss-range::-moz-range-progress {
  height: 3px;
  border-radius: 999px;
  background: var(--ss-accent);
}
.ss-range::-moz-range-thumb {
  width: 14px;
  height: 14px;
  border: 0;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.45);
  cursor: grab;
}
.ss-range:hover::-moz-range-thumb {
  transform: scale(1.15);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.45),
              0 0 0 6px var(--ss-accent-soft);
}

/* ---- Select ----------------------------------------------------------- */

.ss-select {
  width: 100%;
  appearance: none;
  -webkit-appearance: none;
  -moz-appearance: none;
  padding: 8px 30px 8px 12px;
  background-color: var(--ss-surface-1);
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23f5f5f7' stroke-width='1.6' fill='none' stroke-linecap='round' stroke-linejoin='round' opacity='0.6'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 12px center;
  border: 1px solid var(--ss-border);
  border-radius: var(--ss-radius-sm);
  color: var(--ss-text-primary);
  font: inherit;
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
  outline: none;
  transition: background-color 140ms var(--ss-ease),
              border-color 140ms var(--ss-ease);
}
.ss-select:hover {
  background-color: var(--ss-surface-2);
  border-color: var(--ss-border-strong);
}
.ss-select:focus-visible {
  border-color: var(--ss-accent-line);
  box-shadow: 0 0 0 3px var(--ss-accent-soft);
}
.ss-select option {
  background: #0f0f18;
  color: var(--ss-text-primary);
}

/* ---- Toggle switch ---------------------------------------------------- */

.ss-toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 0;
  border-top: 1px solid var(--ss-border);
  cursor: pointer;
  user-select: none;
}
.ss-toggle-row:first-of-type { border-top: 0; padding-top: 4px; }

.ss-toggle {
  position: relative;
  width: 34px;
  height: 20px;
  flex-shrink: 0;
}
.ss-toggle input {
  position: absolute;
  inset: 0;
  margin: 0;
  opacity: 0;
  cursor: pointer;
  z-index: 2;
}
.ss-toggle-track {
  position: absolute;
  inset: 0;
  background: var(--ss-surface-3);
  border-radius: 999px;
  transition: background 180ms var(--ss-ease);
}
.ss-toggle-thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  background: #fff;
  border-radius: 50%;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.35);
  transition: transform 220ms var(--ss-ease-out-expo);
  pointer-events: none;
}
.ss-toggle input:checked ~ .ss-toggle-track {
  background: var(--ss-accent);
}
.ss-toggle input:checked ~ .ss-toggle-thumb {
  transform: translateX(14px);
}
.ss-toggle input:focus-visible ~ .ss-toggle-track {
  box-shadow: 0 0 0 3px var(--ss-accent-soft);
}
`;
