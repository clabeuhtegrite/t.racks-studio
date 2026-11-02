// Editors for one channel's blocks: crossover filters, level / polarity / delay, gate, compressor,
// limiter, output routing and the 31-band graphic EQ. Used by the channel page and by the
// overview pages (Dynamique, Délais, GEQ, Matrice).

import { useMemo, useRef, useState } from 'react';
import {
  eqGainRawToDb, GEQ_FREQS, logFreqs, MODELS, ratioValue, SLOPES, thrRawToDb,
  type DelayUnit, type DeviceConfig, type InputChannel, type OutputChannel, type Xover,
} from '@dsp-studio/protocol';
import type { DeviceMirror } from '../client/mirror.ts';
import { confirmDialog, useMeters } from '../state/store.ts';
import { Button, Card, ParamRow, Segmented, Select, Stepper, Toggle, ValueField } from '../ui/kit.tsx';
import { Slider } from '../ui/Slider.tsx';
import { Meter } from '../ui/Meter.tsx';
import { delayParam, DELAY_UNIT_LABELS, fmtIso, fmtIsoHz, fmtSigned, P } from '../ui/format.ts';
import { chan, colorOf, labelOf, responseOf } from '../ui/channels.tsx';
import { TransferGraph } from '../ui/TransferGraph.tsx';
import { ResponseGraph } from '../ui/ResponseGraph.tsx';
import { t, tx } from '../i18n.tsx';

interface EdProps { cfg: DeviceConfig; ch: number; mirror: DeviceMirror; disabled: boolean }

// ------------------------------------------------------------------------------ crossover
export const SLOPE_OPTIONS = SLOPES.map((s, i) => {
  const [fam, db] = s.split(' ');
  const name = fam === 'BW' ? 'Butterworth' : fam === 'BL' ? 'Bessel' : 'Linkwitz-Riley';
  return { value: i + 1, label: `${name} ${db.replace('-', '−')} dB/oct` };
});
const lastSlopes = new Map<string, number>();

