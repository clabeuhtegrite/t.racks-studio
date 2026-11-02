// Remote calls: the DeviceSession methods a client (web app over the bridge, or the app's own
// in-browser devices) may invoke, with every argument checked. Shared by the bridge and the web app
// so both behave the same.

import type { Action } from './state.ts';
import type { DeviceSession } from './session.ts';
import type { ModelId } from './models.ts';
import { normalizeConfig, normalizeUnit } from './files.ts';
import { deviceAscii } from './codecs.ts';

export type Role = 'admin' | 'operator' | 'viewer';

/** What an operator may do (live use: levels, mutes, preset recall). */
export const OPERATOR_ACTIONS: ReadonlySet<Action['t']> = new Set<Action['t']>(['gain', 'mute']);
export const OPERATOR_CALLS: ReadonlySet<string> = new Set(['loadPreset']);

export class CallError extends Error {
  constructor(message: string) { super(message); this.name = 'CallError'; }
}

const toInt = (v: unknown, lo: number, hi: number, what: string): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < lo || n > hi) throw new CallError(`${what} invalide`);
  return n;
};
const toText = (v: unknown, max: number): string => deviceAscii(String(v ?? ''), max);
const toPin = (v: unknown): string => {
  const p = toText(v, 4);
  if (!p) throw new CallError('mot de passe vide');
  return p;
};
const modelOf = (s: DeviceSession): ModelId => {
  if (!s.snap.model) throw new CallError("l'appareil n'est pas prêt");
  return s.snap.model;
};
const presetMax = (s: DeviceSession): number => s.model?.userPresets ?? 20;

type CallFn = (s: DeviceSession, a: unknown[]) => Promise<unknown>;

export const SESSION_CALLS: Readonly<Record<string, CallFn>> = {
  loadPreset: (s, [n]) => s.loadPreset(toInt(n, 0, presetMax(s), 'preset')),
  storePreset: (s, [n, name]) => s.storePreset(toInt(n, 1, presetMax(s), 'preset'), toText(name, 14)),
  factoryReset: (s) => s.factoryReset(),
  pushConfig: (s, [cfg, label, full]) => s.pushConfig(normalizeConfig(cfg, modelOf(s)), toText(label ?? 'Envoi', 40), full === true),
  writePresetSlot: (s, [slot, cfg, name]) =>
    s.writePresetSlot(toInt(slot, 1, presetMax(s), 'preset'), normalizeConfig(cfg, modelOf(s)), name === undefined ? undefined : toText(name, 14)),
  writePresets: (s, [list]) => {
    if (!Array.isArray(list)) throw new CallError('liste invalide');
    return s.writePresets(list.map((p: { slot?: unknown; name?: unknown; config?: unknown }) => ({
      slot: toInt(p?.slot, 1, presetMax(s), 'preset'), name: toText(p?.name, 14), config: normalizeConfig(p?.config, modelOf(s)),
    })));
  },
  readAllPresets: (s) => s.readAllPresets(),
  downloadUnit: (s) => s.downloadUnit(),
  uploadUnit: (s, [u, o]) => s.uploadUnit(normalizeUnit(u, modelOf(s)), { restoreSystem: (o as { restoreSystem?: unknown } | undefined)?.restoreSystem === true }),
  lock: (s, [pw]) => s.lock(toPin(pw)),
  unlock: (s, [pw]) => s.unlock(toPin(pw)),
  unlockPts: (s, [pw]) => s.unlockPts(toPin(pw)),
  ptsSetup: (s, [pw, limit, on]) => s.ptsSetup(toPin(pw), toInt(limit, 0, 9999, 'limite'), on === true),
  setNetwork: (s, [id, ip]) => {
    if (!Array.isArray(ip) || ip.length !== 4) throw new CallError('adresse IP invalide');
    return s.setNetwork(toInt(id, 1, 250, 'ID'), ip.map((b) => toInt(b, 0, 255, 'adresse IP')) as [number, number, number, number]);
  },
  sync: (s) => s.sync(),
  readConfig: (s) => s.readConfig(),
  refreshLock: (s) => s.refreshLock(),
  readSystem: (s) => s.readSystem(),
};

export function canCall(role: Role, method: string): boolean {
  return role === 'admin' || (role === 'operator' && OPERATOR_CALLS.has(method));
}
export function canApply(role: Role, a: Action): boolean {
  return role === 'admin' || (role === 'operator' && OPERATOR_ACTIONS.has(a.t));
}

/** Runs a remote call on a session (throws CallError for unknown methods or bad arguments). */
export function callSession(s: DeviceSession, method: string, args: unknown[]): Promise<unknown> {
  const fn = Object.hasOwn(SESSION_CALLS, method) ? SESSION_CALLS[method] : undefined;
  if (!fn) throw new CallError('méthode inconnue');
  return fn(s, args);
}
