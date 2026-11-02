// Tools: the Windows editor's Help menu (RS232 code, HidData frames, Memo message list), plus
// calculators and a crossover assistant that the editor does not have, preferences and "About".

import { useEffect, useMemo, useState } from 'react';
import {
  channelResponse, CMD, DELAY_FS, ext, EXT_COMMANDS, extFrame, extHex, freqHzToRaw, freqRawToHz, logFreqs, MODELS, SPEED_OF_SOUND,
  type ExtKind, type Xover,
} from '@dsp-studio/protocol';
import { confirmDialog, setLanguage, setPrefs, setState, toast, useApp, useCanEdit, useDevice, useFrames } from '../state/store.ts';
import { go, href, useRoute } from '../state/route.ts';
import { Badge, Button, Card, Field, Note, ParamRow, Segmented, Select, Tabs, TextInput, Toggle } from '../ui/kit.tsx';
import { Icon } from '../ui/icons.tsx';
import { ResponseGraph, type GraphCurve } from '../ui/ResponseGraph.tsx';
import { colorOf, labelOf } from '../ui/channels.tsx';
import { decimalSep, fmtHzShort, fmtNumber, P } from '../ui/format.ts';
import { SLOPE_OPTIONS } from '../editors/editors.tsx';
import { APP_VERSION } from '../client/types.ts';
import type { FrameLine } from '../client/mirror.ts';
import { downloadFile, stamp } from '../app/files.ts';
import { LANGS, locale, t, tm, tx } from '../i18n.tsx';

type Tab = 'filtrage' | 'calculs' | 'rs232' | 'trames' | 'journal' | 'preferences' | 'apropos';
const TAB_IDS: Tab[] = ['filtrage', 'calculs', 'rs232', 'trames', 'journal', 'preferences', 'apropos'];
const tabs = (): { id: Tab; label: string }[] => [
  { id: 'filtrage', label: t('Assistant de filtrage') },
  { id: 'calculs', label: t('Calculs') },
  { id: 'rs232', label: t('Code RS-232') },
  { id: 'trames', label: t('Trames') },
  { id: 'journal', label: t('Journal') },
  { id: 'preferences', label: t('Préférences') },
  { id: 'apropos', label: t('À propos') },
];

export function ToolsView(): React.JSX.Element {
  const route = useRoute();
  const tab = (TAB_IDS.includes(route.arg as Tab) ? route.arg : 'filtrage') as Tab;
  return (
    <div className="page">
      <div className="page-head"><h1>{t('Outils')}</h1></div>
      <Tabs label={t('Outils')} value={tab} tabs={tabs()} onChange={(v) => go('outils', v)} />
      {tab === 'filtrage' && <CrossoverAssistant />}
      {tab === 'calculs' && <div className="cards"><DelayCalculator /><WavelengthCalculator /></div>}
      {tab === 'rs232' && <Rs232Card />}
      {tab === 'trames' && <FramesCard />}
      {tab === 'journal' && <JournalCard />}
      {tab === 'preferences' && <PrefsCard />}
      {tab === 'apropos' && <AboutCard />}
    </div>
  );
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(t('Copié dans le presse-papiers'), 'ok');
  } catch {
    toast(t('Copie impossible ici : sélectionnez le texte à la main'), 'warn');
  }
}

// --------------------------------------------------------------------------- crossover assistant
const wayNames = (ways: number): string[] => (ways === 2 ? [t('Grave'), t('Aigu')] : [t('Grave'), t('Médium'), t('Aigu')]);
const WAY_COLORS = ['#fb923c', '#34d399', '#38bdf8'];

