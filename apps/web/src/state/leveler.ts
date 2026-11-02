// Automatic gain of a device (see packages/protocol/src/leveler.ts) for the Gain auto page, the DJ
// screen and the overview: its state, its requests, the level history and the advice given to the DJ.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { gainRawToDb, type DeviceConfig, type LevelerPoint, type LevelerState, type LevelerStatus } from '@dsp-studio/protocol';
import type { DeviceMirror } from '../client/mirror.ts';
import type { LevelerOp } from '../client/types.ts';
import { errorText, toast, useMirror } from './store.ts';
import { t } from '../i18n.tsx';

const noop = (): (() => void) => () => {};

/** State of the automatic gain of a device (the selected one when no mirror is given). */
export function useLeveler(m?: DeviceMirror | null): LevelerState | null {
  const selected = useMirror();
  const mirror = m === undefined ? selected : m;
  useSyncExternalStore(mirror ? mirror.subscribeLeveler : noop, () => mirror?.levelerRev ?? -1);
  return mirror?.leveler ?? null;
}

/** Sends a request to the automatic gain; an error becomes a message. */
export async function levelerRequest<T = LevelerState>(mirror: DeviceMirror, op: LevelerOp, value?: unknown): Promise<T | undefined> {
  try {
    return await mirror.backend.leveler<T>(mirror.key, op, value);
  } catch (e) {
    toast(errorText(e), 'error');
    return undefined;
  }
}

/** Level history of the last two hours, read again every 10 s while it is shown. */
export function useLevelerHistory(mirror: DeviceMirror | null): LevelerPoint[] {
  const [points, setPoints] = useState<LevelerPoint[]>([]);
  useEffect(() => {
    setPoints([]);
    if (!mirror) return;
    let alive = true;
    const load = (): void => {
      mirror.backend.leveler<LevelerPoint[]>(mirror.key, 'history').then((p) => { if (alive && Array.isArray(p)) setPoints(p); }, () => {});
    };
    load();
    const id = setInterval(load, 10_000);
    return () => { alive = false; clearInterval(id); };
  }, [mirror]);
  return points;
}

/** below this level (after the gain) there is no music, as for the automatic gain */
const SILENCE_DB = -50;
/** window of the level shown on the bars: the same as the automatic gain's "level" */
const LIVE_MS = 3_000;

/** Level of the chosen inputs after their gain, from one meter reading (null: silence). */
export function meterLevel(st: LevelerState | null, cfg: DeviceConfig | null, db: readonly number[] | undefined): number | null {
  if (!st || !cfg || !db || st.status === 'offline') return null;
  let sum = 0, n = 0;
  for (const i of st.settings.inputs) {
    const c = cfg.inputs[i];
    if (!c || c.mute) continue;
    const m = db[i] ?? -140;
    // a meter read before the gain (or not known yet: the automatic gain assumes "before" too)
    const after = st.settings.meter === 'post' ? m : m + gainRawToDb(c.gain);
    sum += 10 ** (after / 10);
    n++;
  }
  if (!n) return null;
  const level = 10 * Math.log10(sum / n);
  return level < SILENCE_DB ? null : level;
}

/**
 * Level of the chosen inputs over the last 3 seconds, read again with every meter reading (4 per
 * second): the automatic gain's "level", but moving smoothly on the bars.
 */
export function useLiveLevel(mirror: DeviceMirror | null, st: LevelerState | null, cfg: DeviceConfig | null): number | null {
  const [level, setLevel] = useState<number | null>(null);
  const ctx = useRef({ st, cfg });
  ctx.current = { st, cfg };
  useEffect(() => {
    setLevel(null);
    if (!mirror) return;
    const readings: { at: number; power: number | null }[] = [];
    return mirror.subscribeMeters(() => {
      const m = mirror.meters;
      if (!m) return;
      const lv = meterLevel(ctx.current.st, ctx.current.cfg, m.db);
      const now = Date.now();
      readings.push({ at: now, power: lv === null ? null : 10 ** (lv / 10) });
      while (readings.length && readings[0].at < now - LIVE_MS) readings.shift();
      let sum = 0, n = 0;
      for (const r of readings) if (r.power !== null) { sum += r.power; n++; }
      // mostly silence (needle up, between records): no level, as for the automatic gain
      const next = n && n >= readings.length * 0.3 ? Math.round(100 * Math.log10(sum / n)) / 10 : null;
      setLevel((prev) => (prev === next ? prev : next));
    });
  }, [mirror]);
  return level;
}

/**
 * What the DJ should do with the gain of the mixer. Only when the level is out of the zone both
 * over the last seconds and over the decision window (so a breakdown, or a gain the DJ has just
 * moved, gives no advice), and only when the automatic gain cannot do it itself. The number is the
 * smaller of the two gaps: following it never goes past the zone.
 */
export type Advice = { kind: 'none' } | { kind: 'ok' } | { kind: 'auto' } | { kind: 'up' | 'down'; db: number };
export function adviceOf(st: LevelerState | null): Advice {
  if (!st || st.status === 'offline' || st.status === 'checking' || st.level === null || st.average === null) return { kind: 'none' };
  const { target, tolerance, enabled } = st.settings;
  const now = st.level - target, avg = st.average - target;
  if (Math.abs(now) <= tolerance || Math.abs(avg) <= tolerance || Math.sign(now) !== Math.sign(avg)) return { kind: 'ok' };
  if (enabled && st.status !== 'limit' && st.status !== 'budget') return { kind: 'auto' };
  return { kind: avg < 0 ? 'up' : 'down', db: Math.max(1, Math.round(Math.min(Math.abs(now), Math.abs(avg)))) };
}

/** Where a level stands compared with the zone around the target. */
export type Zone = 'none' | 'low' | 'ok' | 'high' | 'clip';
export function zoneOf(st: LevelerState | null, level: number | null): Zone {
  if (!st || level === null) return 'none';
  if (st.clip) return 'clip';
  const { target, tolerance } = st.settings;
  return level < target - tolerance ? 'low' : level > target + tolerance ? 'high' : 'ok';
}
export function zoneText(z: Zone): string {
  switch (z) {
    case 'none': return t('Pas de musique');
    case 'low': return t('Trop faible');
    case 'ok': return t('Dans la zone');
    case 'high': return t('Trop fort');
    case 'clip': return t('Saturation');
  }
}

export function statusText(s: LevelerStatus): string {
  switch (s) {
    case 'off': return t('Gain automatique arrêté');
    case 'offline': return t('Appareil non connecté');
    case 'waiting': return t('Mesure du niveau en cours…');
    case 'ok': return t('Dans la zone : rien à corriger');
    case 'raising': return t('Remonte doucement le gain');
    case 'lowering': return t('Baisse doucement le gain');
    case 'limit': return t('Correction au maximum : le disque reste hors de la zone');
    case 'silence': return t('Silence : en pause');
    case 'break': return t('Break : en pause, pour ne pas le pousser');
    case 'manual': return t('Gain réglé à la main : reprise dans un instant');
    case 'tone': return t('Générateur de test actif : en pause');
    case 'muted': return t('Entrées coupées : en pause');
    case 'budget': return t('Assez de corrections pour cette heure : en pause');
    case 'checking': return t('Vérification des vumètres…');
  }
}

/** Tone of a status, for its badge. */
export function statusTone(s: LevelerStatus): 'ok' | 'warn' | 'muted' | 'accent' {
  if (s === 'raising' || s === 'lowering' || s === 'checking') return 'accent';
  if (s === 'ok') return 'ok';
  if (s === 'limit' || s === 'budget') return 'warn';
  return 'muted';
}
