// Device configuration model (one preset) <-> the binary image returned by 0x27 page reads and
// stored in the editor's .prs files. All values are kept in their raw device units so that
// parse(serialize(x)) is byte exact; codecs.ts converts them for display.

import { putU16, readAscii, u16, writeAscii, EQ_GAIN_0DB, GAIN_RAW_0DB, FREQ_STEPS } from './codecs.ts';
import { layoutOf, MODELS, type ModelId, type ModelSpec } from './models.ts';

export interface PeqBand { gain: number; freq: number; q: number; type: number; bypass: boolean }
export interface Xover { freq: number; slope: number } // slope byte: 0 = off, 1..20 = ladder
export interface Gate { attack: number; release: number; hold: number; threshold: number }
export interface Comp { ratio: number; attack: number; release: number; knee: number; threshold: number }
export interface Limiter { attack: number; release: number; reserved: number; threshold: number }

interface ChannelCommon {
  name: string;
  peq: PeqBand[];
  peqBypass: boolean;
  hpf: Xover;
  lpf: Xover;
  gain: number;
  phase: number; // 0 normal, 1 inverted
  delay: number;
  link: number; // link mask (see links.ts)
  mute: boolean;
}
export interface InputChannel extends ChannelCommon {
  gate: Gate;
  geq: number[];
  geqBypass: boolean;
}
export interface OutputChannel extends ChannelCommon {
  route: number; // bit i = input i feeds this output
  mix: number[]; // per input mix level (gain codec)
  comp: Comp;
  limiter: Limiter;
}
export interface DeviceConfig {
  model: ModelId;
  header: [number, number];
  presetName: string;
  inputs: InputChannel[];
  outputs: OutputChannel[];
  toneSource: number;
  toneFreq: number;
  delayUnit: number;
}

export type AnyChannel = InputChannel | OutputChannel;
export const isInputChannel = (c: AnyChannel): c is InputChannel => 'gate' in c;

const bit = (mask: number, i: number): boolean => ((mask >> i) & 1) === 1;

export function parseConfig(model: ModelId | ModelSpec, bytes: ArrayLike<number>): DeviceConfig {
  const m = typeof model === 'string' ? MODELS[model] : model;
  if (bytes.length < m.configSize) throw new RangeError(`config too short: ${bytes.length} < ${m.configSize}`);
  const L = layoutOf(m);
  const b = bytes;
  const g = L.g;
  const muteIn = u16(b, g.muteIn), muteOut = u16(b, g.muteOut);
  const pbIn = u16(b, g.peqBypassIn), pbOut = u16(b, g.peqBypassOut), geqByp = u16(b, g.geqBypass);
  const readPeq = (o: number, n: number, ch: number): PeqBand[] => {
    const mask = u16(b, g.bandBypass(ch));
    return Array.from({ length: n }, (_, k) => ({
      gain: u16(b, o + 6 * k), freq: u16(b, o + 6 * k + 2), q: b[o + 6 * k + 4], type: b[o + 6 * k + 5], bypass: bit(mask, k),
    }));
  };
  const inputs: InputChannel[] = [];
  for (let i = 0; i < m.inputs; i++) {
    const o = L.inBase(i), I = L.in;
    inputs.push({
      name: readAscii(b, o + I.name, 8),
      gate: { attack: u16(b, o + I.gateAttack), release: u16(b, o + I.gateRelease), hold: u16(b, o + I.gateHold), threshold: u16(b, o + I.gateThreshold) },
      geq: Array.from({ length: m.geqBands }, (_, k) => u16(b, o + I.geq + 2 * k)),
      geqBypass: bit(geqByp, i),
      peq: readPeq(o + I.peq, m.inPeqBands, i),
      peqBypass: bit(pbIn, i),
      hpf: { freq: u16(b, o + I.hpfFreq), slope: b[o + I.hpfSlope] },
      lpf: { freq: u16(b, o + I.lpfFreq), slope: b[o + I.lpfSlope] },
      gain: u16(b, o + I.gain), phase: u16(b, o + I.phase), delay: u16(b, o + I.delay), link: u16(b, o + I.link),
      mute: bit(muteIn, i),
    });
  }
  const outputs: OutputChannel[] = [];
  for (let j = 0; j < m.outputs; j++) {
    const o = L.outBase(j), O = L.out;
    outputs.push({
      name: readAscii(b, o + O.name, 8),
      route: u16(b, o + O.route),
      mix: Array.from({ length: m.inputs }, (_, k) => u16(b, o + O.mix + 2 * k)),
      hpf: { freq: u16(b, o + O.hpfFreq), slope: b[o + O.hpfSlope] },
      lpf: { freq: u16(b, o + O.lpfFreq), slope: b[o + O.lpfSlope] },
      peq: readPeq(o + O.peq, m.outPeqBands, m.inputs + j),
      peqBypass: bit(pbOut, j),
      comp: { ratio: u16(b, o + O.compRatio), attack: u16(b, o + O.compAttack), release: u16(b, o + O.compRelease), knee: u16(b, o + O.compKnee), threshold: u16(b, o + O.compThreshold) },
      limiter: { attack: u16(b, o + O.limAttack), release: u16(b, o + O.limRelease), reserved: u16(b, o + O.limReserved), threshold: u16(b, o + O.limThreshold) },
      gain: u16(b, o + O.gain), phase: u16(b, o + O.phase), delay: u16(b, o + O.delay), link: u16(b, o + O.link),
      mute: bit(muteOut, j),
    });
  }
  return {
    model: m.id, header: [b[0], b[1]], presetName: readAscii(b, L.name, 14),
    inputs, outputs, toneSource: u16(b, g.toneSource), toneFreq: u16(b, g.toneFreq), delayUnit: u16(b, g.delayUnit),
  };
}