function CrossoverAssistant(): React.JSX.Element {
  const { mirror, config } = useDevice();
  const canEdit = useCanEdit();
  const [ways, setWays] = useState<2 | 3>(2);
  const [assign, setAssign] = useState<number[][]>([[0], [1], [2]]);
  const [fs, setFs] = useState<number[]>([freqHzToRaw(1600), freqHzToRaw(250), freqHzToRaw(2500)]);
  const [slope, setSlope] = useState(10); // Linkwitz-Riley -24 dB/oct
  const [invert, setInvert] = useState<boolean[]>([false, false, false]);
  const [protect, setProtect] = useState(false);
  const [protectF, setProtectF] = useState(freqHzToRaw(35));
  const freqs = useMemo(() => logFreqs(220), []);
  if (!mirror || !config) {
    return <Card title={t('Assistant de filtrage')}><p className="muted">{t('Choisissez d’abord un appareil.')}</p></Card>;
  }
  const m = MODELS[config.model];
  const names = wayNames(ways);
  const points = ways === 2 ? [fs[0]] : [fs[1], fs[2]];
  const used = assign.slice(0, ways);
  const valid = used.every((a) => a.length > 0) && (ways === 2 || points[0] < points[1]);
  const plan = (w: number, out: number): { hpf: Xover; lpf: Xover } => {
    const c = config.outputs[out];
    const hpf: Xover = w === 0 ? (protect ? { freq: protectF, slope } : { freq: c.hpf.freq, slope: 0 }) : { freq: points[w - 1], slope };
    const lpf: Xover = w === ways - 1 ? { freq: c.lpf.freq, slope: 0 } : { freq: points[w], slope };
    return { hpf, lpf };
  };
  const curves: GraphCurve[] = [];
  const sum = freqs.map(() => ({ re: 0, im: 0 }));
  used.forEach((outs, w) => {
    const { hpf, lpf } = plan(w, outs[0]);
    const r = channelResponse({ peq: [], peqBypass: true, hpf, lpf, invert: invert[w] }, freqs);
    curves.push({ id: `w${w}`, color: WAY_COLORS[w], values: r.mag, width: 2 });
    r.mag.forEach((db, i) => {
      const a = Math.pow(10, db / 20), ph = (r.phase[i] * Math.PI) / 180;
      sum[i].re += a * Math.cos(ph);
      sum[i].im += a * Math.sin(ph);
    });
  });
  curves.push({ id: 'sum', color: 'currentColor', values: sum.map((z) => 20 * Math.log10(Math.hypot(z.re, z.im) || 1e-9)), width: 2, dash: '5 4' });

  const toggleOut = (w: number, o: number): void => {
    setAssign((a) => a.map((list, k) => (k === w ? (list.includes(o) ? list.filter((x) => x !== o) : [...list, o].sort((x, y) => x - y)) : list.filter((x) => x !== o))));
  };
  const apply = async (): Promise<void> => {
    const lines = used.map((outs, w) => `${names[w]} : ${outs.map((o) => labelOf(config, m.inputs + o)).join(', ')}`).join('\n');
    const ok = await confirmDialog({
      title: t('Appliquer le filtrage'),
      message: invert.slice(0, ways).some(Boolean)
        ? t('{0}\n\nLes filtres passe-haut / passe-bas et la polarité de ces sorties seront remplacés. Les égaliseurs, volumes et délais ne changent pas.', lines)
        : t('{0}\n\nLes filtres passe-haut / passe-bas de ces sorties seront remplacés. Les égaliseurs, volumes et délais ne changent pas.', lines),
      ok: t('Appliquer'),
    });
    if (!ok) return;
    used.forEach((outs, w) => {
      for (const o of outs) {
        const ch = m.inputs + o;
        const { hpf, lpf } = plan(w, o);
        mirror.apply({ t: 'hpf', ch, x: hpf });
        mirror.apply({ t: 'lpf', ch, x: lpf });
        if (!!config.outputs[o].phase !== invert[w]) mirror.apply({ t: 'phase', ch, inv: invert[w] });
      }
    });
    toast(t('Filtrage appliqué'), 'ok');
  };
  const slopeLabel = SLOPE_OPTIONS.find((o) => o.value === slope)?.label ?? '';
  return (
    <div className="cards">
      <Card title={t('Assistant de filtrage')} subtitle={t('Préparez un filtrage 2 ou 3 voies, vérifiez la somme théorique, puis appliquez-le aux sorties choisies.')} className="span2">
        <div className="row wrap">
          <Segmented label={t('Nombre de voies')} value={ways} onChange={setWays} options={[{ value: 2, label: t('2 voies') }, { value: 3, label: t('3 voies') }]} />
          <Select label={t('Pente')} value={slope} onChange={setSlope} options={SLOPE_OPTIONS} />
        </div>
        <ResponseGraph freqs={freqs} curves={curves} mode="mag" range={[-36, 9]} height={240} label={t('Réponse théorique du filtrage {0}', slopeLabel)}
          markers={points.map((f, i) => ({ id: `p${i}`, f: freqRawToHz(f), label: fmtHzShort(freqRawToHz(f)), color: '#8b5cf6' }))}
          onMarker={(id, f) => {
            const i = Number(id.slice(1));
            const raw = freqHzToRaw(f);
            setFs((old) => old.map((v, k) => (ways === 2 ? (k === 0 ? raw : v) : k === i + 1 ? raw : v)));
          }} />
        <div className="legend">
          {used.map((_, w) => <span key={w}><i style={{ background: WAY_COLORS[w] }} />{names[w]}</span>)}
          <span>{tx('{0}Somme (haut-parleurs idéaux, même niveau, même distance)', <i className="legend-dash" />)}</span>
        </div>
      </Card>
      <Card title={t('Fréquences de coupure')}>
        {ways === 2
          ? <ParamRow label={t('Grave / aigu')} param={P.freq} value={fs[0]} onChange={(v) => setFs((o) => [v, o[1], o[2]])} />
          : <>
            <ParamRow label={t('Grave / médium')} param={P.freq} value={fs[1]} onChange={(v) => setFs((o) => [o[0], v, o[2]])} />
            <ParamRow label={t('Médium / aigu')} param={P.freq} value={fs[2]} onChange={(v) => setFs((o) => [o[0], o[1], v])} />
            {fs[1] >= fs[2] && <Note tone="warn">{t('La première coupure doit être plus basse que la seconde.')}</Note>}
          </>}
        <label className="check">
          <input type="checkbox" checked={protect} onChange={(e) => setProtect(e.target.checked)} />
          <span>{t('Coupe-bas de protection sur le grave')}</span>
        </label>
        {protect && <ParamRow label={t('Coupe-bas')} param={P.freq} value={protectF} onChange={setProtectF} />}
      </Card>
      <Card title={t('Sorties')}>
        {used.map((outs, w) => (
          <div key={w} className="way">
            <div className="way-head">
              <span className="way-dot" style={{ background: WAY_COLORS[w] }} />
              <strong className="grow">{names[w]}</strong>
              <Toggle small tone="blue" on={invert[w]} onChange={(v) => setInvert((o) => o.map((x, k) => (k === w ? v : x)))} title={t('Polarité inversée')}>{t('Ø')}</Toggle>
            </div>
            <div className="pick-row">
              {config.outputs.map((c, o) => (
                <button key={o} type="button" className={`pick ${outs.includes(o) ? 'is-on' : ''}`} style={{ ['--ch' as string]: colorOf(config, m.inputs + o) }}
                  aria-pressed={outs.includes(o)} onClick={() => toggleOut(w, o)} title={c.name}>{labelOf(config, m.inputs + o)}</button>
              ))}
            </div>
          </div>
        ))}
        <p className="small muted">{t('Astuce : en Linkwitz-Riley −12 dB/oct ou en Butterworth −6, −18, −30, −42 dB/oct, essayez l’aigu en polarité inversée et regardez la somme.')}</p>
        <div className="row end">
          <Button kind="primary" icon="check" disabled={!canEdit || !valid} onClick={apply}>{t('Appliquer aux sorties')}</Button>
        </div>
      </Card>
    </div>
  );
}

