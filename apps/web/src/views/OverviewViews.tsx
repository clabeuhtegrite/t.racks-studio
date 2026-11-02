// Pages that show one block for every channel, like the editor's GEQ, Gate, Comp, Limit, Delay and
// Matrix pages.

import { useState } from 'react';
import { delayRawToMs, MODELS, SPEED_OF_SOUND, delayMsToRaw, type DelayUnit, type DeviceConfig } from '@dsp-studio/protocol';
import { useApp, useCanEdit, useDevice } from '../state/store.ts';
import { go, useRoute } from '../state/route.ts';
import type { DeviceMirror } from '../client/mirror.ts';
import { Button, Card, Field, Segmented, Stepper, Tabs, TextInput, Toggle, ValueField } from '../ui/kit.tsx';
import { Slider } from '../ui/Slider.tsx';
import { delayParam, DELAY_UNIT_LABELS, fmtMs, fmtNumber, P, parseNumber } from '../ui/format.ts';
import { ChannelChips, chan, colorOf, labelOf, titleOf } from '../ui/channels.tsx';
import { CompEditor, GateEditor, GeqEditor, LimiterEditor } from '../editors/editors.tsx';
import { t, tx } from '../i18n.tsx';

// ------------------------------------------------------------------------------ GEQ
export function GeqView(): React.JSX.Element {
  const { mirror, config } = useDevice();
  const route = useRoute();
  const canEdit = useCanEdit();
  if (!mirror || !config) return <></>;
  const m = MODELS[config.model];
  const ch = Math.min(m.inputs - 1, Math.max(0, Number(route.arg) || 0));
  return (
    <div className="page">
      <div className="page-head"><h1>{t('Égaliseur graphique')}</h1><p className="muted small">{t('31 bandes au tiers d’octave, sur chaque entrée.')}</p></div>
      <ChannelChips cfg={config} value={ch} only="in" onChange={(x) => go('geq', x)} label={t('Entrée')} />
      <GeqEditor cfg={config} ch={ch} mirror={mirror} disabled={!canEdit} />
    </div>
  );
}

// ------------------------------------------------------------------------------ dynamics
type DynTab = 'gate' | 'comp' | 'limit';
export function DynamicsView(): React.JSX.Element {
  const { mirror, config } = useDevice();
  const route = useRoute();
  const canEdit = useCanEdit();
  const expert = useApp((s) => s.prefs.expert);
  if (!mirror || !config) return <></>;
  const m = MODELS[config.model];
  const tab: DynTab = route.arg === 'comp' || route.arg === 'limit' ? route.arg : 'gate';
  const raw = Number(route.sub);
  const ch = tab === 'gate'
    ? Math.min(m.inputs - 1, Math.max(0, Number.isFinite(raw) && route.sub !== '' ? raw : 0))
    : Math.min(m.inputs + m.outputs - 1, Math.max(m.inputs, Number.isFinite(raw) && route.sub !== '' ? raw : m.inputs));
  const p = { cfg: config, ch, mirror, disabled: !canEdit };
  return (
    <div className="page">
      <div className="page-head"><h1>{t('Dynamique')}</h1></div>
      <Tabs label={t('Bloc')} value={tab} onChange={(t) => go('dynamique', t)} tabs={[
        { id: 'gate', label: t('Noise gate (entrées)') }, { id: 'comp', label: t('Compresseur (sorties)') }, { id: 'limit', label: t('Limiteur (sorties)') },
      ]} />
      <ChannelChips cfg={config} value={ch} only={tab === 'gate' ? 'in' : 'out'} onChange={(x) => go('dynamique', tab, String(x))} />
      <Card title={`${tab === 'gate' ? t('Noise gate') : tab === 'comp' ? t('Compresseur') : t('Limiteur')} · ${titleOf(config, ch)}`}>
        {tab === 'gate' && <GateEditor {...p} compact />}
        {tab === 'comp' && <CompEditor {...p} compact />}
        {tab === 'limit' && <LimiterEditor {...p} compact expert={expert} />}
      </Card>
      <Card title={t('Tous les canaux')}>
        <DynTable cfg={config} tab={tab} mirror={mirror} disabled={!canEdit} selected={ch} />
      </Card>
    </div>
  );
}

