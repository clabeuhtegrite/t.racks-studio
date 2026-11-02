// The device hub: every DSP the bridge drives (several at once), with automatic reconnection.
// Each device has one DeviceSession; all web clients share it, so they always see the same state.

import { EventEmitter } from 'node:events';
import {
  describeSource, DeviceSession, DSP_TCP_PORT, sourceKey, type DeviceInfo, type SessionSnapshot, type SourceSpec, type Transport, type VirtualDsp,
} from '@dsp-studio/protocol';
import { demoTransport, serialTransport, tcpTransport, usbTransport } from './transports.ts';

export type { DeviceInfo, SourceSpec };
export const describe = describeSource;
export const specKey = sourceKey;

async function open(spec: SourceSpec): Promise<{ transport: Transport; sim?: VirtualDsp }> {
  switch (spec.kind) {
    case 'tcp': return { transport: await tcpTransport(spec.host, spec.port ?? DSP_TCP_PORT) };
    case 'usb': return { transport: await usbTransport(spec.path) };
    case 'serial': return { transport: await serialTransport(spec.path, spec.baud ?? 115200) };
    case 'demo': return demoTransport(spec.model, spec.deviceId ?? 1);
    default: throw new Error('cette source ne fonctionne que dans le navigateur');
  }
}

export class Device extends EventEmitter {
  readonly key: string;
  label: string;
  readonly spec: SourceSpec;
  session: DeviceSession | null = null;
  sim: VirtualDsp | null = null;
  state: DeviceInfo['state'] = 'offline';
  error: string | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private retryMs = 2000;

  constructor(spec: SourceSpec, label?: string) {
    super();
    this.spec = spec;
    this.key = specKey(spec);
    this.label = label ?? describe(spec);
  }

  info(): DeviceInfo {
    const snap = this.session?.snap;
    return {
      key: this.key, label: this.label, spec: this.spec, state: this.state, error: this.error,
      model: snap?.model ?? null, presetName: snap?.config?.presetName ?? '',
    };
  }

  private setState(s: DeviceInfo['state'], error: string | null = null): void {
    this.state = s; this.error = error;
    this.emit('info', this.info());
  }

  async start(): Promise<void> {
    this.stopped = false;
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    this.setState('connecting');
    try {
      const { transport, sim } = await open(this.spec);
      this.sim = sim ?? null;
      const s = new DeviceSession(transport, { deviceId: this.spec.deviceId ?? 1 });
      this.session = s;
      s.on('snapshot', (snap) => this.emit('snapshot', snap));
      s.on('action', (a) => this.emit('action', a));
      s.on('meters', (m) => this.emit('meters', m));
      s.on('frame', (f) => this.emit('frame', f));
      s.on('status', (st) => {
        if (st === 'closed' && this.session === s) {
          this.session = null;
          this.setState('offline', 'liaison perdue');
          this.schedule();
        } else if (st === 'locked') this.setState('locked');
        else if (st === 'ready') this.setState('online');
      });
      await s.connect();
      this.retryMs = 2000;
      this.setState(s.snap.status === 'locked' ? 'locked' : 'online');
    } catch (e) {
      const msg = (e as Error).message;
      const s = this.session;
      this.session = null; // before close(): the 'closed' status must not schedule a second retry
      try { await s?.close(); } catch { /* ignore */ }
      this.setState('offline', msg);
      this.schedule();
    }
  }

  private schedule(): void {
    if (this.stopped || this.spec.kind === 'demo') return;
    if (this.retry) clearTimeout(this.retry);
    this.retry = setTimeout(() => { this.retry = null; void this.start(); }, this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, 30000);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    const s = this.session;
    this.session = null;
    if (s) await s.close();
    this.setState('offline');
  }

  snapshot(): SessionSnapshot | null { return this.session?.snap ?? null; }
}

export class Hub extends EventEmitter {
  readonly devices = new Map<string, Device>();

  list(): DeviceInfo[] { return [...this.devices.values()].map((d) => d.info()); }

  add(spec: SourceSpec, label?: string): Device {
    const key = specKey(spec);
    const existing = this.devices.get(key);
    if (existing) return existing;
    const d = new Device(spec, label);
    this.devices.set(key, d);
    d.on('info', () => this.emit('devices', this.list()));
    for (const ev of ['snapshot', 'action', 'meters', 'frame'] as const) d.on(ev, (v) => this.emit(ev, d.key, v));
    this.emit('devices', this.list());
    void d.start();
    return d;
  }

  async remove(key: string): Promise<void> {
    const d = this.devices.get(key);
    if (!d) return;
    this.devices.delete(key);
    await d.stop();
    this.emit('devices', this.list());
  }

  get(key: string): Device | undefined { return this.devices.get(key); }

  async close(): Promise<void> {
    await Promise.all([...this.devices.values()].map((d) => d.stop()));
  }
}
