// Printable settings sheet: every setting of the current preset on paper (or PDF), channel by channel,
// with its frequency response. Handy for a technical rider or to keep with the rack.

import { useMemo } from 'react';
import { GEQ_FREQS, logFreqs, MODELS, type DeviceConfig, type InputChannel, type OutputChannel } from '@dsp-studio/protocol';
import { useDevice } from '../state/store.ts';
import { Button } from '../ui/kit.tsx';
import { ResponseGraph } from '../ui/ResponseGraph.tsx';
import { allChannels, chan, colorOf, labelOf, linkMates, responseOf, titleOf } from '../ui/channels.tsx';
import { delayParam, fmtIso, P, presetLabel } from '../ui/format.ts';
import { SLOPE_OPTIONS } from '../editors/editors.tsx';
import { PEQ_TYPE_LABELS } from '../editors/PeqEditor.tsx';
import { t, tx } from '../i18n.tsx';

const slopeText = (s: number): string => (s === 0 ? t('contourné') : SLOPE_OPTIONS.find((o) => o.value === s)?.label ?? String(s));

export function SheetView(): React.JSX.Element {
  const { mirror, config, snap } = useDevice();
  const freqs = useMemo(() => logFreqs(160), []);
  if (!mirror || !config || !snap) return <></>;
  const m = MODELS[config.model];
  return (
    <div className="page fiche-page">
      <div className="page-head no-print">
        <div>
          <h1>{t('Fiche des réglages')}</h1>
          <p className="muted small">{t('Imprimez-la ou enregistrez-la en PDF depuis la fenêtre d’impression.')}</p>
        </div>
        <Button kind="primary" icon="print" onClick={() => window.print()}>{t('Imprimer')}</Button>
      </div>
      <header className="fiche-head">
        <h1>{m.name} · {presetLabel(snap.activePreset)} « {config.presetName || t('Sans nom')} »</h1>
        <p>{tx('{0} · firmware {1} · ID {2} · {3}', mirror.info?.label ?? '', snap.version || '?', snap.deviceId, new Date().toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' }))}</p>
        <p>{tx('Unité des délais : {0}{1}', ['millisecondes', t('mètres'), 'pieds'][config.delayUnit] ?? 'ms', config.toneSource ? t(' · générateur de test actif') : '')}</p>
      </header>
      <div className="fiche-grid">
        {allChannels(config).map((ch) => <SheetChannel key={ch} cfg={config} ch={ch} freqs={freqs} />)}
      </div>
    </div>
  );
}

function SheetChannel({ cfg, ch, freqs }: { cfg: DeviceConfig; ch: number; freqs: number[] }): React.JSX.Element {
  const m = MODELS[cfg.model];
  const c = chan(cfg, ch);
  const input = ch < m.inputs;
  const r = responseOf(cfg, ch, freqs);
  const mates = linkMates(cfg, ch);
  const dp = delayParam(cfg.delayUnit as 0 | 1 | 2);
  const bands = c.peq.map((b, i) => ({ b, i })).filter(({ b }) => !b.bypass && (b.gain !== 120 || b.type > 2));
  const rows: [string, string][] = [
    [t('Volume'), `${P.gain.fmt(c.gain)}${c.mute ? t(' · COUPÉ') : ''}`],
    [t('Polarité'), c.phase ? t('inversée') : 'normale'],
    [t('Délai'), dp.fmt(c.delay)],
    [t('Passe-haut'), `${P.freq.fmt(c.hpf.freq)} · ${slopeText(c.hpf.slope)}`],
    [t('Passe-bas'), `${P.freq.fmt(c.lpf.freq)} · ${slopeText(c.lpf.slope)}`],
  ];
  if (input) {
    const g = (c as InputChannel).gate;
    rows.push([t('Gate'), g.threshold === 0 ? 'ouvert' : t('{0} · att. {1} · maintien {2} · rel. {3}', P.gateThr.fmt(g.threshold), P.gateAttack.fmt(g.attack), P.hold.fmt(g.hold), P.gateRelease.fmt(g.release))]);
  } else {
    const o = c as OutputChannel;
    const src = cfg.inputs.map((_, i) => i).filter((i) => (o.route >> i) & 1);
    rows.unshift([t('Sources'), src.length ? src.map((i) => `${m.inputLabels[i]}${o.mix[i] !== 280 ? ` (${P.mix.fmt(o.mix[i])})` : ''}`).join(' + ') : 'aucune']);
    rows.push([t('Compresseur'), o.comp.threshold >= 220 || o.comp.ratio === 0 ? 'inactif' : t('{0} · {1} · genou {2} · att. {3} · rel. {4}', P.thr.fmt(o.comp.threshold), P.ratio.fmt(o.comp.ratio), P.knee.fmt(o.comp.knee), P.attack.fmt(o.comp.attack), P.release.fmt(o.comp.release))]);
    rows.push([t('Limiteur'), o.limiter.threshold >= 220 ? 'inactif' : t('{0} · att. {1} · rel. {2}', P.thr.fmt(o.limiter.threshold), P.attack.fmt(o.limiter.attack), P.release.fmt(o.limiter.release))]);
  }
  if (mates.length) rows.push([t('Lié à'), mates.map((x) => labelOf(cfg, x)).join(', ')]);
  const geq = input ? (c as InputChannel).geq.map((v, i) => ({ v, i })).filter(({ v }) => v !== 120) : [];
  return (
    <section className="fiche-ch" style={{ ['--ch' as string]: colorOf(cfg, ch) }}>
      <h2><span className="ch-dot" />{titleOf(cfg, ch)}</h2>
      <ResponseGraph freqs={freqs} curves={[{ id: 'r', color: colorOf(cfg, ch), values: r.mag, width: 2, fill: true }]} mode="mag" range={[-24, 18]} height={110} showLabels={false} label={t('Réponse de {0}', labelOf(cfg, ch))} />
      <dl className="kv kv-tight">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
      <p className="small"><strong>{t('Égaliseur paramétrique')}</strong>{c.peqBypass ? t(' (contourné)') : ''} : {bands.length ? '' : t('à plat')}</p>
      {bands.length > 0 && (
        <table className="table table-tight">
          <thead><tr><th>#</th><th>{t('Type')}</th><th>{t('Fréq.')}</th><th>{t('Gain')}</th><th>Q</th></tr></thead>
          <tbody>{bands.map(({ b, i }) => (
            <tr key={i}><td>{i + 1}</td><td>{PEQ_TYPE_LABELS[b.type]}</td><td>{P.freq.fmt(b.freq)}</td><td>{b.type <= 2 ? P.eqGain.fmt(b.gain) : '—'}</td><td>{P.q.fmt(b.q)}</td></tr>
          ))}</tbody>
        </table>
      )}
      {input && (
        <p className="small"><strong>{t('EQ graphique')}</strong>{(c as InputChannel).geqBypass ? t(' (contourné)') : ''} : {geq.length ? geq.map(({ v, i }) => `${fmtIso(GEQ_FREQS[i])} ${P.eqGain.fmt(v)}`).join(' · ') : t('à plat')}</p>
      )}
    </section>
  );
}
