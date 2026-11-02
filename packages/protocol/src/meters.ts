// Meters (reply to 0x40), read the way the official editors (V1.05) read them. Both the firmware
// and the editors were checked: the firmware forwards what the audio DSP measures, and the editors'
// meter code gives the meaning of each byte and the colours of the bars.
//
// - 12 groups of 3 bytes, 4 inputs then 8 outputs on both models (the 206 leaves groups 2, 3, 10
//   and 11 unused). Each group is the high part of a 32-bit float (linear level, 1 = 0 dBFS):
//   bits 16-23, bits 24-31, then bits 8-15.
// - a status word (2 bytes, low byte first): bit j = the compressor of output j is acting,
//   bit 8 + j = its limiter is acting.
// - the editors draw segmented bars, green then yellow then red. Inputs: 6 green, 2 yellow,
//   1 red segment; outputs: 4 green, 3 yellow, 1 red, plus one orange "Limit" segment that lights
//   while the compressor (ratio other than 1:1) or the limiter (threshold under +20 dB) acts.

import { gainRawToDb, thrRawToDb } from './codecs.ts';
import type { DeviceConfig } from './config.ts';
import { MODELS, type ModelId } from './models.ts';

export interface Meters {
  /** linear peak levels per wire channel (inputs then outputs) */
  levels: number[];
  /** dBFS per wire channel */
  db: number[];
  /** status word: bit j = compressor of output j acting, bit 8 + j = limiter of output j acting */
  status: number;
}

/** One level: the three bytes of a group put back into a 32-bit float, as the editors do. */
export function decodeLevel(b0: number, b1: number, b2: number): number {
  const v = new DataView(new ArrayBuffer(4));
  v.setUint8(0, b1); v.setUint8(1, b0); v.setUint8(2, b2); v.setUint8(3, 0);
  const f = Math.abs(v.getFloat32(0));
  return Number.isFinite(f) ? f : 0;
}

/** The three bytes of a level (the simulator's side of decodeLevel). */
export function encodeLevel(level: number): [number, number, number] {
  const v = new DataView(new ArrayBuffer(4));
  v.setFloat32(0, Math.max(0, level));
  return [v.getUint8(1), v.getUint8(0), v.getUint8(2)];
}

export const levelToDb = (v: number): number => (v > 1e-7 ? 20 * Math.log10(v) : -140);

export function decodeMeters(data: ArrayLike<number>, inputs: number, outputs: number): Meters {
  const group = (g: number): number => {
    const o = g * 3;
    return o + 2 < data.length ? decodeLevel(data[o], data[o + 1], data[o + 2]) : 0;
  };
  const levels: number[] = [];
  for (let i = 0; i < inputs; i++) levels.push(group(i));
  for (let j = 0; j < outputs; j++) levels.push(group(4 + j));
  const status = data.length >= 38 ? data[36] | (data[37] << 8) : 0;
  return { levels, db: levels.map(levelToDb), status };
}

/** Where the bars of the editors turn yellow and red (dBFS): the first yellow and the red segment. */
export interface MeterZones { yellow: number; red: number }
const ZONES: Record<ModelId, { in: MeterZones; out: MeterZones }> = {
  // segment thresholds of the editors, minus their offset (18 dB; 24 dB on the 408 outputs):
  // 206 in  -68 -58 -48 -38 -23 -18 | -13 -6 | -3     206 out -68 -48 -28 -23 | -18 -13 -6 | +3
  // 408 in  -68 -48 -38 -28 -23 -18 | -13 -6 | -3     408 out -74 -44 -34 -29 | -24 -19 -12 | -10
  dsp206: { in: { yellow: -13, red: -3 }, out: { yellow: -18, red: 3 } },
  dsp408: { in: { yellow: -13, red: -3 }, out: { yellow: -24, red: -10 } },
};
export const meterZones = (model: ModelId, ch: number): MeterZones => (ch < MODELS[model].inputs ? ZONES[model].in : ZONES[model].out);

