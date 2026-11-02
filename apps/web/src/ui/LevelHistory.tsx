// Level and automatic correction over the last two hours: two panels on the same time axis (the
// level with the target zone, then the correction), a crosshair giving the figures of the moment
// under the pointer, the finger or the arrow keys, and the same figures as a table.

import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { LevelerPoint, LevelerSettings } from '@dsp-studio/protocol';
import { fmtNumber, fmtSigned } from './format.ts';
import { locale, t } from '../i18n.tsx';
import './level.css';

/** two points further apart than this are not joined (device off, bridge restarted) */
const GAP_MS = 25_000;
const MIN_SPAN_MS = 10 * 60_000;
const TICK_MINUTES = [1, 2, 5, 10, 15, 30, 60];

const timeFmt = (seconds: boolean): Intl.DateTimeFormat =>
  new Intl.DateTimeFormat(locale(), seconds ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : { hour: '2-digit', minute: '2-digit' });

const levelText = (v: number | null): string => (v === null ? t('silence') : `${fmtNumber(v)} dBFS`);
const correctionText = (v: number): string => `${fmtSigned(v)} dB`;

/** Index of the point closest in time to `tm` (points in time order). */
function nearest(points: LevelerPoint[], tm: number): number {
  let lo = 0, hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t < tm) lo = mid; else hi = mid;
  }
  return Math.abs(points[lo].t - tm) <= Math.abs(points[hi].t - tm) ? lo : hi;
}

