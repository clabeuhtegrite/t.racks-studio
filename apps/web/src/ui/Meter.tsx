import { t } from '../i18n.tsx';
// Level meter (dBFS) with clip LED, and the limiter LED of the outputs.

const MIN_DB = -60;

export function levelToPos(db: number): number { return Math.max(0, Math.min(1, (db - MIN_DB) / -MIN_DB)); }

export function Meter(p: { db: number | null | undefined; limit?: boolean; vertical?: boolean; label: string; compact?: boolean }): React.JSX.Element {
  const db = p.db ?? -140;
  const pos = levelToPos(db);
  const clip = db > -0.5;
  return (
    <div className={`meter ${p.vertical === false ? 'meter-h' : 'meter-v'} ${p.compact ? 'meter-compact' : ''}`} role="meter" aria-label={p.label}
      aria-valuemin={MIN_DB} aria-valuemax={0} aria-valuenow={Math.round(Math.max(MIN_DB, db))}>
      <div className="meter-leds">
        <span className={`led led-red ${clip ? 'is-on' : ''}`} title={t('Écrêtage')} />
        {p.limit !== undefined && <span className={`led led-amber ${p.limit ? 'is-on' : ''}`} title={t('Limiteur actif')} />}
      </div>
      <div className="meter-bar">
        <div className="meter-fill" style={p.vertical === false ? { transform: `scaleX(${pos})` } : { transform: `scaleY(${pos})` }} />
        {!p.compact && [-6, -18, -40].map((m) => (
          <span key={m} className="meter-mark" style={p.vertical === false ? { left: `${levelToPos(m) * 100}%` } : { bottom: `${levelToPos(m) * 100}%` }} />
        ))}
      </div>
    </div>
  );
}
