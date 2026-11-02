// Connection: how this screen reaches the DSPs (through a t.racks Studio bridge, or the browser itself),
// the list of devices, and adding one: Ethernet (with network discovery), USB, RS-232 / RS-485 and
// demo devices, with the editor's device ID scan.

import { useEffect, useState } from 'react';
import { describeSource, DSP_TCP_PORT, MODELS, type DeviceInfo, type FoundModule, type ModelId, type Role, type SourceSpec } from '@dsp-studio/protocol';
import { confirmDialog, connectBridge, connectDevice, disconnectDevice, errorText, getState, login, promptDialog, run, selectDevice, toast, useApp } from '../state/store.ts';
import { go } from '../state/route.ts';
import { Badge, Button, Card, Field, Note, Segmented, Select, Spinner, Tabs, TextInput } from '../ui/kit.tsx';
import { Icon, type IconName } from '../ui/icons.tsx';
import { stateLabel } from '../ui/format.ts';
import type { Backend, PortsInfo } from '../client/types.ts';
import { hasWebHid, hasWebSerial } from '../client/webtransports.ts';
import { t, tm, tx } from '../i18n.tsx';

export function ConnectView(): React.JSX.Element {
  const backend = useApp((s) => s.backend);
  const mode = useApp((s) => s.mode);
  const role = useApp((s) => s.role);
  return (
    <div className="page">
      <div className="page-head"><h1>{t('Connexion')}</h1></div>
      <div className="cards">
        <ModeCard />
        <DevicesCard />
        {backend && role === 'admin' && (mode === 'bridge' ? <AddOnBridge backend={backend} /> : <AddInBrowser backend={backend} />)}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------ mode
const roleLabel = (r: Role): string => (r === 'admin' ? t('administrateur (tous les réglages)') : r === 'operator' ? t('opérateur (volumes, mutes, presets)') : t('lecture seule'));

function ModeCard(): React.JSX.Element {
  const mode = useApp((s) => s.mode);
  const served = useApp((s) => s.served);
  const status = useApp((s) => s.status);
  const role = useApp((s) => s.role);
  const pinRequired = useApp((s) => s.pinRequired);
  const backend = useApp((s) => s.backend);
  const saved = useApp((s) => s.prefs.bridgeUrl);
  const [addr, setAddr] = useState(saved.replace(/^wss?:\/\//, '').replace(/\/ws$/, ''));
  const changeRole = async (): Promise<void> => {
    const pin = await promptDialog({ title: t('Code d’accès'), message: t('Code administrateur (tous les réglages) ou opérateur (volumes, mutes, rappel de presets).'), label: t('Code'), inputMode: 'numeric', ok: t('Valider') });
    if (pin) await login(pin);
  };
  const connect = async (a: string): Promise<void> => {
    if (getState().devices.length && !await confirmDialog({ title: a ? t('Changer de pont') : t('Mode navigateur'), message: t('Les appareils de cette connexion ne seront plus affichés sur cet écran (ils restent connectés à leur pont).'), ok: t('Continuer') })) return;
    await connectBridge(a);
  };
  if (mode === 'bridge') {
    return (
      <Card title={<><Icon name="plug" size={18} />{' '}{t('Pont t.racks Studio')}</>} subtitle={t('Un ordinateur relié aux DSP partage leur pilotage avec tous les écrans du réseau.')}>
        <dl className="kv">
          <div><dt>{t('État')}</dt><dd>{status === 'online' ? <Badge tone="ok">{t('connecté')}</Badge> : <Badge tone="warn">{status === 'offline' ? t('injoignable, nouvel essai…') : t('connexion…')}</Badge>}</dd></div>
          <div><dt>{t('Version')}</dt><dd>{backend?.version || '—'}</dd></div>
          <div><dt>{t('Votre accès')}</dt><dd>{roleLabel(role)}</dd></div>
          {served && <div><dt>{t('Adresse à ouvrir sur les autres écrans')}</dt><dd><code>{window.location.origin}{window.location.pathname}</code></dd></div>}
        </dl>
        <div className="row wrap">
          {(pinRequired || role !== 'admin') && <Button small icon="user" onClick={changeRole}>{t('Changer d’accès')}</Button>}
          {!served && <Button small kind="ghost" onClick={() => connect('')}>{t('Passer en mode navigateur')}</Button>}
        </div>
      </Card>
    );
  }
  return (
    <Card title={<><Icon name="usb" size={18} />{' '}{t('Mode navigateur')}</>} subtitle={t('Ce navigateur pilote lui-même le DSP branché sur cet ordinateur (USB ou adaptateur série).')}>
      <p className="small">{t('Pour piloter depuis un téléphone ou une tablette, ou à plusieurs, lancez le pont t.racks Studio sur l’ordinateur relié aux DSP, puis ouvrez son adresse ou indiquez-la ici.')}</p>
      <form className="form form-inline" onSubmit={(e) => { e.preventDefault(); if (addr.trim()) void connect(addr.trim()); }}>
        <Field label={t('Adresse du pont')} hint={t('Exemple : 192.168.1.20 ou regie.local:8080')}>
          <TextInput value={addr} onChange={setAddr} placeholder="192.168.1.20" label={t('Adresse du pont')} />
        </Field>
        <Button type="submit" kind="primary" icon="plug" disabled={!addr.trim()}>{t('Se connecter au pont')}</Button>
      </form>
    </Card>
  );
}

// ------------------------------------------------------------------------------------ devices
const SOURCE_ICON: Record<SourceSpec['kind'], IconName> = { tcp: 'ethernet', usb: 'usb', webhid: 'usb', serial: 'serial', webserial: 'serial', demo: 'demo' };

function DevicesCard(): React.JSX.Element {
  const devices = useApp((s) => s.devices);
  const current = useApp((s) => s.current);
  const role = useApp((s) => s.role);
  const backend = useApp((s) => s.backend);
  return (
    <Card title={t('Appareils mémorisés')} subtitle={devices.length ? t('Les appareils déjà utilisés restent dans cette liste : connectez-vous à celui que vous voulez piloter. Plusieurs peuvent être connectés à la fois.') : undefined}>
      {devices.length === 0 && <p className="muted">{t('Aucun appareil pour l’instant.')}</p>}
      <div className="devs">
        {devices.map((d) => backend && <DeviceRow key={d.key} d={d} current={d.key === current} admin={role === 'admin'} operate={role !== 'viewer'} backend={backend} />)}
      </div>
    </Card>
  );
}

function DeviceRow({ d, current, admin, operate, backend }: { d: DeviceInfo; current: boolean; admin: boolean; operate: boolean; backend: Backend }): React.JSX.Element {
  const rename = async (): Promise<void> => {
    const v = await promptDialog({ title: t('Nom de l’appareil'), label: t('Nom'), value: d.label, maxLength: 60, ok: t('Renommer') });
    if (v !== null && v.trim()) await run(t('Renommage'), () => backend.renameDevice(d.key, v.trim()));
  };
  const remove = async (): Promise<void> => {
    if (!await confirmDialog({ title: t('Oublier l’appareil'), message: t('Retirer « {0} » de la liste des appareils mémorisés ? Ses réglages restent dans le DSP.', d.label), ok: t('Oublier'), danger: true })) return;
    if (current) selectDevice(null);
    await run(t('Retrait'), () => backend.removeDevice(d.key));
  };
  const live = d.state === 'online' || d.state === 'locked';
  return (
    <div className={`dev ${current ? 'is-on' : ''}`}>
      <span className="dev-icon"><Icon name={SOURCE_ICON[d.spec.kind]} /></span>
      <div className="grow dev-main">
        <div className="dev-title">
          <span className={`dot dot-${d.state}`} />
          <strong>{d.label}</strong>
          {d.model && <Badge>{MODELS[d.model].name}</Badge>}
          {current && <Badge tone="accent" title={t('Les pages de réglage montrent cet appareil (il est aussi choisi dans la barre du haut).')}>{t('sélectionné')}</Badge>}
        </div>
        <div className="small muted">{tm(describeSource(d.spec))} · {stateLabel(d.state)}{d.presetName ? ` · ${d.presetName}` : ''}</div>
        {d.state === 'offline' && d.error && <div className="small text-error">{errorText(d.error)}</div>}
      </div>
      <div className="dev-actions">
        {live && !current && <Button small kind="primary" title={t('Régler cet appareil dans les autres pages')} onClick={() => selectDevice(d.key)}>{t('Sélectionner')}</Button>}
        {!live && d.state !== 'connecting' && operate && (
          <Button small kind="primary" icon="plug" onClick={() => { connectDevice(d.key); selectDevice(d.key); }}>{d.state === 'offline' ? t('Réessayer') : t('Se connecter')}</Button>
        )}
        {d.state !== 'idle' && operate && <Button small onClick={() => disconnectDevice(d.key)}>{d.state === 'connecting' ? t('Annuler') : t('Se déconnecter')}</Button>}
        {admin && <Button small icon="edit" title={t('Renommer')} onClick={rename} />}
        {admin && <Button small icon="trash" title={t('Oublier')} onClick={remove} />}
      </div>
    </div>
  );
}

async function added(info: DeviceInfo | null | undefined): Promise<void> {
  if (!info) return;
  toast(t('{0} ajouté', tm(info.label)), 'ok');
  selectDevice(info.key);
  go('console');
}

// ------------------------------------------------------------------------------------ add (bridge)
type AddTab = 'tcp' | 'usb' | 'serial' | 'demo';
const bauds = (): { value: number; label: string }[] => [115200, 57600, 38400, 19200, 9600].map((b) => ({ value: b, label: t('{0} bauds', b) }));

/** Device ID (RS-485 lines can chain up to 250 DSPs; the editor's "ID Number Select"). */
function IdField({ value, onChange, onScan, scanning, found }: {
  value: string; onChange: (v: string) => void; onScan?: () => void; scanning?: boolean; found?: { id: number; version: string }[] | null;
}): React.JSX.Element {
  return (
    <div className="idfield">
      <Field label={t('ID de l’appareil')} hint={t('1 par défaut. À changer seulement si plusieurs DSP partagent une ligne RS-485.')}>
        <div className="row">
          <TextInput value={value} onChange={(v) => onChange(v.replace(/\D/g, '').slice(0, 3))} inputMode="numeric" label={t('ID de l’appareil')} className="input-xs" />
          {onScan && <Button small icon="search" disabled={scanning} onClick={onScan}>{scanning ? t('Recherche…') : t('Chercher les ID')}</Button>}
          {scanning && <Spinner />}
        </div>
      </Field>
      {found && (
        <div className="found">
          {found.length === 0 && <span className="small muted">{t('Aucun DSP n’a répondu (ID 1 à 16).')}</span>}
          {found.map((f) => (
            <button key={f.id} type="button" className={`pick ${String(f.id) === value ? 'is-on' : ''}`} onClick={() => onChange(String(f.id))}>{tx('ID {0} · {1}', f.id, f.version)}</button>
          ))}
        </div>
      )}
    </div>
  );
}

function useIdScan(backend: Backend): { found: { id: number; version: string }[] | null; scanning: boolean; scan: (spec: SourceSpec) => Promise<void>; reset: () => void } {
  const [found, setFound] = useState<{ id: number; version: string }[] | null>(null);
  const [scanning, setScanning] = useState(false);
  return {
    found, scanning,
    reset: () => setFound(null),
    scan: async (spec) => {
      setScanning(true); setFound(null);
      try { setFound(await backend.probe(spec, 16)); } catch (e) { toast(errorText(e), 'error'); } finally { setScanning(false); }
    },
  };
}

function AddOnBridge({ backend }: { backend: Backend }): React.JSX.Element {
  const [tab, setTab] = useState<AddTab>('tcp');
  const [id, setId] = useState('1');
  const [label, setLabel] = useState('');
  const idScan = useIdScan(backend);
  const deviceId = Math.min(250, Math.max(1, Number(id) || 1));
  const add = async (spec: SourceSpec): Promise<void> => {
    await added(await run(t('Ajout de l’appareil'), () => backend.addDevice({ ...spec, deviceId } as SourceSpec, label.trim() || undefined)));
  };
  const props: AddProps = {
    backend, onAdd: add, idScan, id, setId,
    name: (
      <Field label={t('Nom (facultatif)')} hint={t('Pour reconnaître l’appareil : « Façade », « Retours »…')}>
        <TextInput value={label} onChange={setLabel} maxLength={60} placeholder={t('Par défaut : le type de liaison')} label={t('Nom de l’appareil')} />
      </Field>
    ),
  };
  return (
    <Card title={t('Ajouter un appareil')} subtitle={t('Choisissez la liaison, renseignez l’appareil, puis touchez Ajouter : il rejoint les appareils mémorisés.')} className="span2">
      <Tabs label={t('Type de liaison')} value={tab} onChange={(t) => { setTab(t); idScan.reset(); }} tabs={[
        { id: 'tcp', label: <><Icon name="ethernet" size={16} />{' '}{t('Ethernet')}</> },
        { id: 'usb', label: <><Icon name="usb" size={16} />{' '}{t('USB')}</> },
        { id: 'serial', label: <><Icon name="serial" size={16} />{' '}{t('RS-232 / RS-485')}</> },
        { id: 'demo', label: <><Icon name="demo" size={16} />{' '}{t('Démo')}</> },
      ]} />
      {tab === 'tcp' && <AddTcp {...props} />}
      {tab === 'usb' && <AddUsb {...props} />}
      {tab === 'serial' && <AddSerial {...props} />}
      {tab === 'demo' && <AddDemo {...props} />}
    </Card>
  );
}

interface AddProps {
  backend: Backend; onAdd: (s: SourceSpec) => Promise<void>; idScan: ReturnType<typeof useIdScan>; id: string; setId: (v: string) => void;
  /** the optional name field, shared by every kind of link */
  name: React.ReactNode;
}

function AddTcp({ backend, onAdd, idScan, id, setId, name }: AddProps): React.JSX.Element {
  const [host, setHost] = useState('');
  const [port, setPort] = useState(String(DSP_TCP_PORT));
  const [found, setFound] = useState<FoundModule[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [sweep, setSweep] = useState(false);
  const spec = (): SourceSpec => ({ kind: 'tcp', host: host.trim(), port: Number(port) || DSP_TCP_PORT });
  const search = async (): Promise<void> => {
    setSearching(true); setFound(null);
    try { setFound(await backend.discover(sweep)); } catch (e) { toast(errorText(e), 'error'); } finally { setSearching(false); }
  };
  return (
    <form className="form add-form" onSubmit={(e) => { e.preventDefault(); if (host.trim()) void onAdd(spec()); }}>
      <div className="row wrap">
        <Button icon="search" disabled={searching} onClick={search}>{searching ? t('Recherche sur le réseau…') : t('Rechercher sur le réseau')}</Button>
        <label className="check">
          <input type="checkbox" checked={sweep} onChange={(e) => setSweep(e.target.checked)} />
          <span>{t('Sonder aussi chaque adresse du réseau local (plus long)')}</span>
        </label>
        {searching && <Spinner />}
      </div>
      {found && (
        <div className="found">
          {found.length === 0 && <span className="small muted">{t('Aucun module Ethernet trouvé. Vérifiez que le DSP et le pont sont sur le même réseau, ou saisissez son adresse.')}</span>}
          {found.map((f) => (
            <button key={f.host} type="button" className={`pick ${host.trim() === f.host ? 'is-on' : ''}`} title={f.mac || undefined}
              onClick={() => { setHost(f.host); setPort(String(DSP_TCP_PORT)); idScan.reset(); }}>
              {[f.host, tm(f.name)].filter(Boolean).join(' · ')}
            </button>
          ))}
        </div>
      )}
      <div className="form-inline">
        <Field label={t('Adresse IP du DSP')}><TextInput value={host} onChange={setHost} placeholder="192.168.1.101" label={t('Adresse IP du DSP')} /></Field>
        <Field label={t('Port')}><TextInput value={port} onChange={(v) => setPort(v.replace(/\D/g, '').slice(0, 5))} inputMode="numeric" label={t('Port TCP')} className="input-xs" /></Field>
      </div>
      <IdField value={id} onChange={setId} found={idScan.found} scanning={idScan.scanning} onScan={host.trim() ? () => idScan.scan(spec()) : undefined} />
      {name}
      <div className="row"><Button type="submit" kind="primary" icon="plus" disabled={!host.trim()}>{t('Ajouter')}</Button></div>
    </form>
  );
}

function usePorts(backend: Backend): { ports: PortsInfo | null; refresh: () => void } {
  const [ports, setPorts] = useState<PortsInfo | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    backend.ports().then((p) => { if (alive) setPorts(p); }, (e) => toast(errorText(e), 'error'));
    return () => { alive = false; };
  }, [backend, n]);
  return { ports, refresh: () => setN((x) => x + 1) };
}

function AddUsb({ backend, onAdd, idScan, id, setId, name }: AddProps): React.JSX.Element {
  const { ports, refresh } = usePorts(backend);
  const [path, setPath] = useState('');
  const usb = ports?.usb;
  // a single DSP plugged in is chosen at once
  const chosen = usb?.find((u) => u.path === path) ?? (usb?.length === 1 ? usb[0] : undefined);
  return (
    <div className="form add-form">
      {ports === null && <Spinner />}
      {ports && usb === null && <Note tone="warn">{tx('Le module USB n’est pas installé sur le pont : lancez {0} dans le dossier du pont, ou utilisez Ethernet ou RS-232.', <code>npm install node-hid</code>)}</Note>}
      <div className="found">
        {usb && usb.length === 0 && <span className="small muted">{t('Aucun DSP t.racks branché en USB sur l’ordinateur du pont.')}</span>}
        {usb?.map((u) => (
          <button key={u.path} type="button" className={`pick ${chosen?.path === u.path ? 'is-on' : ''}`} title={u.path}
            onClick={() => { setPath(u.path); idScan.reset(); }}>
            {[u.product, u.serial].filter(Boolean).join(' · ')}
          </button>
        ))}
        <Button small icon="refresh" onClick={refresh}>{t('Actualiser')}</Button>
      </div>
      <IdField value={id} onChange={setId} found={idScan.found} scanning={idScan.scanning} onScan={chosen ? () => idScan.scan({ kind: 'usb', path: chosen.path }) : undefined} />
      {name}
      <div className="row"><Button kind="primary" icon="plus" disabled={!chosen} onClick={() => { if (chosen) void onAdd({ kind: 'usb', path: chosen.path }); }}>{t('Ajouter')}</Button></div>
    </div>
  );
}

function AddSerial({ backend, onAdd, idScan, id, setId, name }: AddProps): React.JSX.Element {
  const { ports, refresh } = usePorts(backend);
  const [path, setPath] = useState('');
  const [baud, setBaud] = useState(115200);
  const serial = ports?.serial;
  const spec = (): SourceSpec => ({ kind: 'serial', path: path.trim(), baud });
  return (
    <form className="form add-form" onSubmit={(e) => { e.preventDefault(); if (path.trim()) void onAdd(spec()); }}>
      {ports && serial === null && <Note tone="warn">{tx('Le module série n’est pas installé sur le pont : lancez {0} dans le dossier du pont.', <code>npm install serialport</code>)}</Note>}
      <div className="found">
        {serial && serial.length === 0 && <span className="small muted">{t('Aucun port série détecté sur l’ordinateur du pont.')}</span>}
        {serial?.map((p) => (
          <button key={p.path} type="button" className={`pick ${path.trim() === p.path ? 'is-on' : ''}`} title={p.label || undefined}
            onClick={() => { setPath(p.path); idScan.reset(); }}>
            {[p.path, p.label].filter(Boolean).join(' · ')}
          </button>
        ))}
        <Button small icon="refresh" onClick={refresh}>{t('Actualiser')}</Button>
      </div>
      <div className="form-inline">
        <Field label={t('Port')}><TextInput value={path} onChange={setPath} placeholder={t('/dev/ttyUSB0 ou COM3')} label={t('Port série')} /></Field>
        <Field label={t('Débit')}><Select label={t('Débit')} value={baud} onChange={setBaud} options={bauds()} /></Field>
      </div>
      <p className="small muted">{t('Le DSP parle à 115200 bauds, 8 bits, sans parité. En RS-485, plusieurs DSP peuvent partager la ligne : donnez à chacun un ID différent (écran Appareil > Réseau).')}</p>
      <IdField value={id} onChange={setId} found={idScan.found} scanning={idScan.scanning} onScan={path.trim() ? () => idScan.scan(spec()) : undefined} />
      {name}
      <div className="row"><Button type="submit" kind="primary" icon="plus" disabled={!path.trim()}>{t('Ajouter')}</Button></div>
    </form>
  );
}

function AddDemo({ onAdd, name }: AddProps): React.JSX.Element {
  const [model, setModel] = useState<ModelId>('dsp408');
  return (
    <div className="form add-form">
      <p className="small">{t('Un DSP simulé, qui se comporte comme le vrai (mêmes réglages, mêmes réponses, vumètres animés) : idéal pour découvrir t.racks Studio ou préparer un preset sans le matériel.')}</p>
      <div><Segmented label={t('Modèle')} value={model} onChange={setModel} options={[{ value: 'dsp206', label: t('DSP 206 (2 × 6)') }, { value: 'dsp408', label: t('DSP 408 (4 × 8)') }]} /></div>
      {name}
      <div className="row"><Button kind="primary" icon="plus" onClick={() => onAdd({ kind: 'demo', model })}>{tx('Ajouter un {0} de démonstration', MODELS[model].name)}</Button></div>
    </div>
  );
}

// ------------------------------------------------------------------------------------ add (browser)
function AddInBrowser({ backend }: { backend: Backend }): React.JSX.Element {
  const [id, setId] = useState('1');
  const [baud, setBaud] = useState(115200);
  const [model, setModel] = useState<ModelId>('dsp408');
  const deviceId = Math.min(250, Math.max(1, Number(id) || 1));
  const hid = hasWebHid(), ser = hasWebSerial();
  const secure = window.isSecureContext;
  return (
    <Card title={t('Ajouter un appareil')} className="span2">
      {!secure && <Note tone="warn">{t('Cette page n’est pas sécurisée : le navigateur n’autorise l’USB et le port série que sur une adresse https ou localhost.')}</Note>}
      {secure && (!hid || !ser) && <Note>{t('L’USB (WebHID) et le port série (Web Serial) demandent Chrome, Edge ou Opera sur ordinateur. Sur téléphone ou tablette, passez par le pont t.racks Studio.')}</Note>}
      <div className="add-grid">
        <div className="add-box">
          <h3><Icon name="usb" size={18} />{' '}{t('USB')}</h3>
          <p className="small muted">{t('Branchez le DSP sur cet ordinateur, puis choisissez-le dans la liste du navigateur.')}</p>
          <Button kind="primary" disabled={!hid || !backend.requestUsb} onClick={async () => added(await run(t('Connexion USB'), () => backend.requestUsb!(deviceId)))}>{t('Choisir le DSP USB…')}</Button>
        </div>
        <div className="add-box">
          <h3><Icon name="serial" size={18} />{' '}{t('RS-232 / RS-485')}</h3>
          <p className="small muted">{t('Par un adaptateur USB-série relié au port du DSP.')}</p>
          <div className="row">
            <Select label={t('Débit')} value={baud} onChange={setBaud} options={bauds()} />
            <Button kind="primary" disabled={!ser || !backend.requestSerial} onClick={async () => added(await run(t('Connexion série'), () => backend.requestSerial!(baud, deviceId)))}>{t('Choisir le port…')}</Button>
          </div>
        </div>
        <div className="add-box">
          <h3><Icon name="demo" size={18} />{' '}{t('Démo')}</h3>
          <p className="small muted">{t('Un DSP simulé dans le navigateur, sans matériel.')}</p>
          <div className="row">
            <Segmented label={t('Modèle')} value={model} onChange={setModel} options={[{ value: 'dsp206', label: '206' }, { value: 'dsp408', label: '408' }]} />
            <Button kind="primary" icon="plus" onClick={async () => added(await run(t('Ajout'), () => backend.addDevice({ kind: 'demo', model, deviceId })))}>{t('Ajouter')}</Button>
          </div>
        </div>
      </div>
      <IdField value={id} onChange={setId} />
      <p className="small muted">{t('Ethernet : le navigateur ne peut pas ouvrir de connexion TCP vers le DSP ; utilisez le pont t.racks Studio.')}</p>
    </Card>
  );
}
