// Backend over the DSP Studio bridge (WebSocket /ws). Reconnects by itself and restores the
// subscriptions, so a phone that sleeps or changes Wi-Fi simply picks up where it was.

import type { Action, DeviceInfo, FoundModule, Role, SessionSnapshot, SourceSpec } from '@dsp-studio/protocol';
import { Emitter, type Backend, type BackendEvents, type BackendStatus, type LibraryApi, type LibraryDraft, type LibraryEntry, type LibrarySummary, type PortsInfo } from './types.ts';
import { t } from '../i18n.tsx';

interface Pending { res: (v: unknown) => void; rej: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

export class BridgeError extends Error {
  constructor(message: string) { super(message); this.name = 'BridgeError'; }
}

/** ws(s)://host/ws for the page's own origin (the bridge serves the app). */
export function defaultBridgeUrl(): string {
  const l = window.location;
  const path = l.pathname.replace(/[^/]*$/, '');
  return t('{0}://{1}{2}ws', l.protocol === 'https:' ? 'wss' : 'ws', l.host, path);
}

export class BridgeBackend implements Backend {
  readonly kind = 'bridge' as const;
  readonly url: string;
  clientId = 0;
  role: Role = 'viewer';
  pinRequired = false;
  version = '';
  status: BackendStatus = 'connecting';
  devices: DeviceInfo[] = [];
  readonly features = { discover: true, ports: true, probe: true, webhid: false, webserial: false, demo: true };
  readonly library: LibraryApi;
  private ws: WebSocket | null = null;
  private rid = 0;
  private pending = new Map<number, Pending>();
  private subs = new Map<string, boolean>();
  private em = new Emitter<BackendEvents>();
  private retryMs = 800;
  private closed = false;
  private pin: string;
  private name: string;
  private started: { res: () => void; rej: (e: Error) => void } | null = null;

  constructor(url: string, opts: { pin?: string; name?: string } = {}) {
    this.url = url;
    this.pin = opts.pin ?? '';
    this.name = opts.name ?? '';
    const req = this.req.bind(this);
    this.library = {
      shared: true,
      list: () => req<LibrarySummary[]>({ t: 'library.list' }),
      get: (id) => req<LibraryEntry>({ t: 'library.get', id }),
      save: (entry: LibraryDraft) => req<LibrarySummary>({ t: 'library.save', entry }),
      remove: async (id) => { await req({ t: 'library.remove', id }); },
    };
  }

  on<K extends keyof BackendEvents>(k: K, f: (v: BackendEvents[K]) => void): () => void { return this.em.on(k, f); }

  start(): Promise<void> {
    return new Promise((res, rej) => {
      this.started = { res, rej };
      this.open();
      setTimeout(() => { if (this.started) { this.started.rej(new BridgeError(t('le pont ne répond pas'))); this.started = null; } }, 6000);
    });
  }

  private setStatus(s: BackendStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.em.emit('status', s);
  }

  private open(): void {
    if (this.closed) return;
    this.setStatus('connecting');
    let ws: WebSocket;
    try { ws = new WebSocket(this.url); } catch (e) { this.started?.rej(e as Error); this.started = null; return; }
    this.ws = ws;
    ws.onmessage = (ev) => {
      let m: Record<string, unknown>;
      try { m = JSON.parse(String(ev.data)) as Record<string, unknown>; } catch { return; }
      this.onMessage(m);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.rej(new BridgeError(t('liaison avec le pont perdue'))); }
      this.pending.clear();
      this.setStatus('offline');
      if (this.closed) return;
      setTimeout(() => this.open(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 8000);
    };
  }

  private async onWelcome(m: Record<string, unknown>): Promise<void> {
    this.clientId = Number(m.id);
    this.version = String(m.version ?? '');
    this.pinRequired = !!m.pinRequired;
    try {
      const h = await this.req<{ role: Role; devices: DeviceInfo[] }>({ t: 'hello', pin: this.pin || undefined, name: this.name });
      this.role = h.role;
      this.devices = h.devices;
    } catch {
      // wrong saved PIN: continue as a viewer, the app asks again
      this.pin = '';
      const h = await this.req<{ role: Role; devices: DeviceInfo[] }>({ t: 'hello', name: this.name });
      this.role = h.role;
      this.devices = h.devices;
    }
    this.retryMs = 800;
    this.em.emit('devices', this.devices);
    this.setStatus('online');
    this.started?.res();
    this.started = null;
  }

