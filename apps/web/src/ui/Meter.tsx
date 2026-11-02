import type { MeterZones } from '@dsp-studio/protocol';
import { t } from '../i18n.tsx';
// Level meter (dBFS) coloured like the bars of the official editors: green, then yellow from the
// first yellow segment, then red (the "Clip" segment, which also lights the red LED). Outputs have
// the editors' orange "Limit" LED: it lights while the compressor or the limiter acts.

const MIN_DB = -60;
const MAX_DB = 6;

export function levelToPos(db: number): number { return Math.max(0, Math.min(1, (db - MIN_DB) / (MAX_DB - MIN_DB))); }

export function Meter(p: { db: number | null | undefined; zones: MeterZones; dyn?: boolean; vertical?: boolean; label: string; compact?: boolean }): React.JSX.Element {
  const db = p.db ?? -140;
  const pos = levelToPos(db);
  const clip = db > p.zones.red;
  const h = p.vertical === false;
  const hide = `${((1 - pos) * 100).toFixed(1)}%`;
  return (
    <div className={`meter ${h ? 'meter-h' : 'meter-v'} ${p.compact ? 'meter-compact' : ''}`} role="meter" aria-label={p.label}
      aria-valuemin={MIN_DB} aria-valuemax={MAX_DB} aria-valuenow={Math.round(Math.max(MIN_DB, Math.min(MAX_DB, db)))}
      style={{ '--y': `${levelToPos(p.zones.yellow) * 100}%`, '--r': `${levelToPos(p.zones.red) * 100}%` } as React.CSSProperties}>
      <div className="meter-leds">
        <span className={`led led-red ${clip ? 'is-on' : ''}`} title={t('Écrêtage')} />
        {p.dyn !== undefined && <span className={`led led-dyn ${p.dyn ? 'is-on' : ''}`} title={t('Compresseur ou limiteur en action')} />}
      </div>
      <div className="meter-bar">
        <div className="meter-fill" style={{ clipPath: h ? `inset(0 ${hide} 0 0)` : `inset(${hide} 0 0 0)` }} />
        {!p.compact && [-6, -18, -40].map((m) => (
          <span key={m} className="meter-mark" style={h ? { left: `${levelToPos(m) * 100}%` } : { bottom: `${levelToPos(m) * 100}%` }} />
        ))}
      </div>
    </div>
  );
}