export function serializeConfig(c: DeviceConfig): Uint8Array {
  const m = MODELS[c.model];
  const L = layoutOf(m);
  const b = new Uint8Array(m.configSize);
  b[0] = c.header[0]; b[1] = c.header[1];
  writeAscii(b, L.name, 14, c.presetName.padEnd(14, ' '));
  const g = L.g;
  let muteIn = 0, muteOut = 0, pbIn = 0, pbOut = 0, geqByp = 0;
  const writePeq = (o: number, bands: PeqBand[], ch: number): void => {
    let mask = 0;
    bands.forEach((p, k) => {
      putU16(b, o + 6 * k, p.gain); putU16(b, o + 6 * k + 2, p.freq); b[o + 6 * k + 4] = p.q; b[o + 6 * k + 5] = p.type;
      if (p.bypass) mask |= 1 << k;
    });
    putU16(b, g.bandBypass(ch), mask);
  };
  c.inputs.forEach((ch, i) => {
    const o = L.inBase(i), I = L.in;
    writeAscii(b, o + I.name, 8, ch.name);
    putU16(b, o + I.gateAttack, ch.gate.attack); putU16(b, o + I.gateRelease, ch.gate.release);
    putU16(b, o + I.gateHold, ch.gate.hold); putU16(b, o + I.gateThreshold, ch.gate.threshold);
    ch.geq.forEach((v, k) => putU16(b, o + I.geq + 2 * k, v));
    writePeq(o + I.peq, ch.peq, i);
    putU16(b, o + I.hpfFreq, ch.hpf.freq); putU16(b, o + I.lpfFreq, ch.lpf.freq);
    b[o + I.hpfSlope] = ch.hpf.slope; b[o + I.lpfSlope] = ch.lpf.slope;
    putU16(b, o + I.gain, ch.gain); putU16(b, o + I.phase, ch.phase); putU16(b, o + I.delay, ch.delay); putU16(b, o + I.link, ch.link);
    if (ch.mute) muteIn |= 1 << i;
    if (ch.peqBypass) pbIn |= 1 << i;
    if (ch.geqBypass) geqByp |= 1 << i;
  });
  c.outputs.forEach((ch, j) => {
    const o = L.outBase(j), O = L.out;
    writeAscii(b, o + O.name, 8, ch.name);
    putU16(b, o + O.route, ch.route);
    ch.mix.forEach((v, k) => putU16(b, o + O.mix + 2 * k, v));
    putU16(b, o + O.hpfFreq, ch.hpf.freq); putU16(b, o + O.lpfFreq, ch.lpf.freq);
    b[o + O.hpfSlope] = ch.hpf.slope; b[o + O.lpfSlope] = ch.lpf.slope;
    writePeq(o + O.peq, ch.peq, m.inputs + j);
    putU16(b, o + O.compRatio, ch.comp.ratio); putU16(b, o + O.compAttack, ch.comp.attack); putU16(b, o + O.compRelease, ch.comp.release);
    putU16(b, o + O.compKnee, ch.comp.knee); putU16(b, o + O.compThreshold, ch.comp.threshold);
    putU16(b, o + O.limAttack, ch.limiter.attack); putU16(b, o + O.limRelease, ch.limiter.release);
    putU16(b, o + O.limReserved, ch.limiter.reserved); putU16(b, o + O.limThreshold, ch.limiter.threshold);
    putU16(b, o + O.gain, ch.gain); putU16(b, o + O.phase, ch.phase); putU16(b, o + O.delay, ch.delay); putU16(b, o + O.link, ch.link);
    if (ch.mute) muteOut |= 1 << j;
    if (ch.peqBypass) pbOut |= 1 << j;
  });
  putU16(b, g.muteIn, muteIn); putU16(b, g.muteOut, muteOut);
  putU16(b, g.toneSource, c.toneSource); putU16(b, g.toneFreq, c.toneFreq); putU16(b, g.delayUnit, c.delayUnit);
  putU16(b, g.peqBypassIn, pbIn); putU16(b, g.peqBypassOut, pbOut); putU16(b, g.geqBypass, geqByp);
  return b;
}

