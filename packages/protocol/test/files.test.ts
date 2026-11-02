import { describe, expect, it } from 'vitest';
import { defaultConfig, serializeConfig } from '../src/config.ts';
import {
  decodeNative, decodePrs, decodeUnt, encodeNative, encodePrs, encodeUnt, FileFormatError, openFile, presetToNative, prsSize, untSize, type UnitFile,
} from '../src/files.ts';
import { layoutOf, MODELS } from '../src/models.ts';

const custom = (model: 'dsp206' | 'dsp408') => {
  const c = defaultConfig(model);
  c.presetName = 'Live Room';
  c.inputs[0].gain = 300; c.inputs[1].mute = true;
  c.outputs[0].hpf = { freq: 90, slope: 10 }; c.outputs[1].peq[4] = { gain: 90, freq: 200, q: 50, type: 0, bypass: true };
  c.outputs[3].name = 'Sub'; c.outputs[2].limiter.threshold = 170;
  c.inputs[0].peqBypass = true; c.inputs[0].geqBypass = true; c.delayUnit = 1; // not stored in a .prs
  return c;
};

describe('.prs (editor preset file)', () => {
  it('has the editor size and layout', () => {
    expect(prsSize('dsp206')).toBe(932);
    expect(prsSize('dsp408')).toBe(1452); // the editor checks size - 16 == 0x59c
    for (const m of ['dsp206', 'dsp408'] as const) {
      const f = encodePrs(custom(m));
      expect(f.length).toBe(prsSize(m));
      expect(String.fromCharCode(...f.subarray(0, 16))).toBe(MODELS[m].fileMagic);
      expect(String.fromCharCode(...f.subarray(16, 30))).toBe('Live Room     ');
      expect(Array.from(f.subarray(f.length - 2))).toEqual([13, 10]);
      const L = layoutOf(MODELS[m]);
      expect(f.length - 18).toBe(L.g.bandBypass(MODELS[m].inputs + MODELS[m].outputs) - 2);
    }
  });
  it('round-trips the stored fields and keeps the others from the base config', () => {
    for (const m of ['dsp206', 'dsp408'] as const) {
      const c = custom(m);
      const back = decodePrs(encodePrs(c));
      expect(back.inputs[0].gain).toBe(300);
      expect(back.outputs[1].peq[4]).toEqual(c.outputs[1].peq[4]);
      expect(back.outputs[3].name).toBe('Sub');
      expect(back.inputs[0].peqBypass).toBe(false); // not in the file: factory default
      expect(back.delayUnit).toBe(0);
      const kept = decodePrs(encodePrs(c), m, c);
      expect(serializeConfig(kept)).toEqual(serializeConfig(c));
    }
  });
  it('rejects foreign or truncated files with a French message', () => {
    const f = encodePrs(custom('dsp206'));
    expect(() => decodePrs(f, 'dsp408')).toThrow(/DSP 206/);
    expect(() => decodePrs(f.subarray(0, 500))).toThrow(FileFormatError);
    expect(() => decodePrs(new Uint8Array(932))).toThrow(/pas un preset/);
  });
});

describe('.unt (editor unit file)', () => {
  const unit = (m: 'dsp206' | 'dsp408'): UnitFile => {
    const raw = new Array(18).fill(0xff);
    raw[0] = 1; raw.splice(3, 4, 0x31, 0x32, 0x33, 0x34); raw[7] = 0; raw[8] = 12; raw[9] = 0x27; raw[10] = 0x0f; raw[11] = 1; raw[12] = 0;
    const presets: UnitFile['presets'] = Array(20).fill(null);
    presets[0] = { slot: 1, name: 'Live Room', config: custom(m) };
    presets[19] = { slot: 20, name: 'Last', config: defaultConfig(m) };
    return { model: m, system: { raw, deviceId: 1, ptsPassword: '1234', ptsCount: 12, ptsLimit: 9999, ptsOn: true, locked: false, lockPassword: '' }, presets };
  };
  it('has the editor size and layout', () => {
    expect(untSize('dsp206')).toBe(18594);
    expect(untSize('dsp408')).toBe(28994);
    const f = encodeUnt(unit('dsp206'));
    expect(f.length).toBe(18594);
    const rec = 926;
    expect(f[34]).toBe(1); // slot number
    expect(f[35]).toBe(0xff); // first config byte, the editor's "used" marker
    expect(Array.from(f.subarray(34 + rec, 34 + rec + 2))).toEqual([13, 10]);
    expect(f.subarray(34 + rec + 2, 34 + 2 * rec + 2).every((b) => b === 0x64)).toBe(true); // unused slot
  });
  it('round-trips presets and system settings', () => {
    for (const m of ['dsp206', 'dsp408'] as const) {
      const u = unit(m);
      const back = decodeUnt(encodeUnt(u));
      expect(back.model).toBe(m);
      expect(back.presets.map((p) => p?.slot ?? null).filter(Boolean)).toEqual([1, 20]);
      expect(back.presets[0]?.name).toBe('Live Room');
      expect(back.presets[0]?.config.outputs[0].hpf).toEqual({ freq: 90, slope: 10 });
      expect(back.system).toMatchObject({ ptsPassword: '1234', ptsCount: 12, ptsLimit: 9999, ptsOn: true, locked: false });
    }
  });
});

describe('native JSON files and openFile()', () => {
  it('round-trips everything, including what the editor formats drop', () => {
    const c = custom('dsp408');
    const back = decodeNative(encodeNative(presetToNative(c, 'notes')));
    expect(back.kind).toBe('preset');
    if (back.kind === 'preset') expect(serializeConfig(back.config)).toEqual(serializeConfig(c));
  });
  it('opens any supported file', () => {
    const c = custom('dsp206');
    expect(openFile(encodePrs(c), 'a.prs')).toMatchObject({ kind: 'preset', source: 'prs', model: 'dsp206' });
    expect(openFile(new TextEncoder().encode(encodeNative(presetToNative(c))), 'a.json')).toMatchObject({ kind: 'preset', source: 'native' });
    const u: UnitFile = { model: 'dsp206', system: decodeUnt(encodeUnt({ model: 'dsp206', system: { raw: [], deviceId: 1, ptsPassword: '', ptsCount: 0, ptsLimit: 0, ptsOn: false, locked: false, lockPassword: '' }, presets: [] })).system, presets: [] };
    expect(openFile(encodeUnt(u), 'b.unt')).toMatchObject({ kind: 'unit', source: 'unt' });
    expect(() => openFile(new TextEncoder().encode('{"x":1}'), 'c.json')).toThrow(FileFormatError);
  });
});
