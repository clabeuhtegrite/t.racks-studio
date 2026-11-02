// DJ screen, for a tablet or a phone in the booth: says in big letters whether the level of the
// record is right and, when the automatic gain cannot fix it, what to do with the gain of the
// mixer; shows the level against the target zone, and lets the DJ pause the automatic gain for a
// few minutes (scratching, a microphone, a live act). Full screen when the browser allows it, and
// the screen stays on where the browser allows that (HTTPS or the computer itself).

import { useEffect, useState } from 'react';
import { connectDevice, selectDevice, useApp, useDevice } from '../state/store.ts';
import type { LevelerState } from '@dsp-studio/protocol';
import { adviceOf, fmtCountdown, statusText, useLeveler, useLiveLevel } from '../state/leveler.ts';
import { go, useRoute } from '../state/route.ts';
import { Badge, Button } from '../ui/kit.tsx';
import { Icon } from '../ui/icons.tsx';
import { LevelMeter } from '../ui/LevelMeter.tsx';
import { LevelPause } from '../ui/LevelPause.tsx';
import { fmtSigned, stateLabel } from '../ui/format.ts';
import { t, tm } from '../i18n.tsx';
import '../ui/level.css';

type Hero = { tone: 'none' | 'ok' | 'auto' | 'move' | 'clip'; icon: 'up' | 'down' | 'check' | 'auto' | 'warning' | 'wait'; main: string; sub?: string };

const SHAPES = {
  up: 'M12 20V5M5 11l7-7 7 7',
  down: 'M12 4v15M19 13l-7 7-7-7',
  check: 'M4 12.5l5 5L20 6.5',
  auto: 'M20 11a8 8 0 0 0-14-5L4 8M4 4v4h4M4 13a8 8 0 0 0 14 5l2-2M20 20v-4h-4',
  warning: 'M12 3l10 18H2zM12 10v5M12 18h.01',
  wait: 'M3 12h3l2-6 4 12 3-9 2 3h4',
};
function BigIcon({ shape }: { shape: Hero['icon'] }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={SHAPES[shape]} />
    </svg>
  );
}