function DynTable({ cfg, tab, mirror, disabled, selected }: { cfg: DeviceConfig; tab: DynTab; mirror: DeviceMirror; disabled: boolean; selected: number }): React.JSX.Element {
  const m = MODELS[cfg.model];
  if (tab === 'gate') {
    return (
      <div className="table-wrap"><table className="table">
        <thead><tr><th>{t('Entrée')}</th><th>{t('Seuil')}</th><th>{t('Attaque')}</th><th>{t('Maintien')}</th><th>{t('Relâchement')}</th></tr></thead>
        <tbody>{cfg.inputs.map((c, i) => {
          const set = (patch: Partial<typeof c.gate>): void => mirror.apply({ t: 'gate', ch: i, g: { ...(mirror.config ?? cfg).inputs[i].gate, ...patch } });
          return (
            <tr key={i} className={i === selected ? 'is-sel' : ''}>
              <td><button type="button" className="linklike" onClick={() => go('dynamique', 'gate', String(i))}>{titleOf(cfg, i)}</button></td>
              <td><ValueField value={c.gate.threshold} param={P.gateThr} onChange={(threshold) => set({ threshold })} disabled={disabled} label={t('Seuil')} /></td>
              <td><ValueField value={c.gate.attack} param={P.gateAttack} onChange={(attack) => set({ attack })} disabled={disabled} label={t('Attaque')} /></td>
              <td><ValueField value={c.gate.hold} param={P.hold} onChange={(hold) => set({ hold })} disabled={disabled} label={t('Maintien')} /></td>
              <td><ValueField value={c.gate.release} param={P.gateRelease} onChange={(release) => set({ release })} disabled={disabled} label={t('Relâchement')} /></td>
            </tr>
          );
        })}</tbody>
      </table></div>
    );
  }
  return (
    <div className="table-wrap"><table className="table">
      <thead><tr><th>{t('Sortie')}</th><th>{t('Seuil')}</th>{tab === 'comp' && <><th>{t('Taux')}</th><th>{t('Genou')}</th></>}<th>{t('Attaque')}</th><th>{t('Relâchement')}</th></tr></thead>
      <tbody>{cfg.outputs.map((c, j) => {
        const ch = m.inputs + j;
        if (tab === 'comp') {
          const set = (patch: Partial<typeof c.comp>): void => mirror.apply({ t: 'comp', ch, c: { ...(mirror.config ?? cfg).outputs[j].comp, ...patch } });
          return (
            <tr key={j} className={ch === selected ? 'is-sel' : ''}>
              <td><button type="button" className="linklike" onClick={() => go('dynamique', 'comp', String(ch))}>{titleOf(cfg, ch)}</button></td>
              <td><ValueField value={c.comp.threshold} param={P.thr} onChange={(threshold) => set({ threshold })} disabled={disabled} label={t('Seuil')} /></td>
              <td><Stepper value={c.comp.ratio} param={P.ratio} onChange={(ratio) => set({ ratio })} disabled={disabled} label={t('Taux')} /></td>
              <td><Stepper value={c.comp.knee} param={P.knee} onChange={(knee) => set({ knee })} disabled={disabled} label={t('Genou')} /></td>
              <td><ValueField value={c.comp.attack} param={P.attack} onChange={(attack) => set({ attack })} disabled={disabled} label={t('Attaque')} /></td>
              <td><ValueField value={c.comp.release} param={P.release} onChange={(release) => set({ release })} disabled={disabled} label={t('Relâchement')} /></td>
            </tr>
          );
        }
        const set = (patch: Partial<typeof c.limiter>): void => mirror.apply({ t: 'limiter', ch, l: { ...(mirror.config ?? cfg).outputs[j].limiter, ...patch } });
        return (
          <tr key={j} className={ch === selected ? 'is-sel' : ''}>
            <td><button type="button" className="linklike" onClick={() => go('dynamique', 'limit', String(ch))}>{titleOf(cfg, ch)}</button></td>
            <td><ValueField value={c.limiter.threshold} param={P.thr} onChange={(threshold) => set({ threshold })} disabled={disabled} label={t('Seuil')} /></td>
            <td><ValueField value={c.limiter.attack} param={P.attack} onChange={(attack) => set({ attack })} disabled={disabled} label={t('Attaque')} /></td>
            <td><ValueField value={c.limiter.release} param={P.release} onChange={(release) => set({ release })} disabled={disabled} label={t('Relâchement')} /></td>
          </tr>
        );
      })}</tbody>
    </table></div>
  );
}

