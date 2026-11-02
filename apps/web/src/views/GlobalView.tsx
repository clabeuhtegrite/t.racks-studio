// Overview of every device, live: level of each channel (clip and limiter LEDs), mute, volume, a
// small response curve and the active blocks of the channel with their main setting (the editor's
// hidden block diagram), plus the state of each device: connection, preset, lock, links, test
// generator. Mutes work from here; a tap on a channel opens it.

import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { describeSource, dynamicsActive, GEQ_FREQS, logFreqs, meterZones, MODELS, type AnyChannel, type DeviceConfig, type DeviceInfo } from '@dsp-studio/protocol';
import { DeviceMirror } from '../client/mirror.ts';
import type { Backend } from '../client/types.ts';
import { connectDevice, errorText, selectDevice, toast, useApp } from '../state/store.ts';
import { go } from '../state/route.ts';
import { Badge, Button, Card, Empty, Toggle } from '../ui/kit.tsx';
import { Meter } from '../ui/Meter.tsx';
import { Icon } from '../ui/icons.tsx';
import { fmtIsoHz, P, presetLabel, stateLabel } from '../ui/format.ts';
import { channelBlocks, chan, colorOf, labelOf, linkMates, responseOf } from '../ui/channels.tsx';
import { t, tm } from '../i18n.tsx';

export function GlobalView(): React.JSX.Element {
  const devices = useApp((s) => s.devices);
  const current = useApp((s) => s.current);
  const backend = useApp((s) => s.backend);
  const main = useApp((s) => s.mirror);
  const others = useOtherMirrors(backend, devices, current);
  const ordered = [...devices.filter((d) => d.key === current), ...devices.filter((d) => d.key !== current)];
  return (
    <div className="page page-wide">
      <div className="page-head">
        <div>
          <h1>{t('Vue globale')}</h1>
          <p className="muted small">{t('En direct : niveaux, volumes, mutes et traitements actifs de chaque canal, pour chaque appareil.')}</p>
        </div>
      </div>
      {devices.length === 0 && (
        <Empty icon="plug" title={t('Aucun appareil')}>
          <p className="muted">{t('Ajoutez un DSP (USB, Ethernet, RS-232 / RS-485) ou essayez un DSP de démonstration.')}</p>
          <Button kind="primary" icon="plus" onClick={() => go('connexion')}>{t('Ajouter un appareil')}</Button>
        </Empty>
      )}
      {ordered.map((d) => {
        const m = d.key === current ? main : others.get(d.key);
        return m && m.key === d.key && (d.state === 'online' || d.state === 'locked')
          ? <DeviceOverview key={d.key} mirror={m} isCurrent={d.key === current} />
          : <DeviceLine key={d.key} info={d} />;
      })}
    </div>
  );
}

/** Mirrors of the connected devices other than the current one, while the page is shown. */
function useOtherMirrors(backend: Backend | null, devices: DeviceInfo[], current: string | null): Map<string, DeviceMirror> {
  const mirrors = useRef(new Map<string, DeviceMirror>());
  const [, redraw] = useState(0);
  const wanted = backend ? devices.filter((d) => d.key !== current && (d.state === 'online' || d.state === 'locked')).map((d) => d.key) : [];
  const sig = wanted.join('\n');
  useEffect(() => {
    const map = mirrors.current;
    for (const [k, m] of map) {
      if (!wanted.includes(k) || m.backend !== backend) { m.stop(); map.delete(k); }
    }
    for (const k of wanted) {
      if (map.has(k) || !backend) continue;
      const m = new DeviceMirror(backend, k, (msg) => toast(errorText(msg), 'error'));
      map.set(k, m);
      void m.start();
    }
    redraw((n) => n + 1);
  }, [sig, backend]); // `wanted` is summed up by `sig`
  useEffect(() => () => { for (const m of mirrors.current.values()) m.stop(); mirrors.current.clear(); }, []);
  return mirrors.current;
}

const useRev = (m: DeviceMirror): number => useSyncExternalStore(m.subscribe, () => m.rev);
const useMeterState = (m: DeviceMirror): DeviceMirror['meters'] => {
  useSyncExternalStore(m.subscribeMeters, () => m.meterRev);
  return m.meters;
};

