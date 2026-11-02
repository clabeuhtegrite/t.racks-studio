// File formats.
//
// 1. The Windows editor's files, byte compatible with "Processor Editor" v1.05. The layouts below
//    were reconstructed from the editor's own serialiser and parser (x86 code run in an emulator):
//
//    .prs (one preset)
//      "***DSP206V010***" | "***DSP408V010***"     16 bytes
//      config[2 .. G+4+2N)                         preset name .. per-channel PEQ band bypass masks
//      "\r\n"
//      (G = start of the global block, N = channel count). The test-tone, delay-unit, PEQ-bypass
//      and GEQ-bypass words are not part of a .prs: the editor keeps its current values on load.
//      The editor refuses a file whose size is not exactly 16 + body + 2.
//
//    .unt (whole unit: system settings + the 20 user presets)
//      magic                                       16 bytes
//      system EEPROM bytes 0..17                   18 bytes (device id, PTS and lock settings)
//      20 x { record, "\r\n" }
//      record = [slot number 1..20, config[0 .. size-3)]       (size-2 bytes)
//             | size-2 bytes of 0x64 ("d") for a slot holding factory content
//      On upload the editor sends FACTORY_RESET, writes EEPROM bytes 1..17 back, then writes every
//      used slot page by page with WRITE_PRESET_PAGE (0x25), without touching the live preset.
//
// 2. A native JSON format (presets, units, scenes) that keeps every field, including the ones the
//    editor's formats drop.

import { cloneConfig, defaultConfig, parseConfig, serializeConfig, type DeviceConfig } from './config.ts';
import { layoutOf, MODELS, type ModelId, type ModelSpec } from './models.ts';
import { EEPROM } from './commands.ts';
import { deviceAscii } from './codecs.ts';

export class FileFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileFormatError';
  }
}

const CRLF = [0x0d, 0x0a];
const UNUSED = 0x64;
const MAGIC_LEN = 16;
export const UNIT_SYSTEM_BYTES = 18;

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0) & 0xff);
const specOf = (m: ModelId | ModelSpec): ModelSpec => (typeof m === 'string' ? MODELS[m] : m);

/** Model of an editor file, from its magic; undefined if the file is not an editor file. */
export function detectEditorFile(bytes: ArrayLike<number>): ModelSpec | undefined {
  if (bytes.length < MAGIC_LEN) return undefined;
  let magic = '';
  for (let i = 0; i < MAGIC_LEN; i++) magic += String.fromCharCode(bytes[i]);
  return Object.values(MODELS).find((m) => m.fileMagic === magic);
}

function checkMagic(bytes: ArrayLike<number>, m: ModelSpec, kind: string): void {
  const found = detectEditorFile(bytes);
  if (!found) throw new FileFormatError(`Ce fichier n'est pas un fichier ${kind} de l'éditeur t.racks.`);
  if (found.id !== m.id) throw new FileFormatError(`Ce fichier ${kind} est destiné à un ${found.name}, pas à un ${m.name}.`);
}

// ----------------------------------------------------------------------------------------------
// .prs
/** Config byte range stored in a .prs file for a model. */
export function prsRange(model: ModelId | ModelSpec): { from: number; to: number } {
  const m = specOf(model);
  const L = layoutOf(m);
  return { from: 2, to: L.g.bandBypass(m.inputs + m.outputs) };
}
export function prsSize(model: ModelId | ModelSpec): number {
  const r = prsRange(model);
  return MAGIC_LEN + (r.to - r.from) + 2;
}

export function encodePrs(cfg: DeviceConfig): Uint8Array {
  const m = MODELS[cfg.model];
  const img = serializeConfig(cfg);
  const r = prsRange(m);
  const out = new Uint8Array(prsSize(m));
  out.set(ascii(m.fileMagic), 0);
  out.set(img.subarray(r.from, r.to), MAGIC_LEN);
  out.set(CRLF, out.length - 2);
  return out;
}

/**
 * Reads a .prs file. Fields that the format does not store (header, test tone, delay unit, PEQ and
 * GEQ bypass) are taken from `base` (the current configuration, as the editor does), or the
 * factory defaults.
 */
