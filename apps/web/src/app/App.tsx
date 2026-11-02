// Application shell: top bar (device, preset, undo / redo, A/B), navigation (side rail on large
// screens, bottom bar on phones), the current screen, messages and dialogs.

import { useEffect, useState, type ReactNode } from 'react';
import { MODELS } from '@dsp-studio/protocol';
import { closeDialog, connectDevice, disconnectDevice, errorText, getState, login, promptDialog, run, selectDevice, setLanguage, setPrefs, toast, useApp, useDevice } from '../state/store.ts';
import { go, href, useRoute, type ViewId } from '../state/route.ts';
import { Icon, type IconName } from '../ui/icons.tsx';
import { Badge, Button, Empty, Modal, Progress, Spinner, TextInput } from '../ui/kit.tsx';
import { presetLabel, stateLabel } from '../ui/format.ts';
import { ConsoleView } from '../views/ConsoleView.tsx';
import { ChannelView } from '../views/ChannelView.tsx';
import { DelayView, DynamicsView, GeqView, MatrixView } from '../views/OverviewViews.tsx';
import { PresetsView } from '../views/PresetsView.tsx';
import { DeviceView, UnlockCard } from '../views/DeviceView.tsx';
import { ToolsView } from '../views/ToolsView.tsx';
import { ConnectView } from '../views/ConnectView.tsx';
import { LibraryView } from '../views/LibraryView.tsx';
import { SheetView } from '../views/SheetView.tsx';
import { LANGS, t, tm, tx, type Lang } from '../i18n.tsx';

interface NavItem { view: ViewId; label: string; icon: IconName; mobile?: boolean }
const nav = (): NavItem[] => [
  { view: 'console', label: t('Console'), icon: 'console', mobile: true },
  { view: 'canal', label: t('Canaux'), icon: 'eq', mobile: true },
  { view: 'geq', label: t('EQ graphique'), icon: 'geq' },
  { view: 'dynamique', label: t('Dynamique'), icon: 'dynamics' },
  { view: 'delais', label: t('Délais'), icon: 'delay' },
  { view: 'matrice', label: t('Matrice'), icon: 'matrix', mobile: true },
  { view: 'presets', label: t('Presets'), icon: 'presets', mobile: true },
  { view: 'bibliotheque', label: t('Bibliothèque'), icon: 'library' },
  { view: 'appareil', label: t('Appareil'), icon: 'device' },
  { view: 'outils', label: t('Outils'), icon: 'tools' },
  { view: 'connexion', label: t('Connexion'), icon: 'plug' },
];
const NEEDS_CONFIG: ViewId[] = ['console', 'canal', 'geq', 'dynamique', 'delais', 'matrice', 'fiche'];

function useTheme(): void {
  const theme = useApp((s) => s.prefs.theme);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const apply = (): void => {
      const t = theme === 'auto' ? (mq.matches ? 'light' : 'dark') : theme;
      document.documentElement.dataset.theme = t;
      document.querySelector('meta[name=theme-color]')?.setAttribute('content', t === 'light' ? '#f3f5f8' : '#0f1216');
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);
}

