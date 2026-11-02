// Backend running entirely in the browser: demo devices (virtual DSP), USB through WebHID and
// RS-232 / RS-485 through Web Serial. Used when the app is opened without a bridge (for instance
// from a static web host), and offers the same operations as the bridge.

import {
  callSession, DeviceSession, describeSource, Leveler, probeIds, restoreLevelerSettings, restoreLevelerTotals, sourceKey, validateAction, VirtualDsp,
  type Action, type DeviceInfo, type DeviceState, type FoundModule, type LevelerSettings, type LevelerState, type LevelerTotals, type Role, type SessionSnapshot, type SourceSpec, type Transport,
} from '@dsp-studio/protocol';
import { Emitter, APP_VERSION, type Backend, type BackendEvents, type BackendStatus, type LevelerOp, type LibraryApi, type LibraryDraft, type LibraryEntry, type LibrarySummary, type PortsInfo } from './types.ts';
import { DSP_HID_FILTER, grantedHidDevices, hasWebHid, hasWebSerial, serialPortName, webHidTransport, webSerialTransport } from './webtransports.ts';
import { t } from '../i18n.tsx';

const SAVED_KEY = 'dsp-studio.local-devices';
const LIBRARY_KEY = 'dsp-studio.library';
/** automatic gain of each device (settings, reference gains) */
const LEVELER_KEY = 'dsp-studio.leveler';

const clone = <T>(v: T): T => structuredClone(v);

function readJson<T>(key: string, fallback: T): T {
  try { const s = localStorage.getItem(key); return s ? (JSON.parse(s) as T) : fallback; } catch { return fallback; }
}
function writeJson(key: string, v: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) {
    throw new Error(t('stockage du navigateur plein ou indisponible ({0})', (e as Error).message));
  }
}

class LocalLibrary implements LibraryApi {
  readonly shared = false;
  private all(): LibraryEntry[] { return readJson<LibraryEntry[]>(LIBRARY_KEY, []); }
  async list(): Promise<LibrarySummary[]> {
    return this.all().map(({ data: _d, ...m }) => m).sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }
  async get(id: string): Promise<LibraryEntry> {
    const e = this.all().find((x) => x.id === id);
    if (!e) throw new Error(t('entrée introuvable'));
    return e;
  }
  async save(d: LibraryDraft): Promise<LibrarySummary> {
    const entry: LibraryEntry = {
      id: d.id ?? crypto.randomUUID(), kind: d.kind, model: d.model, name: String(d.name).slice(0, 80) || t('Sans nom'),
      notes: String(d.notes ?? '').slice(0, 4000), tags: (d.tags ?? []).map(String).slice(0, 20), savedAt: new Date().toISOString(), data: d.data,
    };
    const list = this.all().filter((x) => x.id !== entry.id);
    list.push(entry);
    writeJson(LIBRARY_KEY, list);
    const { data: _d, ...meta } = entry;
    return meta;
  }
  async remove(id: string): Promise<void> { writeJson(LIBRARY_KEY, this.all().filter((x) => x.id !== id)); }
}

type Opener = () => Promise<{ transport: Transport; sim?: VirtualDsp }>;

class LocalDevice {
  readonly key: string;
  label: string;
  readonly spec: SourceSpec;
  state: DeviceState = 'idle';
  error: string | null = null;
  session: DeviceSession | null = null;
  sim: VirtualDsp | null = null;
  private opener: Opener;
  private onChange: () => void;
  private forward: (ev: 'snapshot' | 'action' | 'meters' | 'frame', v: unknown) => void;
  private stopped = true;
  private opening = false;

  constructor(spec: SourceSpec, opener: Opener, onChange: () => void, forward: LocalDevice['forward'], label?: string) {
    this.spec = spec;
    this.key = sourceKey(spec);
    this.label = label ?? describeSource(spec);
    this.opener = opener;
    this.onChange = onChange;
    this.forward = forward;
  }

  info(): DeviceInfo {
    const snap = this.session?.snap;
    return { key: this.key, label: this.label, spec: this.spec, state: this.state, error: this.error, model: snap?.model ?? null, presetName: snap?.config?.presetName ?? '' };
  }
  private set(state: DeviceState, error: string | null = null): void { this.state = state; this.error = error; this.onChange(); }

