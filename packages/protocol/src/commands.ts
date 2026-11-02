// Command set of the t.racks DSP 206 / 408 firmware v1.04 (identical for both models, only the
// channel count differs). Every opcode and payload below was exercised against the real firmware
// in the emulator; replies noted are what the firmware answers.

import { asciiBytes } from './codecs.ts';

export const CMD = {
  ACK: 0x01, // reply
  NAK: 0x02, // reply: unknown command
  LOGIN: 0x10, // -> 0x10 [0x19]   enter PC-control mode (required before anything else)
  LOGOUT: 0x11, // no reply
  PING: 0x12, // -> ACK
  VERSION: 0x13, // -> 0x13 "DSP206 V0104P"
  ACTIVE_PRESET: 0x14, // -> 0x14 [n]  0 = F00, 1..20 = U01..U20
  DELAY_UNIT: 0x15, // [unit]
  EEPROM_READ: 0x19, // [addrLo, addrHi, len] -> 0x19 [bytes]
  EEPROM_WRITE: 0x1a, // [addrLo, addrHi, len, bytes...]
  LOAD_PRESET: 0x20, // [n] 0 = F00, 1..20 = U01..U20
  STORE_PRESET: 0x21, // [n] 1..20 (send PRESET_NAME first)
  PRESET_INFO: 0x22, // -> 0x22 [20 bytes] 0x00 = factory content, 0xff = user content
  FACTORY_RESET: 0x23, // every user preset back to the factory default
  LOAD_PRESET_ALT: 0x24, // [n] same effect as LOAD_PRESET (used before reading pages with 0x28)
  WRITE_PRESET_PAGE: 0x25, // [page, slot-1, 50 bytes] -> 0x25 [page]  writes a stored preset, live sound untouched
  PRESET_NAME: 0x26, // [14 ascii] -> ACK [0x00 + name]
  READ_PAGE: 0x27, // [page] -> 0x24 [page, 50 bytes]
  READ_PAGE_ALT: 0x28, // [page] -> 0x28 [page, 50 bytes]
  GET_PRESET_NAME: 0x29, // [k] k = 0..19 for U01..U20 -> 0x29 [k, 14 ascii]
  COPY_CHANNEL: 0x2a, // [src, dst]
  LOCK_STATUS: 0x2c, // -> 0x2c [ptsOn, ptsLimitHi, ptsLimitLo, ptsCountHi, ptsCountLo, locked]
  UNLOCK: 0x2d, // [type, p1, p2, p3, p4] -> 0x2d [type, ok]   type 0 = lock password, 1 = PTS password
  PTS_SETUP: 0x2e, // [p1, p2, p3, p4, limitHi, limitLo, on]
  LOCK: 0x2f, // [p1, p2, p3, p4]
  COMP: 0x30, // [ch, ratio(2), attack(2), release(2), knee(2), threshold(2)]
  LPF: 0x31, // [ch, freq(2), slope]
  HPF: 0x32, // [ch, freq(2), slope]
  PEQ: 0x33, // [ch, band, gain(2), freq(2), q, type, bypass]
  GAIN: 0x34, // [ch, gain(2)]
  MUTE: 0x35, // [ch, 0|1]
  PHASE: 0x36, // [ch, 0|1]
  DELAY: 0x38, // [ch, samples(2)]
  TEST_TONE: 0x39, // [source, sineIndex]
  ROUTE: 0x3a, // [outCh, inputMask]
  LINK: 0x3b, // [ch, linkMask]
  PEQ_BYPASS: 0x3c, // [ch, 0|1]
  CHANNEL_NAME: 0x3d, // [ch, 8 ascii]
  GATE: 0x3e, // [ch, attack(2), release(2), hold(2), threshold(2)]
  LIMITER: 0x3f, // [ch, attack(2), release(2), reserved(2), threshold(2)]
  METERS: 0x40, // -> 0x40 [12 x 3 bytes levels, (2 bytes status)]
  MIX: 0x41, // [outCh, input, level(2)]
  GEQ: 0x48, // [ch, band, level(2)]
  GEQ_BYPASS: 0x49, // [ch, 0|1]
  VERSION_EXT: 0x52, // -> 0x52 "DSP206 V0104P 20221206A"
} as const;

/** Reply opcode of READ_PAGE. */
export const REPLY_PAGE = 0x24;

/** Opcodes that must never be sent by a control application (bootloader / production tools). */
export const FORBIDDEN = new Set([0x04, 0x08, 0xa2, 0xa8]);

