// Global state of the app: connection, devices, the device being edited, navigation, messages and
// dialogs. A tiny external store read with useSyncExternalStore.

import { useSyncExternalStore } from 'react';
import type { DeviceConfig, DeviceInfo, Role, SessionSnapshot } from '@dsp-studio/protocol';
import { BridgeBackend, defaultBridgeUrl } from '../client/bridge.ts';
import { LocalBackend } from '../client/local.ts';
import { DeviceMirror } from '../client/mirror.ts';
import type { Backend, BackendStatus } from '../client/types.ts';
import { pickLang, setLang, type Lang } from '@dsp-studio/i18n';
import { t, tm } from '../i18n.tsx';
import { stateLabel } from '../ui/format.ts';

export interface Prefs {
  theme: 'auto' | 'dark' | 'light';
  /** bridge to use when the app is not served by a bridge ('' = none, browser mode) */
  bridgeUrl: string;
  pin: string;
  clientName: string;
  lastDevice: string;
  /** keyboard / gesture hints in the editors */
  hints: boolean;
  /** "advanced" items (frame console, raw values) */
  expert: boolean;
  /** dismissed warnings */
  seen: string[];
  /** language of the interface ('' = the browser's) */
  lang: Lang | '';
}

export interface Toast { id: number; kind: 'info' | 'ok' | 'warn' | 'error'; text: string }
/** Message journal (the editor's Help > Memo "Message List"). */
export interface LogLine { at: number; kind: Toast['kind']; text: string }

export type Dialog =
  | { kind: 'confirm'; title: string; message: string; ok: string; danger: boolean; resolve: (v: boolean) => void }
  | { kind: 'prompt'; title: string; message?: string; label: string; value: string; maxLength?: number; inputMode?: 'text' | 'numeric'; ok: string; resolve: (v: string | null) => void };

export interface AppState {
  backend: Backend | null;
  mode: 'bridge' | 'local' | null;
  /** the page itself comes from a DSP Studio bridge */
  served: boolean;
  status: BackendStatus | 'starting';
  role: Role;
  pinRequired: boolean;
  devices: DeviceInfo[];
  current: string | null;
  mirror: DeviceMirror | null;
  toasts: Toast[];
  journal: LogLine[];
  dialog: Dialog | null;
  busy: string | null;
  prefs: Prefs;
  /** language in use (the app is drawn again when it changes) */
  lang: Lang;
}

const PREFS_KEY = 'dsp-studio.prefs';
const defaults: Prefs = { theme: 'auto', bridgeUrl: '', pin: '', clientName: '', lastDevice: '', hints: true, expert: false, seen: [], lang: '' };
function loadPrefs(): Prefs {
  try { return { ...defaults, ...(JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>) }; } catch { return { ...defaults }; }
}
function savePrefs(p: Prefs): void {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* private mode */ }
}

/** The chosen language, or the first one of the browser's list that the app speaks (English otherwise). */
function applyLang(l: Lang | ''): Lang {
  const v = l || pickLang(typeof navigator === 'undefined' ? [] : [...(navigator.languages ?? []), navigator.language]);
  setLang(v);
  if (typeof document !== 'undefined') document.documentElement.lang = v;
  return v;
}

const initialPrefs = loadPrefs();
let state: AppState = {
  backend: null, mode: null, served: false, status: 'starting', role: 'viewer', pinRequired: false, devices: [], current: null, mirror: null,
  toasts: [], journal: [], dialog: null, busy: null, prefs: initialPrefs, lang: applyLang(initialPrefs.lang),
};
const listeners = new Set<() => void>();

export function getState(): AppState { return state; }
export function setState(p: Partial<AppState> | ((s: AppState) => Partial<AppState>)): void {
  const patch = typeof p === 'function' ? p(state) : p;
  state = { ...state, ...patch };
  for (const f of listeners) f();
}
const subscribe = (f: () => void): (() => void) => { listeners.add(f); return () => { listeners.delete(f); }; };

export function useApp<T>(sel: (s: AppState) => T): T {
  return useSyncExternalStore(subscribe, () => sel(state));
}

export function setPrefs(p: Partial<Prefs>): void {
  const prefs = { ...state.prefs, ...p };
  savePrefs(prefs);
  setState({ prefs });
}

/** Changes the language of the interface ('' = the browser's); the screens are drawn again. */
export function setLanguage(l: Lang | ''): void {
  const prefs = { ...state.prefs, lang: l };
  savePrefs(prefs);
  setState({ prefs, lang: applyLang(l) });
}

