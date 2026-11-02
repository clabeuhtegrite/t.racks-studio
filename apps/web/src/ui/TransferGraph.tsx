// Static transfer curve of a gate, compressor or limiter (input level -> output level), with the
// live signal level shown as a dot, like the editor's dynamics windows.

import { useId } from 'react';
import { compressorCurve } from '@dsp-studio/protocol';

export function TransferGraph(p: {
  kind: 'gate' | 'comp' | 'limit'; thrDb: number; ratio?: number; kneeDb?: number; levelDb?: number | null; color: string; size?: number; label: string;
}): React.JSX.Element {
  const S = p.size ?? 220;
  const pad = 26;
  const lo = -90, hi = 20;
  const span = hi - lo;
  const X = (v: number): number => pad + ((v - lo) / span) * (S - pad - 8);
  const Y = (v: number): number => 8 + ((hi - v) / span) * (S - pad - 8);
  const xs = Array.from({ length: 111 }, (_, i) => lo + i);
  const out = p.kind === 'gate'
    ? xs.map((v) => (v < p.thrDb ? lo : v))
    : compressorCurve(p.thrDb, p.kind === 'limit' ? Infinity : p.ratio ?? 1, p.kind === 'limit' ? 0 : p.kneeDb ?? 0, xs);
  let d = '';
  xs.forEach((v, i) => {
    const o = Math.max(lo, Math.min(hi, out[i]));
    if (p.kind === 'gate' && i > 0 && v >= p.thrDb && xs[i - 1] < p.thrDb) d += `L${X(v).toFixed(1)},${Y(lo).toFixed(1)}`;
    d += `${i === 0 ? 'M' : 'L'}${X(v).toFixed(1)},${Y(o).toFixed(1)}`;
  });
  const lvl = p.levelDb ?? null;
  const lvlOut = lvl === null ? null : p.kind === 'gate' ? (lvl < p.thrDb ? lo : lvl) : compressorCurve(p.thrDb, p.kind === 'limit' ? Infinity : p.ratio ?? 1, p.kneeDb ?? 0, [lvl])[0];
  const grid = [-80, -60, -40, -20, 0, 20];
  const clip = `t${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  return (
    <svg className="transfer" width="100%" viewBox={`0 0 ${S} ${S}`} role="img" aria-label={p.label} style={{ maxWidth: S }}>
      <defs><clipPath id={clip}><rect x={pad} y={8} width={S - pad - 8} height={S - pad - 8} /></clipPath></defs>
      <rect x={pad} y={8} width={S - pad - 8} height={S - pad - 8} className="g-bg" />
      {grid.map((g) => (
        <g key={g}>
          <line x1={X(g)} x2={X(g)} y1={8} y2={S - pad} className="g-line" />
          <line x1={pad} x2={S - 8} y1={Y(g)} y2={Y(g)} className="g-line" />
          <text x={X(g)} y={S - 10} className="g-label" textAnchor="middle">{g}</text>
          <text x={pad - 4} y={Y(g) + 3} className="g-label" textAnchor="end">{g}</text>
        </g>
      ))}
      <g clipPath={`url(#${clip})`}>
        <line x1={X(lo)} y1={Y(lo)} x2={X(hi)} y2={Y(hi)} className="g-line g-zero" strokeDasharray="4 4" />
        <line x1={X(p.thrDb)} x2={X(p.thrDb)} y1={8} y2={S - pad} stroke={p.color} strokeDasharray="2 4" opacity={0.6} />
        <path d={d} fill="none" stroke={p.color} strokeWidth={2.2} />
        {lvl !== null && lvl > lo && lvlOut !== null && <circle cx={X(Math.min(hi, lvl))} cy={Y(Math.max(lo, Math.min(hi, lvlOut)))} r={4.5} className="g-dot" />}
      </g>
    </svg>
  );
}