/** Keeps the screen on while the DJ screen is shown (Screen Wake Lock: HTTPS or localhost only). */
function useWakeLock(): void {
  useEffect(() => {
    if (!('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let alive = true;
    const take = async (): Promise<void> => {
      if (!alive || lock || document.visibilityState !== 'visible') return;
      try {
        const l = await navigator.wakeLock.request('screen');
        if (!alive) { void l.release(); return; }
        lock = l;
        l.addEventListener('release', () => { if (lock === l) lock = null; });
      } catch { /* refused (battery saver, not allowed): the screen may go to sleep */ }
    };
    const onVisible = (): void => { void take(); };
    void take();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', onVisible);
      void lock?.release();
    };
  }, []);
}

/** The line about the automatic gain at the bottom of the screen. */
function autoLine(st: LevelerState): string {
  if (!st.settings.enabled) return t('Gain automatique désactivé : conseils seulement');
  const what = st.pause > 0 ? t('En pause, reprise dans {0}', fmtCountdown(st.pause)) : statusText(st.status);
  return t('Gain automatique : {0} — {1}', `${fmtSigned(st.correction)} dB`, what);
}

function useFullscreen(): { on: boolean; toggle: (() => void) | null } {
  const [on, setOn] = useState(() => !!document.fullscreenElement);
  useEffect(() => {
    const f = (): void => setOn(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', f);
    return () => {
      document.removeEventListener('fullscreenchange', f);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    };
  }, []);
  if (!document.fullscreenEnabled) return { on: false, toggle: null };
  return {
    on,
    toggle: () => {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
      else void document.documentElement.requestFullscreen().catch(() => {});
    },
  };
}

export function DjView(): React.JSX.Element {
  const route = useRoute();
  const devices = useApp((s) => s.devices);
  const current = useApp((s) => s.current);
  const role = useApp((s) => s.role);
  // #/dj/<device>: a tablet can stay on one device
  useEffect(() => {
    if (route.arg && route.arg !== current && devices.some((d) => d.key === route.arg)) selectDevice(route.arg);
  }, [route.arg, current, devices]);
  const { mirror, config } = useDevice();
  const st = useLeveler();
  const live = useLiveLevel(mirror, st, config);
  const full = useFullscreen();
  useWakeLock();

  const advice = adviceOf(st);
  let hero: Hero;
  const link = mirror?.info?.state;
  if (!mirror) hero = { tone: 'none', icon: 'wait', main: devices.length ? t('Choisissez un appareil') : t('Aucun appareil') };
  else if (link === 'connecting') hero = { tone: 'none', icon: 'wait', main: t('Connexion…') };
  else if (link === 'locked') hero = { tone: 'none', icon: 'warning', main: t('Appareil verrouillé') };
  else if (link !== 'online' || !st || st.status === 'offline' || !config) {
    hero = { tone: 'none', icon: 'wait', main: link === 'offline' ? t('Appareil hors ligne') : t('Appareil non connecté') };
  }
  else if (st.status === 'checking') hero = { tone: 'auto', icon: 'auto', main: statusText('checking') };
  else if (st.clip) hero = { tone: 'clip', icon: 'warning', main: t('Ça sature'), sub: t('Baissez la sortie de la table de mixage') };
  else if (advice.kind === 'up') hero = { tone: 'move', icon: 'up', main: t('Montez le gain'), sub: t('d’environ {0} dB', advice.db) };
  else if (advice.kind === 'down') hero = { tone: 'move', icon: 'down', main: t('Baissez le gain'), sub: t('d’environ {0} dB', advice.db) };
  else if (advice.kind === 'break') hero = { tone: 'ok', icon: 'wait', main: t('Break en cours'), sub: t('Rien à toucher : le niveau revient avec la musique') };
  else if (advice.kind === 'limit') hero = { tone: 'move', icon: 'warning', main: t('Ne montez pas le gain'), sub: t('Les limiteurs travaillent déjà') };
  else if (advice.kind === 'auto') hero = { tone: 'auto', icon: 'auto', main: t('Correction en cours'), sub: t('Le gain automatique s’en occupe : rien à toucher') };
  else if (advice.kind === 'ok') hero = { tone: 'ok', icon: 'check', main: t('Bon niveau'), sub: t('Rien à toucher') };
  else if (advice.kind === 'quiet') hero = { tone: 'ok', icon: 'check', main: t('Passage calme'), sub: t('Rien à toucher : le reste du disque est au bon niveau') };
  else hero = { tone: 'none', icon: 'wait', main: t('En attente de musique') };

  const name = mirror ? tm(mirror.info?.label ?? '') : '';
  return (
    <div className="dj">
      <header className="dj-head">
        <div className="dj-name">
          <span>{name}</span>
          {mirror?.info && mirror.info.state !== 'online' && <Badge tone="warn">{stateLabel(mirror.info.state)}</Badge>}
        </div>
        <div className="row">
          {full.toggle && (
            <button type="button" className="btn btn-ghost" onClick={full.toggle} aria-pressed={full.on}>
              <Icon name={full.on ? 'shrink' : 'expand'} />
              <span>{full.on ? t('Quitter le plein écran') : t('Plein écran')}</span>
            </button>
          )}
          <Button kind="ghost" icon="close" onClick={() => go('niveau')}>{t('Fermer')}</Button>
        </div>
      </header>

      <main className={`dj-hero dj-${hero.tone}`} aria-live="polite">
        <p className="dj-main"><BigIcon shape={hero.icon} /><span>{hero.main}</span></p>
        {hero.sub && <p className="dj-sub">{hero.sub}</p>}
        {mirror && (link === 'idle' || link === 'offline') && role !== 'viewer' && (
          <Button kind="primary" icon="plug" onClick={() => connectDevice(mirror.key)}>{link === 'offline' ? t('Réessayer') : t('Se connecter')}</Button>
        )}
      </main>

      {st && st.status !== 'offline' && config && (
        <section className="dj-meter" aria-label={t('Niveau')}>
          <LevelMeter st={st} level={live} label={t('Niveau des entrées suivies')} big showState />
        </section>
      )}

      {st && st.status !== 'offline' && (
        <footer className="dj-foot">
          <div className="dj-foot-text">
            <p className="dj-line">
              <Icon name="wave" />
              <span>{autoLine(st)}</span>
            </p>
            {st.limiting && <p className="dj-line dj-warn"><Icon name="warning" /><span>{t('Le limiteur d’une sortie travaille.')}</span></p>}
          </div>
          {mirror && role !== 'viewer' && <LevelPause mirror={mirror} st={st} countdown={false} />}
        </footer>
      )}
    </div>
  );
}
