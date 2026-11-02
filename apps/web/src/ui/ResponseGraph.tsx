// Frequency response view (magnitude or phase), with draggable EQ bands and crossover markers, like
// the editor's curve window: drag a point to change frequency and gain, mouse wheel on a point or
// two-finger pinch (on the dragged or selected band) for Q.

import { useId, useLayoutEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { fmtHzShort } from './format.ts';

export interface GraphCurve { id: string; color: string; values: number[]; width?: number; opacity?: number; dash?: string; fill?: boolean }
export interface GraphHandle { id: number; f: number; db: number; label: string; color: string; bypass?: boolean; fixedY?: boolean; selected?: boolean; info?: string }
export interface GraphMarker { id: string; f: number; label: string; color: string }

export interface ResponseGraphProps {
  freqs: number[];
  curves: GraphCurve[];
  mode: 'mag' | 'phase';
  range?: [number, number];
  handles?: GraphHandle[];
  markers?: GraphMarker[];
  onHandle?: (id: number, f: number, db: number, done: boolean) => void;
  onHandleWheel?: (id: number, dir: number) => void;
  onMarker?: (id: string, f: number) => void;
  onSelect?: (id: number) => void;
  height?: number;
  showLabels?: boolean;
  label: string;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  disabled?: boolean;
}

const FMIN = 20, FMAX = 20000;
const GRID_F = [20, 30, 40, 50, 60, 70, 80, 90, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000, 20000];
const LABEL_F = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];

