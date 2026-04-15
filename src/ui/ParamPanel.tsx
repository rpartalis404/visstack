import type { ParamSchema, ParamValues } from '../visualizations/types';
import styles from './ui.module.css';

interface Props {
  schema: ParamSchema;
  values: ParamValues;
  onChange: (next: ParamValues) => void;
}

export function ParamPanel({ schema, values, onChange }: Props) {
  const entries = Object.entries(schema);
  if (entries.length === 0) return null;

  const update = (key: string, val: number | boolean | string) => {
    onChange({ ...values, [key]: val });
  };

  return (
    <div className={styles.params}>
      <div className={styles.sectionLabel}>Parameters</div>
      {entries.map(([key, def]) => {
        const value = values[key] ?? def.default;
        if (def.type === 'number') {
          return (
            <label key={key} className={styles.paramRow}>
              <div className={styles.paramHeader}>
                <span>{def.label}</span>
                <span className={styles.paramValue}>
                  {Number(value).toFixed(
                    (def.step ?? 1) < 1 ? 2 : 0,
                  )}
                </span>
              </div>
              <input
                type="range"
                min={def.min}
                max={def.max}
                step={def.step ?? 1}
                value={Number(value)}
                onChange={(e) => update(key, Number(e.target.value))}
                className={styles.slider}
              />
            </label>
          );
        }
        if (def.type === 'boolean') {
          return (
            <label key={key} className={styles.paramRowCheckbox}>
              <input
                type="checkbox"
                checked={Boolean(value)}
                onChange={(e) => update(key, e.target.checked)}
              />
              <span>{def.label}</span>
            </label>
          );
        }
        // select
        return (
          <label key={key} className={styles.paramRow}>
            <div className={styles.paramHeader}>
              <span>{def.label}</span>
            </div>
            <select
              className={styles.select}
              value={String(value)}
              onChange={(e) => update(key, e.target.value)}
            >
              {def.options.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </label>
        );
      })}
    </div>
  );
}
