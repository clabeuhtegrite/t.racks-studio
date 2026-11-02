// The device hub: every DSP the bridge knows (several at once). Devices are remembered and connected
// from the interface; once connected, a device that goes away is reconnected automatically until it
// is disconnected. Each device has one DeviceSession, shared by all web clients, so they always see
// the same state.

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
  state: DeviceInfo['state'] = 'idle';
  error: string | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private opening = false;
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

  /** Connects (or retries at once when a retry is pending); does nothing when already connected. */
  async start(): Promise<void> {
    this.stopped = false;
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    if (this.session || this.opening) return;
    this.opening = true;
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
      if (this.stopped) this.setState('idle'); // disconnected while connecting
      else { this.setState('offline', msg); this.schedule(); }
    } finally { this.opening = false; }
    if (this.stopped && this.session) await this.stop(); // disconnected while connecting
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
    this.setState('idle');
  }

  snapshot(): SessionSnapshot | null { return this.session?.snap ?? null; }
}

export class Hub extends EventEmitter {
  readonly devices = new Map<string, Device>();

  list(): DeviceInfo[] { return [...this.devices.values()].map((d) => d.info()); }

  /** Adds a device (or returns the known one with that key), connecting it unless `connect` is false. */
  add(spec: SourceSpec, label?: string, connect = true): Device {
    const key = specKey(spec);
    const existing = this.devices.get(key);
    if (existing) { if (connect) void existing.start(); return existing; }
    const d = new Device(spec, label);
    this.devices.set(key, d);
    d.on('info', () => this.emit('devices', this.list()));
    for (const ev of ['snapshot', 'action', 'meters', 'frame'] as const) d.on(ev, (v) => this.emit(ev, d.key, v));
    this.emit('devices', this.list());
    if (connect) void d.start();
    return d;
  }

  connect(key: string): void { this.need(key).start().catch(() => { /* reported in the device state */ }); }
  async disconnect(key: string): Promise<void> { await this.need(key).stop(); }

  private need(key: string): Device {
    const d = this.devices.get(key);
    if (!d) throw new Error('appareil inconnu');
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
