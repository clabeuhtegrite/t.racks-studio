// Virtual DSP: answers the protocol like firmware v1.04 does (behaviour measured on the real
// firmware in the emulator). Used for the demo mode, the automated tests and offline editing.

import { CMD, EEPROM, REPLY_PAGE } from './commands.ts';
import { cloneConfig, defaultConfig, parseConfig, serializeConfig, type DeviceConfig } from './config.ts';
import { encodeFrame, FrameParser, type Frame } from './frame.ts';
import { MODELS, type ModelId } from './models.ts';
import { applyAction, type Action } from './state.ts';
import { decodeAscii } from './commands.ts';
import { gainRawToDb, ratioValue } from './codecs.ts';
import { compDbfs, encodeLevel, levelToDb, limiterDbfs } from './meters.ts';
import type { Transport } from './session.ts';

export interface VirtualDspOptions {
  model: ModelId;
  deviceId?: number;
  /** simulated signal on the inputs (dBFS) for the meters; null = silence */
  signalDb?: number | null;
  latencyMs?: number;
}

interface Slot { config: DeviceConfig | null; name: string }

export class VirtualDsp {
  readonly model: ModelId;
  readonly deviceId: number;
  config: DeviceConfig;
  slots: Slot[];
  active = 0;
  eeprom = new Uint8Array(0x20).fill(0xff);
  loggedIn = false;
  signalDb: number | null;
  private parser = new FrameParser();
  private out: ((b: Uint8Array) => void) | null = null;
  private sink: Uint8Array[] | null = null;
  private latency: number;
  private t0 = Date.now();

  constructor(o: VirtualDspOptions) {
    this.model = o.model;
    this.deviceId = o.deviceId ?? 1;
    this.config = defaultConfig(o.model);
    this.slots = Array.from({ length: MODELS[o.model].userPresets }, () => ({ config: null, name: 'Default Preset' }));
    this.signalDb = o.signalDb === undefined ? -21 : o.signalDb; // programme level: green on the meters, yellow on the peaks
    this.latency = o.latencyMs ?? 2;
    this.eeprom[EEPROM.DEVICE_ID] = this.deviceId;
    this.eeprom.set([192, 168, 1, 100], EEPROM.IP);
    this.eeprom.set([0x30, 0x30, 0x30, 0x30], EEPROM.PTS_PASSWORD);
    this.eeprom.set([0x27, 0x0f], EEPROM.PTS_LIMIT);
    this.eeprom.set([0, 0], EEPROM.PTS_COUNT);
    this.eeprom[EEPROM.PTS_ON] = 0;
    this.eeprom[EEPROM.LOCKED] = 0;
  }

  /** A Transport connected to this virtual device. */
  transport(): Transport {
    let dataCb: ((c: Uint8Array) => void) | null = null;
    let closeCb: ((e?: Error) => void) | null = null;
    this.out = (b) => setTimeout(() => dataCb?.(b), this.latency);
    return {
      kind: 'sim',
      send: (bytes) => { this.receive(bytes); },
      onData: (cb) => { dataCb = cb; },
      onClose: (cb) => { closeCb = cb; },
      close: () => { this.loggedIn = false; closeCb?.(); },
    };
  }

  receive(bytes: Uint8Array): void {
    for (const f of this.parser.push(bytes)) this.handle(f);
  }

  private reply(c: number, data: number[] = []): void {
    const bytes = encodeFrame(c, data, this.deviceId, 0);
    if (this.sink) this.sink.push(bytes);
    else this.out?.(bytes);
  }

  /** Synchronous request / reply (tests and tools): returns the frames the device answered. */
  request(cmdByte: number, data: ArrayLike<number> = [], dst = this.deviceId): Frame[] {
    const sink: Uint8Array[] = [];
    this.sink = sink;
    try { this.receive(encodeFrame(cmdByte, data, 0, dst)); } finally { this.sink = null; }
    const p = new FrameParser();
    return sink.flatMap((b) => p.push(b));
  }

  private get locked(): boolean { return this.eeprom[EEPROM.LOCKED] === 1; }