export function XoverEditor({ cfg, ch, mirror, disabled }: EdProps): React.JSX.Element {
  const c = chan(cfg, ch);
  const color = colorOf(cfg, ch);
  const row = (kind: 'hpf' | 'lpf', x: Xover, title: string): React.JSX.Element => {
    const key = `${mirror.key}:${ch}:${kind}`;
    const remembered = lastSlopes.get(key) ?? 10; // LK -24 by default
    const slope = x.slope || remembered;
    const set = (patch: Partial<Xover>): void => {
      const cur = chan(mirror.config ?? cfg, ch)[kind];
      const next = { ...cur, ...patch };
      if (next.slope) lastSlopes.set(key, next.slope);
      mirror.apply({ t: kind, ch, x: next });
    };
    return (
      <div className="xover">
        <div className="xover-head">
          <h3>{title}</h3>
          <Toggle small tone="amber" on={x.slope === 0} disabled={disabled} title={t('Filtre contourné')}
            onChange={(byp) => set({ slope: byp ? 0 : slope })}>{t('Bypass')}</Toggle>
        </div>
        <ParamRow label={t('Fréquence')} param={P.freq} value={x.freq} onChange={(freq) => set({ freq })} disabled={disabled} color={color} />
        <div className="prow">
          <span className="prow-label">{t('Pente')}</span>
          <Select label={t('Pente {0}', title)} value={slope} disabled={disabled} onChange={(s) => { lastSlopes.set(key, s); set({ slope: s }); }} options={SLOPE_OPTIONS} />
        </div>
      </div>
    );
  };
  return (
    <Card title={t('Filtres (crossover)')} subtitle={t('Passe-haut (coupe-bas) et passe-bas (coupe-haut), 20 pentes Butterworth, Bessel et Linkwitz-Riley.')}>
      <div className="grid2">
        {row('hpf', c.hpf, t('Passe-haut (coupe-bas)'))}
        {row('lpf', c.lpf, t('Passe-bas (coupe-haut)'))}
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------------------ level
export function LevelEditor({ cfg, ch, mirror, disabled, canOperate }: EdProps & { canOperate: boolean }): React.JSX.Element {
  const c = chan(cfg, ch);
  const color = colorOf(cfg, ch);
  const unit = cfg.delayUnit as DelayUnit;
  const dp = delayParam(unit);
  const meters = useMeters();
  const m = MODELS[cfg.model];
  return (
    <Card title={t('Niveau, polarité et délai')}>
      <div className="level">
        <Meter db={meters?.db[ch]} vertical={false} limit={ch >= m.inputs ? !!((meters?.status ?? 0) >> (ch - m.inputs) & 1) : undefined} label={t('Niveau {0}', labelOf(cfg, ch))} />
        <ParamRow label={t('Volume')} param={P.gain} value={c.gain} onChange={(raw) => mirror.apply({ t: 'gain', ch, raw })} disabled={!canOperate} color={color} origin={280} />
        <div className="row">
          <Toggle on={c.mute} tone="red" onChange={(on) => mirror.apply({ t: 'mute', ch, on })} disabled={!canOperate} icon="mute">{t('Mute')}</Toggle>
          <Toggle on={!!c.phase} tone="amber" onChange={(inv) => mirror.apply({ t: 'phase', ch, inv })} disabled={disabled} icon="phase">{c.phase ? t('Polarité inversée') : t('Polarité normale')}</Toggle>
        </div>
        <ParamRow label={t('Délai')} param={dp} value={c.delay} onChange={(raw) => mirror.apply({ t: 'delay', ch, raw })} disabled={disabled} color={color} />
        <div className="prow">
          <span className="prow-label">{t('Unité')}</span>
          <Segmented small label={t('Unité des délais')} value={unit} disabled={disabled} onChange={(u) => mirror.apply({ t: 'delayUnit', unit: u })}
            options={DELAY_UNIT_LABELS.map((l, i) => ({ value: i as DelayUnit, label: l, title: i === 0 ? 'millisecondes' : i === 1 ? t('mètres') : 'pieds' }))} />
        </div>
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------------------ dynamics
function useLevel(ch: number): number | null {
  const meters = useMeters();
  const v = meters?.db[ch];
  return v === undefined ? null : v;
}

export function GateEditor({ cfg, ch, mirror, disabled, compact }: EdProps & { compact?: boolean }): React.JSX.Element {
  const c = cfg.inputs[ch] as InputChannel;
  const g = c.gate;
  const color = colorOf(cfg, ch);
  const level = useLevel(ch);
  const set = (patch: Partial<InputChannel['gate']>): void => {
    const cur = (mirror.config ?? cfg).inputs[ch].gate;
    mirror.apply({ t: 'gate', ch, g: { ...cur, ...patch } });
  };
  const body = (
    <div className="dyn">
      <TransferGraph kind="gate" thrDb={thrRawToDb(g.threshold)} levelDb={level} color={color} label={t('Courbe du gate {0}', labelOf(cfg, ch))} />
      <div className="dyn-params">
        <ParamRow label={t('Seuil')} param={P.gateThr} value={g.threshold} onChange={(threshold) => set({ threshold })} disabled={disabled} color={color} />
        <ParamRow label={t('Attaque')} param={P.gateAttack} value={g.attack} onChange={(attack) => set({ attack })} disabled={disabled} color={color} />
        <ParamRow label={t('Maintien')} param={P.hold} value={g.hold} onChange={(hold) => set({ hold })} disabled={disabled} color={color} />
        <ParamRow label={t('Relâchement')} param={P.gateRelease} value={g.release} onChange={(release) => set({ release })} disabled={disabled} color={color} />
      </div>
    </div>
  );
  if (compact) return body;
  return <Card title={t('Noise gate')} subtitle={t('Ferme l’entrée quand le signal passe sous le seuil (−90 dB = gate ouvert en permanence).')}>{body}</Card>;
}

export function CompEditor({ cfg, ch, mirror, disabled, compact }: EdProps & { compact?: boolean }): React.JSX.Element {
  const c = (mirror.config ?? cfg).outputs[ch - MODELS[cfg.model].inputs] as OutputChannel;
  const k = c.comp;
  const color = colorOf(cfg, ch);
  const level = useLevel(ch);
  const set = (patch: Partial<OutputChannel['comp']>): void => {
    const cur = (mirror.config ?? cfg).outputs[ch - MODELS[cfg.model].inputs].comp;
    mirror.apply({ t: 'comp', ch, c: { ...cur, ...patch } });
  };
  const body = (
    <div className="dyn">
      <TransferGraph kind="comp" thrDb={thrRawToDb(k.threshold)} ratio={ratioValue(k.ratio)} kneeDb={k.knee} levelDb={level} color={color} label={t('Courbe du compresseur {0}', labelOf(cfg, ch))} />
      <div className="dyn-params">
        <ParamRow label={t('Seuil')} param={P.thr} value={k.threshold} onChange={(threshold) => set({ threshold })} disabled={disabled} color={color} />
        <div className="prow"><span className="prow-label">{t('Taux')}</span><Stepper value={k.ratio} param={P.ratio} onChange={(ratio) => set({ ratio })} disabled={disabled} label={t('Taux de compression')} /></div>
        <div className="prow"><span className="prow-label">{t('Genou')}</span><Stepper value={k.knee} param={P.knee} onChange={(knee) => set({ knee })} disabled={disabled} label={t('Genou')} /></div>
        <ParamRow label={t('Attaque')} param={P.attack} value={k.attack} onChange={(attack) => set({ attack })} disabled={disabled} color={color} />
        <ParamRow label={t('Relâchement')} param={P.release} value={k.release} onChange={(release) => set({ release })} disabled={disabled} color={color} />
      </div>
    </div>
  );
  if (compact) return body;
  return <Card title={t('Compresseur')} subtitle={t('Seuil +20 dB = compresseur inactif.')}>{body}</Card>;
}

export function LimiterEditor({ cfg, ch, mirror, disabled, compact, expert }: EdProps & { compact?: boolean; expert?: boolean }): React.JSX.Element {
  const c = (mirror.config ?? cfg).outputs[ch - MODELS[cfg.model].inputs] as OutputChannel;
  const l = c.limiter;
  const color = colorOf(cfg, ch);
  const level = useLevel(ch);
  const set = (patch: Partial<OutputChannel['limiter']>): void => {
    const cur = (mirror.config ?? cfg).outputs[ch - MODELS[cfg.model].inputs].limiter;
    mirror.apply({ t: 'limiter', ch, l: { ...cur, ...patch } });
  };
  const body = (
    <div className="dyn">
      <TransferGraph kind="limit" thrDb={thrRawToDb(l.threshold)} levelDb={level} color={color} label={t('Courbe du limiteur {0}', labelOf(cfg, ch))} />
      <div className="dyn-params">
        <ParamRow label={t('Seuil')} param={P.thr} value={l.threshold} onChange={(threshold) => set({ threshold })} disabled={disabled} color={color} />
        <ParamRow label={t('Attaque')} param={P.attack} value={l.attack} onChange={(attack) => set({ attack })} disabled={disabled} color={color} />
        <ParamRow label={t('Relâchement')} param={P.release} value={l.release} onChange={(release) => set({ release })} disabled={disabled} color={color} />
        {expert && <p className="small muted">{tx('Octet réservé du limiteur (non affiché par le logiciel Windows) : {0}', l.reserved)}</p>}
      </div>
    </div>
  );
  if (compact) return body;
  return <Card title={t('Limiteur')} subtitle={t('Protège les amplis et haut-parleurs : le niveau ne dépasse jamais le seuil.')}>{body}</Card>;
}

// ------------------------------------------------------------------------------ routing
export function RoutingEditor({ cfg, ch, mirror, disabled }: EdProps): React.JSX.Element {
  const m = MODELS[cfg.model];
  const o = cfg.outputs[ch - m.inputs];
  return (
    <Card title={t('Routage')} subtitle={t('Entrées mélangées sur cette sortie et leur niveau dans le mélange.')}>
      <div className="routing">
        {cfg.inputs.map((inp, i) => {
          const on = ((o.route >> i) & 1) === 1;
          return (
            <div key={i} className={`route-row ${on ? '' : 'is-off'}`}>
              <Toggle on={on} onChange={(v) => mirror.apply({ t: 'route', ch, mask: v ? o.route | (1 << i) : o.route & ~(1 << i) })} disabled={disabled} small>
                {m.inputLabels[i]}{inp.name && inp.name !== m.inputLabels[i] ? ` · ${inp.name}` : ''}
              </Toggle>
              <Slider value={o.mix[i]} min={P.mix.min} max={P.mix.max} def={P.mix.def} onChange={(raw) => mirror.apply({ t: 'mix', ch, input: i, raw })}
                disabled={disabled} label={t('Niveau de {0} dans {1}', m.inputLabels[i], labelOf(cfg, ch))} valueText={P.mix.fmt} color={colorOf(cfg, i)} />
              <ValueField value={o.mix[i]} param={P.mix} onChange={(raw) => mirror.apply({ t: 'mix', ch, input: i, raw })} disabled={disabled} label={t('Niveau de {0}', m.inputLabels[i])} />
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------------------ GEQ
export function GeqEditor({ cfg, ch, mirror, disabled }: EdProps): React.JSX.Element {
  const c = cfg.inputs[ch];
  const color = colorOf(cfg, ch);
  const freqs = useMemo(() => logFreqs(240), []);
  const r = responseOf(cfg, ch, freqs, { peq: false, xover: false, geq: true });
  const scroller = useRef<HTMLDivElement>(null);
  const [fine, setFine] = useState(false);
  return (
    <Card
      title={t('Égaliseur graphique 31 bandes · {0}', labelOf(cfg, ch))}
      actions={<>
        <Toggle small on={fine} onChange={setFine} title={t('Affiche les valeurs exactes sous les curseurs')}>{t('Valeurs')}</Toggle>
        <Toggle small tone="amber" on={c.geqBypass} onChange={(on) => mirror.apply({ t: 'geqBypass', ch, on })} disabled={disabled}>{t('Bypass GEQ')}</Toggle>
        <Button small icon="refresh" disabled={disabled} onClick={async () => {
          if (await confirmDialog({ title: t('Réinitialiser le GEQ'), message: t('Remettre les 31 bandes de {0} à 0 dB ?', labelOf(cfg, ch)), ok: t('Réinitialiser'), danger: true })) mirror.apply({ t: 'geqReset', ch });
        }}>{t('Réinitialiser')}</Button>
      </>}
    >
      <ResponseGraph freqs={freqs} curves={[{ id: 'geq', color, values: r.mag, width: 2.4, fill: true }]} mode="mag" range={[-15, 15]} height={170} label={t('Courbe du GEQ')} />
      <div className="geq" ref={scroller}>
        {c.geq.map((raw, k) => (
          <div key={k} className={`geq-band ${raw !== 120 ? 'is-active' : ''}`}>
            <span className="geq-val">{fine ? fmtSigned(eqGainRawToDb(raw), 1) : ''}</span>
            <Slider vertical value={raw} min={0} max={240} def={120} step={5} origin={120} onChange={(v) => mirror.apply({ t: 'geq', ch, band: k, raw: v })}
              disabled={disabled} label={`GEQ ${fmtIsoHz(GEQ_FREQS[k])}`} valueText={P.eqGain.fmt} color={color} ticks={[120]} className="geq-slider" />
            <span className="geq-f">{fmtIso(GEQ_FREQS[k])}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}
