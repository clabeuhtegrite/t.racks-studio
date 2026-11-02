// Local copy of one device's state, kept in step with the backend:
// - edits are applied at once on screen (optimistic) and sent;
// - edits made elsewhere (another phone, another tab) arrive as actions and are applied too, and
//   the edits of this window that are still on their way are re-applied on top, so the screen
//   always ends up exactly like the device;
// - every change makes new objects only for the channels it touches, so React redraws only them;
// - undo / redo, and two A/B memories.

import {
  actionKey, applyAction, inverseActions, linkedChannels, MODELS, validateAction,
  type Action, type DeviceConfig, type DeviceInfo, type SessionSnapshot,
} from '@dsp-studio/protocol';
import type { Backend } from './types.ts';

export interface UndoEntry { key: string; action: Action; inverse: Action[]; redo: Action[]; at: number }
export interface FrameLine { dir: 'tx' | 'rx'; hex: string; at: number }
export interface MeterState { db: number[]; status: number; at: number }

/** Applies an action to a copy of the configuration (structural sharing). */
export function applyImmutable(cfg: DeviceConfig, a: Action): DeviceConfig {
  const m = MODELS[cfg.model];
  const next: DeviceConfig = { ...cfg, inputs: cfg.inputs.slice(), outputs: cfg.outputs.slice() };
  const touch = (ch: number): void => {
    if (ch < m.inputs) next.inputs[ch] = structuredClone(cfg.inputs[ch]);
    else if (ch - m.inputs < m.outputs) next.outputs[ch - m.inputs] = structuredClone(cfg.outputs[ch - m.inputs]);
  };
  switch (a.t) {
    case 'link': {
      const base = a.kind === 'in' ? 0 : m.inputs;
      const n = a.kind === 'in' ? m.inputs : m.outputs;
      for (let k = 0; k < n; k++) touch(base + k);
      break;
    }
    case 'copy': touch(a.dst); break;
    case 'delayUnit': case 'testTone': case 'presetName': break;
    case 'route': case 'mix': case 'name': touch(a.ch); break;
    default: for (const ch of linkedChannels(cfg, a.ch)) touch(ch);
  }
  applyAction(next, a);
  return next;
}

/** Keeps the old objects of channels that did not change (fewer redraws after a snapshot). */
function reuse(old: DeviceConfig | null, incoming: DeviceConfig): DeviceConfig {
  if (!old || old.model !== incoming.model) return incoming;
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
  return {
    ...incoming,
    inputs: incoming.inputs.map((c, i) => (same(c, old.inputs[i]) ? old.inputs[i] : c)),
    outputs: incoming.outputs.map((c, i) => (same(c, old.outputs[i]) ? old.outputs[i] : c)),
  };
}

type Fn = () => void;

export class DeviceMirror {
  readonly key: string;
  readonly backend: Backend;
  info: DeviceInfo | null = null;
  snap: SessionSnapshot | null = null;
  config: DeviceConfig | null = null;
  meters: MeterState | null = null;
  frames: FrameLine[] = [];
  undoStack: UndoEntry[] = [];
  redoStack: UndoEntry[] = [];
  ab: { A: DeviceConfig | null; B: DeviceConfig | null; active: 'A' | 'B' | null } = { A: null, B: null, active: null };
  rev = 0;
  meterRev = 0;
  frameRev = 0;
  debug = false;
  private pending: { seq: number; action: Action }[] = [];
  private seq = 0;
  private listeners = new Set<Fn>();
  private meterListeners = new Set<Fn>();
  private frameListeners = new Set<Fn>();
  private unsubs: (() => void)[] = [];
  private onError: (msg: string) => void;
  private alive = true;

  constructor(backend: Backend, key: string, onError: (msg: string) => void) {
    this.backend = backend;
    this.key = key;
    this.onError = onError;
    this.info = backend.devices.find((d) => d.key === key) ?? null;
  }

  // ------------------------------------------------------------------ subscriptions (React)
  subscribe = (f: Fn): (() => void) => { this.listeners.add(f); return () => { this.listeners.delete(f); }; };
  subscribeMeters = (f: Fn): (() => void) => { this.meterListeners.add(f); return () => { this.meterListeners.delete(f); }; };
  subscribeFrames = (f: Fn): (() => void) => { this.frameListeners.add(f); return () => { this.frameListeners.delete(f); }; };
  private bump(): void { this.rev++; for (const f of this.listeners) f(); }

  // ------------------------------------------------------------------ life cycle
  async start(): Promise<void> {
    const b = this.backend;
    this.unsubs.push(
      b.on('snapshot', (e) => { if (e.key === this.key) this.onSnapshot(e.snap); }),
      b.on('action', (e) => { if (e.key === this.key) this.onAction(e.action, e.origin, e.seq); }),
      b.on('meters', (e) => {
        if (e.key !== this.key) return;
        this.meters = { db: e.db, status: e.status, at: Date.now() };
        this.meterRev++;
        for (const f of this.meterListeners) f();
      }),
      b.on('frame', (e) => {
        if (e.key !== this.key) return;
        this.frames.push({ dir: e.dir, hex: e.hex, at: e.at });
        if (this.frames.length > 800) this.frames.splice(0, this.frames.length - 800);
        this.frameRev++;
        for (const f of this.frameListeners) f();
      }),
      b.on('devices', (list) => {
        const i = list.find((d) => d.key === this.key) ?? null;
        const was = this.info?.state;
        this.info = i;
        if (i && was !== 'online' && i.state === 'online') void this.resubscribe();
        this.bump();
      }),
      b.on('status', (s) => { if (s === 'online') void this.resubscribe(); else this.bump(); }),
    );
    await this.resubscribe();
  }