export function LevelHistory(p: { points: LevelerPoint[]; settings: LevelerSettings; label: string }): React.JSX.Element {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(640);
  const [sel, setSel] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(260, el.clientWidth)));
    ro.observe(el);
    setW(Math.max(260, el.clientWidth));
    return () => ro.disconnect();
  }, []);

  const pts = p.points;
  const { target, tolerance } = p.settings;
  const L = 46, R = 12, T = 18, HA = 168, GAP = 34, HB = 84, B = 24;
  const W = w - L - R;
  const h = T + HA + GAP + HB + B;
  const topB = T + HA + GAP;

  // time axis: the history, ten minutes at least
  const t1 = pts.length ? pts[pts.length - 1].t : 0;
  const t0 = pts.length ? Math.min(pts[0].t, t1 - MIN_SPAN_MS) : t1 - MIN_SPAN_MS;
  const x = (tm: number): number => L + ((tm - t0) / (t1 - t0)) * W;
  // level panel: 24 dB below the target, 12 above
  const lo = target - 24, hi = target + 12;
  const yA = (v: number): number => T + ((hi - Math.min(hi, Math.max(lo, v))) / (hi - lo)) * HA;
  // correction panel: symmetric, covers the limits and what happened
  const cMax = Math.max(3, Math.ceil(Math.max(p.settings.maxBoost, p.settings.maxCut, ...pts.map((q) => Math.abs(q.correction))) / 3) * 3);
  const yB = (v: number): number => topB + ((cMax - v) / (2 * cMax)) * HB;

  let levelPath = '', corrPath = '';
  let prev: LevelerPoint | null = null;
  for (const q of pts) {
    const joined = prev !== null && q.t - prev.t <= GAP_MS;
    if (q.level !== null) levelPath += `${joined && prev!.level !== null ? 'L' : 'M'}${x(q.t).toFixed(1)},${yA(q.level).toFixed(1)}`;
    corrPath += joined ? `H${x(q.t).toFixed(1)}V${yB(q.correction).toFixed(1)}` : `M${x(q.t).toFixed(1)},${yB(q.correction).toFixed(1)}`;
    prev = q;
  }

  const levelTicks: number[] = [];
  for (let v = Math.ceil(lo / 6) * 6; v <= hi; v += 6) levelTicks.push(v);
  const cStep = cMax <= 6 ? 3 : 6;
  const corrTicks: number[] = [];
  for (let v = -cMax; v <= cMax; v += cStep) corrTicks.push(v);
  const span = (t1 - t0) / 60_000;
  const minutes = TICK_MINUTES.find((m) => span / m <= Math.max(2, Math.floor(W / 84))) ?? 60;
  const timeTicks: number[] = [];
  for (let tm = Math.ceil(t0 / (minutes * 60_000)) * minutes * 60_000; tm <= t1; tm += minutes * 60_000) timeTicks.push(tm);
  const short = timeFmt(false), long = timeFmt(true);

  const svg = useRef<SVGSVGElement>(null);
  const pick = (e: PointerEvent<SVGSVGElement>): void => {
    if (!pts.length) return;
    const r = svg.current!.getBoundingClientRect();
    const px = e.clientX - r.left;
    if (px < L - 8 || px > L + W + 8) { setSel(null); return; }
    setSel(nearest(pts, t0 + ((px - L) / W) * (t1 - t0)));
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>): void => {
    if (!pts.length) return;
    const last = pts.length - 1;
    const cur = sel ?? last;
    const next = e.key === 'ArrowLeft' ? cur - 1 : e.key === 'ArrowRight' ? cur + 1 : e.key === 'Home' ? 0 : e.key === 'End' ? last
      : e.key === 'PageUp' ? cur - 30 : e.key === 'PageDown' ? cur + 30 : null;
    if (e.key === 'Escape') { setSel(null); return; }
    if (next === null) return;
    e.preventDefault();
    setSel(Math.min(last, Math.max(0, next)));
  };

  const q = sel !== null && sel < pts.length ? pts[sel] : null;
  const qx = q ? x(q.t) : 0;
  const tipLeft = q ? Math.min(Math.max(qx + 12, L), w - 180) : 0;
  const tipFlip = q !== null && qx + 12 + 170 > w;

  return (
    <div className="graph lvh" ref={box}>
      <svg
        ref={svg} width={w} height={h} role="img" tabIndex={0} aria-label={p.label}
        onPointerMove={pick} onPointerDown={pick} onPointerLeave={(e) => { if (e.pointerType === 'mouse') setSel(null); }}
        onKeyDown={onKey} onBlur={() => setSel(null)}
      >
        <text x={L} y={T - 6} className="g-label lvh-title">{t('Niveau après le gain (dBFS)')}</text>
        <rect x={L} y={T} width={W} height={HA} className="g-bg" />
        {levelTicks.map((v) => <line key={v} x1={L} x2={L + W} y1={yA(v)} y2={yA(v)} className="g-line" />)}
        {levelTicks.map((v) => <text key={v} x={L - 6} y={yA(v) + 3.5} className="g-label" textAnchor="end">{fmtNumber(v, 0)}</text>)}
        <rect x={L} y={yA(target + tolerance)} width={W} height={yA(target - tolerance) - yA(target + tolerance)} className="lvh-zone" />
        <line x1={L} x2={L + W} y1={yA(target)} y2={yA(target)} className="lvh-target" />
        <text x={L + W - 4} y={yA(target + tolerance) - 4} className="g-label" textAnchor="end">{t('zone cible')}</text>
        <path d={levelPath} className="lvh-level" />

        <text x={L} y={topB - 6} className="g-label lvh-title">{t('Correction du gain automatique (dB)')}</text>
        <rect x={L} y={topB} width={W} height={HB} className="g-bg" />
        {corrTicks.map((v) => <line key={v} x1={L} x2={L + W} y1={yB(v)} y2={yB(v)} className={v === 0 ? 'g-line g-zero' : 'g-line'} />)}
        {corrTicks.map((v) => <text key={v} x={L - 6} y={yB(v) + 3.5} className="g-label" textAnchor="end">{fmtSigned(v, 0)}</text>)}
        <path d={corrPath} className="lvh-corr" />

        {timeTicks.map((tm) => (
          <g key={tm}>
            <line x1={x(tm)} x2={x(tm)} y1={topB + HB} y2={topB + HB + 4} className="g-line g-zero" />
            <text x={x(tm)} y={h - 6} className="g-label" textAnchor="middle">{short.format(tm)}</text>
          </g>
        ))}

        {q && (
          <g className="lvh-cross" aria-hidden="true">
            <line x1={qx} x2={qx} y1={T} y2={T + HA} />
            <line x1={qx} x2={qx} y1={topB} y2={topB + HB} />
            {q.level !== null && <circle cx={qx} cy={yA(q.level)} r={4.5} className="lvh-dot lvh-dot-level" />}
            <circle cx={qx} cy={yB(q.correction)} r={4.5} className="lvh-dot lvh-dot-corr" />
          </g>
        )}
      </svg>
      {q && (
        <div className="lvh-tip" style={tipFlip ? { left: Math.max(L, qx - 182) } : { left: tipLeft }} role="status">
          <b>{long.format(q.t)}</b>
          <span><i className="lvh-key lvh-key-level" />{t('Niveau')} <em>{levelText(q.level)}</em></span>
          <span><i className="lvh-key lvh-key-corr" />{t('Correction')} <em>{correctionText(q.correction)}</em></span>
        </div>
      )}
    </div>
  );
}

/** The same figures as a table, newest first. */
export function LevelTable(p: { points: LevelerPoint[] }): React.JSX.Element {
  const fmt = timeFmt(true);
  const rows = [...p.points].reverse();
  return (
    <div className="table-wrap lvh-table">
      <table className="table table-tight">
        <thead><tr><th>{t('Heure')}</th><th>{t('Niveau')}</th><th>{t('Correction')}</th></tr></thead>
        <tbody>
          {rows.map((q) => (
            <tr key={q.t}><td>{fmt.format(q.t)}</td><td>{levelText(q.level)}</td><td>{correctionText(q.correction)}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