// --------------------------------------------------------------------------- calculators
const speedAt = (tc: number): number => 331.3 * Math.sqrt(1 + tc / 273.15);

function DelayCalculator(): React.JSX.Element {
  const [temp, setTemp] = useState('20');
  const [dist, setDist] = useState('10');
  const [ms, setMs] = useState('');
  const tc = Number(temp.replace(',', '.'));
  const c = Number.isFinite(tc) ? speedAt(tc) : SPEED_OF_SOUND;
  const d = Number(dist.replace(',', '.'));
  const msN = Number(ms.replace(',', '.'));
  const fromDist = Number.isFinite(d) && dist !== '' ? (d / c) * 1000 : null;
  const fromMs = Number.isFinite(msN) && ms !== '' ? (msN / 1000) * c : null;
  return (
    <Card title={t('Délai et distance')} subtitle={t('Temps de parcours du son selon la température de l’air.')}>
      <div className="form">
        <Field label={t('Température (°C)')}><TextInput value={temp} onChange={setTemp} inputMode="decimal" label={t('Température')} /></Field>
        <p className="small muted">{tx('Vitesse du son : {0} m/s. L’appareil convertit les mètres avec {1} m/s.', fmtNumber(c, 1), fmtNumber(SPEED_OF_SOUND, 1))}</p>
        <Field label={t('Distance (m)')} hint={fromDist !== null ? t('= {0} ms, soit {1} échantillons à 96 kHz', fmtNumber(fromDist, 2), Math.round((fromDist * DELAY_FS) / 1000)) : undefined}>
          <TextInput value={dist} onChange={setDist} inputMode="decimal" label={t('Distance en mètres')} />
        </Field>
        <Field label={t('Temps (ms)')} hint={fromMs !== null ? `= ${fmtNumber(fromMs, 2)} m` : undefined}>
          <TextInput value={ms} onChange={setMs} inputMode="decimal" label={t('Temps en millisecondes')} />
        </Field>
      </div>
      <p className="small">{tx('{0} (écran Délais).', <a href={href('delais')}>{t('Aligner des enceintes par leurs distances')}</a>)}</p>
    </Card>
  );
}