  private handle(f: Frame): void {
    if (f.dst !== this.deviceId) return;
    const d = Array.from(f.data);
    const m = MODELS[this.model];
    if (f.cmd === CMD.LOGIN) { this.loggedIn = true; this.reply(CMD.LOGIN, [0x19]); return; }
    if (!this.loggedIn) return;
    const ack = (): void => this.reply(CMD.ACK);
    const act = (a: Action): void => { applyAction(this.config, a); ack(); };
    switch (f.cmd) {
      case CMD.LOGOUT: this.loggedIn = false; return;
      case CMD.PING: return ack();
      case CMD.VERSION: return this.reply(CMD.VERSION, [...`${m.versionPrefix} V0104P`].map((c) => c.charCodeAt(0)));
      case CMD.VERSION_EXT: return this.reply(CMD.VERSION_EXT, [...`${m.versionPrefix} V0104P 20221206A`].map((c) => c.charCodeAt(0)));
      case CMD.ACTIVE_PRESET: return this.reply(CMD.ACTIVE_PRESET, [this.active]);
      case CMD.LOCK_STATUS: {
        const e = this.eeprom;
        return this.reply(CMD.LOCK_STATUS, [e[EEPROM.PTS_ON] === 1 ? 1 : 0, e[EEPROM.PTS_LIMIT], e[EEPROM.PTS_LIMIT + 1], e[EEPROM.PTS_COUNT], e[EEPROM.PTS_COUNT + 1], this.locked ? 1 : 0]);
      }
      case CMD.UNLOCK: {
        // type 0 = lock password (clears the lock), 1 = PTS password (checked only), as measured
        const type = d[0] === 1 ? 1 : 0;
        const ref = type === 1 ? EEPROM.PTS_PASSWORD : EEPROM.LOCK_PASSWORD;
        const pw = d.slice(1, 5);
        const ok = pw.length === 4 && pw.every((x, i) => x === this.eeprom[ref + i]);
        if (ok && type === 0) this.eeprom[EEPROM.LOCKED] = 0;
        return this.reply(CMD.UNLOCK, [type, ok ? 1 : 0]);
      }
      case CMD.LOCK: this.eeprom.set(d.slice(0, 4), EEPROM.LOCK_PASSWORD); this.eeprom[EEPROM.LOCKED] = 1; return ack();
      case CMD.PTS_SETUP:
        this.eeprom.set(d.slice(0, 4), EEPROM.PTS_PASSWORD); this.eeprom.set([0, 0], EEPROM.PTS_COUNT);
        this.eeprom.set([d[4], d[5]], EEPROM.PTS_LIMIT); this.eeprom[EEPROM.PTS_ON] = d[6] ? 1 : 0; return ack();
      case CMD.EEPROM_READ: {
        const a = d[0] | (d[1] << 8), n = d[2];
        return this.reply(CMD.EEPROM_READ, Array.from({ length: n }, (_, i) => this.eeprom[a + i] ?? 0xff));
      }
      case CMD.EEPROM_WRITE: {
        const a = d[0] | (d[1] << 8), n = d[2];
        for (let i = 0; i < n; i++) if (a + i < this.eeprom.length) this.eeprom[a + i] = d[3 + i];
        return ack();
      }
      case CMD.PRESET_INFO: return this.reply(CMD.PRESET_INFO, this.slots.map((s) => (s.config ? 0xff : 0x00)));
      case CMD.GET_PRESET_NAME: {
        const k = d[0]; const s = this.slots[k];
        const name = (s?.name ?? 'Default Preset').padEnd(14, ' ').slice(0, 14);
        return this.reply(CMD.GET_PRESET_NAME, [k, ...[...name].map((c) => c.charCodeAt(0))]);
      }
      case CMD.PRESET_NAME: {
        const name = decodeAscii(d).padEnd(14, ' ').slice(0, 14);
        this.config.presetName = name.trimEnd();
        return this.reply(CMD.ACK, [0, ...[...name].map((c) => c.charCodeAt(0))]);
      }
      case CMD.STORE_PRESET: {
        const n = d[0];
        if (n >= 1 && n <= this.slots.length) {
          const stored = cloneConfig(this.config);
          stored.header = [0xff, 0xff]; // the firmware marks stored presets this way
          this.slots[n - 1] = { config: stored, name: this.config.presetName };
          this.active = n;
        }
        return ack();
      }
      case CMD.LOAD_PRESET: case CMD.LOAD_PRESET_ALT: {
        const n = d[0];
        const keepUnit = this.config.delayUnit;
        if (n === 0) this.config = defaultConfig(this.model);
        else if (n <= this.slots.length) {
          const s = this.slots[n - 1];
          this.config = s.config ? cloneConfig(s.config) : { ...defaultConfig(this.model), presetName: s.name };
        }
        // measured on the firmware: a recall stops the test tone, clears every PEQ/GEQ bypass and
        // keeps the delay display unit (global setting)
        this.config.toneSource = 0; this.config.toneFreq = 0; this.config.delayUnit = keepUnit;
        for (const c of [...this.config.inputs, ...this.config.outputs]) c.peqBypass = false;
        for (const c of this.config.inputs) c.geqBypass = false;
        this.active = n;
        return ack();
      }
      case CMD.WRITE_PRESET_PAGE: {
        const [page, k] = d;
        if (k >= this.slots.length || page >= m.pages) return this.reply(CMD.NAK);
        const slot = this.slots[k];
        const img = serializeConfig(slot.config ?? { ...defaultConfig(this.model), presetName: slot.name });
        const chunk = d.slice(2, 2 + m.pageSize);
        for (let i = 0; i < chunk.length && page * m.pageSize + i < img.length; i++) img[page * m.pageSize + i] = chunk[i];
        const cfg = parseConfig(this.model, img);
        this.slots[k] = { config: cfg, name: cfg.presetName };
        return this.reply(CMD.WRITE_PRESET_PAGE, [page]);
      }
      case CMD.FACTORY_RESET:
        this.slots = this.slots.map(() => ({ config: null, name: 'Default Preset' }));
        this.config = defaultConfig(this.model); this.active = 0; return ack();
      case CMD.READ_PAGE: case CMD.READ_PAGE_ALT: {
        const p = d[0];
        if (p >= m.pages) return this.reply(CMD.NAK);
        const img = serializeConfig(this.config);
        const chunk = Array.from(img.subarray(p * m.pageSize, (p + 1) * m.pageSize));
        return this.reply(f.cmd === CMD.READ_PAGE ? REPLY_PAGE : CMD.READ_PAGE_ALT, [p, ...chunk]);
      }
      case CMD.METERS: return this.reply(CMD.METERS, this.meterBytes());
      case CMD.GAIN: return act({ t: 'gain', ch: d[0], raw: d[1] | (d[2] << 8) });
      case CMD.MUTE: return act({ t: 'mute', ch: d[0], on: d[1] === 1 });
      case CMD.PHASE: return act({ t: 'phase', ch: d[0], inv: d[1] === 1 });
      case CMD.DELAY: return act({ t: 'delay', ch: d[0], raw: d[1] | (d[2] << 8) });
      case CMD.DELAY_UNIT: return act({ t: 'delayUnit', unit: d[0] });
      case CMD.HPF: return act({ t: 'hpf', ch: d[0], x: { freq: d[1] | (d[2] << 8), slope: d[3] } });
      case CMD.LPF: return act({ t: 'lpf', ch: d[0], x: { freq: d[1] | (d[2] << 8), slope: d[3] } });
      case CMD.PEQ: return act({ t: 'peq', ch: d[0], band: d[1], p: { gain: d[2] | (d[3] << 8), freq: d[4] | (d[5] << 8), q: d[6], type: d[7], bypass: d[8] === 1 } });
      case CMD.PEQ_BYPASS: return act({ t: 'peqBypass', ch: d[0], on: d[1] === 1 });
      case CMD.GEQ: return act({ t: 'geq', ch: d[0], band: d[1], raw: d[2] | (d[3] << 8) });
      case CMD.GEQ_BYPASS: return act({ t: 'geqBypass', ch: d[0], on: d[1] === 1 });
      case CMD.GATE: return act({ t: 'gate', ch: d[0], g: { attack: d[1] | (d[2] << 8), release: d[3] | (d[4] << 8), hold: d[5] | (d[6] << 8), threshold: d[7] | (d[8] << 8) } });
      case CMD.COMP: return act({ t: 'comp', ch: d[0], c: { ratio: d[1] | (d[2] << 8), attack: d[3] | (d[4] << 8), release: d[5] | (d[6] << 8), knee: d[7] | (d[8] << 8), threshold: d[9] | (d[10] << 8) } });
      case CMD.LIMITER: return act({ t: 'limiter', ch: d[0], l: { attack: d[1] | (d[2] << 8), release: d[3] | (d[4] << 8), reserved: d[5] | (d[6] << 8), threshold: d[7] | (d[8] << 8) } });
      case CMD.ROUTE: return act({ t: 'route', ch: d[0], mask: d[1] });
      case CMD.MIX: return act({ t: 'mix', ch: d[0], input: d[1], raw: d[2] | (d[3] << 8) });
      case CMD.CHANNEL_NAME: return act({ t: 'name', ch: d[0], name: decodeAscii(d, 1) });
      case CMD.LINK: {
        const ch = d[0], isIn = ch < m.inputs;
        const list = isIn ? this.config.inputs : this.config.outputs;
        const idx = isIn ? ch : ch - m.inputs;
        if (list[idx]) list[idx].link = d[1];
        return ack();
      }
      case CMD.COPY_CHANNEL: return act({ t: 'copy', src: d[0], dst: d[1] });
      case CMD.TEST_TONE: return act({ t: 'testTone', source: d[0], freq: d[1] });
      default: return this.reply(CMD.NAK);
    }
  }

