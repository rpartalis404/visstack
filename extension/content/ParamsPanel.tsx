import type { CSSProperties } from 'react';
import type { ParamSchema, ParamValues } from '../../src/visualizations/types';

/**
 * Per-visualization parameter panel.
 *
 * Renders one row per param based on its declared type:
 *   - number  → custom-styled range slider with live fill + value readout
 *   - select  → custom-styled dropdown
 *   - boolean → toggle switch
 *
 * All visual styling lives in `ExtensionControls.tsx`'s `<GlobalStyles />`
 * block. This component sits inside the same Shadow DOM so every
 * `.ss-*` class below resolves against those declarations — no prop
 * drilling, no inline style duplication.
 *
 * Purely controlled: the parent owns `values`, we emit a fresh
 * `ParamValues` object on every change via `onChange`.
 */
interface Props {
  schema: ParamSchema;
  values: ParamValues;
  onChange: (next: ParamValues) => void;
}

export function ParamsPanel({ schema, values, onChange }: Props) {
  const entries = Object.entries(schema);

  if (entries.length === 0) {
    return (
      <div className="ss-params" role="group" aria-label="Visualization parameters">
        <div className="ss-params-heading">Parameters</div>
        <div className="ss-params-empty">No tunable parameters for this viz.</div>
      </div>
    );
  }

  const update = (key: string, val: number | boolean | string) => {
    onChange({ ...values, [key]: val });
  };

  return (
    <div className="ss-params" role="group" aria-label="Visualization parameters">
      <div className="ss-params-heading">Parameters</div>
      {entries.map(([key, def]) => {
        const value = values[key] ?? def.default;

        if (def.type === 'number') {
          const step = def.step ?? 1;
          const decimals = step < 1 ? 2 : 0;
          const num = Number(value);
          // Percentage of the range the slider thumb is at — fed into
          // the track's `linear-gradient` via a CSS var so the fill
          // visually tracks the thumb without extra JS.
          const pct = Math.max(
            0,
            Math.min(100, ((num - def.min) / (def.max - def.min)) * 100),
          );
          return (
            <label key={key} className="ss-row">
              <div className="ss-row-head">
                <span className="ss-row-label">{def.label}</span>
                <span className="ss-row-value">{num.toFixed(decimals)}</span>
              </div>
              <input
                type="range"
                className="ss-range"
                min={def.min}
                max={def.max}
                step={step}
                value={num}
                onChange={(e) => update(key, Number(e.target.value))}
                style={{ '--pct': `${pct}%` } as CSSProperties}
              />
            </label>
          );
        }

        if (def.type === 'boolean') {
          const checked = Boolean(value);
          return (
            <label key={key} className="ss-toggle-row">
              <span className="ss-row-label">{def.label}</span>
              <span className="ss-toggle">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => update(key, e.target.checked)}
                />
                <span className="ss-toggle-track" aria-hidden />
                <span className="ss-toggle-thumb" aria-hidden />
              </span>
            </label>
          );
        }

        // select
        return (
          <label key={key} className="ss-row">
            <div className="ss-row-head">
              <span className="ss-row-label">{def.label}</span>
            </div>
            <select
              className="ss-select"
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