  /** Connects; does nothing when already connected or connecting. */
  async start(): Promise<void> {
    this.stopped = false;
    if (this.session || this.opening) return;
    this.opening = true;
    this.set('connecting');
    try {
      const { transport, sim } = await this.opener();
      this.sim = sim ?? null;
      const s = new DeviceSession(transport, { deviceId: this.spec.deviceId ?? 1 });
      this.session = s;
      s.on('snapshot', (snap) => this.forward('snapshot', snap));
      s.on('action', (a) => this.forward('action', a));
      s.on('meters', (m) => this.forward('meters', m));
      s.on('frame', (f) => this.forward('frame', f));
      s.on('status', (st) => {
        if (st === 'closed' && this.session === s) { this.session = null; this.set('offline', this.stopped ? null : t('liaison perdue')); }
        else if (st === 'locked') this.set('locked');
        else if (st === 'ready') this.set('online');
      });
      await s.connect();
      this.set(s.snap.status === 'locked' ? 'locked' : 'online');
    } catch (e) {
      const s = this.session;
      this.session = null;
      try { await s?.close(); } catch { /* ignore */ }
      this.set(this.stopped ? 'idle' : 'offline', this.stopped ? null : (e as Error).message);
    } finally { this.opening = false; }
    if (this.stopped && this.session) await this.stop(); // disconnected while connecting
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const s = this.session;
    this.session = null;
    if (s) await s.close();
    this.set('idle');
  }
}

export class LocalBackend implements Backend {
  readonly kind = 'local' as const;
  readonly clientId = 1;
  readonly role: Role = 'admin';
  readonly pinRequired = false;
  readonly sandbox = false;
  readonly version = APP_VERSION;
  status: BackendStatus = 'online';
  readonly library = new LocalLibrary();
  readonly features = { discover: false, ports: false, probe: false, webhid: hasWebHid(), webserial: hasWebSerial(), demo: true };
  private map = new Map<string, LocalDevice>();
  private hid = new Map<string, HIDDevice>();
  private serial = new Map<string, SerialPort>();
  private subs = new Map<string, boolean>();
  private em = new Emitter<BackendEvents>();
  private origin: { key: string; seq: number } | null = null;
  private snapTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // automatic gain: runs in this page while it is open (with the bridge, it runs in the bridge)
  private levelers = new Map<string, Leveler>();
  private levelerSaved = readJson<Record<string, { settings?: unknown; base?: unknown; totals?: unknown }>>(LEVELER_KEY, {});

  get devices(): DeviceInfo[] { return [...this.map.values()].map((d) => d.info()); }
  on<K extends keyof BackendEvents>(k: K, f: (v: BackendEvents[K]) => void): () => void { return this.em.on(k, f); }

  private changed = (): void => {
    for (const [key, d] of this.map) {
      const lv = this.levelers.get(key);
      if (lv && d.session && d.state === 'online') lv.attach(d.session);
      else if (lv?.attached) lv.detach();
    }
    this.em.emit('devices', this.devices);
    this.persist();
  };

  private forwarder(key: string): (ev: 'snapshot' | 'action' | 'meters' | 'frame', v: unknown) => void {
    return (ev, v) => {
      if (!this.subs.has(key)) return;
      if (ev === 'snapshot') {
        // like the bridge: at most one snapshot every 100 ms, as a copy
        if (this.snapTimers.has(key)) return;
        this.snapTimers.set(key, setTimeout(() => {
          this.snapTimers.delete(key);
          const s = this.map.get(key)?.session?.snap;
          if (s) this.em.emit('snapshot', { key, snap: clone(s) });
        }, 60));
      } else if (ev === 'action') {
        const a = v as { action: Action };
        const o = this.origin && this.origin.key === key ? this.origin : null;
        this.em.emit('action', { key, action: clone(a.action), origin: o ? this.clientId : 0, seq: o?.seq ?? 0 });
      } else if (ev === 'meters') {
        const m = v as { db: number[]; status: number };
        this.em.emit('meters', { key, db: m.db.map((x) => Math.round(x * 10) / 10), status: m.status });
      } else if (ev === 'frame' && this.subs.get(key)) {
        const f = v as { dir: 'tx' | 'rx'; hex: string; t: number };
        this.em.emit('frame', { key, dir: f.dir, hex: f.hex, at: f.t });
      }
    };
  }

  private persist(): void {
    const saved = [...this.map.values()].map((d) => ({ spec: d.spec, label: d.label }));
    try { localStorage.setItem(SAVED_KEY, JSON.stringify(saved)); } catch { /* private mode */ }
  }