function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable) return;
      const m = getState().mirror;
      if (!m || !(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); m.undo(); }
      else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); m.redo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export function App(): React.JSX.Element {
  useTheme();
  useShortcuts();
  const route = useRoute();
  const status = useApp((s) => s.status);
  const { mirror, snap, config } = useDevice();
  const devices = useApp((s) => s.devices);
  const role = useApp((s) => s.role);

  let body: ReactNode;
  const needsConfig = NEEDS_CONFIG.includes(route.view) || route.view === 'presets' || route.view === 'appareil';
  if (status === 'starting') body = <Empty icon="plug" title={t('Connexion…')}><Spinner /></Empty>;
  else if (needsConfig && !mirror) {
    body = (
      <Empty icon="plug" title={devices.length ? t('Choisissez un appareil') : t('Aucun appareil')}>
        <p className="muted">{t('Ajoutez un DSP (USB, Ethernet, RS-232 / RS-485) ou essayez un DSP de démonstration.')}</p>
        <Button kind="primary" icon="plus" onClick={() => go('connexion')}>{t('Ajouter un appareil')}</Button>
      </Empty>
    );
  } else if (needsConfig && snap?.status === 'locked') {
    body = <div className="page"><UnlockCard /></div>;
  } else if (needsConfig && (!config || !snap)) {
    // remembered but not connected, connection lost, or connecting / reading
    const info = mirror?.info;
    const st = info?.state;
    const operate = role !== 'viewer';
    if (mirror && (st === 'idle' || st === 'offline')) {
      body = (
        <Empty icon={st === 'offline' ? 'warning' : 'plug'} title={st === 'offline' ? t('Appareil hors ligne') : t('Appareil non connecté')}>
          <p className="muted">{st === 'offline' ? (info?.error ? errorText(info.error) : t('Pas de liaison avec le DSP.')) : t('« {0} » est mémorisé : connectez-vous pour le piloter.', tm(info?.label ?? ''))}</p>
          {operate && (
            <div className="row center">
              <Button kind="primary" icon="plug" onClick={() => connectDevice(mirror.key)}>{st === 'offline' ? t('Réessayer') : t('Se connecter')}</Button>
              {st === 'offline' && <Button onClick={() => disconnectDevice(mirror.key)}>{t('Se déconnecter')}</Button>}
            </div>
          )}
        </Empty>
      );
    } else {
      body = (
        <Empty icon="refresh" title={st === 'connecting' ? t('Connexion…') : t('Lecture de la configuration…')}>
          <Spinner />
          {mirror && st === 'connecting' && operate && <Button onClick={() => disconnectDevice(mirror.key)}>{t('Annuler')}</Button>}
        </Empty>
      );
    }
  } else {
    switch (route.view) {
      case 'console': body = <ConsoleView />; break;
      case 'canal': body = <ChannelView />; break;
      case 'geq': body = <GeqView />; break;
      case 'dynamique': body = <DynamicsView />; break;
      case 'delais': body = <DelayView />; break;
      case 'matrice': body = <MatrixView />; break;
      case 'presets': body = <PresetsView />; break;
      case 'appareil': body = <DeviceView />; break;
      case 'outils': body = <ToolsView />; break;
      case 'connexion': body = <ConnectView />; break;
      case 'bibliotheque': body = <LibraryView />; break;
      case 'fiche': body = <SheetView />; break;
    }
  }

  return (
    <div className={`app view-${route.view}`}>
      <TopBar />
      <nav className="rail" aria-label={t('Navigation')}>
        {nav().map((n) => <NavLink key={n.view} item={n} active={route.view === n.view} />)}
        <div className="rail-foot"><ThemeButton /><LangSelect /><LangSelect short /></div>
      </nav>
      <main className="main" id="main">
        <OfflineBanner />
        <ProgressStrip />
        {body}
      </main>
      <BottomNav current={route.view} />
      <Toasts />
      <DialogHost />
      <BusyOverlay />
    </div>
  );
}

function NavLink({ item, active, onClick }: { item: NavItem; active: boolean; onClick?: () => void }): React.JSX.Element {
  return (
    <a href={href(item.view)} className={`nav-link ${active ? 'is-on' : ''}`} aria-current={active ? 'page' : undefined} onClick={onClick}>
      <Icon name={item.icon} />
      <span>{item.label}</span>
    </a>
  );
}

function BottomNav({ current }: { current: ViewId }): React.JSX.Element {
  const [more, setMore] = useState(false);
  const items = nav();
  const main = items.filter((n) => n.mobile);
  const others = items.filter((n) => !n.mobile);
  const inOthers = others.some((n) => n.view === current);
  return (
    <>
      <nav className="bottom" aria-label={t('Navigation')}>
        {main.map((n) => <NavLink key={n.view} item={n} active={current === n.view} />)}
        <button type="button" className={`nav-link ${inOthers || more ? 'is-on' : ''}`} onClick={() => setMore(true)} aria-haspopup="dialog">
          <Icon name="more" /><span>{t('Plus')}</span>
        </button>
      </nav>
      {more && (
        <div className="sheet-back" onPointerDown={(e) => { if (e.target === e.currentTarget) setMore(false); }}>
          <div className="sheet" role="dialog" aria-label={t('Autres écrans')}>
            <div className="sheet-grid">
              {others.map((n) => <NavLink key={n.view} item={n} active={current === n.view} onClick={() => setMore(false)} />)}
            </div>
            <div className="sheet-foot"><div className="row"><ThemeButton /><LangSelect /></div><Button onClick={() => setMore(false)}>{t('Fermer')}</Button></div>
          </div>
        </div>
      )}
    </>
  );
}

/** Language of the interface (the full choice, with "automatic", is in Tools > Preferences). */
function LangSelect({ short = false }: { short?: boolean }): React.JSX.Element {
  const lang = useApp((s) => s.lang);
  return (
    <select className={`select select-sm lang-select ${short ? 'lang-short' : 'lang-long'}`} aria-label={t('Langue')} title={t('Langue')} value={lang} onChange={(e) => setLanguage(e.target.value as Lang)}>
      {LANGS.map((l) => <option key={l.id} value={l.id} lang={l.id}>{short ? l.id.toUpperCase() : `${l.id.toUpperCase()} · ${l.name}`}</option>)}
    </select>
  );
}