export function ResponseGraph(p: ResponseGraphProps): React.JSX.Element {
  const box = useRef<HTMLDivElement>(null);
  const clip = `clip${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const [w, setW] = useState(600);
  const h = p.height ?? 280;
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(240, el.clientWidth)));
    ro.observe(el);
    setW(Math.max(240, el.clientWidth));
    return () => ro.disconnect();
  }, []);

  const L = 34, R = 10, T = 10, B = 22;
  const W = w - L - R, H = h - T - B;
  const [lo, hi] = p.mode === 'phase' ? [-180, 180] : p.range ?? [-30, 18];
  const x = (f: number): number => L + (W * Math.log(Math.min(FMAX * 1.01, Math.max(FMIN * 0.98, f)) / FMIN)) / Math.log(FMAX / FMIN);
  const y = (v: number): number => T + ((hi - v) / (hi - lo)) * H;
  const fAt = (px: number): number => FMIN * Math.pow(FMAX / FMIN, (px - L) / W);
  const vAt = (py: number): number => hi - ((py - T) / H) * (hi - lo);

  const drag = useRef<{ kind: 'h'; id: number; pid: number } | { kind: 'm'; id: string; pid: number } | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const local = (e: RPointerEvent): [number, number] => {
    const r = svg.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  // pinch: fingers apart = wider band (lower Q), one Q step (x1.06) per 6 % of spread
  const touches = useRef(new Map<number, [number, number]>());
  const pinch = useRef<{ id: number; d0: number; applied: number } | null>(null);
  const spread = (): number => {
    const [a, b] = [...touches.current.values()];
    return Math.max(1, Math.hypot(a[0] - b[0], a[1] - b[1]));
  };
  const track = (e: RPointerEvent): void => {
    if (e.pointerType !== 'touch') return;
    touches.current.set(e.pointerId, local(e));
    if (touches.current.size !== 2 || !p.onHandleWheel) return;
    const d = drag.current;
    const id = d?.kind === 'h' ? d.id : p.handles?.find((hd) => hd.selected)?.id;
    if (id === undefined) return;
    drag.current = null;
    pinch.current = { id, d0: spread(), applied: 0 };
  };
  const untrack = (e: RPointerEvent): void => {
    touches.current.delete(e.pointerId);
    if (touches.current.size < 2) pinch.current = null;
  };
  const onMove = (e: RPointerEvent<SVGSVGElement>): void => {
    if (touches.current.has(e.pointerId)) touches.current.set(e.pointerId, local(e));
    const pc = pinch.current;
    if (pc && touches.current.size === 2) {
      const steps = Math.round(-Math.log(spread() / pc.d0) / Math.log(1.06));
      if (steps !== pc.applied) { p.onHandleWheel?.(pc.id, steps - pc.applied); pc.applied = steps; }
      return;
    }
    const d = drag.current;
    if (!d || d.pid !== e.pointerId) return;
    const [px, py] = local(e);
    const f = Math.min(20160, Math.max(19.7, fAt(px)));
    if (d.kind === 'h') p.onHandle?.(d.id, f, Math.min(12, Math.max(-12, vAt(py))), false);
    else p.onMarker?.(d.id, f);
  };
  const onUp = (e: RPointerEvent<SVGSVGElement>): void => {
    untrack(e);
    const d = drag.current;
    if (!d || d.pid !== e.pointerId) return;
    drag.current = null;
    if (d.kind === 'h') {
      const [px, py] = local(e);
      p.onHandle?.(d.id, Math.min(20160, Math.max(19.7, fAt(px))), Math.min(12, Math.max(-12, vAt(py))), true);
    }
  };

  const path = (vals: number[]): string => {
    let s = '';
    let prev: number | null = null;
    vals.forEach((v, i) => {
      const cv = Math.min(hi + 6, Math.max(lo - 6, v));
      const broken = p.mode === 'phase' && prev !== null && Math.abs(v - prev) > 180;
      s += `${i === 0 || broken ? 'M' : 'L'}${x(p.freqs[i]).toFixed(1)},${y(cv).toFixed(1)}`;
      prev = v;
    });
    return s;
  };
  const zero = y(0);
  const step = p.mode === 'phase' ? 90 : (hi - lo) > 30 ? 6 : 3;
  const hLines: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) hLines.push(v);

  return (
    <div className="graph" ref={box} style={{ height: h }}>
      <svg
        ref={svg} width={w} height={h} role="img" aria-label={p.label} tabIndex={p.onKeyDown ? 0 : -1} onKeyDown={p.onKeyDown}
        onPointerDown={(e) => { if (!p.disabled && e.pointerType === 'touch') { svg.current?.setPointerCapture(e.pointerId); track(e); } }}
        onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} className={p.disabled ? 'is-disabled' : ''}
      >
        <defs>
          <clipPath id={clip}><rect x={L} y={T} width={W} height={H} /></clipPath>
        </defs>
        <rect x={L} y={T} width={W} height={H} className="g-bg" />
        {GRID_F.map((f) => <line key={f} x1={x(f)} x2={x(f)} y1={T} y2={T + H} className={LABEL_F.includes(f) ? 'g-line g-major' : 'g-line'} />)}
        {hLines.map((v) => <line key={v} x1={L} x2={L + W} y1={y(v)} y2={y(v)} className={v === 0 ? 'g-line g-zero' : 'g-line'} />)}
        {LABEL_F.map((f) => <text key={f} x={x(f)} y={h - 6} className="g-label" textAnchor="middle">{fmtHzShort(f)}</text>)}
        {hLines.filter((_, i) => i % (p.mode === 'phase' ? 1 : 2) === 0).map((v) => (
          <text key={v} x={L - 5} y={y(v) + 4} className="g-label" textAnchor="end">{v > 0 ? `+${v}` : v}{p.mode === 'phase' ? '°' : ''}</text>
        ))}
        <g clipPath={`url(#${clip})`}>
          {p.curves.map((c) => (
            <g key={c.id}>
              {c.fill && p.mode === 'mag' && (
                <path d={`${path(c.values)}L${x(p.freqs[p.freqs.length - 1])},${zero}L${x(p.freqs[0])},${zero}Z`} fill={c.color} opacity={0.12} stroke="none" />
              )}
              <path d={path(c.values)} fill="none" stroke={c.color} strokeWidth={c.width ?? 2} opacity={c.opacity ?? 1} strokeDasharray={c.dash} strokeLinejoin="round" />
            </g>
          ))}
          {p.mode === 'mag' && p.markers?.map((m) => (
            <g key={m.id} className="g-marker">
              <line x1={x(m.f)} x2={x(m.f)} y1={T} y2={T + H} stroke={m.color} strokeDasharray="3 4" opacity={0.7} />
            </g>
          ))}
        </g>
        {p.mode === 'mag' && p.markers?.map((m) => {
          const mx = x(m.f);
          return (
            <g
              key={m.id} className="g-pill" transform={`translate(${mx},${T + H - 12})`}
              onPointerDown={(e) => { if (p.disabled) return; e.stopPropagation(); svg.current?.setPointerCapture(e.pointerId); drag.current = { kind: 'm', id: m.id, pid: e.pointerId }; }}
            >
              <rect x={-17} y={-9} width={34} height={18} rx={9} fill={m.color} />
              <text y={4} textAnchor="middle">{m.label}</text>
            </g>
          );
        })}
        {p.mode === 'mag' && p.handles?.map((hd) => {
          const hx = x(hd.f), hy = y(hd.fixedY ? 0 : hd.db);
          return (
            <g
              key={hd.id} transform={`translate(${hx},${hy})`} className={`g-handle ${hd.selected ? 'is-sel' : ''} ${hd.bypass ? 'is-byp' : ''}`}
              onPointerDown={(e) => {
                if (p.disabled) return;
                e.stopPropagation();
                svg.current?.setPointerCapture(e.pointerId);
                // a second finger, even on another band, pinches the band already held
                if (e.pointerType === 'touch' && (drag.current || pinch.current)) { track(e); return; }
                p.onSelect?.(hd.id);
                drag.current = { kind: 'h', id: hd.id, pid: e.pointerId };
                track(e);
              }}
              onWheel={(e) => { if (!p.disabled && p.onHandleWheel) p.onHandleWheel(hd.id, e.deltaY < 0 ? 1 : -1); }}
            >
              <circle r={18} className="g-hit" />
              <circle r={hd.selected ? 10 : 8} fill={hd.bypass ? 'transparent' : hd.color} stroke={hd.color} strokeWidth={2} />
              <text y={4} textAnchor="middle" className="g-hlabel">{hd.label}</text>
              {p.showLabels && hd.info && (
                <text y={hy < T + 30 ? 26 : -16} textAnchor="middle" className="g-info">{hd.info}</text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