  /** Adds a device (or returns the known one), connecting it unless `connect` is false. */
  private create(spec: SourceSpec, opener: Opener, label?: string, connect = true): LocalDevice {
    const key = sourceKey(spec);
    const existing = this.map.get(key);
    if (existing) { if (connect) void existing.start(); return existing; }
    const d = new LocalDevice(spec, opener, this.changed, this.forwarder(key), label);
    this.map.set(key, d);
    this.levelers.set(key, this.newLeveler(key));
    this.changed();
    if (connect) void d.start();
    return d;
  }

  private newLeveler(key: string): Leveler {
    const saved = this.levelerSaved[key];
    const base = Array.isArray(saved?.base) && saved.base.every((x) => Number.isInteger(x)) ? (saved.base as number[]) : null;
    // in the browser the history of the night lasts as long as the page
    const lv = new Leveler({
      settings: restoreLevelerSettings(saved?.settings), base, totals: restoreLevelerTotals(saved?.totals),
      save: (settings: LevelerSettings, b: number[] | null, totals: LevelerTotals) => {
        this.levelerSaved[key] = { settings, base: b, totals };
        try { localStorage.setItem(LEVELER_KEY, JSON.stringify(this.levelerSaved)); } catch { /* private mode */ }
      },
    });
    lv.onState((state) => { if (this.subs.has(key)) this.em.emit('leveler', { key, state: clone(state) }); });
    return lv;
  }

  private demoOpener(spec: Extract<SourceSpec, { kind: 'demo' }>): Opener {
    return async () => {
      const sim = new VirtualDsp({ model: spec.model, deviceId: spec.deviceId ?? 1, latencyMs: 2 });
      return { transport: sim.transport(), sim };
    };
  }

  /** Lists the remembered devices, not connected: connections are opened from the interface. */
  async start(): Promise<void> {
    const saved = readJson<{ spec: SourceSpec; label?: string }[]>(SAVED_KEY, []);
    const granted = await grantedHidDevices().catch(() => [] as HIDDevice[]);
    const ports = hasWebSerial() ? await navigator.serial.getPorts().catch(() => [] as SerialPort[]) : [];
    for (const s of saved) {
      if (s.spec.kind === 'demo') this.create(s.spec, this.demoOpener(s.spec), s.label, false);
      else if (s.spec.kind === 'webhid') {
        const dev = granted.find((g) => (g.productName || '') === (s.spec as { name?: string }).name) ?? granted[0];
        if (dev) this.addHid(dev, s.spec.deviceId, s.label, false);
      } else if (s.spec.kind === 'webserial') {
        const spec = s.spec;
        const port = ports.find((p) => serialPortName(p) === spec.name) ?? (ports.length === 1 ? ports[0] : undefined);
        if (port) this.addSerial(port, spec.baud, spec.deviceId, s.label, false);
      }
    }
    if (hasWebHid()) {
      navigator.hid.addEventListener('connect', (e) => {
        const d = e.device;
        if (d.vendorId !== DSP_HID_FILTER.vendorId || d.productId !== DSP_HID_FILTER.productId) return;
        const known = [...this.map.values()].find((x) => x.spec.kind === 'webhid' && this.hid.get(x.key) === d);
        if (known && known.state === 'offline') void known.start();
      });
    }
    this.em.emit('status', 'online');
  }

  private addHid(dev: HIDDevice, deviceId?: number, label?: string, connect = true): LocalDevice {
    const spec: SourceSpec = { kind: 'webhid', name: dev.productName || 'DSP', deviceId };
    this.hid.set(sourceKey(spec), dev);
    return this.create(spec, async () => ({ transport: await webHidTransport(dev) }), label, connect);
  }

  private addSerial(port: SerialPort, baud = 115200, deviceId?: number, label?: string, connect = true): LocalDevice {
    const spec: SourceSpec = { kind: 'webserial', name: serialPortName(port), baud, deviceId };
    this.serial.set(sourceKey(spec), port);
    return this.create(spec, async () => ({ transport: await webSerialTransport(port, baud) }), label, connect);
  }

  async requestUsb(deviceId?: number): Promise<DeviceInfo | null> {
    if (!hasWebHid()) throw new Error(t('WebHID indisponible : utilisez Chrome ou Edge sur une page https ou localhost'));
    const list = await navigator.hid.requestDevice({ filters: [DSP_HID_FILTER] });
    if (!list.length) return null;
    return this.addHid(list[0], deviceId).info();
  }

  async requestSerial(baud = 115200, deviceId?: number): Promise<DeviceInfo | null> {
    if (!hasWebSerial()) throw new Error(t('Web Serial indisponible : utilisez Chrome ou Edge sur une page https ou localhost'));
    const port = await navigator.serial.requestPort();
    return this.addSerial(port, baud, deviceId).info();
  }

