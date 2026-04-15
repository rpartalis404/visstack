import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AudioEngine } from '../../src/audio/AudioEngine';
import { VISUALIZATIONS, getPluginById } from '../../src/visualizations/registry';
import { defaultParamValues, type ParamValues } from '../../src/visualizations/types';
import { VisualizerHost } from '../../src/ui/VisualizerHost';
import type { MountContext } from './mount';

const STORAGE_KEY = 'soundstack-ext-state-v1';

interface Persisted {
  activeId: string;
}

interface Props {
  engine: AudioEngine;
  context: MountContext;
  onClose: () => void;
}

/**
 * Extension overlay UI. Minimal controls:
 *   - Viz switcher (compact dropdown in a corner)
 *   - Close button (tears down the extension activation)
 *   - (optional) fullscreen toggle if we're in overlay mode
 *
 * The full parameter panel from the webapp is deliberately NOT rendered
 * here — users tweak params on the webapp and the defaults are what ship
 * in the extension. Keeps the overlay uncluttered.
 */
export function ExtensionOverlay({ engine, context, onClose }: Props) {
  const persisted = useMemo<Partial<Persisted>>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as Persisted) : {};
    } catch {
      return {};
    }
  }, []);

  const [activeId, setActiveId] = useState<string>(() => {
    const id = persisted.activeId;
    return id && getPluginById(id) ? id : VISUALIZATIONS[0].id;
  });
  const [menuOpen, setMenuOpen] = useState(false);

  // Persist viz choice across activations
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ activeId }));
    } catch {
      // storage disabled — no-op
    }
  }, [activeId]);

  const activePlugin = getPluginById(activeId) ?? VISUALIZATIONS[0];

  // Always start with the plugin's declared defaults in the extension —
  // no live param tweaking here, just a stable known-good starting point.
  const defaults: ParamValues = useMemo(
    () => defaultParamValues(activePlugin.params),
    [activePlugin],
  );

  const close = useCallback(() => onClose(), [onClose]);

  // Keyboard shortcut: Escape to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  return (
    <div style={rootStyle}>
      <VisualizerHost
        engine={engine}
        plugin={activePlugin}
        params={defaults}
      />

      {/* Control strip — small, transparent, stays out of the way */}
      <div style={controlsStyle}>
        <button
          type="button"
          style={buttonStyle}
          onClick={() => setMenuOpen((v) => !v)}
          aria-label="Choose visualization"
          title="Choose visualization"
        >
          {activePlugin.name} ▾
        </button>
        <button
          type="button"
          style={closeButtonStyle}
          onClick={close}
          aria-label="Stop visualizer"
          title={
            context.mode === 'live365-hero'
              ? 'Stop visualizer and restore the album image'
              : 'Close visualizer'
          }
        >
          ✕
        </button>

        {menuOpen && (
          <div style={menuStyle} role="menu">
            {VISUALIZATIONS.map((viz) => (
              <button
                key={viz.id}
                type="button"
                role="menuitem"
                style={{
                  ...menuItemStyle,
                  ...(viz.id === activePlugin.id ? menuItemActiveStyle : null),
                }}
                onClick={() => {
                  setActiveId(viz.id);
                  setMenuOpen(false);
                }}
              >
                <div style={menuItemNameStyle}>{viz.name}</div>
                <div style={menuItemDescStyle}>{viz.description}</div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline styles — we're in a Shadow DOM, and avoiding a bundler CSS step
// for the extension keeps the build surface small. These aren't meant to
// be tweakable — they're utility positioning for the compact UI.
// ---------------------------------------------------------------------------

const rootStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  overflow: 'hidden',
};

const controlsStyle: React.CSSProperties = {
  position: 'absolute',
  top: 8,
  right: 8,
  display: 'flex',
  gap: 6,
  zIndex: 2,
  pointerEvents: 'auto',
};

const buttonStyle: React.CSSProperties = {
  padding: '6px 10px',
  fontSize: 12,
  fontFamily: 'inherit',
  color: '#fff',
  background: 'rgba(10,10,16,0.65)',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 6,
  cursor: 'pointer',
  backdropFilter: 'blur(8px)',
  WebkitBackdropFilter: 'blur(8px)',
  lineHeight: 1,
};

const closeButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  width: 28,
  padding: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 13,
};

const menuStyle: React.CSSProperties = {
  position: 'absolute',
  top: 40,
  right: 0,
  minWidth: 260,
  padding: 6,
  background: 'rgba(14,14,21,0.92)',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 8,
  boxShadow: '0 12px 32px rgba(0,0,0,0.55)',
  backdropFilter: 'blur(8px)',
  WebkitBackdropFilter: 'blur(8px)',
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
};

const menuItemStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: 2,
  padding: '8px 10px',
  background: 'transparent',
  border: 'none',
  borderRadius: 5,
  color: '#e8e8ef',
  textAlign: 'left',
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const menuItemActiveStyle: React.CSSProperties = {
  background: 'rgba(124,61,255,0.22)',
};

const menuItemNameStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
};

const menuItemDescStyle: React.CSSProperties = {
  fontSize: 11,
  opacity: 0.6,
  lineHeight: 1.3,
};
