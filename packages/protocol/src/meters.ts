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
