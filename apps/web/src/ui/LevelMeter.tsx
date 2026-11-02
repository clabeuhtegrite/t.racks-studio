// Level of the mix against the zone of the automatic gain: a bar on a scale centred on the target
// (18 dB below, 12 dB above), the zone and the target drawn over it, and where the level stands in
// words with an icon (never colour alone).

import type { LevelerState } from '@dsp-studio/protocol';
import { zoneOf, zoneText, type Zone } from '../state/leveler.ts';
import { fmtNumber, fmtSigned } from './format.ts';
import { Icon, type IconName } from './icons.tsx';
import { t } from '../i18n.tsx';
import './level.css';

const BELOW = 18;
const ABOVE = 12;
const TICKS = [-18, -12, -6, 0, 6, 12];
/** position of a level relative to the target on the bar, 0..1 */
const pos = (rel: number): number => Math.min(1, Math.max(0, (rel + BELOW) / (BELOW + ABOVE)));

export const zoneIcon = (z: Zone): IconName => (z === 'ok' ? 'check' : z === 'none' ? 'wave' : 'warning');

export function LevelMeter(p: { st: LevelerState; level: number | null; label: string; big?: boolean; showState?: boolean }): React.JSX.Element {
  const { target, tolerance } = p.st.settings;
  const zone = zoneOf(p.st, p.level);
  const rel = p.level === null ? null : p.level - target;
  const valueText = p.level === null ? zoneText(zone) : `${fmtNumber(p.level)} dBFS, ${zoneText(zone)}`;
  return (
    <div className={`lvm lvm-${zone} ${p.big ? 'lvm-big' : ''}`}>
      <div
        className="lvm-track" role="meter" aria-label={p.label} aria-valuetext={valueText}
        aria-valuemin={target - BELOW} aria-valuemax={target + ABOVE} aria-valuenow={Math.round(Math.max(target - BELOW, p.level ?? target - BELOW))}
      >
        <div className="lvm-fill" style={{ transform: `scaleX(${rel === null ? 0 : pos(rel)})` }} />
        <div className="lvm-zone" style={{ left: `${pos(-tolerance) * 100}%`, right: `${(1 - pos(tolerance)) * 100}%` }} />
        <div className="lvm-target" style={{ left: `${pos(0) * 100}%` }} />
      </div>
      <div className="lvm-scale" aria-hidden="true">
        {TICKS.map((v) => (
          <span key={v} className={v === 0 ? 'is-target' : ''} style={{ left: `${pos(v) * 100}%` }}>{v === 0 ? t('cible') : fmtSigned(v, 0)}</span>
        ))}
      </div>
      {p.showState && (
        <div className="lvm-state">
          <span className="lvm-word"><Icon name={zoneIcon(zone)} size={p.big ? 28 : 18} />{zoneText(zone)}</span>
          {rel !== null && <span className="lvm-gap">{t('{0} dB par rapport à la cible', fmtSigned(rel))}</span>}
        </div>
      )}
    </div>
  );
}