/** Opens a device in the editor (another device becomes the current one first). */
function open(key: string, isCurrent: boolean, view: 'console' | 'canal' | 'presets', ch?: number): void {
  if (!isCurrent) selectDevice(key);
  go(view, ch);
}

function DeviceOverview({ mirror, isCurrent }: { mirror: DeviceMirror; isCurrent: boolean }): React.JSX.Element {
  useRev(mirror);
  const role = useApp((s) => s.role);
  const { info, snap, config } = mirror;
  const locked = snap?.status === 'locked';
  const canOperate = (role === 'admin' || role === 'operator') && !locked && !!config;
  const m = config ? MODELS[config.model] : null;
  const outs = m ? Array.from({ length: m.outputs }, (_, j) => m.inputs + j) : [];
  const allOutMuted = !!config && outs.every((ch) => chan(config, ch).mute);
  return (
    <Card className="gv-dev">
      <DeviceHead info={info} mirror={mirror} isCurrent={isCurrent}>
        {config && (
          <div className="gv-actions">
            <Button small icon="console" onClick={() => open(mirror.key, isCurrent, 'console')}>{t('Console')}</Button>
            <Button small icon={allOutMuted ? 'speaker' : 'mute'} kind={allOutMuted ? 'plain' : 'danger'} disabled={!canOperate}
              title={t('Coupe ou rétablit toutes les sorties d’un coup')}
              onClick={() => outs.forEach((ch) => { if (chan(config, ch).mute === allOutMuted) mirror.apply({ t: 'mute', ch, on: !allOutMuted }); })}>
              {allOutMuted ? t('Rétablir les sorties') : t('Couper les sorties')}
            </Button>
          </div>
        )}
      </DeviceHead>
      {config && m ? (
        <>
          <DeviceFacts cfg={config} />
          <h3 className="gv-group">{t('Entrées')}</h3>
          <div className="gv-grid">
            {config.inputs.map((c, i) => <ChannelTile key={i} mirror={mirror} cfg={config} ch={i} c={c} linked={linkMates(config, i).length > 0} canOperate={canOperate} isCurrent={isCurrent} />)}
          </div>
          <h3 className="gv-group">{t('Sorties')}</h3>
          <div className="gv-grid">
            {config.outputs.map((c, j) => <ChannelTile key={j} mirror={mirror} cfg={config} ch={m.inputs + j} c={c} linked={linkMates(config, m.inputs + j).length > 0} canOperate={canOperate} isCurrent={isCurrent} />)}
          </div>
        </>
      ) : (
        <div className="row wrap">
          <p className="muted">{locked ? t('Appareil verrouillé par mot de passe.') : t('Lecture de la configuration…')}</p>
          {locked && <Button small icon="unlock" onClick={() => open(mirror.key, isCurrent, 'console')}>{t('Déverrouiller')}</Button>}
        </div>
      )}
    </Card>
  );
}

function DeviceHead({ info, mirror, isCurrent, children }: { info: DeviceInfo | null; mirror: DeviceMirror; isCurrent: boolean; children?: ReactNode }): React.JSX.Element {
  const { snap, config } = mirror;
  const state = snap?.status === 'locked' ? 'locked' : info?.state ?? 'connecting';
  return (
    <header className="gv-head">
      <span className={`dot dot-${state}`} />
      <div className="gv-name">
        <h2>{info ? info.label : mirror.key}</h2>
        <span className="muted small">
          {deviceLine(info, state)}
        </span>
      </div>
      {snap && config && (
        <button type="button" className="gv-preset" onClick={() => open(mirror.key, isCurrent, 'presets')} title={t('Preset en cours : ouvrir les presets')}>
          <span className="preset-num">{presetLabel(snap.activePreset)}</span>
          <span>{config.presetName || t('Sans nom')}</span>
        </button>
      )}
      <LiveAlerts mirror={mirror} />
      {children}
    </header>
  );
}