  async login(): Promise<Role> { return 'admin'; }

  async subscribe(key: string, debug = false): Promise<{ info: DeviceInfo; snap: SessionSnapshot | null; leveler?: LevelerState | null }> {
    const d = this.map.get(key);
    if (!d) throw new Error(t('appareil inconnu'));
    this.subs.set(key, debug);
    return { info: d.info(), snap: d.session ? clone(d.session.snap) : null, leveler: this.levelers.get(key)?.state() ?? null };
  }
  unsubscribe(key: string): void { this.subs.delete(key); }

  private sessionOf(key: string): DeviceSession {
    const s = this.map.get(key)?.session;
    if (!s) throw new Error(t('l\'appareil n\'est pas connecté'));
    return s;
  }

  async action(key: string, a: Action, seq: number): Promise<void> {
    const s = this.sessionOf(key);
    if (!s.snap.model) throw new Error(t('l\'appareil n\'est pas prêt'));
    if (s.snap.status === 'locked') throw new Error(t('l\'appareil est verrouillé'));
    const clean = validateAction(s.snap.model, a);
    this.origin = { key, seq };
    let p: Promise<void>;
    try { p = s.apply(clean); } finally { this.origin = null; }
    await p;
  }

  async call<T = unknown>(key: string, method: string, args: unknown[] = []): Promise<T> {
    return clone(await callSession(this.sessionOf(key), method, clone(args))) as T;
  }

  async leveler<T = unknown>(key: string, op: LevelerOp, value?: unknown): Promise<T> {
    const lv = this.levelers.get(key);
    if (!lv) throw new Error(t('appareil inconnu'));
    switch (op) {
      case 'state': return clone(lv.state()) as T;
      case 'history': return clone(lv.history(typeof value === 'number' ? value : undefined)) as T;
      case 'enable': return clone(lv.enable(value === true)) as T;
      case 'pause': return clone(lv.pause(value)) as T;
      case 'set': return clone(lv.update(clone(value))) as T;
      case 'target': return clone(lv.takeTarget()) as T;
      case 'check': return clone(await lv.checkMeter()) as T;
      default: throw new Error(t('requête inconnue'));
    }
  }

  async addDevice(spec: SourceSpec, label?: string): Promise<DeviceInfo> {
    if (spec.kind !== 'demo') throw new Error(t('dans le navigateur, branchez le DSP avec les boutons USB ou Série'));
    return this.create(spec, this.demoOpener(spec), label).info();
  }
  async removeDevice(key: string): Promise<void> {
    const d = this.map.get(key);
    if (!d) return;
    this.map.delete(key);
    await d.stop();
    this.levelers.get(key)?.detach();
    this.levelers.delete(key);
    if (this.levelerSaved[key]) {
      delete this.levelerSaved[key];
      try { localStorage.setItem(LEVELER_KEY, JSON.stringify(this.levelerSaved)); } catch { /* private mode */ }
    }
    const dev = this.hid.get(key);
    if (dev) { this.hid.delete(key); try { await dev.forget(); } catch { /* old browsers */ } }
    this.serial.delete(key);
    this.changed();
  }
  async renameDevice(key: string, label: string): Promise<void> {
    const d = this.map.get(key);
    if (d) { d.label = label.slice(0, 60) || d.label; this.changed(); }
  }
  async connectDevice(key: string): Promise<void> {
    const d = this.map.get(key);
    if (!d) throw new Error(t('appareil inconnu'));
    void d.start();
  }
  async disconnectDevice(key: string): Promise<void> { await this.map.get(key)?.stop(); }
  async discover(): Promise<FoundModule[]> { return []; }
  async ports(): Promise<PortsInfo> { return { usb: null, serial: null }; }
  async probe(spec: SourceSpec, max = 16): Promise<{ id: number; version: string }[]> {
    // only for a granted USB / serial device that is not in use
    const key = sourceKey(spec);
    if (this.map.get(key)?.session) throw new Error(t('déconnectez d\'abord l\'appareil'));
    const dev = this.hid.get(key);
    const port = this.serial.get(key);
    const tr = dev ? await webHidTransport(dev) : port ? await webSerialTransport(port, (spec as { baud?: number }).baud) : null;
    if (!tr) return [];
    try { return await probeIds(tr, max); } finally { await tr.close(); }
  }
  close(): void { for (const d of this.map.values()) void d.stop(); }
}