export function decodePrs(bytes: ArrayLike<number>, model?: ModelId, base?: DeviceConfig): DeviceConfig {
  const m = model ? MODELS[model] : detectEditorFile(bytes);
  if (!m) throw new FileFormatError("Ce fichier n'est pas un preset (.prs) de l'éditeur t.racks.");
  checkMagic(bytes, m, 'preset (.prs)');
  const r = prsRange(m);
  const body = r.to - r.from;
  if (bytes.length < MAGIC_LEN + body) {
    throw new FileFormatError(`Preset incomplet : ${bytes.length} octets au lieu de ${prsSize(m)}.`);
  }
  const img = serializeConfig(base && base.model === m.id ? base : defaultConfig(m.id));
  for (let i = 0; i < body; i++) img[r.from + i] = bytes[MAGIC_LEN + i] & 0xff;
  return parseConfig(m, img);
}

// ----------------------------------------------------------------------------------------------
// .unt
export interface UnitSystem {
  /** raw EEPROM bytes 0..17 as stored in the file */
  raw: number[];
  deviceId: number;
  ptsPassword: string;
  ptsCount: number;
  ptsLimit: number;
  ptsOn: boolean;
  locked: boolean;
  lockPassword: string;
}
export interface UnitPreset { slot: number; name: string; config: DeviceConfig }
export interface UnitFile {
  model: ModelId;
  system: UnitSystem;
  /** one entry per user slot (index 0 = U01); null = factory content */
  presets: (UnitPreset | null)[];
}

const pw = (raw: number[], o: number): string => String.fromCharCode(...raw.slice(o, o + 4).map((c) => (c >= 0x20 && c < 0x7f ? c : 0x30)));
export function decodeUnitSystem(raw: ArrayLike<number>): UnitSystem {
  const r = Array.from({ length: UNIT_SYSTEM_BYTES }, (_, i) => (raw[i] ?? 0xff) & 0xff);
  const id = r[EEPROM.DEVICE_ID];
  return {
    raw: r,
    deviceId: id === 0xff || id === 0 ? 1 : id,
    ptsPassword: pw(r, EEPROM.PTS_PASSWORD),
    ptsCount: (r[EEPROM.PTS_COUNT] << 8) | r[EEPROM.PTS_COUNT + 1],
    ptsLimit: (r[EEPROM.PTS_LIMIT] << 8) | r[EEPROM.PTS_LIMIT + 1],
    ptsOn: r[EEPROM.PTS_ON] === 1,
    locked: r[EEPROM.LOCKED] === 1,
    lockPassword: pw(r, EEPROM.LOCK_PASSWORD),
  };
}

/** Bytes of a preset record (slot number + config bytes) for a model. */
export const unitRecordSize = (model: ModelId | ModelSpec): number => specOf(model).configSize - 2;
export function untSize(model: ModelId | ModelSpec): number {
  const m = specOf(model);
  return MAGIC_LEN + UNIT_SYSTEM_BYTES + m.userPresets * (unitRecordSize(m) + 2);
}

export function encodeUnt(u: UnitFile): Uint8Array {
  const m = MODELS[u.model];
  const rec = unitRecordSize(m);
  const out = new Uint8Array(untSize(m));
  out.set(ascii(m.fileMagic), 0);
  out.set(decodeUnitSystem(u.system.raw).raw, MAGIC_LEN);
  let o = MAGIC_LEN + UNIT_SYSTEM_BYTES;
  for (let s = 0; s < m.userPresets; s++) {
    const p = u.presets[s];
    if (p) {
      const img = serializeConfig({ ...p.config, presetName: p.name });
      img[0] = 0xff; // the editor only uploads records whose first config byte is 0xff
      out[o] = s + 1;
      out.set(img.subarray(0, rec - 1), o + 1);
    } else {
      out.fill(UNUSED, o, o + rec);
    }
    out.set(CRLF, o + rec);
    o += rec + 2;
  }
  return out;
}