/** EEPROM system area (0x57) - addresses confirmed in the firmware. */
export const EEPROM = {
  DEVICE_ID: 0x00, // 1 byte, 0xff (blank) = 1 ; the device only answers frames whose dst = its id
  PTS_PASSWORD: 0x03, // 4 ascii
  PTS_COUNT: 0x07, // u16 BE
  PTS_LIMIT: 0x09, // u16 BE
  PTS_ON: 0x0b,
  LOCKED: 0x0c,
  LOCK_PASSWORD: 0x0d, // 4 ascii
  IP: 0x13, // 4 bytes, pushed to the Ethernet module at boot (needs a power cycle)
  SYSTEM_SIZE: 0x18,
} as const;

export interface Command { cmd: number; data: number[] }
const w = (v: number): number[] => [v & 0xff, (v >> 8) & 0xff];
const c = (cmd: number, data: number[] = []): Command => ({ cmd, data });

export const cmd = {
  login: () => c(CMD.LOGIN),
  logout: () => c(CMD.LOGOUT),
  ping: () => c(CMD.PING),
  version: () => c(CMD.VERSION),
  versionExt: () => c(CMD.VERSION_EXT),
  activePreset: () => c(CMD.ACTIVE_PRESET),
  meters: () => c(CMD.METERS),
  readPage: (p: number) => c(CMD.READ_PAGE, [p]),
  presetInfo: () => c(CMD.PRESET_INFO),
  presetName: (slot: number) => c(CMD.GET_PRESET_NAME, [slot - 1]), // slot 1..20
  lockStatus: () => c(CMD.LOCK_STATUS),
  eepromRead: (addr: number, len: number) => c(CMD.EEPROM_READ, [...w(addr), len]),
  eepromWrite: (addr: number, bytes: number[]) => c(CMD.EEPROM_WRITE, [...w(addr), bytes.length, ...bytes]),

  loadPreset: (n: number) => c(CMD.LOAD_PRESET, [n]),
  storePreset: (n: number) => c(CMD.STORE_PRESET, [n]),
  setPresetName: (name: string) => c(CMD.PRESET_NAME, asciiBytes(name.padEnd(14, ' '), 14)),
  factoryReset: () => c(CMD.FACTORY_RESET),
  /** Writes one 50-byte page of user preset `slot` (1..20) straight into the preset memory. */
  writePresetPage: (slot: number, page: number, bytes: ArrayLike<number>) =>
    c(CMD.WRITE_PRESET_PAGE, [page, slot - 1, ...Array.from({ length: 50 }, (_, i) => (bytes[i] ?? 0) & 0xff)]),
  copyChannel: (src: number, dst: number) => c(CMD.COPY_CHANNEL, [src, dst]),
  lock: (pw: string) => c(CMD.LOCK, asciiBytes(pw.padStart(4, '0'), 4)),
  unlock: (pw: string) => c(CMD.UNLOCK, [0, ...asciiBytes(pw.padStart(4, '0'), 4)]),
  /** checks the PTS (power-on counter) password, as the editor's "PTS Password" dialog does */
  unlockPts: (pw: string) => c(CMD.UNLOCK, [1, ...asciiBytes(pw.padStart(4, '0'), 4)]),
  ptsSetup: (pw: string, limit: number, on: boolean) =>
    c(CMD.PTS_SETUP, [...asciiBytes(pw.padStart(4, '0'), 4), (limit >> 8) & 0xff, limit & 0xff, on ? 1 : 0]),
  setDeviceId: (id: number) => c(CMD.EEPROM_WRITE, [...w(EEPROM.DEVICE_ID), 1, id & 0xff]),
  setIp: (ip: [number, number, number, number]) => c(CMD.EEPROM_WRITE, [...w(EEPROM.IP), 4, ...ip.map((x) => x & 0xff)]),

  gain: (ch: number, raw: number) => c(CMD.GAIN, [ch, ...w(raw)]),
  mute: (ch: number, on: boolean) => c(CMD.MUTE, [ch, on ? 1 : 0]),
  phase: (ch: number, inv: boolean | number) => c(CMD.PHASE, [ch, inv ? 1 : 0]),
  delay: (ch: number, samples: number) => c(CMD.DELAY, [ch, ...w(samples)]),
  delayUnit: (u: number) => c(CMD.DELAY_UNIT, [u]),
  hpf: (ch: number, freq: number, slope: number) => c(CMD.HPF, [ch, ...w(freq), slope]),
  lpf: (ch: number, freq: number, slope: number) => c(CMD.LPF, [ch, ...w(freq), slope]),
  peq: (ch: number, band: number, p: { gain: number; freq: number; q: number; type: number; bypass: boolean }) =>
    c(CMD.PEQ, [ch, band, ...w(p.gain), ...w(p.freq), p.q, p.type, p.bypass ? 1 : 0]),
  peqBypass: (ch: number, on: boolean) => c(CMD.PEQ_BYPASS, [ch, on ? 1 : 0]),
  geq: (ch: number, band: number, raw: number) => c(CMD.GEQ, [ch, band, ...w(raw)]),
  geqBypass: (ch: number, on: boolean) => c(CMD.GEQ_BYPASS, [ch, on ? 1 : 0]),
  gate: (ch: number, g: { attack: number; release: number; hold: number; threshold: number }) =>
    c(CMD.GATE, [ch, ...w(g.attack), ...w(g.release), ...w(g.hold), ...w(g.threshold)]),
  comp: (ch: number, k: { ratio: number; attack: number; release: number; knee: number; threshold: number }) =>
    c(CMD.COMP, [ch, ...w(k.ratio), ...w(k.attack), ...w(k.release), ...w(k.knee), ...w(k.threshold)]),
  limiter: (ch: number, l: { attack: number; release: number; reserved?: number; threshold: number }) =>
    c(CMD.LIMITER, [ch, ...w(l.attack), ...w(l.release), ...w(l.reserved ?? 0), ...w(l.threshold)]),
  route: (outCh: number, mask: number) => c(CMD.ROUTE, [outCh, mask]),
  mix: (outCh: number, input: number, raw: number) => c(CMD.MIX, [outCh, input, ...w(raw)]),
  link: (ch: number, mask: number) => c(CMD.LINK, [ch, mask]),
  channelName: (ch: number, name: string) => c(CMD.CHANNEL_NAME, [ch, ...asciiBytes(name, 8)]),
  testTone: (source: number, sine: number) => c(CMD.TEST_TONE, [source, sine]),
};