// ------------------------------------------------------------------------------ delays
export function DelayView(): React.JSX.Element {
  const { mirror, config } = useDevice();
  const canEdit = useCanEdit();
  if (!mirror || !config) return <></>;
  const m = MODELS[config.model];
  const unit = config.delayUnit as DelayUnit;
  const dp = delayParam(unit);
  const all = Array.from({ length: m.inputs + m.outputs }, (_, i) => i);
  const maxDelay = Math.max(1, ...all.map((ch) => chan(config, ch).delay));
  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('Délais')}</h1>
        <Segmented label={t('Unité')} value={unit} disabled={!canEdit} onChange={(u) => mirror.apply({ t: 'delayUnit', unit: u })}
          options={DELAY_UNIT_LABELS.map((l, i) => ({ value: i as DelayUnit, label: l }))} />
      </div>
      <Card title={t('Délai de chaque canal')} subtitle={t('Jusqu’à 680 ms (environ 233 m) par canal, au 1/96 000 de seconde près.')}>
        <div className="delays">
          {all.map((ch) => {
            const c = chan(config, ch);
            return (
              <div key={ch} className="delay-row" style={{ ['--ch' as string]: colorOf(config, ch) }}>
                <button type="button" className="linklike delay-name" onClick={() => go('canal', ch)}>{titleOf(config, ch)}</button>
                <Slider value={c.delay} min={0} max={dp.max} def={0} step={dp.step} onChange={(raw) => mirror.apply({ t: 'delay', ch, raw })} disabled={!canEdit}
                  label={t('Délai {0}', labelOf(config, ch))} valueText={dp.fmt} color={colorOf(config, ch)} />
                <ValueField value={c.delay} param={dp} onChange={(raw) => mirror.apply({ t: 'delay', ch, raw })} disabled={!canEdit} label={t('Délai {0}', labelOf(config, ch))} wide />
                <div className="delay-bar" aria-hidden="true"><span style={{ width: `${(c.delay / maxDelay) * 100}%` }} /></div>
              </div>
            );
          })}
        </div>
      </Card>
      <AlignHelper cfg={config} mirror={mirror} disabled={!canEdit} />
    </div>
  );
}

/** Extra: time alignment from distances (speakers at different distances from the audience). */
function AlignHelper({ cfg, mirror, disabled }: { cfg: DeviceConfig; mirror: DeviceMirror; disabled: boolean }): React.JSX.Element {
  const m = MODELS[cfg.model];
  const [dist, setDist] = useState<string[]>(() => cfg.outputs.map(() => ''));
  const [temp, setTemp] = useState('20');
  const tc = parseNumber(temp) ?? 20;
  const c = 331.3 * Math.sqrt(1 + tc / 273.15);
  const ds = dist.map((d) => parseNumber(d));
  const far = Math.max(0, ...ds.filter((d): d is number => d !== null));
  const delays = ds.map((d) => (d === null ? null : ((far - d) / c) * 1000));
  return (
    <Card title={t('Alignement temporel par distances')} subtitle={t('Indiquez la distance entre chaque enceinte et le point d’écoute : les enceintes les plus proches sont retardées pour arriver en même temps que la plus éloignée.')}>
      <div className="align">
        {cfg.outputs.map((_, j) => (
          <Field key={j} label={titleOf(cfg, m.inputs + j)}>
            <TextInput value={dist[j]} onChange={(v) => setDist(dist.map((x, k) => (k === j ? v : x)))} placeholder={t('distance en m')} inputMode="decimal" label={t('Distance {0}', labelOf(cfg, m.inputs + j))} />
            <span className="small muted">{delays[j] === null ? ' ' : `→ ${fmtMs(delays[j]!, 2)}`}</span>
          </Field>
        ))}
        <Field label={t('Température (°C)')} hint={t('Vitesse du son : {0} m/s (l’appareil compte {1} m/s pour l’affichage en m / ft).', fmtNumber(c, 1), fmtNumber(SPEED_OF_SOUND, 1))}>
          <TextInput value={temp} onChange={setTemp} inputMode="decimal" label={t('Température')} />
        </Field>
      </div>
      <div className="row end">
        <Button kind="primary" icon="check" disabled={disabled || !delays.some((d) => d !== null)} onClick={() => {
          delays.forEach((d, j) => { if (d !== null) mirror.apply({ t: 'delay', ch: m.inputs + j, raw: delayMsToRaw(d) }); });
        }}>{t('Appliquer les délais aux sorties')}</Button>
      </div>
      <p className="small muted">{tx('Délais actuels : {0}', cfg.outputs.map((o, j) => `${labelOf(cfg, m.inputs + j)} ${fmtMs(delayRawToMs(o.delay), 2)}`).join(' · '))}</p>
    </Card>
  );
}