function ThemeButton(): React.JSX.Element {
  const theme = useApp((s) => s.prefs.theme);
  const next = theme === 'auto' ? 'dark' : theme === 'dark' ? 'light' : 'auto';
  const label = theme === 'auto' ? t('Thème : automatique') : theme === 'dark' ? t('Thème : sombre') : t('Thème : clair');
  return <Button small icon={theme === 'light' ? 'sun' : 'moon'} title={label} onClick={() => setPrefs({ theme: next })}>{theme === 'auto' ? t('Auto') : theme === 'dark' ? t('Sombre') : t('Clair')}</Button>;
}

function TopBar(): React.JSX.Element {
  const { mirror, snap, config } = useDevice();
  const role = useApp((s) => s.role);
  const pinRequired = useApp((s) => s.pinRequired);
  const mode = useApp((s) => s.mode);
  return (
    <header className="top">
      <a className="brand" href={href('console')} aria-label={t('t.racks Studio, accueil')}>
        <img src="./icon.svg" alt="" width={28} height={28} />
        <span>t.racks Studio</span>
      </a>
      <DevicePicker />
      {snap && config && (
        <a className="preset-badge" href={href('presets')} title={t('Presets')}>
          <span className="preset-num">{presetLabel(snap.activePreset)}</span>
          <span className="preset-name">{config.presetName || t('Sans nom')}</span>
        </a>
      )}
      <div className="top-spacer" />
      {mode === 'local' && <Badge tone="muted" title={t('Le navigateur pilote directement le DSP')}>{t('Navigateur')}</Badge>}
      {(role !== 'admin' || pinRequired) && <RoleButton />}
      {mirror && config && role !== 'viewer' && <HistoryButtons />}
      {mirror && config && role === 'admin' && <AbButton />}
    </header>
  );
}

function RoleButton(): React.JSX.Element {
  const role = useApp((s) => s.role);
  const label = role === 'admin' ? t('Administrateur') : role === 'operator' ? t('Opérateur') : t('Lecture seule');
  return (
    <Button small icon="user" kind="ghost" title={t('Changer d’accès (code PIN)')} onClick={async () => {
      const pin = await promptDialog({ title: t('Code d’accès'), message: t('Code administrateur (tous les réglages) ou opérateur (volumes, mutes, rappel de presets).'), label: t('Code'), inputMode: 'numeric', ok: t('Valider') });
      if (pin) await login(pin);
    }}>{label}</Button>
  );
}

function HistoryButtons(): React.JSX.Element {
  const { mirror } = useDevice();
  if (!mirror) return <></>;
  const u = mirror.undoStack.length, r = mirror.redoStack.length;
  return (
    <div className="btn-group">
      <Button small icon="undo" title={u ? t('Annuler (Ctrl+Z)') : t('Annuler (Ctrl+Z) : rien à annuler')} disabled={!u || mirror.readOnly} onClick={() => mirror.undo()} />
      <Button small icon="redo" title={t('Rétablir (Ctrl+Maj+Z)')} disabled={!r || mirror.readOnly} onClick={() => mirror.redo()} />
    </div>
  );
}

function AbButton(): React.JSX.Element {
  const { mirror } = useDevice();
  const [open, setOpen] = useState(false);
  if (!mirror) return <></>;
  const { A, B, active } = mirror.ab;
  const recall = (s: 'A' | 'B'): void => { void run(t('Comparaison {0}', s), () => mirror.recallAB(s)); };
  return (
    <div className="ab">
      <div className="btn-group">
        {(['A', 'B'] as const).map((s) => (
          <Button
            key={s} small active={active === s} disabled={mirror.readOnly}
            title={(s === 'A' ? A : B) ? t('Écouter la version {0}', s) : t('Mémoriser les réglages actuels en {0}', s)}
            onClick={() => ((s === 'A' ? A : B) ? recall(s) : mirror.storeAB(s))}
          >{s}{(s === 'A' ? A : B) ? '' : '+'}</Button>
        ))}
        <Button small icon="chevronDown" title={t('Comparaison A/B')} onClick={() => setOpen(true)} />
      </div>
      <Button small className="ab-mobile" active={!!active} title={t('Comparaison A/B')} onClick={() => setOpen(true)}>{active ?? 'A/B'}</Button>
      {open && (
        <Modal title={t('Comparaison A / B')} onClose={() => setOpen(false)}>
          <p className="muted">{t('Mémorisez deux versions de vos réglages et passez de l’une à l’autre pour comparer à l’oreille. Seuls les paramètres qui diffèrent sont envoyés, le changement est donc rapide.')}</p>
          <div className="grid2">
            {(['A', 'B'] as const).map((s) => (
              <div key={s} className="ab-slot">
                <h3>{tx('Version {0}', s)}{' '}{active === s && <Badge tone="accent">{t('en écoute')}</Badge>}</h3>
                <p className="small muted">{(s === 'A' ? A : B) ? t('Mémorisée') : t('Vide')}</p>
                <div className="row">
                  <Button small icon="save" onClick={() => { mirror.storeAB(s); toast(t('Réglages mémorisés en {0}', s), 'ok'); }}>{t('Mémoriser ici')}</Button>
                  <Button small icon="play" disabled={!(s === 'A' ? A : B)} onClick={() => { recall(s); setOpen(false); }}>{t('Écouter')}</Button>
                </div>
              </div>
            ))}
          </div>
          <div className="row end"><Button small kind="ghost" icon="trash" onClick={() => mirror.clearAB()}>{t('Effacer A et B')}</Button></div>
        </Modal>
      )}
    </div>
  );
}

