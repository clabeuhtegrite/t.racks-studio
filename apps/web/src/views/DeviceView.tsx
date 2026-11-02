// The "Appareil" screen: every function of the Windows editor's menus that is not a channel
// setting: Link, Copy, Channel name list, Lock setup, PTS setup / PTS password, Network setup
// (ID and IP), Test tone and Factory default, plus what the device reports about itself.

import { useState } from 'react';
import {
  describeSource, deviceAscii, GEQ_FREQS, linkLeaders, masksFromLeaders, MODELS,
  type DeviceConfig, type LockStatus, type SessionSnapshot,
} from '@dsp-studio/protocol';
import { confirmDialog, run, toast, useApp, useCanEdit, useDevice } from '../state/store.ts';
import { go, useRoute } from '../state/route.ts';
import { Badge, Button, Card, Field, Note, Segmented, Tabs, TextInput, Toggle } from '../ui/kit.tsx';
import { Icon } from '../ui/icons.tsx';
import { allChannels, chan, colorOf, labelOf } from '../ui/channels.tsx';
import { fmtIso, fmtIsoHz, presetLabel, stateLabel } from '../ui/format.ts';
import type { DeviceMirror } from '../client/mirror.ts';
import { factoryReset } from './PresetsView.tsx';

type Tab = 'general' | 'liaisons' | 'noms' | 'securite' | 'generateur';
const TABS: { id: Tab; label: string }[] = [
  { id: 'general', label: 'Général' },
  { id: 'liaisons', label: 'Liaisons et copie' },
  { id: 'noms', label: 'Noms des canaux' },
  { id: 'securite', label: 'Verrouillage' },
  { id: 'generateur', label: 'Générateur' },
];

export function DeviceView(): React.JSX.Element {
  const { mirror, config, snap } = useDevice();
  const route = useRoute();
  const canEdit = useCanEdit();
  const tab = (TABS.some((t) => t.id === route.arg) ? route.arg : 'general') as Tab;
  if (!mirror || !config || !snap) return <></>;
  const disabled = !canEdit;
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Appareil</h1>
          <p className="muted small">{MODELS[config.model].name} · {mirror.info?.label ?? ''}</p>
        </div>
      </div>
      <Tabs label="Sections" value={tab} tabs={TABS} onChange={(t) => go('appareil', t)} />
      {tab === 'general' && (
        <div className="cards">
          <InfoCard mirror={mirror} snap={snap} config={config} />
          <NetworkCard key={snap.system ? `${snap.system.deviceId}-${snap.system.ip.join('.')}` : 'none'} mirror={mirror} snap={snap} disabled={disabled} />
          <MaintenanceCard mirror={mirror} disabled={disabled} />
        </div>
      )}
      {tab === 'liaisons' && (
        <div className="cards">
          <LinksCard cfg={config} mirror={mirror} disabled={disabled} />
          <CopyCard cfg={config} mirror={mirror} disabled={disabled} />
        </div>
      )}
      {tab === 'noms' && <NamesCard cfg={config} mirror={mirror} disabled={disabled} />}
      {tab === 'securite' && (
        <div className="cards">
          {snap.lock?.locked ? <UnlockCard /> : <LockCard mirror={mirror} disabled={disabled} />}
          <PtsCard key={snap.lock ? `${snap.lock.ptsOn}-${snap.lock.ptsLimit}` : 'none'} mirror={mirror} lock={snap.lock} disabled={disabled} />
        </div>
      )}
      {tab === 'generateur' && <ToneCard cfg={config} mirror={mirror} disabled={disabled} />}
    </div>
  );
}

