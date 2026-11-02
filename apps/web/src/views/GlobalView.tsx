// Overview of every device, live: level of each channel (clip and limiter LEDs), mute, volume, a
// small response curve and the active blocks of the channel with their main setting (the editor's
// hidden block diagram), plus the state of each device: connection, preset, lock, links, test
// generator. On outputs, the margin left before the compressor and the limiter act, on the peaks of
// the last seconds, with their thresholds marked on the level bar. Mutes work from here; a tap on a
// channel opens it.

import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { describeSource, dynamicsActive, dynamicsHeadroom, GEQ_FREQS, logFreqs, meterZones, MODELS, thrRawToDb, type AnyChannel, type DeviceConfig, type DeviceInfo, type Headroom } from '@dsp-studio/protocol';
import { DeviceMirror } from '../client/mirror.ts';
import type { Backend } from '../client/types.ts';
import { connectDevice, errorText, selectDevice, toast, useApp } from '../state/store.ts';
import { go } from '../state/route.ts';
import { Badge, Button, Card, Empty, Toggle } from '../ui/kit.tsx';
import { Meter } from '../ui/Meter.tsx';
import { thresholdMarks } from '../editors/editors.tsx';
import { Icon } from '../ui/icons.tsx';
import { fmtDb, fmtIsoHz, fmtSigned, P, presetLabel, stateLabel } from '../ui/format.ts';
import { statusText, statusTone, useLeveler } from '../state/leveler.ts';
import '../ui/level.css';
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
        {config && <DeviceFacts cfg={config} mirror={mirror} isCurrent={isCurrent} />}
        {config && (
          <div className="gv-actions">
            <Button small icon="console" title={t('Console')} onClick={() => open(mirror.key, isCurrent, 'console')}>{t('Console')}</Button>
            <Button small icon={allOutMuted ? 'speaker' : 'mute'} kind={allOutMuted ? 'plain' : 'danger'} disabled={!canOperate}
              title={t('Coupe ou rétablit toutes les sorties d’un coup')}
              onClick={() => outs.forEach((ch) => { if (chan(config, ch).mute === allOutMuted) mirror.apply({ t: 'mute', ch, on: !allOutMuted }); })}>
              {allOutMuted ? t('Rétablir les sorties') : t('Couper les sorties')}
            </Button>
          </div>
        )}
      </DeviceHead>
      {config && m ? (
        // on a computer the inputs and the outputs share a line when they fit (DSP 206), eight tiles a line
        <div className="gv-tiles">
          <section className="gv-set" aria-label={t('Entrées')} style={{ ['--n' as string]: config.inputs.length }}>
            <h3 className="gv-group">{t('Entrées')}</h3>
            <div className="gv-grid">
              {config.inputs.map((c, i) => <ChannelTile key={i} mirror={mirror} cfg={config} ch={i} c={c} linked={linkMates(config, i).length > 0} canOperate={canOperate} isCurrent={isCurrent} />)}
            </div>
          </section>
          <section className="gv-set" aria-label={t('Sorties')} style={{ ['--n' as string]: config.outputs.length }}>
            <h3 className="gv-group">{t('Sorties')}</h3>
            <div className="gv-grid">
              {config.outputs.map((c, j) => <ChannelTile key={j} mirror={mirror} cfg={config} ch={m.inputs + j} c={c} linked={linkMates(config, m.inputs + j).length > 0} canOperate={canOperate} isCurrent={isCurrent} />)}
            </div>
          </section>
        </div>
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

/** Settings that matter for the whole device: automatic gain, test generator, links, delay unit. */
function DeviceFacts({ cfg, mirror, isCurrent }: { cfg: DeviceConfig; mirror: DeviceMirror; isCurrent: boolean }): React.JSX.Element | null {
  const lv = useLeveler(mirror);
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
  const auto = lv?.settings.enabled ? lv : null;
  if (!tone && !groups.length && !auto) return null;
  return (
    <div className="gv-facts">
      {auto && (
        <button
          type="button" className={`badge badge-${statusTone(auto.status)} lv-badge`} title={`${statusText(auto.status)} · ${t('ouvrir le gain automatique')}`}
          onClick={() => { if (!isCurrent) selectDevice(mirror.key); go('niveau'); }}
        >
          <Icon name="gauge" size={13} />{t('Gain auto : {0}', `${fmtSigned(auto.correction)} dB`)}
        </button>
      )}
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
        <Toggle small tone="red" icon="mute" on={c.mute} disabled={!p.canOperate} onChange={(on) => mirror.apply({ t: 'mute', ch, on })} title={c.mute ? t('Canal coupé : touchez pour le rétablir') : t('Couper ce canal')}>{t('Mute')}</Toggle>
      </div>
      <LiveLevel mirror={mirror} ch={ch} output={ch >= MODELS[cfg.model].inputs} label={label} />
      <div className="gv-vol"><span className="muted" title={t('Volume')}>{t('Volume')}</span><strong>{P.gain.fmt(c.gain)}</strong></div>
      <MiniCurve cfg={cfg} ch={ch} c={c} color={color} />
      <div className="gv-pills" aria-label={t('Traitements actifs de {0}', label)} title={blocks.map((b) => b.short).join(' · ') || undefined}>
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
  // margins on the peaks of the last seconds, and the status bits of the last moments
  const room = output ? dynamicsHeadroom(cfg, ch, meters?.peak[ch], meters?.recent ?? 0) : null;
  const marks = output ? thresholdMarks(cfg, ch) : undefined;
  const o = output ? cfg.outputs[ch - MODELS[cfg.model].inputs] : null;
  const uses = output ? dynamicsInUse(cfg) : null;
  return (
    <>
      <div className="gv-level">
        <Meter db={db} zones={meterZones(cfg.model, ch)} dyn={output ? !!dyn && (dyn.comp || dyn.limit) : undefined} vertical={false} compact label={t('Niveau {0}', label)} marks={marks} />
        <span className="gv-db">{db === undefined || db <= -60 ? '—' : `${Math.round(db)} dB`}</span>
      </div>
      {o && room && uses && (uses.comp || uses.limit) && (
        <div className="gv-dyn" role="group" aria-label={t('Marge avant le compresseur et le limiteur de {0}', label)}>
          <div className="gv-dyn-grid">
            <span className="muted gv-dyn-label">{t('Marge')}</span>
            {uses.comp && (room.comp
              ? <Margin kind="comp" h={room.comp} name={t('Comp.')} setting={fmtDb(thrRawToDb(o.comp.threshold), 0)} />
              : <Unused kind="comp" name={t('Comp.')} title={t('Compresseur désactivé sur cette sortie (taux 1:1).')} />)}
            {uses.limit && (room.limit
              ? <Margin kind="limit" h={room.limit} name={t('Lim.')} setting={fmtDb(thrRawToDb(o.limiter.threshold), 0)} />
              : <Unused kind="limit" name={t('Lim.')} title={t('Limiteur désactivé sur cette sortie (seuil au maximum).')} />)}
          </div>
        </div>
      )}
    </>
  );
}

/** Whether some output of the device uses its compressor, its limiter. Each of the two then has a line
 *  of its own on every output tile of the device, so the lines of the tiles stay level. */
function dynamicsInUse(cfg: DeviceConfig): { comp: boolean; limit: boolean } {
  const n = MODELS[cfg.model].inputs;
  const all = cfg.outputs.map((_, j) => dynamicsHeadroom(cfg, n + j, null, 0));
  return { comp: all.some((r) => r.comp !== null), limit: all.some((r) => r.limit !== null) };
}

/** The line of a block this output does not use, while another output of the device does. */
function Unused({ kind, name, title }: { kind: 'comp' | 'limit'; name: string; title: string }): React.JSX.Element {
  return (
    <span className="gv-margin is-off" title={title}>
      <i className={`gv-margin-key gv-margin-${kind}`} aria-hidden="true" />{name} <strong>{t('inactif')}</strong>
    </span>
  );
}

/** "Comp. 4 dB": dB left before the block acts (amber under 6 dB), or "en action" while it acts. In a tile too
 *  narrow for the words, a lit LED stands for them (the words stay for screen readers). */
function Margin({ kind, h, name, setting }: { kind: 'comp' | 'limit'; h: Headroom; name: string; setting: string }): React.JSX.Element {
  // the colour follows the dB shown, so "6 dB" is never amber on one output and green on another
  const shown = h.margin === null ? null : Math.max(0, Math.round(h.margin));
  const state = h.acting ? 'is-on' : shown === null ? 'is-idle' : shown < 6 ? 'is-low' : 'is-ok';
  const value = h.acting
    ? <><span className="gv-act-txt">{t('en action')}</span><i className="gv-act-led" aria-hidden="true" /></>
    : shown === null ? '—' : `${shown} dB`;
  const title = h.acting
    ? (kind === 'comp' ? t('Le compresseur ({0}) agit en ce moment.', setting) : t('Le limiteur ({0}) agit en ce moment.', setting))
    : h.margin === null ? t('Pas de signal sur cette sortie.')
      : kind === 'comp' ? t('Compresseur ({0}) : marge avant qu’il agisse, sur les pics des 3 dernières secondes (estimée d’après le vumètre).', setting)
        : t('Limiteur ({0}) : marge avant qu’il agisse, sur les pics des 3 dernières secondes (estimée d’après le vumètre).', setting);
  return (
    <span className={`gv-margin ${state}`} title={title}>
      <i className={`gv-margin-key gv-margin-${kind}`} aria-hidden="true" />{name} <strong>{value}</strong>
    </span>
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
