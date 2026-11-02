// Touch-friendly slider / fader working on raw device values.
// - drag anywhere (relative movement, no jump under the finger); tap on the track to jump;
// - fine adjustment: hold Shift (or move the finger away from the track: 4x slower);
// - keyboard: arrows (1 step), Page Up / Down (10 steps), Home / End;
// - double click / double tap: back to the default value;
// - mouse wheel while focused.
// Changes are sent at most once per animation frame.

import { useCallback, useEffect, useRef, type CSSProperties, type KeyboardEvent, type PointerEvent, type WheelEvent } from 'react';

export interface SliderProps {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  /** default value (double click) */
  def?: number;
  step?: number;
  vertical?: boolean;
  disabled?: boolean;
  label: string;
  valueText?: (v: number) => string;
  color?: string;
  /** value drawn as the zero of the bar (bipolar controls such as EQ gains) */
  origin?: number;
  className?: string;
  style?: CSSProperties;
  /** ticks (raw values) drawn along the track */
  ticks?: number[];
}

export function Slider(p: SliderProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; start: number; startV: number; v: number; moved: boolean } | null>(null);
  const frame = useRef<number | null>(null);
  const queued = useRef<number | null>(null);
  const lastTap = useRef(0);
  const { value, min, max, vertical, disabled, onChange } = p;
  const step = p.step ?? 1;
  const span = max - min || 1;
  const pos = (Math.min(max, Math.max(min, value)) - min) / span;
  const originPos = p.origin === undefined ? 0 : (p.origin - min) / span;

  const emit = useCallback((v: number) => {
    const r = Math.min(max, Math.max(min, Math.round(v)));
    queued.current = r;
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      if (queued.current !== null) onChange(queued.current);
      queued.current = null;
    });
  }, [max, min, onChange]);
  useEffect(() => () => { if (frame.current !== null) cancelAnimationFrame(frame.current); }, []);

  const length = (): number => {
    const r = ref.current?.getBoundingClientRect();
    return r ? (vertical ? r.height : r.width) : 200;
  };
  const at = (e: PointerEvent): number => {
    const r = ref.current!.getBoundingClientRect();
    const f = vertical ? 1 - (e.clientY - r.top) / r.height : (e.clientX - r.left) / r.width;
    return min + Math.min(1, Math.max(0, f)) * span;
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (disabled || e.button > 0) return;
    const now = Date.now();
    if (now - lastTap.current < 320 && p.def !== undefined) { onChange(p.def); lastTap.current = 0; return; }
    lastTap.current = now;
    const el = ref.current!;
    el.focus({ preventScroll: true });
    const thumb = (e.target as HTMLElement).closest('.sl-thumb');
    let v = value;
    if (!thumb) { v = at(e); emit(v); }
    drag.current = { id: e.pointerId, start: vertical ? e.clientY : e.clientX, startV: v, v, moved: false };
    el.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const r = ref.current!.getBoundingClientRect();
    const away = vertical ? Math.abs(e.clientX - (r.left + r.width / 2)) : Math.abs(e.clientY - (r.top + r.height / 2));
    const fine = e.shiftKey || away > 90 ? 0.25 : 1;
    const delta = vertical ? d.start - e.clientY : e.clientX - d.start;
    const v = d.startV + (delta / length()) * span * fine;
    if (fine !== 1) { d.start = vertical ? e.clientY : e.clientX; d.startV = v; }
    d.v = v;
    d.moved = true;
    emit(v);
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>): void => {
    if (drag.current?.id === e.pointerId) drag.current = null;
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (disabled) return;
    const big = step * 10;
    let v: number | null = null;
    switch (e.key) {
      case 'ArrowUp': case 'ArrowRight': v = value + (e.shiftKey ? big : step); break;
      case 'ArrowDown': case 'ArrowLeft': v = value - (e.shiftKey ? big : step); break;
      case 'PageUp': v = value + big; break;
      case 'PageDown': v = value - big; break;
      case 'Home': v = min; break;
      case 'End': v = max; break;
      case 'Enter': case ' ': if (p.def !== undefined && e.altKey) v = p.def; break;
    }
    if (v === null) return;
    e.preventDefault();
    onChange(Math.min(max, Math.max(min, Math.round(v))));
  };
  const onWheel = (e: WheelEvent<HTMLDivElement>): void => {
    if (disabled || document.activeElement !== ref.current) return;
    const dir = (vertical ? -e.deltaY : e.deltaX || -e.deltaY) > 0 ? 1 : -1;
    onChange(Math.min(max, Math.max(min, Math.round(value + dir * step * (e.shiftKey ? 10 : 1)))));
  };

  const lo = Math.min(pos, originPos), hi = Math.max(pos, originPos);
  const fill: CSSProperties = vertical ? { bottom: `${lo * 100}%`, height: `${(hi - lo) * 100}%` } : { left: `${lo * 100}%`, width: `${(hi - lo) * 100}%` };
  const thumb: CSSProperties = vertical ? { bottom: `${pos * 100}%` } : { left: `${pos * 100}%` };
  return (
    <div
      ref={ref}
      className={`sl ${vertical ? 'sl-v' : 'sl-h'} ${disabled ? 'is-disabled' : ''} ${p.className ?? ''}`}
      style={{ ...p.style, ['--sl-color' as string]: p.color }}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={p.label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={p.valueText?.(value)}
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      aria-disabled={disabled || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKey}
      onWheel={onWheel}
      onDoubleClick={() => { if (!disabled && p.def !== undefined) onChange(p.def); }}
    >
      <div className="sl-track">
        {p.ticks?.map((t) => {
          const tp = (t - min) / span;
          return <span key={t} className="sl-tick" style={vertical ? { bottom: `${tp * 100}%` } : { left: `${tp * 100}%` }} />;
        })}
        <div className="sl-fill" style={fill} />
      </div>
      <div className="sl-thumb" style={thumb} />
    </div>
  );
}
