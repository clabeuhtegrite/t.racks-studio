// Hardware models and their configuration memory layout.
// Every offset below was measured on the real firmware (v1.04) running in the emulator: each
// set-command was applied, the config dumped with 0x27 and diffed (see emulator/tools/mapper.py).

export type ModelId = 'dsp206' | 'dsp408';

export interface ModelSpec {
  id: ModelId;
  name: string;
  /** prefix of the 0x13 version string, e.g. "DSP206 V0104P" */
  versionPrefix: string;
  /** magic that starts the editor's .prs / .unt files */
  fileMagic: string;
  inputs: number;
  outputs: number;
  inPeqBands: number;
  outPeqBands: number;
  geqBands: number;
  /** number of user presets U01..Unn (F00 is the read-only factory preset) */
  userPresets: number;
  configSize: number;
  pageSize: number;
  pages: number;
  inputLabels: string[];
  outputLabels: string[];
}

const PAGE = 50;
const IN_BLOCK = 0x8c;
const outBlock = (nin: number): number => 96 + 2 * nin;
const sizeOf = (nin: number, nout: number): number => 0x10 + nin * IN_BLOCK + nout * outBlock(nin) + 16 + 2 * (nin + nout);

function spec(id: ModelId, nin: number, nout: number, presets: number): ModelSpec {
  const configSize = sizeOf(nin, nout);
  const n = id === 'dsp206' ? '206' : '408';
  return {
    id, name: `DSP ${n}`, versionPrefix: `DSP${n}`, fileMagic: `***DSP${n}V010***`,
    inputs: nin, outputs: nout, inPeqBands: 8, outPeqBands: 9, geqBands: 31, userPresets: presets,
    configSize, pageSize: PAGE, pages: Math.ceil(configSize / PAGE),
    inputLabels: Array.from({ length: nin }, (_, i) => 'In' + String.fromCharCode(65 + i)),
    outputLabels: Array.from({ length: nout }, (_, i) => 'Out' + (i + 1)),
  };
}

export const MODELS: Record<ModelId, ModelSpec> = {
  dsp206: spec('dsp206', 2, 6, 20), // 928 bytes, 19 pages
  dsp408: spec('dsp408', 4, 8, 20), // 1448 bytes, 29 pages
};

export function modelFromVersion(version: string): ModelSpec | undefined {
  const v = version.replace(/\s+/g, '').toUpperCase();
  return Object.values(MODELS).find((m) => v.startsWith(m.versionPrefix));
}

/** Channel ids used on the wire: inputs 0..nin-1 then outputs nin..nin+nout-1. */
export const isInput = (m: ModelSpec, ch: number): boolean => ch < m.inputs;
export const outIndex = (m: ModelSpec, ch: number): number => ch - m.inputs;
export const outChannel = (m: ModelSpec, o: number): number => m.inputs + o;
export const channelCount = (m: ModelSpec): number => m.inputs + m.outputs;
export const channelLabel = (m: ModelSpec, ch: number): string =>
  isInput(m, ch) ? m.inputLabels[ch] : m.outputLabels[ch - m.inputs];

// ----------------------------------------------------------------------------------------------
// Offsets
export interface Layout {
  name: number; // 14 bytes preset name
  inBase: (i: number) => number;
  outBase: (o: number) => number;
  in: {
    name: 0; gateAttack: 8; gateRelease: 10; gateHold: 12; gateThreshold: 14; geq: 16; peq: 0x4e;
    hpfFreq: 0x7e; lpfFreq: 0x80; hpfSlope: 0x82; lpfSlope: 0x83; gain: 0x84; phase: 0x86; delay: 0x88; link: 0x8a;
  };
  out: {
    name: number; route: number; mix: number; hpfFreq: number; lpfFreq: number; hpfSlope: number; lpfSlope: number;
    peq: number; compRatio: number; compAttack: number; compRelease: number; compKnee: number; compThreshold: number;
    limAttack: number; limRelease: number; limReserved: number; limThreshold: number;
    gain: number; phase: number; delay: number; link: number;
  };
  g: {
    muteIn: number; muteOut: number; bandBypass: (ch: number) => number; toneSource: number; toneFreq: number;
    delayUnit: number; peqBypassIn: number; peqBypassOut: number; geqBypass: number;
  };
}

export function layoutOf(m: ModelSpec): Layout {
  const nin = m.inputs, M = 2 * nin;
  const outStart = 0x10 + nin * IN_BLOCK;
  const G = outStart + m.outputs * outBlock(nin);
  return {
    name: 2,
    inBase: (i) => 0x10 + i * IN_BLOCK,
    outBase: (o) => outStart + o * outBlock(nin),
    in: {
      name: 0, gateAttack: 8, gateRelease: 10, gateHold: 12, gateThreshold: 14, geq: 16, peq: 0x4e,
      hpfFreq: 0x7e, lpfFreq: 0x80, hpfSlope: 0x82, lpfSlope: 0x83, gain: 0x84, phase: 0x86, delay: 0x88, link: 0x8a,
    },
    out: {
      name: 0, route: 8, mix: 10, hpfFreq: 10 + M, lpfFreq: 12 + M, hpfSlope: 14 + M, lpfSlope: 15 + M, peq: 16 + M,
      compRatio: 70 + M, compAttack: 72 + M, compRelease: 74 + M, compKnee: 76 + M, compThreshold: 78 + M,
      limAttack: 80 + M, limRelease: 82 + M, limReserved: 84 + M, limThreshold: 86 + M,
      gain: 88 + M, phase: 90 + M, delay: 92 + M, link: 94 + M,
    },
    g: {
      muteIn: G, muteOut: G + 2, bandBypass: (ch) => G + 4 + 2 * ch,
      toneSource: G + 4 + 2 * (nin + m.outputs), toneFreq: G + 6 + 2 * (nin + m.outputs),
      delayUnit: G + 8 + 2 * (nin + m.outputs), peqBypassIn: G + 10 + 2 * (nin + m.outputs),
      peqBypassOut: G + 12 + 2 * (nin + m.outputs), geqBypass: G + 14 + 2 * (nin + m.outputs),
    },
  };
}