export function decodeUnt(bytes: ArrayLike<number>, model?: ModelId): UnitFile {
  const m = model ? MODELS[model] : detectEditorFile(bytes);
  if (!m) throw new FileFormatError("Ce fichier n'est pas une sauvegarde complète (.unt) de l'éditeur t.racks.");
  checkMagic(bytes, m, 'unité (.unt)');
  const rec = unitRecordSize(m);
  const minSize = MAGIC_LEN + UNIT_SYSTEM_BYTES + m.userPresets * rec;
  if (bytes.length < minSize) throw new FileFormatError(`Fichier unité incomplet : ${bytes.length} octets au lieu de ${untSize(m)}.`);
  const system = decodeUnitSystem(Array.from({ length: UNIT_SYSTEM_BYTES }, (_, i) => bytes[MAGIC_LEN + i]));
  // records are separated by CRLF in files written by the editor; tolerate files without them
  const stride = bytes.length >= untSize(m) ? rec + 2 : rec;
  const presets: (UnitPreset | null)[] = [];
  for (let s = 0; s < m.userPresets; s++) {
    const o = MAGIC_LEN + UNIT_SYSTEM_BYTES + s * stride;
    if (bytes[o + 1] !== 0xff) { presets.push(null); continue; }
    const img = serializeConfig(defaultConfig(m.id));
    for (let i = 0; i < rec - 1; i++) img[i] = bytes[o + 1 + i] & 0xff;
    // the record stops 3 bytes short of the config (PEQ-bypass high byte, GEQ bypass): keep defaults
    const config = parseConfig(m, img);
    presets.push({ slot: s + 1, name: config.presetName, config });
  }
  return { model: m.id, system, presets };
}

// ----------------------------------------------------------------------------------------------
// Native JSON format
export const NATIVE_FORMAT = 'dsp-studio';
export const NATIVE_VERSION = 1;

export interface NativePresetFile {
  format: typeof NATIVE_FORMAT;
  version: number;
  kind: 'preset';
  model: ModelId;
  name: string;
  savedAt: string;
  notes?: string;
  config: DeviceConfig;
}
export interface NativeUnitFile {
  format: typeof NATIVE_FORMAT;
  version: number;
  kind: 'unit';
  model: ModelId;
  name: string;
  savedAt: string;
  notes?: string;
  system: UnitSystem | null;
  live: DeviceConfig | null;
  presets: (UnitPreset | null)[];
}
export type NativeFile = NativePresetFile | NativeUnitFile;

export function presetToNative(cfg: DeviceConfig, notes?: string): NativePresetFile {
  return { format: NATIVE_FORMAT, version: NATIVE_VERSION, kind: 'preset', model: cfg.model, name: cfg.presetName, savedAt: new Date().toISOString(), notes, config: cloneConfig(cfg) };
}
export function unitToNative(u: UnitFile, live: DeviceConfig | null, name = 'Sauvegarde', notes?: string): NativeUnitFile {
  return {
    format: NATIVE_FORMAT, version: NATIVE_VERSION, kind: 'unit', model: u.model, name, savedAt: new Date().toISOString(), notes,
    system: u.system, live: live ? cloneConfig(live) : null,
    presets: u.presets.map((p) => (p ? { slot: p.slot, name: p.name, config: cloneConfig(p.config) } : null)),
  };
}

/** Validates a configuration coming from JSON: every field is rebuilt through the binary layout. */
export function normalizeConfig(c: unknown, model?: ModelId): DeviceConfig {
  const x = c as Partial<DeviceConfig> | null;
  if (!x || typeof x !== 'object' || !x.model || !(x.model in MODELS)) throw new FileFormatError('Configuration invalide : modèle inconnu.');
  if (model && x.model !== model) throw new FileFormatError(`Ce preset est destiné à un ${MODELS[x.model].name}, pas à un ${MODELS[model].name}.`);
  const m = MODELS[x.model];
  if (!Array.isArray(x.inputs) || x.inputs.length !== m.inputs || !Array.isArray(x.outputs) || x.outputs.length !== m.outputs) {
    throw new FileFormatError('Configuration invalide : nombre de canaux incorrect.');
  }
  try {
    return parseConfig(m, serializeConfig(x as DeviceConfig));
  } catch (e) {
    throw new FileFormatError(`Configuration invalide : ${(e as Error).message}`);
  }
}