// ---------------------------------------------------------------------------------------- general
function InfoCard({ mirror, snap, config }: { mirror: DeviceMirror; snap: SessionSnapshot; config: DeviceConfig }): React.JSX.Element {
  const m = MODELS[config.model];
  const info = mirror.info;
  const lock = snap.lock;
  const role = useApp((s) => s.role);
  const used = snap.presets.filter((p) => p.user).length;
  const rows: [string, string][] = [
    ['Modèle', `${m.name} · ${m.inputs} entrées, ${m.outputs} sorties`],
    ['Firmware', [snap.version, snap.versionExt].filter(Boolean).join(' · ') || '—'],
    ['ID de l’appareil', String(snap.system?.deviceId ?? snap.deviceId)],
    ['Adresse IP', snap.system ? snap.system.ip.join('.') : '—'],
    ['Liaison', info ? `${describeSource(info.spec)} · ${stateLabel(info.state)}` : '—'],
    ['Preset en cours', `${presetLabel(snap.activePreset)} · ${config.presetName || 'Sans nom'}`],
    ['Mémoires utilisées', `${used} sur ${m.userPresets}`],
    ['Verrouillage', lock ? `${lock.locked ? 'verrouillé' : 'déverrouillé'}${lock.ptsOn ? ` · limite d’allumages active (${lock.ptsCount} sur ${lock.ptsLimit})` : ''}` : '—'],
  ];
  return (
    <Card title="Informations" actions={
      <Button small icon="refresh" disabled={role !== 'admin'} onClick={() => run('Relecture de l’appareil', () => mirror.call('sync'), 'Appareil relu')}>Relire</Button>
    }>
      <dl className="kv">
        {rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
      </dl>
    </Card>
  );
}

/** Network setup of the editor: device ID (1..250) and IP address, stored in EEPROM. */
function NetworkCard({ mirror, snap, disabled }: { mirror: DeviceMirror; snap: SessionSnapshot; disabled: boolean }): React.JSX.Element {
  const sys = snap.system;
  const [id, setId] = useState(String(sys?.deviceId ?? snap.deviceId ?? 1));
  const [ip, setIp] = useState<string[]>((sys?.ip ?? [192, 168, 0, 100]).map(String));
  const idN = Number(id);
  const ipN = ip.map((x) => Number(x));
  const idOk = /^\d+$/.test(id) && idN >= 1 && idN <= 250;
  const ipOk = ip.every((x) => /^\d{1,3}$/.test(x) && Number(x) <= 255);
  const changed = !sys || idN !== sys.deviceId || ipN.some((x, i) => x !== sys.ip[i]);
  const setPart = (i: number, v: string): void => {
    if (v.includes('.')) {
      // pasted or typed "192.168.1.20": spread it over the fields
      const parts = v.split('.').map((x) => x.replace(/\D/g, '').slice(0, 3));
      setIp((old) => old.map((o, k) => (k >= i && k - i < parts.length ? parts[k - i] : o)));
      const next = Math.min(3, i + parts.length - 1);
      requestAnimationFrame(() => document.getElementById(`ip-${next}`)?.focus());
      return;
    }
    setIp((old) => old.map((o, k) => (k === i ? v.replace(/\D/g, '').slice(0, 3) : o)));
  };
  const save = async (): Promise<void> => {
    const ok = await confirmDialog({
      title: 'Réglages réseau',
      message: `Enregistrer l’ID ${idN} et l’adresse ${ipN.join('.')} dans l’appareil ?\n\nIls sont pris en compte au prochain allumage du DSP. Si vous le pilotez par cette adresse ou cet ID, mettez ensuite l’appareil à jour dans « Connexion ».`,
      ok: 'Enregistrer',
    });
    if (!ok) return;
    await run('Réglages réseau', () => mirror.call('setNetwork', idN, ipN), 'Enregistré : éteignez puis rallumez le DSP pour l’appliquer');
  };
  return (
    <Card title="Réseau" subtitle="ID et adresse IP de l’appareil (menu « Network setup » du logiciel Windows).">
      <div className="form">
        <Field label="ID de l’appareil" hint="De 1 à 250. Distingue plusieurs DSP sur une même ligne RS-485 ; le pilotage se fait sur cet ID.">
          <TextInput value={id} onChange={(v) => setId(v.replace(/\D/g, '').slice(0, 3))} inputMode="numeric" disabled={disabled} label="ID de l’appareil" className={idOk ? '' : 'is-bad'} />
        </Field>
        <Field label="Adresse IP" hint="Pour les modèles avec prise Ethernet. Port TCP 9761.">
          <div className="ip">
            {ip.map((x, i) => (
              <span key={i} className="ip-part">
                {i > 0 && <span className="ip-dot">.</span>}
                <input
                  id={`ip-${i}`} className="input" value={x} inputMode="numeric" maxLength={i === 0 ? 15 : 3} aria-label={`Octet ${i + 1} de l’adresse IP`} disabled={disabled}
                  onChange={(e) => setPart(i, e.target.value)}
                  onKeyDown={(e) => { if (e.key === '.' && i < 3) { e.preventDefault(); document.getElementById(`ip-${i + 1}`)?.focus(); } }}
                />
              </span>
            ))}
          </div>
        </Field>
      </div>
      <div className="row end">
        <Button kind="primary" icon="save" disabled={disabled || !idOk || !ipOk || !changed} onClick={save}>Enregistrer dans l’appareil</Button>
      </div>
    </Card>
  );
}

function MaintenanceCard({ mirror, disabled }: { mirror: DeviceMirror; disabled: boolean }): React.JSX.Element {
  return (
    <Card title="Maintenance">
      <div className="stack">
        <div className="row between">
          <div>
            <strong>Sauvegarder ou restaurer l’appareil</strong>
            <p className="small muted">Les 20 mémoires et les réglages de verrouillage, en .unt (logiciel Windows) ou .json.</p>
          </div>
          <Button small icon="presets" onClick={() => go('presets')}>Presets</Button>
        </div>
        <div className="row between">
          <div>
            <strong>Réglages d’usine</strong>
            <p className="small muted">Efface les 20 mémoires utilisateur (menu File &gt; Factory Default).</p>
          </div>
          <Button small kind="danger" icon="trash" disabled={disabled} onClick={() => factoryReset(mirror)}>Réglages d’usine</Button>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------- links
/**
 * New leader of every channel of a kind after linking (or unlinking) a selection. A group is always
 * led by its first channel, as the firmware requires; channels left behind keep their group.
 */
export function regroup(leaders: number[], sel: Set<number>, mode: 'link' | 'unlink'): number[] {
  const group = leaders.map((l, k) => (sel.has(k) ? (mode === 'link' ? -1 : -2 - k) : l));
  const first = new Map<number, number>();
  return group.map((g, k) => {
    if (!first.has(g)) first.set(g, k);
    return first.get(g)!;
  });
}

function LinksCard({ cfg, mirror, disabled }: { cfg: DeviceConfig; mirror: DeviceMirror; disabled: boolean }): React.JSX.Element {
  const m = MODELS[cfg.model];
  const [kind, setKind] = useState<'in' | 'out'>('out');
  const [sel, setSel] = useState<number[]>([]);
  const [align, setAlign] = useState(true);
  const n = kind === 'in' ? m.inputs : m.outputs;
  const base = kind === 'in' ? 0 : m.inputs;
  const leaders = linkLeaders(cfg, kind);
  const groups = [...new Set(leaders)].map((l) => leaders.flatMap((x, k) => (x === l ? [k] : []))).filter((g) => g.length > 1);
  const label = (k: number): string => labelOf(cfg, base + k);
  const toggle = (k: number): void => setSel((s) => (s.includes(k) ? s.filter((x) => x !== k) : [...s, k].sort((a, b) => a - b)));
  const send = (next: number[]): void => {
    mirror.apply({ t: 'link', kind, masks: masksFromLeaders(next) });
    setSel([]);
  };
  const link = (): void => {
    const root = sel[0];
    const newcomers = sel.filter((k) => k !== root && leaders[k] !== leaders[root]);
    if (align) for (const k of newcomers) mirror.apply({ t: 'copy', src: base + root, dst: base + k });
    send(regroup(leaders, new Set(sel), 'link'));
    toast(`${sel.map(label).join(' + ')} liés`, 'ok');
  };
  return (
    <Card title="Liaisons" subtitle="Des canaux liés reçoivent ensemble chaque réglage (égaliseurs, filtres, dynamique, volume, délai…), comme le menu « Link » du logiciel Windows.">
      <Segmented label="Type de canaux" value={kind} onChange={(v) => { setKind(v); setSel([]); }} options={[{ value: 'in', label: 'Entrées' }, { value: 'out', label: 'Sorties' }]} />
      <p className="small muted">Touchez les canaux à lier ensemble, puis « Lier ».</p>
      <div className="link-pick">
        {Array.from({ length: n }, (_, k) => {
          const g = groups.findIndex((x) => x.includes(k));
          return (
            <button
              key={k} type="button" disabled={disabled} aria-pressed={sel.includes(k)}
              className={`link-ch ${sel.includes(k) ? 'is-on' : ''} ${g >= 0 ? `in-group group-${g % 4}` : ''}`}
              style={{ ['--ch' as string]: colorOf(cfg, base + k) }}
              onClick={() => toggle(k)}
            >
              <span className="chip-id">{label(k)}</span>
              <span className="chip-name">{chan(cfg, base + k).name !== label(k) ? chan(cfg, base + k).name : ' '}</span>
              {g >= 0 && <span className="link-tag"><Icon name="link" size={12} /> {g + 1}</span>}
            </button>
          );
        })}
      </div>
      <label className="check">
        <input type="checkbox" checked={align} onChange={(e) => setAlign(e.target.checked)} disabled={disabled} />
        <span>Recopier d’abord les réglages du premier canal sélectionné sur les autres</span>
      </label>
      <div className="row wrap">
        <Button kind="primary" icon="link" disabled={disabled || sel.length < 2} onClick={link}>Lier</Button>
        <Button icon="close" disabled={disabled || !sel.some((k) => groups.some((g) => g.includes(k)))} onClick={() => send(regroup(leaders, new Set(sel), 'unlink'))}>Délier la sélection</Button>
        <Button kind="ghost" disabled={disabled || !groups.length} onClick={() => send(leaders.map((_, k) => k))}>Tout délier</Button>
      </div>
      <div className="groups">
        {groups.length === 0 && <p className="small muted">Aucun canal lié.</p>}
        {groups.map((g, i) => (
          <div key={i} className={`group-line group-${i % 4}`}>
            <Icon name="link" size={16} />
            <span className="grow">Groupe {i + 1} : {g.map(label).join(' + ')}</span>
            <Button small kind="ghost" disabled={disabled} onClick={() => send(regroup(leaders, new Set(g), 'unlink'))}>Délier</Button>
          </div>
        ))}
      </div>
    </Card>
  );
}

/** Channel Copy dialog of the editor (In / Out, source -> destination), with several destinations. */
function CopyCard({ cfg, mirror, disabled }: { cfg: DeviceConfig; mirror: DeviceMirror; disabled: boolean }): React.JSX.Element {
  const m = MODELS[cfg.model];
  const [kind, setKind] = useState<'in' | 'out'>('out');
  const [src, setSrc] = useState(0);
  const [dst, setDst] = useState<number[]>([]);
  const n = kind === 'in' ? m.inputs : m.outputs;
  const base = kind === 'in' ? 0 : m.inputs;
  const label = (k: number): string => labelOf(cfg, base + k);
  const copy = async (): Promise<void> => {
    const ok = await confirmDialog({
      title: 'Copier un canal',
      message: `Copier tous les réglages de ${label(src)} vers ${dst.map(label).join(', ')} ?\n(égaliseurs, filtres, dynamique, volume, délai, polarité ; ${kind === 'out' ? 'le nom, le routage' : 'le nom'} et les liaisons sont conservés, comme sur l’appareil)`,
      ok: 'Copier',
    });
    if (!ok) return;
    for (const d of dst) mirror.apply({ t: 'copy', src: base + src, dst: base + d });
    toast(`${label(src)} copié vers ${dst.map(label).join(', ')}`, 'ok');
    setDst([]);
  };
  return (
    <Card title="Copie de canal" subtitle="Menu « Copy » du logiciel Windows.">
      <Segmented label="Type de canaux" value={kind} onChange={(v) => { setKind(v); setSrc(0); setDst([]); }} options={[{ value: 'in', label: 'Entrées' }, { value: 'out', label: 'Sorties' }]} />
      <div className="copy-grid">
        <div>
          <p className="field-label">Copier</p>
          <div className="pick-row">
            {Array.from({ length: n }, (_, k) => (
              <button key={k} type="button" className={`pick ${src === k ? 'is-on' : ''}`} style={{ ['--ch' as string]: colorOf(cfg, base + k) }} disabled={disabled}
                aria-pressed={src === k} onClick={() => { setSrc(k); setDst((d) => d.filter((x) => x !== k)); }}>{label(k)}</button>
            ))}
          </div>
        </div>
        <Icon name="chevronRight" className="copy-arrow" />
        <div>
          <p className="field-label">vers</p>
          <div className="pick-row">
            {Array.from({ length: n }, (_, k) => (
              <button key={k} type="button" className={`pick ${dst.includes(k) ? 'is-on' : ''}`} style={{ ['--ch' as string]: colorOf(cfg, base + k) }}
                disabled={disabled || k === src} aria-pressed={dst.includes(k)}
                onClick={() => setDst((d) => (d.includes(k) ? d.filter((x) => x !== k) : [...d, k].sort((a, b) => a - b)))}>{label(k)}</button>
            ))}
          </div>
        </div>
      </div>
      <div className="row end">
        <Button kind="primary" icon="copy" disabled={disabled || !dst.length} onClick={copy}>Copier</Button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------- names
/** Names are stored as ASCII by the device (8 characters for channels). */
const deviceText = deviceAscii;

function NamesCard({ cfg, mirror, disabled }: { cfg: DeviceConfig; mirror: DeviceMirror; disabled: boolean }): React.JSX.Element {
  const [draft, setDraft] = useState<Record<number, string>>({});
  const m = MODELS[cfg.model];
  const dirty = Object.entries(draft).map(([k, v]) => [Number(k), v] as const).filter(([ch, v]) => chan(cfg, ch).name !== v);
  const save = (): void => {
    for (const [ch, name] of dirty) mirror.apply({ t: 'name', ch, name });
    setDraft({});
    toast(dirty.length > 1 ? `${dirty.length} noms enregistrés` : 'Nom enregistré', 'ok');
  };
  const row = (ch: number): React.JSX.Element => (
    <label key={ch} className="name-row" style={{ ['--ch' as string]: colorOf(cfg, ch) }}>
      <span className="name-id">{labelOf(cfg, ch)}</span>
      <TextInput
        value={draft[ch] ?? chan(cfg, ch).name} maxLength={8} disabled={disabled} label={`Nom de ${labelOf(cfg, ch)}`} placeholder={labelOf(cfg, ch)}
        onChange={(v) => setDraft((d) => ({ ...d, [ch]: deviceText(v, 8) }))} onEnter={save}
      />
    </label>
  );
  const all = allChannels(cfg);
  return (
    <Card title="Noms des canaux" subtitle="8 caractères, sans accents (limite de l’appareil). Menu « Channel name » du logiciel Windows.">
      <div className="names">
        <div><h3 className="small muted">Entrées</h3>{all.filter((ch) => ch < m.inputs).map(row)}</div>
        <div><h3 className="small muted">Sorties</h3>{all.filter((ch) => ch >= m.inputs).map(row)}</div>
      </div>
      <div className="row end">
        <Button kind="ghost" disabled={!Object.keys(draft).length} onClick={() => setDraft({})}>Annuler</Button>
        <Button kind="primary" icon="check" disabled={disabled || !dirty.length} onClick={save}>Enregistrer{dirty.length ? ` (${dirty.length})` : ''}</Button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------- lock
const PW_HINT = '4 caractères (lettres ou chiffres)';
/** for a new password: the front panel only offers 0-9 and A-Z */
const NEW_PW_HINT = '4 caractères : chiffres et majuscules (0000 à ZZZZ) pour pouvoir aussi le saisir sur la façade';
const pwOk = (s: string): boolean => /^[\x21-\x7e]{4}$/.test(s);

function LockCard({ mirror, disabled }: { mirror: DeviceMirror; disabled: boolean }): React.JSX.Element {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const lock = async (): Promise<void> => {
    const ok = await confirmDialog({
      title: 'Verrouiller l’appareil',
      message: `Une fois verrouillé, DSP Studio comme le logiciel Windows demandent le mot de passe « ${pw} » avant toute modification. Notez-le bien.`,
      ok: 'Verrouiller', danger: true,
    });
    if (!ok) return;
    await run('Verrouillage', () => mirror.call('lock', pw), 'Appareil verrouillé');
    setPw(''); setPw2('');
  };
  return (
    <Card title={<><Icon name="unlock" size={18} /> Verrouillage par mot de passe</>} subtitle="Menu « Lock » du logiciel Windows. Empêche toute modification sans le mot de passe.">
      <form className="form" onSubmit={(e) => { e.preventDefault(); if (pwOk(pw) && pw === pw2) void lock(); }}>
        <Field label="Mot de passe" hint={NEW_PW_HINT}>
          <TextInput type="password" value={pw} onChange={(v) => setPw(deviceText(v, 4))} maxLength={4} disabled={disabled} label="Mot de passe" />
        </Field>
        <Field label="Confirmation" hint={pw2 && pw !== pw2 ? 'Les deux saisies diffèrent' : undefined}>
          <TextInput type="password" value={pw2} onChange={(v) => setPw2(deviceText(v, 4))} maxLength={4} disabled={disabled} label="Confirmation du mot de passe" />
        </Field>
        <div className="row end">
          <Button type="submit" kind="danger" icon="lock" disabled={disabled || !pwOk(pw) || pw !== pw2}>Verrouiller</Button>
        </div>
      </form>
    </Card>
  );
}

/** Shown instead of the settings while the device is locked. */
export function UnlockCard(): React.JSX.Element {
  const { mirror, snap } = useDevice();
  const role = useApp((s) => s.role);
  const [pw, setPw] = useState('');
  if (!mirror || !snap) return <></>;
  const lock = snap.lock;
  const unlock = async (): Promise<void> => {
    const ok = await run('Déverrouillage', () => mirror.call<boolean>('unlock', pw));
    if (ok === false) toast('Mot de passe incorrect', 'error');
    else if (ok) toast('Appareil déverrouillé', 'ok');
    setPw('');
  };
  return (
    <div className="stack unlock">
      <Card title={<><Icon name="lock" size={18} /> Appareil verrouillé</>} subtitle="Ce DSP a été verrouillé par mot de passe (depuis DSP Studio ou le logiciel Windows).">
        {role !== 'admin' ? <Note>Seul un administrateur peut déverrouiller l’appareil.</Note> : (
          <form className="form" onSubmit={(e) => { e.preventDefault(); if (pw) void unlock(); }}>
            <Field label="Mot de passe" hint={PW_HINT}>
              <TextInput type="password" value={pw} onChange={(v) => setPw(deviceText(v, 4))} maxLength={4} autoFocus label="Mot de passe" />
            </Field>
            <div className="row end"><Button type="submit" kind="primary" icon="unlock" disabled={!pw}>Déverrouiller</Button></div>
          </form>
        )}
      </Card>
      {lock?.ptsOn && <PtsPasswordCard mirror={mirror} lock={lock} disabled={role !== 'admin'} />}
    </div>
  );
}

/** "PTS" = lock after a number of power-ons (次数锁 in the editor's Chinese strings). */
function PtsCard({ mirror, lock, disabled }: { mirror: DeviceMirror; lock: LockStatus | null; disabled: boolean }): React.JSX.Element {
  const [pw, setPw] = useState('');
  const [on, setOn] = useState(lock?.ptsOn ?? false);
  const [limit, setLimit] = useState(String(lock?.ptsLimit || 100));
  const limitN = Number(limit);
  const limitOk = /^\d{1,4}$/.test(limit);
  const save = async (): Promise<void> => {
    const ok = await confirmDialog({
      title: 'Limite d’allumages (PTS)',
      message: on
        ? `Après ${limitN} allumages, l’appareil demandera le mot de passe PTS « ${pw} ». Notez-le bien.\nLe compteur repart de zéro.`
        : 'Désactiver la limite d’allumages ? Le compteur repart de zéro.',
      ok: 'Enregistrer', danger: on,
    });
    if (!ok) return;
    await run('Limite d’allumages', () => mirror.call('ptsSetup', pw, limitN, on), on ? 'Limite d’allumages activée' : 'Limite d’allumages désactivée');
    setPw('');
  };
  return (
    <>
      <Card title="Limite d’allumages (PTS)" subtitle="Menus « PTS setup » et « PTS password » du logiciel Windows : au-delà d’un nombre d’allumages, l’appareil demande un second mot de passe (location, prêt).">
        <dl className="kv">
          <div><dt>État</dt><dd>{lock ? (lock.ptsOn ? <Badge tone="warn">active</Badge> : <Badge>désactivée</Badge>) : '—'}</dd></div>
          <div><dt>Allumages comptés (« Now »)</dt><dd>{lock ? lock.ptsCount : '—'}</dd></div>
          <div><dt>Limite (« Time »)</dt><dd>{lock ? lock.ptsLimit : '—'}</dd></div>
        </dl>
        <form className="form" onSubmit={(e) => { e.preventDefault(); if (pwOk(pw) && limitOk) void save(); }}>
          <Field label="Mot de passe PTS" hint={NEW_PW_HINT}>
            <TextInput type="password" value={pw} onChange={(v) => setPw(deviceText(v, 4))} maxLength={4} disabled={disabled} label="Mot de passe PTS" />
          </Field>
          <Field label="Nombre d’allumages autorisés" hint="De 0 à 9999.">
            <TextInput value={limit} onChange={(v) => setLimit(v.replace(/\D/g, '').slice(0, 4))} inputMode="numeric" disabled={disabled} label="Nombre d’allumages autorisés" />
          </Field>
          <div className="row between">
            <Toggle on={on} onChange={setOn} disabled={disabled} tone="amber">{on ? 'Limite activée' : 'Limite désactivée'}</Toggle>
            <Button type="submit" kind="primary" icon="save" disabled={disabled || !pwOk(pw) || !limitOk}>Enregistrer</Button>
          </div>
        </form>
      </Card>
      {lock?.ptsOn && <PtsPasswordCard mirror={mirror} lock={lock} disabled={disabled} />}
    </>
  );
}

function PtsPasswordCard({ mirror, lock, disabled }: { mirror: DeviceMirror; lock: LockStatus; disabled: boolean }): React.JSX.Element {
  const [pw, setPw] = useState('');
  const due = lock.ptsCount >= lock.ptsLimit;
  const check = async (): Promise<void> => {
    const ok = await run('Mot de passe PTS', () => mirror.call<boolean>('unlockPts', pw));
    if (ok === false) toast('Mot de passe PTS incorrect', 'error');
    else if (ok) toast('Mot de passe PTS accepté', 'ok');
    setPw('');
  };
  return (
    <Card title="Mot de passe PTS" subtitle={due ? 'La limite d’allumages est atteinte : saisissez le mot de passe PTS.' : `${lock.ptsCount} allumage(s) sur ${lock.ptsLimit} autorisés.`}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); if (pw) void check(); }}>
        <Field label="Mot de passe PTS" hint={PW_HINT}>
          <TextInput type="password" value={pw} onChange={(v) => setPw(deviceText(v, 4))} maxLength={4} disabled={disabled} label="Mot de passe PTS" />
        </Field>
        <div className="row end"><Button type="submit" kind={due ? 'primary' : 'plain'} icon="unlock" disabled={disabled || !pw}>Valider</Button></div>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------- tone
const TONE_SOURCES = ['Entrée analogique', 'Bruit rose', 'Bruit blanc', 'Sinus'];

function ToneCard({ cfg, mirror, disabled }: { cfg: DeviceConfig; mirror: DeviceMirror; disabled: boolean }): React.JSX.Element {
  const src = cfg.toneSource;
  const set = async (source: number, freq = cfg.toneFreq): Promise<void> => {
    if (src === 0 && source !== 0) {
      const ok = await confirmDialog({
        title: 'Générateur de test',
        message: 'Le signal de test remplace la musique sur les entrées et part vers toutes les sorties routées, au niveau des réglages actuels. Baissez les amplis avant de continuer.',
        ok: `Envoyer ${TONE_SOURCES[source].toLowerCase()}`, danger: true,
      });
      if (!ok) return;
    }
    mirror.apply({ t: 'testTone', source, freq });
  };
  return (
    <Card title="Générateur de test" subtitle="Menu « Test tone » du logiciel Windows : bruit rose, bruit blanc ou sinus à la place des entrées.">
      {src !== 0 && (
        <div className="tone-live">
          <Note tone="warn">Générateur actif : {TONE_SOURCES[src].toLowerCase()}{src === 3 ? ` à ${fmtIsoHz(GEQ_FREQS[cfg.toneFreq])}` : ''}.</Note>
          <Button kind="danger" icon="stop" disabled={disabled} onClick={() => set(0)}>Arrêter (revenir aux entrées)</Button>
        </div>
      )}
      <Segmented
        label="Source" value={src} disabled={disabled} onChange={(v) => void set(v)}
        options={TONE_SOURCES.map((l, i) => ({ value: i, label: l }))}
      />
      <p className="field-label">Fréquence du sinus</p>
      <div className="tone-freqs" role="radiogroup" aria-label="Fréquence du sinus">
        {GEQ_FREQS.map((hz, i) => (
          <button
            key={i} type="button" role="radio" aria-checked={cfg.toneFreq === i} disabled={disabled}
            className={`tone-f ${cfg.toneFreq === i ? 'is-on' : ''} ${cfg.toneFreq === i && src === 3 ? 'is-live' : ''}`}
            onClick={() => void set(3, i)}
          >{fmtIso(hz)}</button>
        ))}
      </div>
    </Card>
  );
}
