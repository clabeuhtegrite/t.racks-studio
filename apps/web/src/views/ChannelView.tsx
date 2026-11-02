// One channel with all its blocks (the editor's InA .. Out8 pages, plus its gate / compressor /
// limiter / routing): block diagram on top, then every editor.

import { MODELS, thrRawToDb, type DeviceConfig } from '@dsp-studio/protocol';
import { confirmDialog, promptDialog, useApp, useCanEdit, useCanOperate, useDevice } from '../state/store.ts';
import { go, useRoute } from '../state/route.ts';
import { Button, Card, Select } from '../ui/kit.tsx';
import { Icon } from '../ui/icons.tsx';
import { ChannelChips, chan, colorOf, labelOf, linkMates, titleOf } from '../ui/channels.tsx';
import { PeqEditor } from '../editors/PeqEditor.tsx';
import { CompEditor, GateEditor, GeqEditor, LevelEditor, LimiterEditor, RoutingEditor, XoverEditor } from '../editors/editors.tsx';
import { P } from '../ui/format.ts';

export function ChannelView(): React.JSX.Element {
  const { mirror, config } = useDevice();
  const route = useRoute();
  const canEdit = useCanEdit();
  const canOperate = useCanOperate();
  const expert = useApp((s) => s.prefs.expert);
  if (!mirror || !config) return <></>;
  const m = MODELS[config.model];
  const n = m.inputs + m.outputs;
  const ch = Math.min(n - 1, Math.max(0, Number(route.arg) || 0));
  const c = chan(config, ch);
  const input = ch < m.inputs;
  const mates = linkMates(config, ch);
  const disabled = !canEdit;
  const p = { cfg: config, ch, mirror, disabled };
  const rename = async (): Promise<void> => {
    const v = await promptDialog({ title: `Nom de ${labelOf(config, ch)}`, label: 'Nom (8 caractères)', value: c.name, maxLength: 8, ok: 'Renommer' });
    if (v !== null) mirror.apply({ t: 'name', ch, name: v });
  };
  return (
    <div className="page" style={{ ['--ch' as string]: colorOf(config, ch) }}>
      <ChannelChips cfg={config} value={ch} onChange={(x) => go('canal', x)} />
      <div className="page-head">
        <div>
          <h1 className="ch-title"><span className="ch-dot" />{titleOf(config, ch)}</h1>
          {mates.length > 0 && (
            <p className="muted small"><Icon name="link" size={14} /> Lié à {mates.map((x) => labelOf(config, x)).join(', ')} : chaque réglage s’applique à tout le groupe.</p>
          )}
        </div>
        <div className="row">
          <Button small icon="chevronLeft" title="Canal précédent" disabled={ch === 0} onClick={() => go('canal', ch - 1)} />
          <Button small icon="chevronRight" title="Canal suivant" disabled={ch === n - 1} onClick={() => go('canal', ch + 1)} />
          <Button small icon="edit" disabled={disabled} onClick={rename}>Renommer</Button>
          <CopyTo cfg={config} ch={ch} disabled={disabled} onCopy={(dst) => mirror.apply({ t: 'copy', src: ch, dst })} />
        </div>
      </div>
      <BlockDiagram cfg={config} ch={ch} />
      <div className="cards">
        <div id="blk-peq" className="span2"><PeqEditor {...p} /></div>
        <div id="blk-xover"><XoverEditor {...p} /></div>
        <div id="blk-level"><LevelEditor {...p} canOperate={canOperate} /></div>
        {input && <div id="blk-gate"><GateEditor {...p} /></div>}
        {input && <div id="blk-geq" className="span2"><GeqEditor {...p} /></div>}
        {!input && <div id="blk-route"><RoutingEditor {...p} /></div>}
        {!input && <div id="blk-comp"><CompEditor {...p} /></div>}
        {!input && <div id="blk-limit"><LimiterEditor {...p} expert={expert} /></div>}
      </div>
    </div>
  );
}