function normalizePresets(list: unknown, model: ModelId): (UnitPreset | null)[] {
  const m = MODELS[model];
  const arr = Array.isArray(list) ? (list as unknown[]) : [];
  return Array.from({ length: m.userPresets }, (_, s) => {
    const p = arr[s] as Partial<UnitPreset> | null | undefined;
    return p ? { slot: s + 1, name: deviceAscii(String(p.name ?? ''), 14), config: normalizeConfig(p.config, model) } : null;
  });
}

/** Validates a whole-unit backup coming from JSON (network, library). */
export function normalizeUnit(u: unknown, model?: ModelId): UnitFile {
  const x = u as Partial<UnitFile> | null;
  if (!x || typeof x !== 'object' || !x.model || !(x.model in MODELS)) throw new FileFormatError('Sauvegarde invalide : modèle inconnu.');
  if (model && x.model !== model) throw new FileFormatError(`Cette sauvegarde est destinée à un ${MODELS[x.model].name}, pas à un ${MODELS[model].name}.`);
  return { model: x.model, system: decodeUnitSystem(x.system?.raw ?? []), presets: normalizePresets(x.presets, x.model) };
}

export function encodeNative(f: NativeFile): string {
  return JSON.stringify(f, null, 1);
}

export function decodeNative(text: string): NativeFile {
  let j: unknown;
  try { j = JSON.parse(text); } catch { throw new FileFormatError("Ce fichier n'est pas un fichier t.racks Studio (JSON illisible)."); }
  const f = j as Partial<NativeFile>;
  if (!f || f.format !== NATIVE_FORMAT) throw new FileFormatError("Ce fichier n'est pas un fichier t.racks Studio.");
  if ((f.version ?? 0) > NATIVE_VERSION) throw new FileFormatError('Ce fichier a été créé par une version plus récente de t.racks Studio.');
  if (!f.model || !(f.model in MODELS)) throw new FileFormatError('Modèle inconnu dans le fichier.');
  if (f.kind === 'preset') {
    const p = f as NativePresetFile;
    return { ...p, config: normalizeConfig(p.config, p.model) };
  }
  if (f.kind === 'unit') {
    const u = f as NativeUnitFile;
    const presets = normalizePresets(u.presets, u.model);
    return { ...u, system: u.system ? decodeUnitSystem(u.system.raw) : null, live: u.live ? normalizeConfig(u.live, u.model) : null, presets };
  }
  throw new FileFormatError('Type de fichier t.racks Studio inconnu.');
}

/** Opens any supported file (editor .prs / .unt, or native JSON). */
export type OpenedFile =
  | { kind: 'preset'; source: 'prs' | 'native'; model: ModelId; config: DeviceConfig; name: string }
  | { kind: 'unit'; source: 'unt' | 'native'; model: ModelId; unit: UnitFile; live: DeviceConfig | null; name: string };

export function openFile(bytes: Uint8Array, fileName = '', base?: DeviceConfig): OpenedFile {
  const ed = detectEditorFile(bytes);
  const lower = fileName.toLowerCase();
  if (ed) {
    const isUnit = lower.endsWith('.unt') || (!lower.endsWith('.prs') && bytes.length >= untSize(ed) - 2 * ed.userPresets);
    if (isUnit) {
      const unit = decodeUnt(bytes, ed.id);
      return { kind: 'unit', source: 'unt', model: ed.id, unit, live: null, name: fileName.replace(/\.[^.]+$/, '') };
    }
    const config = decodePrs(bytes, ed.id, base);
    return { kind: 'preset', source: 'prs', model: ed.id, config, name: config.presetName };
  }
  const text = new TextDecoder().decode(bytes);
  const f = decodeNative(text);
  if (f.kind === 'preset') return { kind: 'preset', source: 'native', model: f.model, config: f.config, name: f.name };
  const unit: UnitFile = { model: f.model, system: f.system ?? decodeUnitSystem([]), presets: f.presets };
  return { kind: 'unit', source: 'native', model: f.model, unit, live: f.live, name: f.name };
}
