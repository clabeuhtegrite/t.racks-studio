// DeviceSession: everything needed to drive one DSP over any byte transport (USB HID, TCP through
// the Ethernet module, RS-232/RS-485, the virtual DSP or the firmware emulator). Isomorphic: runs
// in Node (bridge) and in the browser (WebHID / Web Serial / demo mode).

import { CMD, cmd, decodeAscii, decodeLockStatus, decodeMeters, FORBIDDEN, REPLY_PAGE, type Command, type LockStatus, type Meters } from './commands.ts';
import { parseConfig, serializeConfig, type DeviceConfig } from './config.ts';
import { decodeUnitSystem, UNIT_SYSTEM_BYTES, type UnitFile, type UnitPreset } from './files.ts';
import { encodeFrame, FrameParser, toHex, type Frame } from './frame.ts';
import { MODELS, modelFromVersion, type ModelSpec } from './models.ts';
import { actionCommands, actionKey, applyAction, configToActions, diffActions, type Action } from './state.ts';
import { EEPROM } from './commands.ts';

export interface Transport {
  readonly kind: string;
  send(bytes: Uint8Array): void | Promise<void>;
  onData(cb: (chunk: Uint8Array) => void): void;
  onClose(cb: (err?: Error) => void): void;
  close(): void | Promise<void>;
}

export interface PresetSlot { slot: number; name: string; user: boolean }
export interface SystemInfo { deviceId: number; ip: [number, number, number, number]; raw: number[] }
export type SessionStatus = 'idle' | 'connecting' | 'locked' | 'syncing' | 'ready' | 'busy' | 'closed' | 'error';

export interface SessionSnapshot {
  status: SessionStatus;
  model: ModelSpec['id'] | null;
  version: string;
  versionExt: string;
  deviceId: number;
  config: DeviceConfig | null;
  activePreset: number;
  presets: PresetSlot[];
  lock: LockStatus | null;
  system: SystemInfo | null;
  progress: { label: string; done: number; total: number } | null;
}

type Listener<T> = (v: T) => void;
class Emitter<E extends Record<string, unknown>> {
  private l: { [K in keyof E]?: Set<Listener<E[K]>> } = {};
  on<K extends keyof E>(k: K, f: Listener<E[K]>): () => void {
    (this.l[k] ??= new Set()).add(f);
    return () => this.l[k]?.delete(f);
  }
  emit<K extends keyof E>(k: K, v: E[K]): void { this.l[k]?.forEach((f) => { try { f(v); } catch (e) { console.error(e); } }); }
}

export interface SessionEvents extends Record<string, unknown> {
  status: SessionStatus;
  snapshot: SessionSnapshot;
  action: { action: Action; channels: number[] };
  config: DeviceConfig;
  meters: Meters;
  frame: { dir: 'tx' | 'rx'; hex: string; t: number };
  error: string;
}

interface Pending {
  c: Command;
  key?: string;
  expect: number[]; // acceptable reply opcodes
  resolve: (f: Frame) => void;
  reject: (e: Error) => void;
  tries: number;
  low?: boolean;
  timeoutMs?: number;
}

export interface RequestOptions {
  /** coalesces repeated edits of the same parameter (only the last queued value is sent) */
  key?: string;
  /** low priority (meters): dropped when one is already queued */
  low?: boolean;
  /** reply timeout for slow commands (EEPROM writes) */
  timeoutMs?: number;
}

export interface SessionOptions {
  deviceId?: number;
  meterIntervalMs?: number;
  timeoutMs?: number;
  retries?: number;
  /** skip the config download at connect (used by tools) */
  lazy?: boolean;
}

export class DeviceSession extends Emitter<SessionEvents> {
  readonly transport: Transport;
  private parser = new FrameParser();
  private queue: Pending[] = [];
  private inflight: Pending | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private meterTimer: ReturnType<typeof setInterval> | null = null;
  private opts: Required<SessionOptions>;
  snap: SessionSnapshot;

