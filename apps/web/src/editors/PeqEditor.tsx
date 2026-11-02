// Parametric EQ of one channel (8 bands on inputs, 9 on outputs): interactive curve (drag the
// points, wheel for Q, keyboard like the editor: frequency ← →, gain ↑ ↓, bandwidth + −), band
// table, per-band and global bypass, reset, magnitude / phase view and other channels overlaid.

import { useMemo, useState } from 'react';
import {
  bandResponse, eqGainDbToRaw, eqGainRawToDb, freqHzToRaw, freqRawToHz, logFreqs, peqTypeHasGain, peqTypeHasQ, qRawToValue,
  type DeviceConfig, type PeqBand,
} from '@dsp-studio/protocol';
import type { DeviceMirror } from '../client/mirror.ts';
import { confirmDialog, useApp } from '../state/store.ts';
import { Button, Card, ParamRow, Select, Segmented, Toggle, ValueField } from '../ui/kit.tsx';
import { fmtDb, fmtHz, fmtNumber, P } from '../ui/format.ts';
import { allChannels, chan, colorOf, labelOf, responseOf } from '../ui/channels.tsx';
import { ResponseGraph, type GraphCurve, type GraphHandle, type GraphMarker } from '../ui/ResponseGraph.tsx';
import { t, tx } from '../i18n.tsx';

/** Short names of the band types (table), then the full ones with the editor's names (band editor, sheet). */
export const peqTypeShort = (): string[] => [
  t('Cloche'), t('Plateau grave'), t('Plateau aigu'), t('Passe-bas 6'), t('Passe-bas 12'), t('Passe-haut 6'), t('Passe-haut 12'), t('Passe-tout 1'), t('Passe-tout 2'),
];
export const peqTypeLabels = (): string[] => [
  t('Cloche (Peak)'), t('Plateau grave (Low Shelf)'), t('Plateau aigu (High Shelf)'), t('Passe-bas 6 dB'), t('Passe-bas 12 dB'),
  t('Passe-haut 6 dB'), t('Passe-haut 12 dB'), t('Passe-tout 1er ordre'), t('Passe-tout 2e ordre'),
];