// ------------------------------------------------------------------------- messages & dialogs
let toastId = 0;
export function logLine(text: string, kind: Toast['kind'] = 'info'): void {
  setState((s) => ({ journal: [...s.journal.slice(-299), { at: Date.now(), kind, text }] }));
}
export function toast(text: string, kind: Toast['kind'] = 'info', ms = kind === 'error' ? 6000 : 3200): void {
  const id = ++toastId;
  logLine(text, kind);
  setState((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, text }] }));
  setTimeout(() => setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms);
}
/** Message of an error, in the language of the interface (the bridge and the protocol write French). */
export const errorText = (e: unknown): string => {
  const m = tm(e instanceof Error ? e.message : String(e));
  return m.charAt(0).toUpperCase() + m.slice(1);
};

export function confirmDialog(o: { title: string; message: string; ok?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    setState({ dialog: { kind: 'confirm', title: o.title, message: o.message, ok: o.ok ?? t('Confirmer'), danger: !!o.danger, resolve } });
  });
}
export function promptDialog(o: { title: string; message?: string; label: string; value?: string; maxLength?: number; inputMode?: 'text' | 'numeric'; ok?: string }): Promise<string | null> {
  return new Promise((resolve) => {
    setState({ dialog: { kind: 'prompt', title: o.title, message: o.message, label: o.label, value: o.value ?? '', maxLength: o.maxLength, inputMode: o.inputMode, ok: o.ok ?? t('Valider'), resolve } });
  });
}
export function closeDialog(): void { setState({ dialog: null }); }

/** Runs a long operation with a busy indicator and turns errors into messages. */
export async function run<T>(label: string, f: () => Promise<T>, done?: string): Promise<T | undefined> {
  setState({ busy: label });
  try {
    const v = await f();
    if (done) toast(done, 'ok');
    return v;
  } catch (e) {
    toast(errorText(e), 'error');
    return undefined;
  } finally {
    setState({ busy: null });
  }
}

// ------------------------------------------------------------------------- connection
async function bridgeAvailable(): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    const r = await fetch('./api/health', { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(t);
    if (!r.ok) return false;
    const j = (await r.json()) as { ok?: boolean };
    return !!j.ok;
  } catch { return false; }
}


/** Device names made by the bridge ("Démo DSP 206", "Série COM3"...) in the language of the interface. */
const localized = (list: DeviceInfo[]): DeviceInfo[] => list.map((d) => ({ ...d, label: tm(d.label) }));

function attach(b: Backend, mode: 'bridge' | 'local'): void {
  const seen = new Map<string, string>();
  b.on('status', (st) => {
    setState({ status: st, role: b.role, pinRequired: b.pinRequired });
    logLine(mode === 'bridge' ? t('Pont : {0}', stateLabel(st)) : t('Navigateur : {0}', stateLabel(st)), st === 'offline' ? 'warn' : 'info');
  });
  b.on('devices', (list) => {
    for (const d of list) {
      const was = seen.get(d.key);
      if (was !== d.state) logLine(`${tm(d.label)} : ${stateLabel(d.state)}${d.state === 'offline' && d.error ? ` (${tm(d.error)})` : ''}`, d.state === 'offline' && was ? 'warn' : 'info');
      seen.set(d.key, d.state);
    }
    setState({ devices: localized(list) });
    const s = getState();
    if (!s.current && list.length) {
      const pick = list.find((d) => d.key === s.prefs.lastDevice) ?? list.find((d) => d.state === 'online') ?? list[0];
      selectDevice(pick.key);
    }
  });
  setState({ backend: b, mode, status: b.status, role: b.role, devices: localized(b.devices), pinRequired: b.pinRequired });
}

export async function startApp(): Promise<void> {
  const p = state.prefs;
  const served = await bridgeAvailable();
  setState({ served });
  const url = served ? defaultBridgeUrl() : p.bridgeUrl;
  if (url) {
    const b = new BridgeBackend(url, { pin: p.pin, name: p.clientName || navigator.platform || 'navigateur' });
    attach(b, 'bridge');
    try {
      await b.start();
      setState({ role: b.role, pinRequired: b.pinRequired, status: b.status, devices: localized(b.devices) });
      const list = b.devices;
      if (list.length && !getState().current) {
        const pick = list.find((d) => d.key === p.lastDevice) ?? list.find((d) => d.state === 'online') ?? list[0];
        selectDevice(pick.key);
      }
      return;
    } catch (e) {
      if (served) { toast(errorText(e), 'error'); return; } // the bridge will come back by itself
      toast(t('Pont {0} injoignable : mode navigateur', url), 'warn');
      b.close();
    }
  }
  const local = new LocalBackend();
  attach(local, 'local');
  await local.start();
  setState({ status: 'online', devices: localized(local.devices) });
}