/** Settings that matter for the whole device: test generator, links, delay unit. */
function DeviceFacts({ cfg }: { cfg: DeviceConfig }): React.JSX.Element | null {
  const m = MODELS[cfg.model];
  const all = Array.from({ length: m.inputs + m.outputs }, (_, i) => i);
  const groups: string[] = [];
  const seen = new Set<number>();
  for (const ch of all) {
    if (seen.has(ch)) continue;
    const mates = linkMates(cfg, ch);
    if (!mates.length) continue;
    [ch, ...mates].forEach((x) => seen.add(x));
    groups.push([ch, ...mates].map((x) => labelOf(cfg, x)).join(' + '));
  }
  const tone = cfg.toneSource === 1 ? t('bruit rose') : cfg.toneSource === 2 ? t('bruit blanc') : cfg.toneSource === 3 ? t('sinus à {0}', fmtIsoHz(GEQ_FREQS[cfg.toneFreq])) : '';
  if (!tone && !groups.length) return null;
  return (
    <div className="gv-facts">
      {tone && <Badge tone="warn" title={t('Le générateur remplace les entrées : Appareil > Générateur pour l’arrêter')}><Icon name="warning" size={13} />{t('Générateur actif : {0}', tone)}</Badge>}
      {groups.map((g) => <Badge key={g} tone="muted" title={t('Canaux liés : chaque réglage s’applique au groupe')}><Icon name="link" size={13} />{g}</Badge>)}
    </div>
  );
}

/** Channels clipping (red segment of the editors' bars), compressing or limiting right now. */
function LiveAlerts({ mirror }: { mirror: DeviceMirror }): React.JSX.Element | null {
  const meters = useMeterState(mirror);
  const cfg = mirror.config;
  if (!meters || !cfg) return null;
  const m = MODELS[cfg.model];
  const clip = meters.db.map((db, ch) => (db > meterZones(cfg.model, ch).red ? labelOf(cfg, ch) : '')).filter(Boolean);
  const outs = Array.from({ length: m.outputs }, (_, j) => m.inputs + j).map((ch) => ({ ch, ...dynamicsActive(meters.status, cfg, ch) }));
  const comp = outs.filter((o) => o.comp).map((o) => labelOf(cfg, o.ch));
  const lim = outs.filter((o) => o.limit).map((o) => labelOf(cfg, o.ch));
  if (!clip.length && !comp.length && !lim.length) return null;
  return (
    <span className="gv-alerts" role="status">
      {clip.length > 0 && <Badge tone="error">{t('Écrêtage : {0}', clip.join(', '))}</Badge>}
      {comp.length > 0 && <Badge tone="warn">{t('Compresseur : {0}', comp.join(', '))}</Badge>}
      {lim.length > 0 && <Badge tone="warn">{t('Limiteur : {0}', lim.join(', '))}</Badge>}
    </span>
  );
}

interface TileProps { mirror: DeviceMirror; cfg: DeviceConfig; ch: number; c: AnyChannel; linked: boolean; canOperate: boolean; isCurrent: boolean }
/** Drawn again only when its channel changes: the configuration object is new after every edit, a channel object only after its own. */
const sameTile = (a: TileProps, b: TileProps): boolean =>
  a.c === b.c && a.linked === b.linked && a.canOperate === b.canOperate && a.isCurrent === b.isCurrent && a.mirror === b.mirror && a.cfg.delayUnit === b.cfg.delayUnit && a.cfg.model === b.cfg.model;

const ChannelTile = memo(function ChannelTile(p: TileProps): React.JSX.Element {
  const { mirror, cfg, ch, c, linked } = p;
  const label = labelOf(cfg, ch);
  const color = colorOf(cfg, ch);
  // active blocks only, in the order of the signal (mute and volume have their own place)
  const blocks = useMemo(() => channelBlocks(cfg, ch).filter((b) => b.on && b.key !== 'mute' && b.key !== 'gain'), [c, cfg.delayUnit]);
  return (
    <div className={`gv-ch ${c.mute ? 'is-muted' : ''}`} style={{ ['--ch' as string]: color }}>
      <div className="gv-ch-head">
        <button type="button" className="gv-ch-name" onClick={() => open(mirror.key, p.isCurrent, 'canal', ch)} title={t('Ouvrir le canal')}>
          <span className="gv-ch-id">{label}{linked && <Icon name="link" size={12} />}</span>
          <span className="gv-ch-sub">{c.name && c.name !== label ? c.name : ' '}</span>
        </button>
        <Toggle small tone="red" on={c.mute} disabled={!p.canOperate} onChange={(on) => mirror.apply({ t: 'mute', ch, on })} title={c.mute ? t('Canal coupé : touchez pour le rétablir') : t('Couper ce canal')}>{t('Mute')}</Toggle>
      </div>
      <LiveLevel mirror={mirror} ch={ch} output={ch >= MODELS[cfg.model].inputs} label={label} />
      <div className="gv-vol"><span className="muted">{t('Volume')}</span><strong>{P.gain.fmt(c.gain)}</strong></div>
      <MiniCurve cfg={cfg} ch={ch} c={c} color={color} />
      <div className="gv-pills" aria-label={t('Traitements actifs de {0}', label)}>
        {blocks.length ? blocks.map((b) => <span key={b.key} className="pill is-on" title={b.title}>{b.short}</span>)
          : <span className="small muted">{t('Aucun traitement actif')}</span>}
      </div>
    </div>
  );
}, sameTile);