function DevicePicker(): React.JSX.Element {
  const devices = useApp((s) => s.devices);
  const current = useApp((s) => s.current);
  const [open, setOpen] = useState(false);
  const cur = devices.find((d) => d.key === current);
  return (
    <div className="devpick">
      <button type="button" className="devpick-btn" onClick={() => setOpen(!open)} aria-haspopup="listbox" aria-expanded={open}>
        <span className={`dot dot-${cur?.state ?? 'none'}`} />
        <span className="devpick-label">{cur ? cur.label : t('Aucun appareil')}</span>
        {cur?.model && <span className="devpick-model">{MODELS[cur.model].name}</span>}
        <Icon name="chevronDown" size={16} />
      </button>
      {open && (
        <>
          <div className="pop-back" onPointerDown={() => setOpen(false)} />
          <div className="pop" role="listbox">
            {devices.map((d) => (
              <button key={d.key} type="button" role="option" aria-selected={d.key === current} className={`pop-item ${d.key === current ? 'is-on' : ''}`}
                onClick={() => { selectDevice(d.key); setOpen(false); }}>
                <span className={`dot dot-${d.state}`} />
                <span className="grow">{d.label}<small className="muted block">{d.model ? MODELS[d.model].name : ''} {stateLabel(d.state)}{d.presetName ? ` · ${d.presetName}` : ''}</small></span>
              </button>
            ))}
            <a className="pop-item" href={href('connexion')} onClick={() => setOpen(false)}><Icon name="plus" />{' '}{t('Gérer les appareils')}</a>
          </div>
        </>
      )}
    </div>
  );
}

function OfflineBanner(): React.JSX.Element | null {
  const status = useApp((s) => s.status);
  const mode = useApp((s) => s.mode);
  if (status !== 'offline' || mode !== 'bridge') return null;
  return <div className="banner banner-warn"><Spinner />{' '}{t('Liaison avec le pont perdue, reconnexion…')}</div>;
}

function ProgressStrip(): React.JSX.Element | null {
  const { snap } = useDevice();
  const p = snap?.progress;
  if (!p) return null;
  return (
    <div className="banner">
      <span>{tm(p.label)}</span>
      <Progress value={p.done} max={p.total} label={tm(p.label)} />
    </div>
  );
}

function Toasts(): React.JSX.Element {
  const toasts = useApp((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
          <Icon name={t.kind === 'ok' ? 'check' : t.kind === 'info' ? 'info' : 'warning'} />
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}

function BusyOverlay(): React.JSX.Element | null {
  const busy = useApp((s) => s.busy);
  if (!busy) return null;
  return <div className="busy" role="status"><Spinner /><span>{busy}…</span></div>;
}

function DialogHost(): React.JSX.Element | null {
  const d = useApp((s) => s.dialog);
  const [text, setText] = useState('');
  useEffect(() => { if (d?.kind === 'prompt') setText(d.value); }, [d]);
  if (!d) return null;
  if (d.kind === 'confirm') {
    const done = (v: boolean): void => { closeDialog(); d.resolve(v); };
    return (
      <Modal title={d.title} onClose={() => done(false)} footer={<>
        <Button onClick={() => done(false)}>{t('Annuler')}</Button>
        <Button kind={d.danger ? 'danger' : 'primary'} onClick={() => done(true)}>{d.ok}</Button>
      </>}>
        <p className="pre">{d.message}</p>
      </Modal>
    );
  }
  const done = (v: string | null): void => { closeDialog(); d.resolve(v); };
  return (
    <Modal title={d.title} onClose={() => done(null)} footer={<>
      <Button onClick={() => done(null)}>{t('Annuler')}</Button>
      <Button kind="primary" onClick={() => done(text)}>{d.ok}</Button>
    </>}>
      {d.message && <p className="muted pre">{d.message}</p>}
      <label className="field">
        <span className="field-label">{d.label}</span>
        <TextInput value={text} onChange={setText} maxLength={d.maxLength} inputMode={d.inputMode} autoFocus onEnter={() => done(text)} label={d.label} />
        {d.maxLength && <span className="field-hint">{tx('{0} / {1} caractères', text.length, d.maxLength)}</span>}
      </label>
    </Modal>
  );
}