/** Switches between the browser mode and a bridge given by its address. */
export async function connectBridge(address: string): Promise<void> {
  const url = address.trim() ? toWsUrl(address.trim()) : '';
  setPrefs({ bridgeUrl: url });
  const s = getState();
  s.mirror?.stop();
  s.backend?.close();
  setState({ backend: null, mirror: null, current: null, devices: [], status: 'starting' });
  await startApp();
}
/** "192.168.1.20", "pc.local:8081", "https://x" or "ws://x/ws" -> WebSocket address of the bridge */
export function toWsUrl(a: string): string {
  if (/^wss?:\/\//.test(a)) return a.replace(/\/+$/, '').replace(/(\/ws)?$/, '/ws');
  const http = /^https?:\/\//.test(a) ? a : `http://${a}`;
  const u = new URL(http);
  if (!u.port && u.protocol === 'http:') u.port = '8080';
  return t('{0}://{1}/ws', u.protocol === 'https:' ? 'wss' : 'ws', u.host);
}

/** Opens the connection to a remembered device (errors become messages). */
export function connectDevice(key: string): void {
  getState().backend?.connectDevice(key).catch((e: unknown) => toast(errorText(e), 'error'));
}
export function disconnectDevice(key: string): void {
  getState().backend?.disconnectDevice(key).catch((e: unknown) => toast(errorText(e), 'error'));
}

export function selectDevice(key: string | null): void {
  const s = getState();
  if (s.current === key) return;
  s.mirror?.stop();
  if (!key || !s.backend) { setState({ current: null, mirror: null }); return; }
  const m = new DeviceMirror(s.backend, key, (msg) => toast(errorText(msg), 'error'));
  setState({ current: key, mirror: m });
  setPrefs({ lastDevice: key });
  void m.start();
}

export async function login(pin: string): Promise<boolean> {
  const b = getState().backend;
  if (!b) return false;
  try {
    const role = await b.login(pin);
    setPrefs({ pin });
    setState({ role });
    toast(role === 'admin' ? t('Accès administrateur') : role === 'operator' ? t('Accès opérateur') : t('Accès en lecture'), 'ok');
    return true;
  } catch (e) {
    toast(errorText(e), 'error');
    return false;
  }
}

// ------------------------------------------------------------------------- device hooks
const noop = (): (() => void) => () => {};

export function useMirror(): DeviceMirror | null { return useApp((s) => s.mirror); }

/** Re-renders on every change of the current device. */
export function useDevice(): { mirror: DeviceMirror | null; config: DeviceConfig | null; snap: SessionSnapshot | null; rev: number } {
  const mirror = useMirror();
  const rev = useSyncExternalStore(mirror ? mirror.subscribe : noop, () => mirror?.rev ?? -1);
  return { mirror, config: mirror?.config ?? null, snap: mirror?.snap ?? null, rev };
}
export function useConfig(): DeviceConfig | null { return useDevice().config; }

export function useMeters(): { db: number[]; status: number } | null {
  const mirror = useMirror();
  useSyncExternalStore(mirror ? mirror.subscribeMeters : noop, () => mirror?.meterRev ?? -1);
  return mirror?.meters ?? null;
}
export function useFrames(): DeviceMirror['frames'] {
  const mirror = useMirror();
  useSyncExternalStore(mirror ? mirror.subscribeFrames : noop, () => mirror?.frameRev ?? -1);
  return mirror?.frames ?? [];
}

/** Can the user change settings (role and lock)? */
export function useCanEdit(): boolean {
  const role = useApp((s) => s.role);
  const { snap } = useDevice();
  return role === 'admin' && snap?.status !== 'locked' && !!snap?.config;
}
export function useCanOperate(): boolean {
  const role = useApp((s) => s.role);
  const { snap } = useDevice();
  return (role === 'admin' || role === 'operator') && snap?.status !== 'locked' && !!snap?.config;
}
