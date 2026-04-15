import type { VisualizationPlugin } from '../visualizations/types';
import styles from './ui.module.css';

interface Props {
  visualizations: readonly VisualizationPlugin[];
  activeId: string;
  onChange: (id: string) => void;
}

export function Switcher({ visualizations, activeId, onChange }: Props) {
  return (
    <div className={styles.switcher}>
      <div className={styles.sectionLabel}>Visualization</div>
      <div className={styles.switcherButtons}>
        {visualizations.map((viz) => (
          <button
            key={viz.id}
            type="button"
            className={
              viz.id === activeId
                ? `${styles.switcherButton} ${styles.switcherButtonActive}`
                : styles.switcherButton
            }
            onClick={() => onChange(viz.id)}
          >
            <span className={styles.switcherButtonName}>{viz.name}</span>
            <span className={styles.switcherButtonDesc}>{viz.description}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