function LiveLevel({ mirror, ch, output, label }: { mirror: DeviceMirror; ch: number; output: boolean; label: string }): React.JSX.Element {
  const meters = useMeterState(mirror);
  const cfg = mirror.config;
  if (!cfg) return <></>;
  const db = meters?.db[ch];
  const dyn = output && meters ? dynamicsActive(meters.status, cfg, ch) : null;
  return (
    <div className="gv-level">
      <Meter db={db} zones={meterZones(cfg.model, ch)} dyn={output ? !!dyn && (dyn.comp || dyn.limit) : undefined} vertical={false} compact label={t('Niveau {0}', label)} />
      <span className="gv-db">{db === undefined || db <= -60 ? '—' : `${Math.round(db)} dB`}</span>
    </div>
  );
}

const CURVE_F = logFreqs(64);
const LO = -24, HI = 12;
/** Response of the channel (EQ, filters, polarity) as a small line, −24 to +12 dB. */
function MiniCurve({ cfg, ch, c, color }: { cfg: DeviceConfig; ch: number; c: AnyChannel; color: string }): React.JSX.Element {
  const d = useMemo(() => {
    const mag = responseOf(cfg, ch, CURVE_F).mag;
    const y = (v: number): number => ((HI - Math.max(LO, Math.min(HI, v))) / (HI - LO)) * 30;
    return mag.map((v, i) => `${i ? 'L' : 'M'}${((i / (mag.length - 1)) * 100).toFixed(2)} ${y(v).toFixed(2)}`).join(' ');
  }, [c]);
  return (
    <svg className="gv-curve" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">
      <line x1="0" x2="100" y1={(HI / (HI - LO)) * 30} y2={(HI / (HI - LO)) * 30} className="gv-zero" />
      <path d={`${d} L100 30 L0 30 Z`} fill={color} opacity="0.14" />
      <path d={d} fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** "DSP 408 · Ethernet 192.168.1.101 · en ligne" (the model only once: "Démo DSP 408 · en ligne"). */
function deviceLine(info: DeviceInfo | null, state: string): string {
  const src = info ? tm(describeSource(info.spec)) : '';
  const model = info?.model ? MODELS[info.model].name : '';
  return [model && !src.includes(model) ? model : '', src, stateLabel(state)].filter(Boolean).join(' · ');
}

/** A remembered device that is not connected (or not reachable). */
function DeviceLine({ info }: { info: DeviceInfo }): React.JSX.Element {
  const role = useApp((s) => s.role);
  const state = info.state;
  return (
    <Card className="gv-dev gv-off">
      <header className="gv-head">
        <span className={`dot dot-${state}`} />
        <div className="gv-name">
          <h2>{info.label}</h2>
          <span className="muted small">{deviceLine(info, state)}</span>
          {state === 'offline' && info.error && <span className="small text-error">{errorText(info.error)}</span>}
        </div>
        <div className="gv-actions">
          {(state === 'idle' || state === 'offline') && role !== 'viewer' && (
            <Button small kind="primary" icon="plug" onClick={() => connectDevice(info.key)}>{state === 'offline' ? t('Réessayer') : t('Se connecter')}</Button>
          )}
          {state === 'connecting' && <span className="muted small">{t('Connexion…')}</span>}
        </div>
      </header>
    </Card>
  );
}