/** What the dynamics of an output are doing now, with the editors' conditions. */
export function dynamicsActive(status: number, cfg: DeviceConfig, ch: number): { comp: boolean; limit: boolean } {
  const j = ch - MODELS[cfg.model].inputs;
  const o = cfg.outputs[j];
  if (!o) return { comp: false, limit: false };
  return {
    comp: ((status >> j) & 1) === 1 && o.comp.ratio > 0,
    limit: ((status >> (8 + j)) & 1) === 1 && o.limiter.threshold < 220,
  };
}

// Where the compressor and the limiter start to act, on the scale of the meters. Read on the
// firmware (words it sends to the audio DSP when a threshold is set, the same on both models): the
// limiter gets its threshold minus 15 dB, the compressor its threshold minus 17.8 dB (whatever the
// knee and the ratio), the gate minus 14 dB, as dB of the DSP's own scale, the one of the meters.
// A limiter at +20 dB is also switched off by a flag. Both blocks come before the output volume (the editor's block
// diagram), and the output meters are taken as reading after it (their red segment is the
// output's clipping), so the volume moves the thresholds on the meter. To be checked on a real unit.
export const LIMITER_OFFSET_DB = 15;
export const COMP_OFFSET_DB = 17.8;
/** The gate of the inputs gets its threshold minus 14 dB. */
export const GATE_OFFSET_DB = 14;
/** dBFS where a limiter threshold (raw) starts to act, before the output volume. */
export const limiterDbfs = (raw: number): number => thrRawToDb(raw) - LIMITER_OFFSET_DB;
/** dBFS where a compressor threshold (raw) starts to act, before the output volume. */
export const compDbfs = (raw: number): number => thrRawToDb(raw) - COMP_OFFSET_DB;

/**
 * A level read on a meter, moved onto the scale of the thresholds as they are set (for the curves of
 * the gate, compressor and limiter). The input meters are taken as reading at the gate.
 */
export function levelOnThresholdScale(cfg: DeviceConfig, ch: number, db: number, block: 'gate' | 'comp' | 'limit'): number {
  if (block === 'gate') return db + GATE_OFFSET_DB;
  const o = cfg.outputs[ch - MODELS[cfg.model].inputs];
  return db - (o ? gainRawToDb(o.gain) : 0) + (block === 'comp' ? COMP_OFFSET_DB : LIMITER_OFFSET_DB);
}

export interface Headroom {
  /** where the block starts to act, as read on the output meter (dBFS) */
  at: number;
  /** dB left before it acts at the level given (negative: above it); null without signal */
  margin: number | null;
  /** acting now, according to the DSP */
  acting: boolean;
}

/** Below this level an output is taken as silent: no margin is worked out. */
export const SILENCE_DBFS = -80;

/**
 * Headroom of the compressor and the limiter of an output, null for a block that is off (compressor
 * at 1:1, limiter at +20 dB: the editors' conditions). `db` is the level to compare (the meter, or its recent peak).
 */
export function dynamicsHeadroom(cfg: DeviceConfig, ch: number, db: number | null | undefined, status: number): { comp: Headroom | null; limit: Headroom | null } {
  const j = ch - MODELS[cfg.model].inputs;
  const o = cfg.outputs[j];
  if (!o) return { comp: null, limit: null };
  const vol = gainRawToDb(o.gain);
  const acting = dynamicsActive(status, cfg, ch);
  const level = db !== null && db !== undefined && db > SILENCE_DBFS ? db : null;
  const make = (at: number, on: boolean): Headroom => ({ at, margin: level === null ? null : at - level, acting: on });
  return {
    comp: o.comp.ratio > 0 ? make(compDbfs(o.comp.threshold) + vol, acting.comp) : null,
    limit: o.limiter.threshold < 220 ? make(limiterDbfs(o.limiter.threshold) + vol, acting.limit) : null,
  };
}