// ----------------------------------------------------------------------------------------------
// Factory preset F00 as produced by the firmware (identical to the editor's "Default Preset").
const DEFAULT_PEQ_IN = [41, 71, 101, 140, 170, 200, 240, 270]; // 50 Hz .. 10 kHz
const DEFAULT_PEQ_OUT = [31, 63, 95, 127, 158, 190, 222, 253, 285];
export function defaultPeq(n: number, isIn: boolean): PeqBand[] {
  const f = isIn ? DEFAULT_PEQ_IN : DEFAULT_PEQ_OUT;
  return Array.from({ length: n }, (_, k) => ({ gain: EQ_GAIN_0DB, freq: f[k] ?? 170, q: 35, type: 0, bypass: false }));
}
export function defaultConfig(model: ModelId): DeviceConfig {
  const m = MODELS[model];
  const inputs: InputChannel[] = Array.from({ length: m.inputs }, (_, i) => ({
    name: m.inputLabels[i], gate: { attack: 0, release: 99, hold: 99, threshold: 0 },
    geq: Array(m.geqBands).fill(EQ_GAIN_0DB), geqBypass: false, peq: defaultPeq(m.inPeqBands, true), peqBypass: false,
    hpf: { freq: 0, slope: 0 }, lpf: { freq: FREQ_STEPS, slope: 0 }, gain: GAIN_RAW_0DB, phase: 0, delay: 0, link: 1 << i, mute: false,
  }));
  const outputs: OutputChannel[] = Array.from({ length: m.outputs }, (_, j) => ({
    name: m.outputLabels[j], route: 1 << (j % m.inputs), mix: Array(m.inputs).fill(GAIN_RAW_0DB),
    hpf: { freq: 0, slope: 0 }, lpf: { freq: FREQ_STEPS, slope: 0 }, peq: defaultPeq(m.outPeqBands, false), peqBypass: false,
    comp: { ratio: 0, attack: 49, release: 499, knee: 0, threshold: 220 },
    limiter: { attack: 49, release: 499, reserved: 0, threshold: 220 },
    gain: GAIN_RAW_0DB, phase: 0, delay: 0, link: 1 << j, mute: false,
  }));
  return { model, header: [0xff, 0x00], presetName: 'Default Preset', inputs, outputs, toneSource: 0, toneFreq: 0, delayUnit: 0 };
}

export function cloneConfig(c: DeviceConfig): DeviceConfig {
  return parseConfig(c.model, serializeConfig(c));
}