function CopyTo(p: { cfg: DeviceConfig; ch: number; disabled: boolean; onCopy: (dst: number) => void }): React.JSX.Element {
  const m = MODELS[p.cfg.model];
  const input = p.ch < m.inputs;
  const targets = Array.from({ length: input ? m.inputs : m.outputs }, (_, k) => (input ? k : m.inputs + k)).filter((x) => x !== p.ch);
  return (
    <Select
      label="Copier ce canal vers" value={-1} disabled={p.disabled} className="select-sm"
      options={[{ value: -1, label: 'Copier vers…' }, ...targets.map((t) => ({ value: t, label: labelOf(p.cfg, t) }))]}
      onChange={async (dst) => {
        if (dst < 0) return;
        if (await confirmDialog({
          title: 'Copier un canal',
          message: `Copier tous les réglages de ${labelOf(p.cfg, p.ch)} vers ${labelOf(p.cfg, dst)} ?\n(égaliseurs, filtres, dynamique, volume, délai, polarité ; le nom${input ? '' : ', le routage'} et les liaisons de ${labelOf(p.cfg, dst)} sont conservés, comme sur l’appareil)`,
          ok: 'Copier',
        })) p.onCopy(dst);
      }}
    />
  );
}

/** Signal flow of the channel; lit blocks are active, a click jumps to the block. */
function BlockDiagram({ cfg, ch }: { cfg: DeviceConfig; ch: number }): React.JSX.Element {
  const m = MODELS[cfg.model];
  const c = chan(cfg, ch);
  const input = ch < m.inputs;
  const peqOn = !c.peqBypass && c.peq.some((b) => !b.bypass && (b.gain !== 120 || b.type > 2));
  const xOn = c.hpf.slope > 0 || c.lpf.slope > 0;
  const blocks: { id: string; label: string; on: boolean; info?: string }[] = input
    ? [
      { id: 'blk-level', label: 'Gain', on: c.gain !== 280, info: c.gain !== 280 ? P.gain.fmt(c.gain) : '' },
      { id: 'blk-gate', label: 'Gate', on: 'gate' in c && c.gate.threshold > 0, info: 'gate' in c && c.gate.threshold > 0 ? `${thrRawToDb(c.gate.threshold)} dB` : '' },
      { id: 'blk-geq', label: 'GEQ', on: 'geq' in c && !c.geqBypass && c.geq.some((g) => g !== 120) },
      { id: 'blk-peq', label: 'PEQ', on: peqOn },
      { id: 'blk-xover', label: 'HP / LP', on: xOn },
      { id: 'blk-level', label: 'Délai', on: c.delay > 0 },
      { id: 'blk-level', label: c.phase ? 'Ø inversé' : 'Ø', on: !!c.phase },
      { id: 'blk-level', label: 'Mute', on: c.mute },
    ]
    : [
      { id: 'blk-route', label: 'Matrice', on: true, info: 'route' in c ? cfg.inputs.map((_, i) => ((c.route >> i) & 1 ? m.inputLabels[i].slice(2) : '')).join('') : '' },
      { id: 'blk-xover', label: 'HP / LP', on: xOn },
      { id: 'blk-peq', label: 'PEQ', on: peqOn },
      { id: 'blk-comp', label: 'Comp', on: 'comp' in c && c.comp.threshold < 220 && c.comp.ratio > 0 },
      { id: 'blk-limit', label: 'Limiteur', on: 'limiter' in c && c.limiter.threshold < 220 },
      { id: 'blk-level', label: 'Délai', on: c.delay > 0 },
      { id: 'blk-level', label: c.phase ? 'Ø inversé' : 'Ø', on: !!c.phase },
      { id: 'blk-level', label: 'Gain', on: c.gain !== 280, info: c.gain !== 280 ? P.gain.fmt(c.gain) : '' },
      { id: 'blk-level', label: 'Mute', on: c.mute },
    ];
  return (
    <Card className="card-flow">
      <div className="flow" aria-label="Schéma du canal">
        <span className="flow-end">{input ? 'Entrée' : 'Mélange'}</span>
        {blocks.map((b, i) => (
          <button key={i} type="button" className={`flow-blk ${b.on ? 'is-on' : ''} ${b.label === 'Mute' && b.on ? 'is-mute' : ''}`}
            onClick={() => document.getElementById(b.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
            {b.label}{b.info ? <small>{b.info}</small> : null}
          </button>
        ))}
        <span className="flow-end">{input ? 'Matrice' : 'Sortie'}</span>
      </div>
    </Card>
  );
}
