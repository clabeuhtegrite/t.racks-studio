// Console: every channel on one screen (the editor's "Gain" page): level faders, mute, polarity,
// meters with clip / limiter LEDs, plus the response curves of the channels you pick.

import { memo, useMemo, useState } from 'react';
import { MODELS, logFreqs, type AnyChannel, type DeviceConfig } from '@dsp-studio/protocol';
import { promptDialog, useCanEdit, useCanOperate, useDevice, useMeters } from '../state/store.ts';
import { go } from '../state/route.ts';
import type { DeviceMirror } from '../client/mirror.ts';
import { Slider } from '../ui/Slider.tsx';
import { Button, Card, Toggle, ValueField } from '../ui/kit.tsx';
import { Meter } from '../ui/Meter.tsx';
import { Icon } from '../ui/icons.tsx';
import { P } from '../ui/format.ts';
import { allChannels, chan, colorOf, labelOf, linkMates, responseOf } from '../ui/channels.tsx';
import { ResponseGraph, type GraphCurve } from '../ui/ResponseGraph.tsx';

const GAIN_TICKS = [0, 40, 80, 160, 220, 280, 340, 400];

export function ConsoleView(): React.JSX.Element {
  const { mirror, config } = useDevice();
  const canEdit = useCanEdit();
  const canOperate = useCanOperate();
  const [curves, setCurves] = useState(false);
  if (!mirror || !config) return <></>;
  const m = MODELS[config.model];
  const outs = allChannels(config).filter((ch) => ch >= m.inputs);
  const allOutMuted = outs.every((ch) => chan(config, ch).mute);
  return (
    <div className="page page-wide">
      <div className="page-head">
        <h1>Console</h1>
        <div className="row">
          <Toggle on={curves} onChange={setCurves} icon="eq" small>Courbes</Toggle>
          <Button small icon={allOutMuted ? 'speaker' : 'mute'} kind={allOutMuted ? 'plain' : 'danger'} disabled={!canOperate}
            title="Coupe ou rétablit toutes les sorties d’un coup"
            onClick={() => outs.forEach((ch) => { if (chan(config, ch).mute === allOutMuted) mirror.apply({ t: 'mute', ch, on: !allOutMuted }); })}>
            {allOutMuted ? 'Rétablir les sorties' : 'Couper les sorties'}
          </Button>
        </div>
      </div>
      {curves && <OverlayCurves config={config} />}
      <div className="console">
        <div className="strip-group">
          <h2 className="strip-group-title">Entrées</h2>
          <div className="strips">
            {config.inputs.map((c, i) => <Strip key={i} ch={i} c={c} {...stripInfo(config, i)} mirror={mirror} canEdit={canEdit} canOperate={canOperate} />)}
          </div>
        </div>
        <div className="strip-group">
          <h2 className="strip-group-title">Sorties</h2>
          <div className="strips">
            {config.outputs.map((c, j) => <Strip key={j} ch={m.inputs + j} c={c} {...stripInfo(config, m.inputs + j)} mirror={mirror} canEdit={canEdit} canOperate={canOperate} />)}
          </div>
        </div>
      </div>
    </div>
  );
}

function OverlayCurves({ config }: { config: DeviceConfig }): React.JSX.Element {
  const freqs = useMemo(() => logFreqs(200), []);
  const [shown, setShown] = useState<number[]>(() => allChannels(config).filter((ch) => ch >= MODELS[config.model].inputs));
  const [mode, setMode] = useState<'mag' | 'phase'>('mag');
  const curves: GraphCurve[] = shown.map((ch) => {
    const r = responseOf(config, ch, freqs);
    return { id: String(ch), color: colorOf(config, ch), values: mode === 'mag' ? r.mag : r.phase, width: 2 };
  });
  return (
    <Card title="Réponse des canaux" actions={
      <div className="seg seg-sm" role="radiogroup" aria-label="Affichage">
        <button type="button" className={mode === 'mag' ? 'is-on' : ''} onClick={() => setMode('mag')}>Amplitude</button>
        <button type="button" className={mode === 'phase' ? 'is-on' : ''} onClick={() => setMode('phase')}>Phase</button>
      </div>
    }>
      <ResponseGraph freqs={freqs} curves={curves} mode={mode} height={230} label="Courbes de réponse des canaux affichés" />
      <div className="chips chips-small">
        {allChannels(config).map((ch) => (
          <button key={ch} type="button" aria-pressed={shown.includes(ch)} className={`chip ${shown.includes(ch) ? 'is-on' : ''}`} style={{ ['--ch' as string]: colorOf(config, ch) }}
            onClick={() => setShown(shown.includes(ch) ? shown.filter((x) => x !== ch) : [...shown, ch])}>
            <span className="chip-id">{labelOf(config, ch)}</span>
          </button>
        ))}
      </div>
    </Card>
  );
}

