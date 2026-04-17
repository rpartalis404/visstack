import { useEffect, useState } from 'react';
import type { VisualizationPlugin } from '../visualizations/types';
import { thumbnailFor } from '../visualizations/thumbnails';
import styles from './ui.module.css';

/**
 * Visualization switcher.
 *
 * The trigger is a compact "now playing"-style card in the sidebar that
 * shows the active plugin's thumbnail, name, and description. Clicking
 * it opens a fullscreen modal with a grid of all 32 visualizations —
 * each rendered as a thumbnail tile with its signature gradient, name,
 * and short description. Selecting one closes the modal.
 *
 * With 32 plugins a scrolling list became tedious; a grid-in-a-modal
 * shows far more at once and gives each viz a visual identity (via its
 * thumbnail) that a plain text list can't. See
 * `src/visualizations/thumbnails.ts` for the gradient definitions.
 */
interface Props {
  visualizations: readonly VisualizationPlugin[];
  activeId: string;
  onChange: (id: string) => void;
}

export function Switcher({ visualizations, activeId, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const active =
    visualizations.find((v) => v.id === activeId) ?? visualizations[0];

  // Close on Escape while the modal is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const handleSelect = (id: string) => {
    onChange(id);
    setOpen(false);
  };

  return (
    <div className={styles.switcher}>
      <div className={styles.sectionLabel}>Visualization</div>
      <button
        type="button"
        className={styles.switcherTrigger}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span
          className={styles.switcherTriggerThumb}
          style={{ backgroundImage: thumbnailFor(active.id) }}
          aria-hidden
        />
        <span className={styles.switcherTriggerText}>
          <span className={styles.switcherTriggerName}>{active.name}</span>
          <span className={styles.switcherTriggerDesc}>
            {active.description}
          </span>
        </span>
        <svg
          className={styles.switcherTriggerChevron}
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden
        >
          <path
            d="M8 10l4 4 4-4"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open && (
        <div
          className={styles.modalBackdrop}
          onClick={() => setOpen(false)}
          role="presentation"
        >
          <div
            className={styles.modalPanel}
            role="dialog"
            aria-label="Choose visualization"
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.modalHeader}>
              <div>
                <div className={styles.modalTitle}>Visualizations</div>
                <div className={styles.modalSubtitle}>
                  {visualizations.length} styles
                </div>
              </div>
              <button
                type="button"
                className={styles.modalClose}
                onClick={() => setOpen(false)}
                aria-label="Close"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  aria-hidden
                >
                  <path
                    d="M6 6l12 12M18 6L6 18"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>
            <div className={styles.modalGrid}>
              {visualizations.map((viz) => {
                const isActive = viz.id === activeId;
                return (
                  <button
                    key={viz.id}
                    type="button"
                    className={
                      isActive
                        ? `${styles.tile} ${styles.tileActive}`
                        : styles.tile
                    }
                    style={{ backgroundImage: thumbnailFor(viz.id) }}
                    onClick={() => handleSelect(viz.id)}
                    title={viz.description}
                  >
                    {isActive && (
                      <span className={styles.tileEq} aria-hidden>
                        <span />
                        <span />
                        <span />
                      </span>
                    )}
                    <span className={styles.tileOverlay}>
                      <span className={styles.tileName}>{viz.name}</span>
                      <span className={styles.tileDesc}>{viz.description}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
