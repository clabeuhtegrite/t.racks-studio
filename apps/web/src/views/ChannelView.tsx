// One channel with all its blocks (the editor's InA .. Out8 pages, plus its gate / compressor /
// limiter / routing): block diagram on top, then every editor. On a computer the whole channel fits
// the screen: the parametric EQ on the left, level and delay across the top of the rest, then the
// filters with the routing (or the gate) and the dynamics (or the graphic EQ).

import { MODELS, type DeviceConfig } from '@dsp-studio/protocol';
import { confirmDialog, promptDialog, useApp, useCanEdit, useCanOperate, useDevice } from '../state/store.ts';
import { go, useRoute } from '../state/route.ts';
import { Button, Card, Select } from '../ui/kit.tsx';
import { Icon } from '../ui/icons.tsx';
import { channelBlocks, ChannelChips, chan, colorOf, labelOf, linkMates, titleOf } from '../ui/channels.tsx';
import { PeqEditor } from '../editors/PeqEditor.tsx';
import { CompEditor, GateEditor, GeqEditor, LevelEditor, LimiterEditor, RoutingEditor, XoverEditor } from '../editors/editors.tsx';
import { t, tx } from '../i18n.tsx';

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
    const v = await promptDialog({ title: t('Nom de {0}', labelOf(config, ch)), label: t('Nom (8 caractères)'), value: c.name, maxLength: 8, ok: t('Renommer') });
    if (v !== null) mirror.apply({ t: 'name', ch, name: v });
  };
  return (
    <div className={`page dense ch-page ${mates.length > 0 ? 'is-linked' : ''}`} style={{ ['--ch' as string]: colorOf(config, ch) }}>
      <ChannelChips cfg={config} value={ch} onChange={(x) => go('canal', x)} />
      <div className="page-head">
        <div>
          <h1 className="ch-title"><span className="ch-dot" />{titleOf(config, ch)}</h1>
          {mates.length > 0 && (
            <p className="muted small"><Icon name="link" size={14} />{' '}{tx('Lié à {0} : chaque réglage s’applique à tout le groupe.', mates.map((x) => labelOf(config, x)).join(', '))}</p>
          )}
        </div>
        <div className="row">
          <Button small icon="chevronLeft" title={t('Canal précédent')} disabled={ch === 0} onClick={() => go('canal', ch - 1)} />
          <Button small icon="chevronRight" title={t('Canal suivant')} disabled={ch === n - 1} onClick={() => go('canal', ch + 1)} />
          <Button small icon="edit" className="btn-rename" title={t('Renommer')} disabled={disabled} onClick={rename}>{t('Renommer')}</Button>
          <CopyTo cfg={config} ch={ch} disabled={disabled} onCopy={(dst) => mirror.apply({ t: 'copy', src: ch, dst })} />
        </div>
      </div>
      <BlockDiagram cfg={config} ch={ch} />
      {/* the columns (ch-col) only group the cards on a computer; elsewhere the cards flow in one grid */}
      <div className={`cards ch-grid ${input ? 'ch-in' : 'ch-out'}`}>
        <div id="blk-peq" className="span2 ch-peq"><PeqEditor {...p} /></div>
        <div id="blk-level" className="ch-level"><LevelEditor {...p} canOperate={canOperate} /></div>
        <div className="ch-col ch-a">
          <div id="blk-xover"><XoverEditor {...p} /></div>
          {!input && <div id="blk-route"><RoutingEditor {...p} /></div>}
        </div>
        <div className="ch-col ch-b">
          {input && <div id="blk-gate"><GateEditor {...p} /></div>}
          {!input && <div id="blk-comp"><CompEditor {...p} /></div>}
          {!input && <div id="blk-limit"><LimiterEditor {...p} expert={expert} /></div>}
        </div>
        {input && <div id="blk-geq" className="span2 ch-geq"><GeqEditor {...p} /></div>}
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
      label={t('Copier ce canal vers')} value={-1} disabled={p.disabled} className="select-sm"
      options={[{ value: -1, label: t('Copier vers…') }, ...targets.map((t) => ({ value: t, label: labelOf(p.cfg, t) }))]}
      onChange={async (dst) => {
        if (dst < 0) return;
        if (await confirmDialog({
          title: t('Copier un canal'),
          message: input
            ? t('Copier tous les réglages de {0} vers {1} ?\n(égaliseurs, filtres, dynamique, volume, délai, polarité ; le nom et les liaisons de {1} sont conservés, comme sur l’appareil)', labelOf(p.cfg, p.ch), labelOf(p.cfg, dst))
            : t('Copier tous les réglages de {0} vers {1} ?\n(égaliseurs, filtres, dynamique, volume, délai, polarité ; le nom, le routage et les liaisons de {1} sont conservés, comme sur l’appareil)', labelOf(p.cfg, p.ch), labelOf(p.cfg, dst)),
          ok: t('Copier'),
        })) p.onCopy(dst);
      }}
    />
  );
}

/** Signal flow of the channel; lit blocks are active, a click jumps to the block. */
function BlockDiagram({ cfg, ch }: { cfg: DeviceConfig; ch: number }): React.JSX.Element {
  const input = ch < MODELS[cfg.model].inputs;
  const blocks = channelBlocks(cfg, ch);
  return (
    <Card className="card-flow">
      <div className="flow" aria-label={t('Chaîne du signal de {0}', labelOf(cfg, ch))}>
        <span className="flow-end">{input ? t('Entrée') : t('Mélange')}</span>
        {blocks.map((b) => (
          <button key={b.key} type="button" className={`flow-blk ${b.on ? 'is-on' : ''} ${b.mute && b.on ? 'is-mute' : ''}`} title={b.title}
            onClick={() => showBlock(b.id)}>
            {b.label}{b.on && b.info ? <small>{b.info}</small> : null}
          </button>
        ))}
        <span className="flow-end">{input ? t('Matrice') : t('Sortie')}</span>
        <span className="flow-legend"><i />{t('allumé = actif')}</span>
      </div>
    </Card>
  );
}

/** Brings a block's editor into view and makes it blink once (on a computer it is already on screen). */
function showBlock(id: string): void {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  el.classList.remove('is-flash');
  void el.offsetWidth; // restart the animation
  el.classList.add('is-flash');
  window.setTimeout(() => el.classList.remove('is-flash'), 1000);
}