export function PeqEditor(p: { cfg: DeviceConfig; ch: number; mirror: DeviceMirror; disabled: boolean }): React.JSX.Element {
  const { cfg, ch, mirror, disabled } = p;
  const c = chan(cfg, ch);
  const color = colorOf(cfg, ch);
  const hints = useApp((s) => s.prefs.hints);
  const [sel, setSel] = useState(0);
  const [mode, setMode] = useState<'mag' | 'phase'>('mag');
  const [showAll, setShowAll] = useState(false);
  const [overlay, setOverlay] = useState<number[]>([]);
  const freqs = useMemo(() => logFreqs(240), []);
  const band = Math.min(sel, c.peq.length - 1);
  const b = c.peq[band];

  const setBand = (k: number, patch: Partial<PeqBand>): void => {
    const cur = chan(mirror.config ?? cfg, ch).peq[k];
    const next = { ...cur, ...patch };
    if (JSON.stringify(next) !== JSON.stringify(cur)) mirror.apply({ t: 'peq', ch, band: k, p: next });
  };

  const total = responseOf(cfg, ch, freqs, { geq: false });
  const curves: GraphCurve[] = [];
  for (const o of overlay) {
    if (o === ch) continue;
    const r = responseOf(cfg, o, freqs, { geq: false });
    curves.push({ id: `o${o}`, color: colorOf(cfg, o), values: mode === 'mag' ? r.mag : r.phase, width: 1.4, opacity: 0.8, dash: '5 4' });
  }
  if (mode === 'mag' && !c.peqBypass) {
    c.peq.forEach((pb, k) => {
      if (pb.bypass) return;
      const values = freqs.map((f) => { const r = bandResponse(pb, f); return 20 * Math.log10(Math.hypot(r.re, r.im) || 1e-9); });
      curves.push({ id: `b${k}`, color, values, width: k === band ? 1.5 : 1, opacity: k === band ? 0.7 : 0.28, fill: k === band });
    });
  }
  curves.push({ id: 'total', color, values: mode === 'mag' ? total.mag : total.phase, width: 2.6 });

  const handles: GraphHandle[] = c.peq.map((pb, k) => ({
    id: k, f: freqRawToHz(pb.freq), db: eqGainRawToDb(pb.gain), label: String(k + 1), color, bypass: pb.bypass || c.peqBypass,
    fixedY: !peqTypeHasGain(pb.type), selected: k === band,
    info: `${fmtHz(freqRawToHz(pb.freq))}${peqTypeHasGain(pb.type) ? ' · ' + fmtDb(eqGainRawToDb(pb.gain)) : ''}${peqTypeHasQ(pb.type) ? ' · Q ' + fmtNumber(qRawToValue(pb.q), 2) : ''}`,
  }));
  const markers: GraphMarker[] = [];
  if (c.hpf.slope) markers.push({ id: 'hp', f: freqRawToHz(c.hpf.freq), label: 'HP', color });
  if (c.lpf.slope) markers.push({ id: 'lp', f: freqRawToHz(c.lpf.freq), label: 'LP', color });

  const onKey = (e: React.KeyboardEvent): void => {
    if (disabled) return;
    const k = e.key;
    const big = e.shiftKey ? 10 : 1;
    if (/^[1-9]$/.test(k) && Number(k) <= c.peq.length) { setSel(Number(k) - 1); e.preventDefault(); return; }
    if (k === 'ArrowLeft' || k === 'ArrowRight') setBand(band, { freq: Math.min(300, Math.max(0, b.freq + (k === 'ArrowRight' ? big : -big))) });
    else if ((k === 'ArrowUp' || k === 'ArrowDown') && peqTypeHasGain(b.type)) setBand(band, { gain: Math.min(240, Math.max(0, b.gain + (k === 'ArrowUp' ? 5 : -5) * big)) });
    else if (k === '+' || k === '-' || k === '=') setBand(band, { q: Math.min(100, Math.max(0, b.q + (k === '-' ? -1 : 1) * big)) });
    else if (k === 'b' || k === 'B') setBand(band, { bypass: !b.bypass });
    else if (k === 'Tab') return;
    else return;
    e.preventDefault();
  };

  const sameKind = allChannels(cfg).filter((x) => x !== ch);
  return (
    <Card
      title={t('Égaliseur paramétrique')} className="card-eq"
      subtitle={hints ? t('Glissez un point pour régler fréquence et gain, molette ou touches + / − pour la largeur (Q), flèches au clavier.') : undefined}
      actions={<>
        <Segmented small label={t('Affichage')} value={mode} onChange={setMode} options={[{ value: 'mag', label: t('Amplitude') }, { value: 'phase', label: t('Phase') }]} />
        <Toggle small on={showAll} onChange={setShowAll} title={t('Affiche les réglages de toutes les bandes sur la courbe')}>{t('Tous les paramètres')}</Toggle>
        <Toggle small tone="amber" on={c.peqBypass} onChange={(on) => mirror.apply({ t: 'peqBypass', ch, on })} disabled={disabled} title={t('Contourne tout l’égaliseur de ce canal')}>{t('Bypass EQ')}</Toggle>
        <Button small icon="refresh" disabled={disabled} onClick={async () => {
          if (await confirmDialog({ title: t('Réinitialiser l’égaliseur'), message: t('Remettre les {0} bandes de {1} à plat (0 dB, fréquences et largeurs d’origine) ?', c.peq.length, labelOf(cfg, ch)), ok: t('Réinitialiser'), danger: true })) {
            mirror.apply({ t: 'peqReset', ch });
          }
        }}>{t('Réinitialiser')}</Button>
      </>}
    >
      <ResponseGraph
        freqs={freqs} curves={curves} mode={mode} handles={handles} markers={markers} showLabels={showAll} disabled={disabled}
        label={t('Courbe de {0}', labelOf(cfg, ch))} height={300} onKeyDown={onKey} onSelect={setSel}
        onHandle={(k, f, db) => {
          const cur = chan(mirror.config ?? cfg, ch).peq[k];
          setBand(k, { freq: freqHzToRaw(f), ...(peqTypeHasGain(cur.type) ? { gain: eqGainDbToRaw(db) } : {}) });
        }}
        onHandleWheel={(k, dir) => setBand(k, { q: Math.min(100, Math.max(0, chan(mirror.config ?? cfg, ch).peq[k].q + dir)) })}
        onMarker={(id, f) => {
          const cur = chan(mirror.config ?? cfg, ch);
          if (id === 'hp') mirror.apply({ t: 'hpf', ch, x: { ...cur.hpf, freq: freqHzToRaw(f) } });
          else mirror.apply({ t: 'lpf', ch, x: { ...cur.lpf, freq: freqHzToRaw(f) } });
        }}
      />
      <div className="overlay-pick">
        <span className="muted small">{t('Superposer :')}</span>
        <div className="chips chips-small">
          {sameKind.map((o) => (
            <button key={o} type="button" aria-pressed={overlay.includes(o)} className={`chip ${overlay.includes(o) ? 'is-on' : ''}`} style={{ ['--ch' as string]: colorOf(cfg, o) }}
              onClick={() => setOverlay(overlay.includes(o) ? overlay.filter((x) => x !== o) : [...overlay, o])}>
              <span className="chip-id">{labelOf(cfg, o)}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="bands">
        <div className="band-tabs" role="tablist" aria-label={t('Bande')}>
          {c.peq.map((pb, k) => (
            <button key={k} type="button" role="tab" aria-selected={k === band} className={`band-tab ${k === band ? 'is-on' : ''} ${pb.bypass ? 'is-byp' : ''} ${pb.gain !== 120 && peqTypeHasGain(pb.type) ? 'is-active' : ''}`} onClick={() => setSel(k)}>
              {k + 1}
            </button>
          ))}
        </div>
        <div className="band-edit">
          <div className="band-edit-top">
            <Select label={t('Type de filtre')} value={b.type} disabled={disabled} onChange={(type) => setBand(band, { type })}
              options={peqTypeLabels().map((label, i) => ({ value: i, label }))} />
            <Toggle small tone="amber" on={b.bypass} onChange={(bypass) => setBand(band, { bypass })} disabled={disabled}>{tx('Bypass bande {0}', band + 1)}</Toggle>
          </div>
          <ParamRow label={t('Fréquence')} param={P.freq} value={b.freq} onChange={(freq) => setBand(band, { freq })} disabled={disabled} color={color} />
          <ParamRow label={t('Gain')} param={P.eqGain} value={b.gain} onChange={(gain) => setBand(band, { gain })} disabled={disabled || !peqTypeHasGain(b.type)} color={color} origin={120} />
          <ParamRow label={t('Largeur (Q)')} param={P.q} value={b.q} onChange={(q) => setBand(band, { q })} disabled={disabled || !peqTypeHasQ(b.type)} color={color} />
        </div>
      </div>

      <div className="table-wrap band-table">
        <table className="table">
          <thead><tr><th>{t('Bande')}</th><th>{t('Type')}</th><th>{t('Fréquence')}</th><th>Q</th><th>{t('Gain')}</th><th>{t('Bypass')}</th></tr></thead>
          <tbody>
            {c.peq.map((pb, k) => (
              <tr key={k} className={k === band ? 'is-sel' : ''} onClick={() => setSel(k)}>
                <td><strong>{k + 1}</strong></td>
                <td>
                  <Select label={t('Type bande {0}', k + 1)} value={pb.type} disabled={disabled} onChange={(type) => setBand(k, { type })}
                    options={peqTypeShort().map((label, i) => ({ value: i, label }))} className="select-sm" />
                </td>
                <td><ValueField value={pb.freq} param={P.freq} onChange={(freq) => setBand(k, { freq })} disabled={disabled} label={t('Fréquence bande {0}', k + 1)} /></td>
                <td><ValueField value={pb.q} param={P.q} onChange={(q) => setBand(k, { q })} disabled={disabled || !peqTypeHasQ(pb.type)} label={t('Q bande {0}', k + 1)} /></td>
                <td><ValueField value={pb.gain} param={P.eqGain} onChange={(gain) => setBand(k, { gain })} disabled={disabled || !peqTypeHasGain(pb.type)} label={t('Gain bande {0}', k + 1)} /></td>
                <td><Toggle small tone="amber" on={pb.bypass} onChange={(bypass) => setBand(k, { bypass })} disabled={disabled}>{t('Byp')}</Toggle></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
