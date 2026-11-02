// Small UI building blocks shared by every screen.

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Icon, type IconName } from './icons.tsx';
import type { Param } from './format.ts';
import { Slider } from './Slider.tsx';
import { t } from '../i18n.tsx';

export function Button(p: {
  children?: ReactNode; onClick?: () => void; icon?: IconName; kind?: 'primary' | 'ghost' | 'danger' | 'plain';
  small?: boolean; disabled?: boolean; title?: string; type?: 'button' | 'submit'; className?: string; active?: boolean;
}): React.JSX.Element {
  return (
    <button
      type={p.type ?? 'button'}
      className={`btn btn-${p.kind ?? 'plain'} ${p.small ? 'btn-sm' : ''} ${p.active ? 'is-active' : ''} ${!p.children ? 'btn-icon' : ''} ${p.className ?? ''}`}
      onClick={p.onClick}
      disabled={p.disabled}
      title={p.title}
      aria-label={!p.children ? p.title : undefined}
      aria-pressed={p.active === undefined ? undefined : p.active}
    >
      {p.icon && <Icon name={p.icon} />}
      {p.children && <span>{p.children}</span>}
    </button>
  );
}

/** Latching button (mute, phase, bypass...). `tone` colours the "on" state. */
export function Toggle(p: { on: boolean; onChange: (v: boolean) => void; children: ReactNode; tone?: 'red' | 'amber' | 'accent' | 'blue'; disabled?: boolean; title?: string; small?: boolean; icon?: IconName }): React.JSX.Element {
  return (
    <button
      type="button"
      className={`tg tg-${p.tone ?? 'accent'} ${p.on ? 'is-on' : ''} ${p.small ? 'tg-sm' : ''}`}
      aria-pressed={p.on}
      disabled={p.disabled}
      title={p.title}
      onClick={() => p.onChange(!p.on)}
    >
      {p.icon && <Icon name={p.icon} />}
      <span>{p.children}</span>
    </button>
  );
}

export function Segmented<T extends string | number>(p: { value: T; options: { value: T; label: ReactNode; title?: string }[]; onChange: (v: T) => void; disabled?: boolean; label: string; small?: boolean }): React.JSX.Element {
  return (
    <div className={`seg ${p.small ? 'seg-sm' : ''}`} role="radiogroup" aria-label={p.label}>
      {p.options.map((o) => (
        <button
          key={String(o.value)} type="button" role="radio" aria-checked={o.value === p.value} title={o.title}
          className={o.value === p.value ? 'is-on' : ''} disabled={p.disabled} onClick={() => p.onChange(o.value)}
        >{o.label}</button>
      ))}
    </div>
  );
}

export function Select<T extends string | number>(p: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; disabled?: boolean; label: string; className?: string }): React.JSX.Element {
  return (
    <select
      className={`select ${p.className ?? ''}`} aria-label={p.label} value={String(p.value)} disabled={p.disabled}
      onChange={(e) => {
        const o = p.options.find((x) => String(x.value) === e.target.value);
        if (o) p.onChange(o.value);
      }}
    >
      {p.options.map((o) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
    </select>
  );
}

export function Card(p: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; id?: string; subtitle?: ReactNode }): React.JSX.Element {
  return (
    <section className={`card ${p.className ?? ''}`} id={p.id}>
      {(p.title || p.actions) && (
        <header className="card-head">
          <div>
            {p.title && <h2>{p.title}</h2>}
            {p.subtitle && <p className="muted small">{p.subtitle}</p>}
          </div>
          {p.actions && <div className="card-actions">{p.actions}</div>}
        </header>
      )}
      {p.children}
    </section>
  );
}

/** Editable value: shows the formatted value, becomes a text field on focus / click. */
export function ValueField(p: { value: number; param: Param; onChange: (raw: number) => void; disabled?: boolean; label: string; className?: string; wide?: boolean }): React.JSX.Element {
  const [text, setText] = useState<string | null>(null);
  const [bad, setBad] = useState(false);
  const commit = (): void => {
    if (text === null) return;
    const v = p.param.parse(text);
    if (v === null) { setBad(true); setTimeout(() => setBad(false), 900); }
    else if (v !== p.value) p.onChange(Math.min(p.param.max, Math.max(p.param.min, v)));
    setText(null);
  };
  return (
    <input
      className={`vf ${bad ? 'is-bad' : ''} ${p.wide ? 'vf-wide' : ''} ${p.className ?? ''}`}
      aria-label={p.label}
      disabled={p.disabled}
      inputMode="decimal"
      value={text ?? p.param.fmt(p.value)}
      onFocus={(e) => { setText(p.param.edit(p.value)); requestAnimationFrame(() => e.target.select()); }}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { commit(); (e.target as HTMLInputElement).blur(); }
        else if (e.key === 'Escape') { setText(null); (e.target as HTMLInputElement).blur(); }
        else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          const st = (p.param.step ?? 1) * (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
          const v = Math.min(p.param.max, Math.max(p.param.min, p.value + st));
          p.onChange(v);
          setText(p.param.edit(v));
        }
      }}
    />
  );
}

