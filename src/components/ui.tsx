import type { ReactNode } from 'react';

export function Section({ title, children, aside }: { title?: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="sect">
      {title && <div className="sect-head"><h3>{title}</h3>{aside}</div>}
      {children}
    </section>
  );
}

export function Slider({ label, value, min, max, step = 1, onChange, format, disabled }: {
  label: string; value: number; min: number; max: number; step?: number;
  onChange: (v: number) => void; format?: (v: number) => string; disabled?: boolean;
}) {
  return (
    <label className={'slider' + (disabled ? ' is-disabled' : '')}>
      <span className="slider-row"><span>{label}</span><output>{format ? format(value) : value}</output></span>
      <input type="range" min={min} max={max} step={step} value={value} disabled={disabled}
        onChange={e => onChange(parseFloat(e.target.value))} />
    </label>
  );
}

export function Seg<T extends string | number>({ value, options, onChange, label }: {
  value: T; options: { value: T; label: ReactNode; title?: string }[]; onChange: (v: T) => void; label?: string;
}) {
  return (
    <div className="field">
      {label && <span className="field-label">{label}</span>}
      <div className="seg" role="radiogroup" aria-label={label}>
        {options.map(o => (
          <button key={String(o.value)} type="button" role="radio" aria-checked={o.value === value}
            title={o.title} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>{o.label}</button>
        ))}
      </div>
    </div>
  );
}

export function Toggle({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <label className="toggle" title={hint}>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
      <span className="toggle-track" aria-hidden />
      <span>{label}</span>
    </label>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="field"><span className="field-label">{label}</span>{children}</label>;
}

export function ColorInput({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <label className="color-in" title={label}>
      <input type="color" value={value} onChange={e => onChange(e.target.value)} aria-label={label} />
      <span>{label}</span>
    </label>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

export function Note({ children }: { children: ReactNode }) {
  return <p className="note">{children}</p>;
}
