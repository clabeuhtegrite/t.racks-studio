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

const slopeText = (s: number): string => (s === 0 ? 'contourné' : SLOPE_OPTIONS.find((o) => o.value === s)?.label ?? String(s));

export function SheetView(): React.JSX.Element {
  const { mirror, config, snap } = useDevice();
  const freqs = useMemo(() => logFreqs(160), []);
  if (!mirror || !config || !snap) return <></>;
  const m = MODELS[config.model];
  return (
    <div className="page fiche-page">
      <div className="page-head no-print">
        <div>
          <h1>Fiche des réglages</h1>
          <p className="muted small">Imprimez-la ou enregistrez-la en PDF depuis la fenêtre d’impression.</p>
        </div>
        <Button kind="primary" icon="print" onClick={() => window.print()}>Imprimer</Button>
      </div>
      <header className="fiche-head">
        <h1>{m.name} · {presetLabel(snap.activePreset)} « {config.presetName || 'Sans nom'} »</h1>
        <p>{mirror.info?.label ?? ''} · firmware {snap.version || '?'} · ID {snap.deviceId} · {new Date().toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' })}</p>
        <p>Unité des délais : {['millisecondes', 'mètres', 'pieds'][config.delayUnit] ?? 'ms'}{config.toneSource ? ' · générateur de test actif' : ''}</p>
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
    ['Volume', `${P.gain.fmt(c.gain)}${c.mute ? ' · COUPÉ' : ''}`],
    ['Polarité', c.phase ? 'inversée' : 'normale'],
    ['Délai', dp.fmt(c.delay)],
    ['Passe-haut', `${P.freq.fmt(c.hpf.freq)} · ${slopeText(c.hpf.slope)}`],
    ['Passe-bas', `${P.freq.fmt(c.lpf.freq)} · ${slopeText(c.lpf.slope)}`],
  ];
  if (input) {
    const g = (c as InputChannel).gate;
    rows.push(['Gate', g.threshold === 0 ? 'ouvert' : `${P.gateThr.fmt(g.threshold)} · att. ${P.gateAttack.fmt(g.attack)} · maintien ${P.hold.fmt(g.hold)} · rel. ${P.gateRelease.fmt(g.release)}`]);
  } else {
    const o = c as OutputChannel;
    const src = cfg.inputs.map((_, i) => i).filter((i) => (o.route >> i) & 1);
    rows.unshift(['Sources', src.length ? src.map((i) => `${m.inputLabels[i]}${o.mix[i] !== 280 ? ` (${P.mix.fmt(o.mix[i])})` : ''}`).join(' + ') : 'aucune']);
    rows.push(['Compresseur', o.comp.threshold >= 220 || o.comp.ratio === 0 ? 'inactif' : `${P.thr.fmt(o.comp.threshold)} · ${P.ratio.fmt(o.comp.ratio)} · genou ${P.knee.fmt(o.comp.knee)} · att. ${P.attack.fmt(o.comp.attack)} · rel. ${P.release.fmt(o.comp.release)}`]);
    rows.push(['Limiteur', o.limiter.threshold >= 220 ? 'inactif' : `${P.thr.fmt(o.limiter.threshold)} · att. ${P.attack.fmt(o.limiter.attack)} · rel. ${P.release.fmt(o.limiter.release)}`]);
  }
  if (mates.length) rows.push(['Lié à', mates.map((x) => labelOf(cfg, x)).join(', ')]);
  const geq = input ? (c as InputChannel).geq.map((v, i) => ({ v, i })).filter(({ v }) => v !== 120) : [];
  return (
    <section className="fiche-ch" style={{ ['--ch' as string]: colorOf(cfg, ch) }}>
      <h2><span className="ch-dot" />{titleOf(cfg, ch)}</h2>
      <ResponseGraph freqs={freqs} curves={[{ id: 'r', color: colorOf(cfg, ch), values: r.mag, width: 2, fill: true }]} mode="mag" range={[-24, 18]} height={110} showLabels={false} label={`Réponse de ${labelOf(cfg, ch)}`} />
      <dl className="kv kv-tight">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
      <p className="small"><strong>Égaliseur paramétrique</strong>{c.peqBypass ? ' (contourné)' : ''} : {bands.length ? '' : 'à plat'}</p>
      {bands.length > 0 && (
        <table className="table table-tight">
          <thead><tr><th>#</th><th>Type</th><th>Fréq.</th><th>Gain</th><th>Q</th></tr></thead>
          <tbody>{bands.map(({ b, i }) => (
            <tr key={i}><td>{i + 1}</td><td>{PEQ_TYPE_LABELS[b.type]}</td><td>{P.freq.fmt(b.freq)}</td><td>{b.type <= 2 ? P.eqGain.fmt(b.gain) : '—'}</td><td>{P.q.fmt(b.q)}</td></tr>
          ))}</tbody>
        </table>
      )}
      {input && (
        <p className="small"><strong>EQ graphique</strong>{(c as InputChannel).geqBypass ? ' (contourné)' : ''} : {geq.length ? geq.map(({ v, i }) => `${fmtIso(GEQ_FREQS[i])} ${P.eqGain.fmt(v)}`).join(' · ') : 'à plat'}</p>
      )}
    </section>
  );
}