// ----------------------------------------------------------------------------------------------
// Reply decoding
export function decodeFloat16(lo: number, hi: number): number {
  const v = lo | (hi << 8);
  const s = (v >> 15) & 1, e = (v >> 10) & 0x1f, f = v & 0x3ff;
  let r: number;
  if (e === 0) r = (f / 1024) * 2 ** -14;
  else if (e === 31) r = f ? NaN : Infinity;
  else r = (1 + f / 1024) * 2 ** (e - 15);
  return s ? -r : r;
}
export interface Meters {
  /** linear peak levels per wire channel (inputs then outputs) */
  levels: number[];
  /** dBFS per wire channel */
  db: number[];
  /** trailing status word (limiter / compressor activity on the 206) */
  status: number;
}
/** Meter groups are laid out for 4 inputs + 8 outputs on both models. */
export function decodeMeters(data: ArrayLike<number>, inputs: number, outputs: number): Meters {
  const group = (g: number): number => {
    const o = g * 3;
    if (o + 1 >= data.length) return 0;
    const v = Math.abs(decodeFloat16(data[o], data[o + 1]));
    return Number.isFinite(v) ? v : 0;
  };
  const levels: number[] = [];
  for (let i = 0; i < inputs; i++) levels.push(group(i));
  for (let j = 0; j < outputs; j++) levels.push(group(4 + j));
  const status = data.length >= 38 ? data[36] | (data[37] << 8) : 0;
  return { levels, db: levels.map((v) => (v > 1e-7 ? 20 * Math.log10(v) : -140)), status };
}

export interface LockStatus { ptsOn: boolean; ptsLimit: number; ptsCount: number; locked: boolean }
export function decodeLockStatus(d: ArrayLike<number>): LockStatus {
  return { ptsOn: d[0] === 1, ptsLimit: (d[1] << 8) | d[2], ptsCount: (d[3] << 8) | d[4], locked: d[5] === 1 };
}

export function decodeAscii(d: ArrayLike<number>, from = 0): string {
  let s = '';
  for (let i = from; i < d.length; i++) {
    const ch = d[i];
    if (ch === 0) break;
    s += ch === 0xff ? '' : String.fromCharCode(ch & 0x7f);
  }
  return s.replace(/\s+$/, '');
}