function WavelengthCalculator(): React.JSX.Element {
  const [f, setF] = useState('80');
  const hz = Number(f.replace(',', '.').replace(/k$/i, '')) * (/k$/i.test(f) ? 1000 : 1);
  const lambda = hz > 0 ? SPEED_OF_SOUND / hz : null;
  return (
    <Card title={t('Longueur d’onde')} subtitle={t('Utile pour placer des subwoofers ou repérer un creux de filtrage en peigne.')}>
      <Field label={t('Fréquence (Hz)')} hint={lambda !== null ? `λ = ${fmtNumber(lambda, 2)} m ; ½ λ = ${fmtNumber(lambda / 2, 2)} m ; ¼ λ = ${fmtNumber(lambda / 4, 2)} m` : undefined}>
        <TextInput value={f} onChange={setF} inputMode="decimal" label={t('Fréquence')} />
      </Field>
    </Card>
  );
}

// --------------------------------------------------------------------------- RS-232 code
function Rs232Card(): React.JSX.Element {
  const { snap, config } = useDevice();
  const m = config ? MODELS[config.model] : MODELS.dsp408;
  const [id, setId] = useState(String(snap?.deviceId ?? 1));
  const [cmd, setCmd] = useState(0x42);
  const [kind, setKind] = useState<ExtKind>(1);
  const [ch, setCh] = useState(0);
  const [flag, setFlag] = useState(true);
  const [vol, setVol] = useState(280);
  const [preset, setPreset] = useState(1);
  const idN = Math.min(250, Math.max(1, Number(id) || 1));
  const def = EXT_COMMANDS.find((c) => c.cmd === cmd) ?? EXT_COMMANDS[0];
  const isVolume = cmd === 0x44 || cmd === 0x45;
  const k: ExtKind = cmd === 0x44 ? 0 : cmd === 0x45 ? 1 : kind;
  const nCh = k === 0 ? m.inputs : m.outputs;
  const chN = Math.min(ch, nCh - 1);
  let frame: Uint8Array;
  switch (cmd) {
    case 0x41: frame = extFrame(idN, cmd, k, chN, flag ? 0 : 1); break;
    case 0x42: frame = extFrame(idN, cmd, k, chN, flag ? 1 : 0); break;
    case 0x43: frame = ext.recall(idN, preset); break;
    case 0x44: case 0x45: frame = extFrame(idN, cmd, chN, vol >> 8, vol & 0xff); break;
    case 0x4a: frame = extFrame(idN, cmd, 0, 0, 0); break;
    default: frame = extFrame(idN, cmd, k, chN, 0);
  }
  const hex = extHex(frame).replace(/(..)(?!$)/g, '$1 ');
  const chLabel = (i: number): string => (k === 0 ? m.inputLabels[i] : m.outputLabels[i]);
  return (
    <div className="cards">
      <Card title={t('Code RS-232 pour automates')} subtitle={t('Protocole simplifié (« Processor Extend Remote Control Protocol ») pour Crestron, AMX, domotique… Menu Help > RS232 Code du logiciel Windows.')} className="span2">
        <p className="small">{tx('Trame de 9 octets, sans somme de contrôle : {0} | ID | commande | d1 | d2 | d3 | {1}. Liaison série 115200 bauds, 8 bits, sans parité, 1 bit d’arrêt. L’appareil ne répond qu’aux trames portant son ID.', <code>7B 7D</code>, <code>7D 7B</code>)}</p>
        <Note>{tx('Plusieurs DSP sur une même ligne RS-485 : le firmware 1.04 ne se remet pas d’une trame Extend destinée à un autre ID (ou qui ne fait pas exactement 9 octets) et n’entend plus rien ensuite, protocole normal compris. Faites suivre chaque trame de 128 octets {0} : ils remettent sa réception à zéro et ne gênent aucun appareil.', <code>00</code>)}</Note>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>{t('Code')}</th><th>{t('Fonction')}</th><th>{t('d1 d2 d3')}</th><th>{t('Réponse')}</th><th>{t('Firmware 1.04')}</th></tr></thead>
            <tbody>
              {EXT_COMMANDS.map((c) => (
                <tr key={c.cmd} className={c.cmd === cmd ? 'is-on' : ''} onClick={() => setCmd(c.cmd)}>
                  <td><code>{c.cmd.toString(16).toUpperCase()}</code></td>
                  <td><strong>{tm(c.name)}</strong><br /><span className="small muted">{tm(c.description)}</span></td>
                  <td className="small">{tm(c.data)}</td>
                  <td className="small">{tm(c.reply)}</td>
                  <td>{c.verified ? <Badge tone="ok">{t('vérifié')}</Badge> : <Badge tone="warn">{t('sans réponse')}</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <Card title={t('Générateur de trame')} className="span2">
        <div className="form form-inline">
          <Field label={t('ID de l’appareil')}><TextInput value={id} onChange={(v) => setId(v.replace(/\D/g, '').slice(0, 3))} inputMode="numeric" label="ID" /></Field>
          <Field label={t('Commande')}><Select label={t('Commande')} value={cmd} onChange={setCmd} options={EXT_COMMANDS.map((c) => ({ value: c.cmd, label: `${c.cmd.toString(16).toUpperCase()} · ${tm(c.name)}` }))} /></Field>
          {cmd !== 0x43 && cmd !== 0x4a && (
            <>
              {!isVolume && <Field label={t('Type')}><Segmented label={t('Type')} value={kind} onChange={setKind} options={[{ value: 0 as ExtKind, label: t('Entrée') }, { value: 1 as ExtKind, label: t('Sortie') }]} /></Field>}
              <Field label={t('Canal')}><Select label={t('Canal')} value={chN} onChange={setCh} options={Array.from({ length: nCh }, (_, i) => ({ value: i, label: chLabel(i) }))} /></Field>
            </>
          )}
          {cmd === 0x41 && <Field label={t('Sens')}><Segmented label={t('Sens')} value={flag ? 1 : 0} onChange={(v) => setFlag(v === 1)} options={[{ value: 1, label: t('+0,5 dB') }, { value: 0, label: t('−0,5 dB') }]} /></Field>}
          {cmd === 0x42 && <Field label={t('État')}><Segmented label={t('État')} value={flag ? 1 : 0} onChange={(v) => setFlag(v === 1)} options={[{ value: 1, label: t('Coupé') }, { value: 0, label: t('Actif') }]} /></Field>}
          {cmd === 0x43 && <Field label={t('Preset')}><Select label={t('Preset')} value={preset} onChange={setPreset} options={Array.from({ length: m.userPresets + 1 }, (_, i) => ({ value: i, label: i === 0 ? 'F00' : `U${String(i).padStart(2, '0')}` }))} /></Field>}
        </div>
        {isVolume && <ParamRow label={t('Volume')} param={P.gain} value={vol} onChange={setVol} />}
        <div className="frame-out">
          <code className="frame-hex">{hex}</code>
          <Button small icon="copy" onClick={() => copyText(hex)}>{t('Copier')}</Button>
        </div>
        <p className="small muted">{t('{0} Réponse : {1}.', tm(def.description), tm(def.reply))}</p>
        {!def.verified && <Note tone="warn">{t('Cette commande figure dans l’aide de Thomann mais le firmware 1.04 n’y répond pas.')}</Note>}
      </Card>
    </div>
  );
}

// --------------------------------------------------------------------------- frames (HidData)
const CMD_NAMES = new Map<number, string>(Object.entries(CMD).map(([k, v]) => [v as number, k]));
function frameCmd(hex: string): number | null {
  const b = hex.split(' ');
  return b[0] === '10' && b[1] === '02' && b.length > 5 ? parseInt(b[5], 16) : null;
}
const fmtTime = (t: number): string => {
  const d = new Date(t);
  return `${d.toLocaleTimeString(locale())}${decimalSep()}${String(d.getMilliseconds()).padStart(3, '0')}`;
};

function FramesCard(): React.JSX.Element {
  const { mirror } = useDevice();
  const frames = useFrames();
  const [paused, setPaused] = useState<FrameLine[] | null>(null);
  const [hidePolls, setHidePolls] = useState(true);
  useEffect(() => {
    if (!mirror) return;
    mirror.setDebug(true);
    return () => mirror.setDebug(false);
  }, [mirror]);
  if (!mirror) return <Card title={t('Trames')}><p className="muted">{t('Choisissez d’abord un appareil.')}</p></Card>;
  const source = paused ?? frames;
  const list = source.filter((f) => !hidePolls || frameCmd(f.hex) !== CMD.METERS).slice(-400);
  const text = (): string => list.map((f) => `${fmtTime(f.at)} ${f.dir === 'tx' ? '>' : '<'} ${f.hex}`).join('\n');
  return (
    <Card title={t('Trames échangées')} subtitle={t('Ce que t.racks Studio envoie au DSP et ce qu’il répond (menu Help > HidData du logiciel Windows).')} className="frames-card"
      actions={<>
        <Button small icon={paused ? 'play' : 'stop'} onClick={() => setPaused(paused ? null : frames.slice())}>{paused ? t('Reprendre') : t('Pause')}</Button>
        <Button small icon="trash" onClick={() => { mirror.clearFrames(); setPaused(null); }}>{t('Effacer')}</Button>
        <Button small icon="copy" onClick={() => copyText(text())}>{t('Copier')}</Button>
        <Button small icon="download" onClick={() => downloadFile(`${t('trames')}_${stamp()}.txt`, text(), 'text/plain')}>{t('Télécharger')}</Button>
      </>}>
      <label className="check">
        <input type="checkbox" checked={hidePolls} onChange={(e) => setHidePolls(e.target.checked)} />
        <span>{t('Masquer la lecture des vumètres (0x40, plusieurs fois par seconde)')}</span>
      </label>
      <div className="frames" role="log" aria-live="off">
        {list.length === 0 && <p className="muted small">{t('Aucune trame pour l’instant : modifiez un réglage pour en voir passer.')}</p>}
        {list.map((f, i) => {
          const c = frameCmd(f.hex);
          return (
            <div key={`${f.at}-${i}`} className={`frame frame-${f.dir}`}>
              <span className="frame-t">{fmtTime(f.at)}</span>
              <span className="frame-dir" title={f.dir === 'tx' ? t('envoyée') : t('reçue')}>{f.dir === 'tx' ? '→' : '←'}</span>
              <span className="frame-cmd">{c === null ? '' : CMD_NAMES.get(c) ?? `0x${c.toString(16)}`}</span>
              <code className="frame-hex">{f.hex}</code>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// --------------------------------------------------------------------------- journal (Memo)
function JournalCard(): React.JSX.Element {
  const journal = useApp((s) => s.journal);
  return (
    <Card title={t('Journal')} subtitle={t('Les messages de la session : connexions, opérations, erreurs (menu Help > Memo du logiciel Windows).')}
      actions={<>
        <Button small icon="copy" disabled={!journal.length} onClick={() => copyText(journal.map((l) => `${new Date(l.at).toLocaleTimeString(locale())} ${l.text}`).join('\n'))}>{t('Copier')}</Button>
        <Button small icon="trash" disabled={!journal.length} onClick={() => setState({ journal: [] })}>{t('Effacer')}</Button>
      </>}>
      <div className="journal">
        {journal.length === 0 && <p className="muted small">{t('Rien pour l’instant.')}</p>}
        {journal.slice().reverse().map((l, i) => (
          <div key={`${l.at}-${i}`} className={`journal-line jl-${l.kind}`}>
            <span className="frame-t">{new Date(l.at).toLocaleTimeString(locale())}</span>
            <Icon name={l.kind === 'ok' ? 'check' : l.kind === 'info' ? 'info' : 'warning'} size={16} />
            <span>{l.text}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

// --------------------------------------------------------------------------- preferences
function PrefsCard(): React.JSX.Element {
  const prefs = useApp((s) => s.prefs);
  const mode = useApp((s) => s.mode);
  const [name, setName] = useState(prefs.clientName);
  return (
    <div className="cards">
      <Card title={t('Affichage')}>
        <div className="stack">
          <div className="row between">
            <div><span>{t('Langue')}</span><p className="small muted">{t('Automatique : la langue du navigateur, sinon l’anglais.')}</p></div>
            <Select label={t('Langue')} value={prefs.lang} onChange={(l) => setLanguage(l)} options={[{ value: '' as const, label: t('Automatique') }, ...LANGS.map((l) => ({ value: l.id, label: l.name }))]} />
          </div>
          <div className="row between">
            <span>{t('Thème')}</span>
            <Segmented label={t('Thème')} value={prefs.theme} onChange={(theme) => setPrefs({ theme })} options={[{ value: 'auto', label: t('Auto') }, { value: 'dark', label: t('Sombre') }, { value: 'light', label: t('Clair') }]} />
          </div>
          <div className="row between">
            <div><span>{t('Aides et raccourcis')}</span><p className="small muted">{t('Rappels des gestes et des touches dans les éditeurs.')}</p></div>
            <Toggle on={prefs.hints} onChange={(hints) => setPrefs({ hints })}>{prefs.hints ? t('Affichées') : t('Masquées')}</Toggle>
          </div>
          <div className="row between">
            <div><span>{t('Mode expert')}</span><p className="small muted">{t('Valeurs brutes de l’appareil et paramètres cachés (octet réservé du limiteur…).')}</p></div>
            <Toggle on={prefs.expert} onChange={(expert) => setPrefs({ expert })}>{prefs.expert ? t('Activé') : t('Désactivé')}</Toggle>
          </div>
          <div className="row between">
            <div><span>{t('Avertissements')}</span><p className="small muted">{t('Réafficher les messages masqués.')}</p></div>
            <Button small disabled={!prefs.seen.length} onClick={() => setPrefs({ seen: [] })}>{t('Réinitialiser')}</Button>
          </div>
        </div>
      </Card>
      {mode === 'bridge' && (
        <Card title={t('Cet écran')} subtitle={t('Nom affiché aux autres utilisateurs du pont.')}>
          <Field label={t('Nom')} hint={t('Pris en compte à la prochaine connexion.')}>
            <TextInput value={name} onChange={setName} maxLength={40} placeholder={t('Régie, tablette scène…')} label={t('Nom de cet écran')} onEnter={() => setPrefs({ clientName: name.trim() })} />
          </Field>
          <div className="row end"><Button small icon="check" disabled={name.trim() === prefs.clientName} onClick={() => { setPrefs({ clientName: name.trim() }); toast(t('Nom enregistré'), 'ok'); }}>{t('Enregistrer')}</Button></div>
        </Card>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------- about
function AboutCard(): React.JSX.Element {
  const backend = useApp((s) => s.backend);
  const mode = useApp((s) => s.mode);
  const { snap } = useDevice();
  return (
    <div className="cards">
      <Card title="t.racks Studio" subtitle={t('Logiciel libre et non officiel (licence MIT)')}>
        <dl className="kv">
          <div><dt>{t('Application')}</dt><dd>{APP_VERSION}</dd></div>
          <div><dt>{t('Mode')}</dt><dd>{mode === 'bridge' ? t('pont t.racks Studio {0}', backend?.version ?? '') : t('navigateur (WebHID, Web Serial, démo)')}</dd></div>
          <div><dt>{t('Firmware de l’appareil')}</dt><dd>{snap?.version || '—'}</dd></div>
        </dl>
        <p className="small">{t('Une interface moderne pour les processeurs t.racks DSP 206 et DSP 408, avec toutes les fonctions du logiciel « Processor Editor » pour Windows, sur ordinateur, tablette et téléphone.')}</p>
        <div className="row wrap">
          <Button small icon="print" onClick={() => go('fiche')}>{t('Fiche des réglages')}</Button>
        </div>
      </Card>
      <Card title={t('Sources et remerciements')}>
        <p className="small">{t('Le protocole a été établi en faisant tourner le firmware officiel et le logiciel Windows dans un émulateur, et en s’appuyant sur les travaux publics suivants (aucun code n’en est repris) :')}</p>
        <ul className="small list">
          <li>{t('dxtrzlb/z3r0-dsp206 : description du protocole USB du DSP 206')}</li>
          <li>{t('gr4per/dsp206 : table des commandes et carte mémoire')}</li>
          <li>{t('FlexiFlizz/t.racks-DSP-control : contrôle des DSP 204 / 206 / 306 / 408')}</li>
          <li>{t('Aeternitaas/dsp-408-ui : DSP 408 en Ethernet')}</li>
          <li>{t('DoctorRemoteControl/dsp408-protocol : trames du DSP 408')}</li>
        </ul>
        <p className="small muted">{t('t.racks Studio n’est ni développé ni soutenu par Thomann. t.racks est une marque de Thomann GmbH.')}</p>
      </Card>
    </div>
  );
}