  stop(): void {
    this.alive = false;
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.backend.unsubscribe(this.key);
  }

  async resubscribe(): Promise<void> {
    if (!this.alive || this.backend.status !== 'online') return;
    try {
      const { info, snap } = await this.backend.subscribe(this.key, this.debug);
      this.info = info;
      this.pending = [];
      if (snap) this.onSnapshot(snap); else { this.snap = null; this.config = null; this.bump(); }
    } catch (e) {
      this.onError((e as Error).message);
    }
  }

  setDebug(on: boolean): void {
    if (this.debug === on) return;
    this.debug = on;
    void this.resubscribe();
  }
  clearFrames(): void { this.frames = []; this.frameRev++; for (const f of this.frameListeners) f(); }

  // ------------------------------------------------------------------ inbound
  private rebase(base: DeviceConfig): DeviceConfig {
    let c = base;
    for (const p of this.pending) {
      try { c = applyImmutable(c, p.action); } catch { /* channel layout changed */ }
    }
    return c;
  }

  private onSnapshot(snap: SessionSnapshot): void {
    this.snap = snap;
    this.config = snap.config ? reuse(this.config, this.rebase(snap.config)) : null;
    this.bump();
  }

  private onAction(a: Action, origin: number, seq: number): void {
    if (!this.config) return;
    if (origin === this.backend.clientId && origin !== 0) {
      // our own edit coming back: already on screen
      this.pending = this.pending.filter((p) => p.seq > seq);
      return;
    }
    try {
      let c = applyImmutable(this.config, a);
      for (const p of this.pending) c = applyImmutable(c, p.action);
      this.config = c;
    } catch { void this.resubscribe(); }
    this.bump();
  }

  // ------------------------------------------------------------------ outbound
  get model() { return this.config ? MODELS[this.config.model] : this.snap?.model ? MODELS[this.snap.model] : null; }
  get readOnly(): boolean { return this.backend.role === 'viewer' || this.snap?.status === 'locked'; }

  apply(input: Action, opts: { record?: boolean } = {}): void {
    const before = this.config;
    if (!before) return;
    let a: Action;
    let next: DeviceConfig;
    try {
      a = validateAction(before.model, input); // same cleaning as the device (names in ASCII...)
      next = applyImmutable(before, a);
    } catch (e) { this.onError((e as Error).message); return; }
    this.config = next;
    const seq = ++this.seq;
    this.pending.push({ seq, action: a });
    if (opts.record !== false) this.record(before, a);
    if (this.ab.active) this.ab = { ...this.ab, active: null };
    this.bump();
    this.backend.action(this.key, a, seq).catch((e: Error) => {
      this.pending = this.pending.filter((p) => p.seq !== seq);
      this.onError(e.message);
      void this.resubscribe();
    });
  }

  call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
    return this.backend.call<T>(this.key, method, args);
  }

  // ------------------------------------------------------------------ undo / redo
  private record(before: DeviceConfig, a: Action): void {
    const key = actionKey(a);
    const now = Date.now();
    const top = this.undoStack[this.undoStack.length - 1];
    if (top && top.key === key && now - top.at < 1500) {
      top.redo = [a];
      top.action = a;
      top.at = now;
    } else {
      this.undoStack.push({ key, action: a, inverse: inverseActions(before, a), redo: [a], at: now });
      if (this.undoStack.length > 300) this.undoStack.shift();
    }
    this.redoStack = [];
  }
  undo(): void {
    const e = this.undoStack.pop();
    if (!e) return;
    for (const a of e.inverse) this.apply(a, { record: false });
    this.redoStack.push(e);
    this.bump();
  }
  redo(): void {
    const e = this.redoStack.pop();
    if (!e) return;
    for (const a of e.redo) this.apply(a, { record: false });
    this.undoStack.push({ ...e, at: 0 });
    this.bump();
  }
  clearHistory(): void { this.undoStack = []; this.redoStack = []; this.bump(); }

  // ------------------------------------------------------------------ A / B
  storeAB(slot: 'A' | 'B'): void {
    if (!this.config) return;
    this.ab = { ...this.ab, [slot]: structuredClone(this.config), active: slot };
    this.bump();
  }
  async recallAB(slot: 'A' | 'B'): Promise<void> {
    const target = this.ab[slot];
    if (!target) return;
    await this.call('pushConfig', target, `Comparaison ${slot}`);
    this.ab = { ...this.ab, active: slot };
    this.bump();
  }
  clearAB(): void { this.ab = { A: null, B: null, active: null }; this.bump(); }
}