  /**
   * Meters: a slowly moving programme-like signal shaped by gains, mutes, routing and the outputs'
   * compressor and limiter, encoded like the firmware (see meters.ts), with the status word that
   * tells when the compressor or the limiter acts.
   */
  private meterBytes(): number[] {
    const m = MODELS[this.model];
    const c = this.config;
    const t = (Date.now() - this.t0) / 1000;
    const groups: number[] = Array(12).fill(0);
    let status = 0;
    const inLv: number[] = [];
    for (let i = 0; i < m.inputs; i++) {
      if (this.signalDb === null) { inLv.push(0); continue; }
      const wobble = 6 * Math.sin(t * (1.3 + i * 0.37)) + 3 * Math.sin(t * (4.1 + i)) + (Math.random() - 0.5) * 2;
      const db = this.signalDb + wobble + (c.toneSource ? 6 : 0);
      inLv.push(Math.pow(10, db / 20));
      groups[i] = c.inputs[i].mute ? 0 : inLv[i] * Math.pow(10, gainRawToDb(c.inputs[i].gain) / 20);
    }
    for (let j = 0; j < m.outputs; j++) {
      const o = c.outputs[j];
      let sum = 0;
      for (let i = 0; i < m.inputs; i++) if ((o.route >> i) & 1) sum += groups[i] * Math.pow(10, gainRawToDb(o.mix[i]) / 20);
      // compressor, then limiter, at the thresholds the firmware gives the DSP, then the output volume
      let db = levelToDb(sum);
      const compThr = compDbfs(o.comp.threshold);
      if (o.comp.ratio > 0 && db > compThr) {
        db = compThr + (db - compThr) / ratioValue(o.comp.ratio);
        status |= 1 << j;
      }
      const limThr = limiterDbfs(o.limiter.threshold);
      if (o.limiter.threshold < 220 && db > limThr) {
        db = limThr;
        status |= 1 << (8 + j);
      }
      db += gainRawToDb(o.gain);
      groups[4 + j] = db > -140 ? Math.pow(10, db / 20) : 0; // meters are taken before the output mute, like the hardware
    }
    const out: number[] = [];
    for (const v of groups) out.push(...encodeLevel(Math.min(v, 4)));
    out.push(status & 0xff, status >> 8);
    return out;
  }

  /** Raw bytes of the live config (handy for tests). */
  image(): Uint8Array { return serializeConfig(this.config); }
  loadImage(bytes: ArrayLike<number>): void { this.config = parseConfig(this.model, bytes); }
}