  constructor(transport: Transport, opts: SessionOptions = {}) {
    super();
    this.transport = transport;
    this.opts = { deviceId: 1, meterIntervalMs: 250, timeoutMs: 800, retries: 2, lazy: false, ...opts };
    this.snap = {
      status: 'idle', model: null, version: '', versionExt: '', deviceId: this.opts.deviceId, config: null,
      activePreset: 0, presets: [], lock: null, system: null, progress: null,
    };
    transport.onData((chunk) => { for (const f of this.parser.push(chunk)) this.onFrame(f); });
    transport.onClose((err) => {
      this.stopMeters();
      this.failAll(new Error(err?.message ?? 'transport closed'));
      this.setStatus('closed');
    });
  }

  get model(): ModelSpec | null { return this.snap.model ? MODELS[this.snap.model] : null; }
  get config(): DeviceConfig | null { return this.snap.config; }

  private setStatus(s: SessionStatus): void {
    if (this.snap.status === s) return;
    this.snap.status = s;
    this.emit('status', s);
    this.emit('snapshot', this.snap);
  }
  private changed(): void { this.emit('snapshot', this.snap); }

  // ------------------------------------------------------------------ low level
  private onFrame(f: Frame): void {
    this.emit('frame', { dir: 'rx', hex: toHex([f.cmd, ...f.data]), t: Date.now() });
    if (f.dst !== 0) return; // not for the host
    // Frames nobody waits for are dropped, among them 0xb8 / 0xbe, which the firmware sends to
    // its Ethernet module (with dst 0 too) at power on.
    const p = this.inflight;
    if (!p) return;
    if (p.expect.includes(f.cmd) || f.cmd === CMD.NAK) {
      this.clearTimer();
      this.inflight = null;
      if (f.cmd === CMD.NAK && !p.expect.includes(CMD.NAK)) p.reject(new Error(`command 0x${p.c.cmd.toString(16)} refused (NAK)`));
      else p.resolve(f);
      this.pump();
    }
  }
  private clearTimer(): void { if (this.timer) { clearTimeout(this.timer); this.timer = null; } }
  private failAll(e: Error): void {
    this.clearTimer();
    const all = [...(this.inflight ? [this.inflight] : []), ...this.queue];
    this.inflight = null; this.queue = [];
    all.forEach((p) => p.reject(e));
  }
  private pump(): void {
    if (this.inflight || !this.queue.length) return;
    const p = this.queue.shift()!;
    this.inflight = p;
    if (FORBIDDEN.has(p.c.cmd)) { this.inflight = null; p.reject(new Error(`commande 0x${p.c.cmd.toString(16)} interdite`)); this.pump(); return; }
    const bytes = encodeFrame(p.c.cmd, p.c.data, 0, this.snap.deviceId);
    this.emit('frame', { dir: 'tx', hex: toHex([p.c.cmd, ...p.c.data]), t: Date.now() });
    // arm the timeout before sending: a transport may answer synchronously
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.inflight !== p) return;
      this.inflight = null;
      if (p.tries < this.opts.retries) { p.tries++; this.queue.unshift(p); }
      else p.reject(new Error(`pas de réponse à la commande 0x${p.c.cmd.toString(16)}`));
      this.pump();
    }, p.timeoutMs ?? this.opts.timeoutMs);
    try {
      const r = this.transport.send(bytes);
      if (r && typeof (r as Promise<void>).catch === 'function') (r as Promise<void>).catch((e) => this.onSendError(p, e));
    } catch (e) { this.onSendError(p, e); }
  }
  private onSendError(p: Pending, e: unknown): void {
    if (this.inflight !== p) { p.reject(e instanceof Error ? e : new Error(String(e))); return; }
    this.clearTimer();
    this.inflight = null;
    p.reject(e instanceof Error ? e : new Error(String(e)));
    this.pump();
  }

  /** Send a command and wait for its reply. */
  request(c: Command, expect: number[] = [CMD.ACK], o: RequestOptions = {}): Promise<Frame> {
    const { key, low, timeoutMs } = o;
    return new Promise<Frame>((resolve, reject) => {
      if (key) {
        const i = this.queue.findIndex((q) => q.key === key);
        if (i >= 0) {
          const old = this.queue[i];
          this.queue[i] = { c, key, expect, timeoutMs, resolve: (f) => { old.resolve(f); resolve(f); }, reject: (e) => { old.reject(e); reject(e); }, tries: 0 };
          return;
        }
      }
      const p: Pending = { c, key, expect, resolve, reject, tries: 0, low, timeoutMs };
      if (low && this.queue.some((q) => q.low)) { reject(new Error('dropped')); return; }
      this.queue.push(p);
      this.pump();
    });
  }
  get queueLength(): number { return this.queue.length + (this.inflight ? 1 : 0); }

  // ------------------------------------------------------------------ connection
  async connect(): Promise<void> {
    this.setStatus('connecting');
    await this.request(cmd.login(), [CMD.LOGIN]);
    const v = await this.request(cmd.version(), [CMD.VERSION]);
    this.snap.version = decodeAscii(v.data);
    const model = modelFromVersion(this.snap.version);
    if (!model) throw new Error(`appareil non reconnu : "${this.snap.version}"`);
    this.snap.model = model.id;
    try { this.snap.versionExt = decodeAscii((await this.request(cmd.versionExt(), [CMD.VERSION_EXT])).data); } catch { /* optional */ }
    await this.refreshLock();
    if (this.snap.lock?.locked) { this.setStatus('locked'); return; }
    if (!this.opts.lazy) await this.sync();
    this.startMeters();
  }

  async refreshLock(): Promise<LockStatus> {
    const f = await this.request(cmd.lockStatus(), [CMD.LOCK_STATUS]);
    this.snap.lock = decodeLockStatus(f.data);
    this.changed();
    return this.snap.lock;
  }

  /** Full read-back: presets list, active preset and the live configuration. */
  async sync(): Promise<void> {
    const m = this.model!;
    this.setStatus('syncing');
    const total = m.userPresets + m.pages + 2;
    let done = 0;
    const prog = (label: string): void => { this.snap.progress = { label, done: ++done, total }; this.changed(); };
    const info = await this.request(cmd.presetInfo(), [CMD.PRESET_INFO]); prog('Presets');
    const presets: PresetSlot[] = [];
    for (let s = 1; s <= m.userPresets; s++) {
      const f = await this.request(cmd.presetName(s), [CMD.GET_PRESET_NAME]);
      presets.push({ slot: s, name: decodeAscii(f.data, 1), user: info.data[s - 1] === 0xff });
      prog('Presets');
    }
    this.snap.presets = presets;
    const ap = await this.request(cmd.activePreset(), [CMD.ACTIVE_PRESET]); prog('Preset actif');
    this.snap.activePreset = ap.data[0] ?? 0;
    await this.readConfig((d) => prog(`Configuration ${d}/${m.pages}`));
    try { await this.readSystem(); } catch { /* old firmware */ }
    this.snap.progress = null;
    this.setStatus('ready');
    this.changed();
  }

  async readConfig(onPage?: (n: number) => void): Promise<DeviceConfig> {
    const m = this.model!;
    const buf = new Uint8Array(m.pages * m.pageSize);
    for (let p = 0; p < m.pages; p++) {
      const f = await this.request(cmd.readPage(p), [REPLY_PAGE]);
      if (f.data[0] !== p) throw new Error(`page ${p} attendue, ${f.data[0]} reçue`);
      buf.set(f.data.subarray(1), p * m.pageSize);
      onPage?.(p + 1);
    }
    this.snap.config = parseConfig(m, buf.subarray(0, m.configSize));
    this.emit('config', this.snap.config);
    this.changed();
    return this.snap.config;
  }

  async readSystem(): Promise<SystemInfo> {
    const f = await this.request(cmd.eepromRead(0, EEPROM.SYSTEM_SIZE), [CMD.EEPROM_READ]);
    const raw = Array.from(f.data);
    const id = raw[EEPROM.DEVICE_ID];
    const ip = raw.slice(EEPROM.IP, EEPROM.IP + 4) as [number, number, number, number];
    this.snap.system = { deviceId: id === 0xff || id === 0 ? 1 : id, ip, raw };
    this.changed();
    return this.snap.system;
  }

  // ------------------------------------------------------------------ meters / keepalive
  startMeters(): void {
    this.stopMeters();
    this.meterTimer = setInterval(() => {
      if (!this.model || this.queue.length > 2) return; // edits first, the keepalive can wait
      this.request(cmd.meters(), [CMD.METERS], { low: true })
        .then((f) => this.emit('meters', decodeMeters(f.data, this.model!.inputs, this.model!.outputs)))
        .catch(() => { /* dropped or timeout: next tick */ });
    }, this.opts.meterIntervalMs);
  }
  stopMeters(): void { if (this.meterTimer) { clearInterval(this.meterTimer); this.meterTimer = null; } }

  // ------------------------------------------------------------------ editing
  /** Apply an edit locally (optimistic) and send it. */
  apply(action: Action): Promise<void> {
    const cfg = this.snap.config;
    if (!cfg) return Promise.reject(new Error('pas de configuration'));
    const cmds = actionCommands(cfg, action);
    const channels = applyAction(cfg, action);
    this.emit('action', { action, channels });
    const key = cmds.length === 1 ? actionKey(action) : undefined;
    return Promise.all(cmds.map((c) => this.request(c, [CMD.ACK], { key }))).then(() => undefined);
  }

  /**
   * Makes the live preset equal to `target` (opened file, scene, A/B, undo...). Only the parameters
   * that differ are sent, unless `full` is set (then every parameter is written, like the editor).
   */
  async pushConfig(target: DeviceConfig, label = 'Envoi', full = false): Promise<void> {
    const cur = this.snap.config;
    const actions = full || !cur ? configToActions(target) : diffActions(cur, target);
    if (!actions.length) return;
    this.setStatus('busy');
    let done = 0;
    try {
      for (const a of actions) {
        await this.apply(a);
        this.snap.progress = { label, done: ++done, total: actions.length };
        if (done % 8 === 0) this.changed();
      }
    } finally { this.snap.progress = null; this.setStatus('ready'); }
  }

  async loadPreset(n: number): Promise<void> {
    const m = this.model!;
    if (!(n >= 0 && n <= m.userPresets)) throw new RangeError(`preset ${n} hors limites`);
    this.setStatus('busy');
    try {
      await this.request(cmd.loadPreset(n), [CMD.ACK], { timeoutMs: 4000 });
      const ap = await this.request(cmd.activePreset(), [CMD.ACTIVE_PRESET]);
      this.snap.activePreset = ap.data[0] ?? n;
      await this.readConfig();
    } finally { this.setStatus('ready'); }
  }

  async storePreset(n: number, name: string): Promise<void> {
    const m = this.model!;
    if (!(n >= 1 && n <= m.userPresets)) throw new RangeError(`preset ${n} hors limites`);
    this.setStatus('busy');
    try {
      await this.request(cmd.setPresetName(name), [CMD.ACK]);
      if (this.snap.config) this.snap.config.presetName = name.slice(0, 14);
      await this.request(cmd.storePreset(n), [CMD.ACK], { timeoutMs: 4000 });
      this.snap.activePreset = n;
      const p = this.snap.presets.find((x) => x.slot === n);
      if (p) { p.name = name.trim(); p.user = true; }
      this.changed();
    } finally { this.setStatus('ready'); }
  }

  async factoryReset(): Promise<void> {
    this.setStatus('busy');
    try { await this.request(cmd.factoryReset(), [CMD.ACK], { timeoutMs: 20000 }); } catch { /* the firmware may answer late */ }
    await this.sync();
  }

  /**
   * Reads every user preset ("download unit"). The firmware can only read a preset through the live
   * buffer, so each one is recalled in turn (the sound changes meanwhile, exactly as with the Windows
   * editor); the preset that was active is recalled at the end.
   */
  async readAllPresets(onProgress?: (done: number, total: number) => void): Promise<UnitPreset[]> {
    const m = this.model!;
    const back = this.snap.activePreset;
    const out: UnitPreset[] = [];
    this.setStatus('busy');
    try {
      for (let s = 1; s <= m.userPresets; s++) {
        this.snap.progress = { label: 'Lecture des presets', done: s - 1, total: m.userPresets }; this.changed();
        onProgress?.(s - 1, m.userPresets);
        await this.request(cmd.loadPreset(s), [CMD.ACK], { timeoutMs: 4000 });
        const cfg = await this.readConfig();
        const p = this.snap.presets.find((x) => x.slot === s);
        out.push({ slot: s, name: p?.name ?? cfg.presetName, config: cfg });
      }
      await this.request(cmd.loadPreset(back), [CMD.ACK], { timeoutMs: 4000 });
      this.snap.activePreset = back;
      await this.readConfig();
    } finally { this.snap.progress = null; this.setStatus('ready'); }
    return out;
  }

  /** Downloads the whole unit: system settings, preset flags and the 20 user presets. */
  async downloadUnit(onProgress?: (done: number, total: number) => void): Promise<UnitFile> {
    const m = this.model!;
    const sys = await this.request(cmd.eepromRead(0, UNIT_SYSTEM_BYTES), [CMD.EEPROM_READ]);
    const info = await this.request(cmd.presetInfo(), [CMD.PRESET_INFO]);
    const all = await this.readAllPresets(onProgress);
    const presets = all.map((p) => (info.data[p.slot - 1] === 0xff ? p : null));
    while (presets.length < m.userPresets) presets.push(null);
    return { model: m.id, system: decodeUnitSystem(sys.data), presets };
  }

  /**
   * Writes a configuration straight into user preset `slot` (page by page, command 0x25), without
   * changing what is playing. This is how the Windows editor uploads a unit.
   */
  async writePresetSlot(slot: number, cfg: DeviceConfig, name = cfg.presetName): Promise<void> {
    const m = this.model!;
    if (!(slot >= 1 && slot <= m.userPresets)) throw new RangeError(`preset ${slot} hors limites`);
    if (cfg.model !== m.id) throw new Error(`ce preset est pour un ${MODELS[cfg.model].name}`);
    const img = serializeConfig({ ...cfg, presetName: name.slice(0, 14) });
    img[0] = 0xff; img[1] = 0xff;
    for (let p = 0; p < m.pages; p++) {
      const f = await this.request(cmd.writePresetPage(slot, p, img.subarray(p * m.pageSize, (p + 1) * m.pageSize)), [CMD.WRITE_PRESET_PAGE], { timeoutMs: 2000 });
      if (f.data[0] !== p) throw new Error(`écriture du preset U${String(slot).padStart(2, '0')} : page ${p} non confirmée`);
    }
    const ps = this.snap.presets.find((x) => x.slot === slot);
    if (ps) { ps.name = name.trim(); ps.user = true; }
    this.changed();
  }

  /** Writes several presets into the unit (live sound untouched). */
  async writePresets(list: { slot: number; name: string; config: DeviceConfig }[]): Promise<void> {
    this.setStatus('busy');
    try {
      for (const [i, p] of list.entries()) {
        this.snap.progress = { label: `Écriture du preset U${String(p.slot).padStart(2, '0')}`, done: i, total: list.length }; this.changed();
        await this.writePresetSlot(p.slot, p.config, p.name);
      }
    } finally { this.snap.progress = null; this.setStatus('ready'); }
    await this.sync();
  }

  /**
   * Uploads a whole unit like the Windows editor: factory reset (every slot back to default), optional
   * restore of the PTS / lock settings stored in the file (EEPROM bytes 1..17, never the device id),
   * then every used preset written page by page.
   */
  async uploadUnit(u: UnitFile, opts: { restoreSystem?: boolean } = {}): Promise<void> {
    const m = this.model!;
    if (u.model !== m.id) throw new Error(`cette sauvegarde est pour un ${MODELS[u.model].name}`);
    this.setStatus('busy');
    try {
      this.snap.progress = { label: 'Remise à zéro des presets', done: 0, total: 1 }; this.changed();
      await this.request(cmd.factoryReset(), [CMD.ACK], { timeoutMs: 20000 });
      if (opts.restoreSystem) {
        const raw = decodeUnitSystem(u.system.raw).raw.slice(1, UNIT_SYSTEM_BYTES);
        await this.request(cmd.eepromWrite(1, raw), [CMD.ACK], { timeoutMs: 2000 });
      }
      const used = u.presets.filter((p): p is UnitPreset => !!p);
      for (const [i, p] of used.entries()) {
        this.snap.progress = { label: `Écriture du preset U${String(p.slot).padStart(2, '0')}`, done: i, total: used.length }; this.changed();
        await this.writePresetSlot(p.slot, p.config, p.name);
      }
    } finally { this.snap.progress = null; this.setStatus('ready'); }
    await this.refreshLock();
    if (this.snap.lock?.locked) this.enterLocked(); // the restored system settings lock the device
    else await this.sync();
  }

  /** Locked: like at connection, nothing can be changed until the password is given. */
  private enterLocked(): void {
    this.stopMeters();
    this.setStatus('locked');
  }
  async lock(pw: string): Promise<void> {
    await this.request(cmd.lock(pw), [CMD.ACK]);
    await this.refreshLock();
    if (this.snap.lock?.locked) this.enterLocked();
  }
  async unlock(pw: string): Promise<boolean> {
    const f = await this.request(cmd.unlock(pw), [CMD.UNLOCK]);
    const ok = f.data[1] === 1;
    await this.refreshLock();
    if (ok && this.snap.status === 'locked') { await this.sync(); this.startMeters(); }
    return ok;
  }
  /** Sends the PTS password (needed once the power-on counter has reached its limit). */
  async unlockPts(pw: string): Promise<boolean> {
    const f = await this.request(cmd.unlockPts(pw), [CMD.UNLOCK]);
    const ok = f.data[1] === 1;
    await this.refreshLock();
    if (ok && this.snap.status === 'locked' && !this.snap.lock?.locked) { await this.sync(); this.startMeters(); }
    return ok;
  }
  async ptsSetup(pw: string, limit: number, on: boolean): Promise<void> {
    await this.request(cmd.ptsSetup(pw, limit, on), [CMD.ACK]);
    await this.refreshLock();
  }
  /** Device id and IP are stored in EEPROM and used after the next power cycle. */
  async setNetwork(id: number, ip: [number, number, number, number]): Promise<void> {
    if (!(id >= 1 && id <= 250)) throw new RangeError('ID 1..250');
    await this.request(cmd.setDeviceId(id), [CMD.ACK]);
    await this.request(cmd.setIp(ip), [CMD.ACK]);
    await this.readSystem();
  }

  async close(): Promise<void> {
    this.stopMeters();
    try { if (this.snap.status !== 'closed') await Promise.race([this.request(cmd.logout(), [CMD.ACK]), new Promise((r) => setTimeout(r, 150))]); } catch { /* no reply to logout */ }
    this.failAll(new Error('closed'));
    await this.transport.close();
    this.setStatus('closed');
  }
}