  private onMessage(m: Record<string, unknown>): void {
    switch (m.t) {
      case 'welcome': void this.onWelcome(m).catch((e: Error) => { this.started?.rej(e); this.started = null; }); return;
      case 'result': {
        const p = this.pending.get(Number(m.rid));
        if (!p) return;
        this.pending.delete(Number(m.rid));
        clearTimeout(p.timer);
        if (m.ok) p.res(m.value); else p.rej(new BridgeError(String(m.error ?? 'erreur')));
        return;
      }
      case 'devices': this.devices = m.list as DeviceInfo[]; this.em.emit('devices', this.devices); return;
      case 'snapshot': this.em.emit('snapshot', { key: String(m.key), snap: m.snap as SessionSnapshot }); return;
      case 'action': this.em.emit('action', { key: String(m.key), action: m.action as Action, origin: Number(m.origin), seq: Number(m.seq) }); return;
      case 'meters': this.em.emit('meters', { key: String(m.key), db: m.db as number[], status: Number(m.status) }); return;
      case 'frame': this.em.emit('frame', { key: String(m.key), dir: m.dir as 'tx' | 'rx', hex: String(m.hex), at: Number(m.at) }); return;
    }
  }

  private req<T = unknown>(msg: Record<string, unknown>, timeoutMs = 20000): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new BridgeError(t('pont non connecté')));
    const rid = ++this.rid;
    return new Promise<T>((res, rej) => {
      const timer = setTimeout(() => { this.pending.delete(rid); rej(new BridgeError(t('le pont ne répond pas'))); }, timeoutMs);
      this.pending.set(rid, { res: res as (v: unknown) => void, rej, timer });
      ws.send(JSON.stringify({ ...msg, rid }));
    });
  }

  async login(pin: string): Promise<Role> {
    const h = await this.req<{ role: Role; devices: DeviceInfo[] }>({ t: 'hello', pin, name: this.name });
    this.pin = pin;
    this.role = h.role;
    this.em.emit('status', this.status);
    return h.role;
  }

  async subscribe(key: string, debug = false): Promise<{ info: DeviceInfo; snap: SessionSnapshot | null }> {
    this.subs.set(key, debug);
    return this.req({ t: 'subscribe', key, debug });
  }
  unsubscribe(key: string): void {
    this.subs.delete(key);
    void this.req({ t: 'unsubscribe', key }).catch(() => {});
  }
  async action(key: string, a: Action, seq: number): Promise<void> { await this.req({ t: 'action', key, action: a, seq }); }
  call<T = unknown>(key: string, method: string, args: unknown[] = []): Promise<T> {
    return this.req<T>({ t: 'call', key, method, args }, 240000);
  }
  addDevice(spec: SourceSpec, label?: string): Promise<DeviceInfo> { return this.req({ t: 'add', spec, label }); }
  async removeDevice(key: string): Promise<void> { await this.req({ t: 'remove', key }); }
  async renameDevice(key: string, label: string): Promise<void> { await this.req({ t: 'rename', key, label }); }
  async connectDevice(key: string): Promise<void> { await this.req({ t: 'connect', key }); }
  async disconnectDevice(key: string): Promise<void> { await this.req({ t: 'disconnect', key }); }
  discover(sweep: boolean): Promise<FoundModule[]> { return this.req({ t: 'discover', sweep }, sweep ? 60000 : 10000); }
  ports(): Promise<PortsInfo> { return this.req({ t: 'ports' }); }
  probe(spec: SourceSpec, max = 16): Promise<{ id: number; version: string }[]> { return this.req({ t: 'probe', spec, max }, 60000); }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }
}