function stripInfo(cfg: DeviceConfig, ch: number): { label: string; color: string; linked: boolean; route: string | null; nin: number } {
  const m = MODELS[cfg.model];
  const c = chan(cfg, ch);
  const route = 'route' in c ? cfg.inputs.map((_, i) => ((c.route >> i) & 1 ? m.inputLabels[i].slice(2) : '')).filter(Boolean).join('+') : null;
  return { label: labelOf(cfg, ch), color: colorOf(cfg, ch), linked: linkMates(cfg, ch).length > 0, route, nin: m.inputs };
}

const Strip = memo(function Strip(p: {
  ch: number; c: AnyChannel; label: string; color: string; linked: boolean; route: string | null; nin: number;
  mirror: DeviceMirror; canEdit: boolean; canOperate: boolean;
}): React.JSX.Element {
  const { ch, c, mirror, label, color } = p;
  const input = p.route === null;
  const rename = async (): Promise<void> => {
    const v = await promptDialog({ title: `Nom de ${label}`, label: 'Nom (8 caractères)', value: c.name, maxLength: 8, ok: 'Renommer' });
    if (v !== null) mirror.apply({ t: 'name', ch, name: v });
  };
  return (
    <div className={`strip ${c.mute ? 'is-muted' : ''}`} style={{ ['--ch' as string]: color }}>
      <button type="button" className="strip-head" onClick={() => go('canal', ch)} title="Ouvrir le canal">
        <span className="strip-id">{label}{p.linked && <Icon name="link" size={12} />}</span>
        <span className="strip-name">{c.name && c.name !== label ? c.name : ' '}</span>
      </button>
      {p.canEdit ? <button type="button" className="strip-rename" onClick={rename} title="Renommer"><Icon name="edit" size={14} /></button> : null}
      <div className="strip-body">
        <StripMeter ch={ch} output={!input} nin={p.nin} />
        <Slider
          vertical value={c.gain} min={P.gain.min} max={P.gain.max} def={P.gain.def} onChange={(raw) => mirror.apply({ t: 'gain', ch, raw })}
          disabled={!p.canOperate} label={`Volume ${label}`} valueText={P.gain.fmt} color={color} ticks={GAIN_TICKS} className="fader"
        />
      </div>
      <ValueField value={c.gain} param={P.gain} onChange={(raw) => mirror.apply({ t: 'gain', ch, raw })} disabled={!p.canOperate} label={`Volume ${label}`} />
      <div className="strip-btns">
        <Toggle on={c.mute} onChange={(on) => mirror.apply({ t: 'mute', ch, on })} tone="red" disabled={!p.canOperate} small title="Mute">Mute</Toggle>
        <Toggle on={!!c.phase} onChange={(inv) => mirror.apply({ t: 'phase', ch, inv })} tone="amber" disabled={!p.canEdit} small title={c.phase ? 'Polarité inversée' : 'Polarité normale'}>Ø</Toggle>
      </div>
      {!input && <div className="strip-route" title="Entrées envoyées sur cette sortie">{p.route ? `← ${p.route}` : 'aucune entrée'}</div>}
    </div>
  );
});

function StripMeter({ ch, output, nin }: { ch: number; output: boolean; nin: number }): React.JSX.Element {
  const meters = useMeters();
  const db = meters?.db[ch];
  const limit = output ? !!(meters && (meters.status >> (ch - nin)) & 1) : undefined;
  return <Meter db={db} limit={limit} label={`Niveau ${ch}`} />;
}