/** Label + slider + value field on one row (stacked on narrow screens). */
export function ParamRow(p: { label: ReactNode; param: Param; value: number; onChange: (raw: number) => void; disabled?: boolean; color?: string; origin?: number; hint?: string }): React.JSX.Element {
  const label = typeof p.label === 'string' ? p.label : 'valeur';
  return (
    <div className="prow" title={p.hint}>
      <span className="prow-label">{p.label}</span>
      <Slider
        value={p.value} min={p.param.min} max={p.param.max} def={p.param.def} step={p.param.step} onChange={p.onChange}
        disabled={p.disabled} label={label} valueText={p.param.fmt} color={p.color} origin={p.origin}
      />
      <ValueField value={p.value} param={p.param} onChange={p.onChange} disabled={p.disabled} label={label} />
    </div>
  );
}

/** Step control (ratio, knee...) */
export function Stepper(p: { value: number; param: Param; onChange: (v: number) => void; disabled?: boolean; label: string }): React.JSX.Element {
  const set = (v: number): void => p.onChange(Math.min(p.param.max, Math.max(p.param.min, v)));
  return (
    <div className="stepper">
      <button type="button" aria-label={`${p.label} moins`} disabled={p.disabled || p.value <= p.param.min} onClick={() => set(p.value - 1)}>−</button>
      <ValueField value={p.value} param={p.param} onChange={set} disabled={p.disabled} label={p.label} />
      <button type="button" aria-label={`${p.label} plus`} disabled={p.disabled || p.value >= p.param.max} onClick={() => set(p.value + 1)}>+</button>
    </div>
  );
}

export function Field(p: { label: ReactNode; children: ReactNode; hint?: ReactNode; className?: string }): React.JSX.Element {
  return (
    <label className={`field ${p.className ?? ''}`}>
      <span className="field-label">{p.label}</span>
      {p.children}
      {p.hint && <span className="field-hint">{p.hint}</span>}
    </label>
  );
}

export function TextInput(p: { value: string; onChange: (v: string) => void; maxLength?: number; placeholder?: string; disabled?: boolean; label?: string; inputMode?: 'text' | 'numeric' | 'decimal'; type?: string; autoFocus?: boolean; onEnter?: () => void; className?: string }): React.JSX.Element {
  return (
    <input
      className={`input ${p.className ?? ''}`} value={p.value} maxLength={p.maxLength} placeholder={p.placeholder} disabled={p.disabled} aria-label={p.label}
      inputMode={p.inputMode} type={p.type ?? 'text'} autoFocus={p.autoFocus}
      onChange={(e) => p.onChange(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') p.onEnter?.(); }}
    />
  );
}

export function Modal(p: { title: string; children: ReactNode; onClose: () => void; footer?: ReactNode; wide?: boolean }): React.JSX.Element {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(p.onClose);
  close.current = p.onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') close.current(); };
    window.addEventListener('keydown', onKey);
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('input, select, textarea, button:not(.modal-x)');
    first?.focus();
    return () => { window.removeEventListener('keydown', onKey); prev?.focus?.(); };
  }, []);
  return (
    <div className="modal-back" onPointerDown={(e) => { if (e.target === e.currentTarget) p.onClose(); }}>
      <div className={`modal ${p.wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={id} ref={ref}>
        <header className="modal-head">
          <h2 id={id}>{p.title}</h2>
          <button type="button" className="modal-x" aria-label={t('Fermer')} onClick={p.onClose}><Icon name="close" /></button>
        </header>
        <div className="modal-body">{p.children}</div>
        {p.footer && <footer className="modal-foot">{p.footer}</footer>}
      </div>
    </div>
  );
}

export function Tabs<T extends string>(p: { value: T; tabs: { id: T; label: ReactNode; hidden?: boolean }[]; onChange: (v: T) => void; label: string }): React.JSX.Element {
  return (
    <div className="tabs" role="tablist" aria-label={p.label}>
      {p.tabs.filter((t) => !t.hidden).map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={t.id === p.value} className={t.id === p.value ? 'is-on' : ''} onClick={() => p.onChange(t.id)}>{t.label}</button>
      ))}
    </div>
  );
}

export function Empty(p: { icon?: IconName; title: string; children?: ReactNode }): React.JSX.Element {
  return (
    <div className="empty">
      {p.icon && <Icon name={p.icon} size={36} />}
      <h2>{p.title}</h2>
      {p.children}
    </div>
  );
}

export function Badge(p: { children: ReactNode; tone?: 'ok' | 'warn' | 'error' | 'muted' | 'accent'; title?: string }): React.JSX.Element {
  return <span className={`badge badge-${p.tone ?? 'muted'}`} title={p.title}>{p.children}</span>;
}

export function Note(p: { children: ReactNode; tone?: 'info' | 'warn' | 'danger' }): React.JSX.Element {
  return (
    <div className={`note note-${p.tone ?? 'info'}`}>
      <Icon name={p.tone === 'info' || !p.tone ? 'info' : 'warning'} />
      <div>{p.children}</div>
    </div>
  );
}

export function Spinner(): React.JSX.Element { return <span className="spinner" aria-hidden="true" />; }

export function Progress(p: { value: number; max: number; label?: string }): React.JSX.Element {
  const pc = p.max ? Math.round((p.value / p.max) * 100) : 0;
  return (
    <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pc} aria-label={p.label}>
      <div style={{ width: `${pc}%` }} />
    </div>
  );
}