// ------------------------------------------------------------------------------ matrix
export function MatrixView(): React.JSX.Element {
  const { mirror, config } = useDevice();
  const canEdit = useCanEdit();
  const [levels, setLevels] = useState(true);
  if (!mirror || !config) return <></>;
  const m = MODELS[config.model];
  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('Matrice')}</h1>
        <Toggle small on={levels} onChange={setLevels}>{t('Niveaux de mélange')}</Toggle>
      </div>
      <Card title={t('Routage entrées → sorties')} subtitle={t('Allumez une case pour envoyer une entrée vers une sortie ; le niveau règle sa part dans le mélange (−60 à 0 dB).')}>
        <div className="table-wrap">
          <table className="table matrix">
            <thead>
              <tr><th>{t('Sortie')}</th>{config.inputs.map((_, i) => <th key={i} style={{ color: colorOf(config, i) }}>{titleOf(config, i)}</th>)}</tr>
            </thead>
            <tbody>
              {config.outputs.map((o, j) => {
                const ch = m.inputs + j;
                return (
                  <tr key={j}>
                    <th scope="row"><button type="button" className="linklike" style={{ color: colorOf(config, ch) }} onClick={() => go('canal', ch)}>{titleOf(config, ch)}</button></th>
                    {config.inputs.map((_, i) => {
                      const on = ((o.route >> i) & 1) === 1;
                      return (
                        <td key={i} className={`mx-cell ${on ? 'is-on' : ''}`}>
                          <button type="button" className="mx-btn" aria-pressed={on} disabled={!canEdit} title={`${labelOf(config, i)} → ${labelOf(config, ch)}`}
                            onClick={() => mirror.apply({ t: 'route', ch, mask: on ? o.route & ~(1 << i) : o.route | (1 << i) })}>
                            {on ? '●' : '○'}
                          </button>
                          {levels && <ValueField value={o.mix[i]} param={P.mix} onChange={(raw) => mirror.apply({ t: 'mix', ch, input: i, raw })} disabled={!canEdit || !on} label={t('Niveau {0} dans {1}', labelOf(config, i), labelOf(config, ch))} />}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
      <Card title={t('Schéma bloc')} subtitle={t('Blocs actifs de chaque canal ; touchez un canal pour l’ouvrir.')}>
        <BlockSummary cfg={config} />
      </Card>
    </div>
  );
}

function BlockSummary({ cfg }: { cfg: DeviceConfig }): React.JSX.Element {
  const m = MODELS[cfg.model];
  const pills = (ch: number): { l: string; on: boolean }[] => {
    const c = chan(cfg, ch);
    const peq = !c.peqBypass && c.peq.some((b) => !b.bypass && (b.gain !== 120 || b.type > 2));
    const x = c.hpf.slope > 0 || c.lpf.slope > 0;
    if ('gate' in c) {
      return [
        { l: 'GAIN', on: c.gain !== 280 }, { l: 'GATE', on: c.gate.threshold > 0 }, { l: 'GEQ', on: !c.geqBypass && c.geq.some((g) => g !== 120) },
        { l: 'PEQ', on: peq }, { l: 'HP/LP', on: x }, { l: 'DELAY', on: c.delay > 0 }, { l: t('Ø'), on: !!c.phase }, { l: 'MUTE', on: c.mute },
      ];
    }
    const o = c as DeviceConfig['outputs'][number];
    return [
      { l: 'XOVER', on: x }, { l: 'PEQ', on: peq }, { l: 'COMP', on: o.comp.threshold < 220 && o.comp.ratio > 0 }, { l: 'LIMIT', on: o.limiter.threshold < 220 },
      { l: 'DELAY', on: c.delay > 0 }, { l: t('Ø'), on: !!c.phase }, { l: 'GAIN', on: c.gain !== 280 }, { l: 'MUTE', on: c.mute },
    ];
  };
  const row = (ch: number): React.JSX.Element => (
    <button key={ch} type="button" className="blk-row" onClick={() => go('canal', ch)} style={{ ['--ch' as string]: colorOf(cfg, ch) }}>
      <span className="blk-name">{titleOf(cfg, ch)}</span>
      <span className="blk-pills">{pills(ch).map((p) => <span key={p.l} className={`pill ${p.on ? 'is-on' : ''} ${p.l === 'MUTE' && p.on ? 'is-mute' : ''}`}>{p.l}</span>)}</span>
    </button>
  );
  return (
    <div className="grid2">
      <div><h3 className="muted small">{t('Entrées')}</h3>{cfg.inputs.map((_, i) => row(i))}</div>
      <div><h3 className="muted small">{t('Sorties')}</h3>{cfg.outputs.map((_, j) => row(m.inputs + j))}</div>
    </div>
  );
}
