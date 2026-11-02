// The virtual DSP and the config model checked against measurements made on the real firmware
// (v1.04, running in the emulator). Every probe: F00 loaded, one command, config read back.
import { describe, expect, it } from 'vitest';
import { defaultConfig, parseConfig, serializeConfig } from '../src/config.ts';
import { frameToBytes, fromHex, toHex } from '../src/frame.ts';
import { MODELS, layoutOf } from '../src/models.ts';
import { VirtualDsp } from '../src/sim.ts';
import { diffOf, loadProbes } from './helpers.ts';

// commands that are not configuration edits (lock, EEPROM, dangerous production opcodes, preset slots)
const SKIP = new Set(['lock', 'c08', 'c09', 'c0f', 'c1a', 'c2e', 'c24', 'c21']);

for (const m of ['206', '408'] as const) {
  describe(`DSP ${m}: config model vs real firmware`, () => {
    const f = loadProbes(m);
    const model = MODELS[f.model];
    it('config size', () => {
      expect(model.configSize).toBe(f.size);
      expect(model.pages).toBe(Math.ceil(f.size / 50));
    });
    it('factory preset F00 = defaultConfig, byte for byte', () => {
      expect(diffOf(serializeConfig(defaultConfig(f.model)), f.baseBytes)).toEqual([]);
    });
    it('parse / serialize is byte exact', () => {
      expect(diffOf(serializeConfig(parseConfig(f.model, f.baseBytes)), f.baseBytes)).toEqual([]);
    });
    for (const p of f.probes.filter((x) => !SKIP.has(x.name))) {
      it(`${p.name} [${p.data}] changes the same bytes`, () => {
        const sim = new VirtualDsp({ model: f.model });
        sim.loadImage(f.baseBytes);
        sim.request(0x10);
        const replies = sim.request(p.cmd, fromHex(p.data));
        if (p.reply) expect(toHex(frameToBytes(replies[0]))).toBe(toHex(fromHex(p.reply)));
        expect(diffOf(f.baseBytes, sim.image())).toEqual(p.diff);
      });
    }
  });
}

describe('DSP 206: link groups behave like the firmware', () => {
  const f = loadProbes('206');
  const L = layoutOf(MODELS.dsp206);
  const OUT1 = L.outBase(0), OUT2 = L.outBase(1), INA = L.inBase(0), INB = L.inBase(1), G = L.g.muteIn;
  const region = (i: number): string => {
    const h = (v: number) => v.toString(16).padStart(2, '0');
    if (i >= INA && i < INB) return 'InA+' + h(i - INA);
    if (i >= INB && i < OUT1) return 'InB+' + h(i - INB);
    if (i >= OUT1 && i < OUT2) return 'Out1+' + h(i - OUT1);
    if (i >= OUT2 && i < OUT2 + 0x64) return 'Out2+' + h(i - OUT2);
    return 'G+' + (G + (i - G)).toString(16).padStart(3, '0');
  };
  // results of emulator/tools/test_link.py on the real firmware
  const expected: [string, number, number[], string[]][] = [
    ['gain', 0x34, [2, 0x23, 0x01], ['Out1+5c', 'Out2+5c']],
    ['mute', 0x35, [2, 1], ['G+382']],
    ['phase', 0x36, [2, 1], ['Out1+5e', 'Out2+5e']],
    ['delay', 0x38, [2, 0x56, 0x04], ['Out1+60', 'Out1+61', 'Out2+60', 'Out2+61']],
    ['hpf', 0x32, [2, 0x89, 0, 0x0b], ['Out1+0e', 'Out1+12', 'Out2+0e', 'Out2+12']],
    ['lpf', 0x31, [2, 0x11, 1, 0x0c], ['Out1+10', 'Out1+13', 'Out2+10', 'Out2+13']],
    ['peq', 0x33, [2, 0, 0x55, 0, 7, 1, 0x33, 2, 1], ['G+388', 'G+38a', 'Out1+14', 'Out1+16', 'Out1+17', 'Out1+18', 'Out1+19', 'Out2+14', 'Out2+16', 'Out2+17', 'Out2+18', 'Out2+19']],
    ['peqbyp', 0x3c, [2, 1], ['G+39c']],
    ['name', 0x3d, [2, ...[...'ABCDEFGH'].map((c) => c.charCodeAt(0))], ['Out1+00', 'Out1+01', 'Out1+02', 'Out1+03', 'Out1+04', 'Out1+05', 'Out1+06', 'Out1+07']],
    ['comp', 0x30, [2, 5, 0, 0x21, 0, 0x22, 2, 7, 0, 0x77, 0], ['Out1+4a', 'Out1+4c', 'Out1+4e', 'Out1+4f', 'Out1+50', 'Out1+52', 'Out2+4a', 'Out2+4c', 'Out2+4e', 'Out2+4f', 'Out2+50', 'Out2+52']],
    ['limit', 0x3f, [2, 0x13, 0, 0x44, 1, 0, 0, 0x66, 0], ['Out1+54', 'Out1+56', 'Out1+5a', 'Out2+54', 'Out2+56', 'Out2+5a']],
    ['route', 0x3a, [2, 2], ['Out1+08']],
    ['mix', 0x41, [2, 1, 0x77, 1], ['Out1+0c']],
    ['gate', 0x3e, [0, 0x15, 0, 0x55, 1, 0x66, 0, 0x44, 0], ['InA+08', 'InA+0a', 'InA+0b', 'InA+0c', 'InA+0e', 'InB+08', 'InB+0a', 'InB+0b', 'InB+0c', 'InB+0e']],
    ['geq', 0x48, [0, 3, 0x99, 0], ['InA+16', 'InB+16']],
    ['geqbyp', 0x49, [0, 1], ['G+39e']],
    ['gain on the member', 0x34, [3, 0x23, 0x01], ['Out1+5c', 'Out2+5c']],
    ['copy', 0x2a, [2, 4], []],
  ];
  for (const [name, c, data, regions] of expected) {
    it(name, () => {
      const sim = new VirtualDsp({ model: 'dsp206' });
      sim.loadImage(f.baseBytes);
      sim.request(0x10);
      for (const [ch, mk] of [[2, 3], [3, 0], [0, 3], [1, 0]]) sim.request(0x3b, [ch, mk]); // as the editor links Out1+Out2, InA+InB
      const before = sim.image();
      sim.request(c, data);
      const got = [...new Set(diffOf(before, sim.image()).map(([i]) => region(i)))].sort();
      expect(got).toEqual([...regions].sort());
    });
  }
});

describe('DSP 206: channel copy behaves like the firmware', () => {
  it('copies everything but name, routing, mix levels and link', () => {
    const f = loadProbes('206');
    const L = layoutOf(MODELS.dsp206);
    const sim = new VirtualDsp({ model: 'dsp206' });
    sim.loadImage(f.baseBytes);
    sim.request(0x10);
    const a = (s: string) => [...s].map((c) => c.charCodeAt(0));
    const cmds: [number, number[]][] = [
      [0x34, [2, 0x23, 1]], [0x3a, [2, 3]], [0x41, [2, 1, 0x77, 1]], [0x3d, [2, ...a('SRCNAME!')]], [0x33, [2, 1, 0x55, 0, 7, 1, 0x33, 2, 1]],
      [0x35, [2, 1]], [0x36, [2, 1]], [0x3c, [2, 1]], [0x30, [2, 5, 0, 0x21, 0, 0x22, 2, 7, 0, 0x77, 0]], [0x38, [2, 0x56, 4]],
      [0x34, [0, 0x45, 1]], [0x3e, [0, 0x15, 0, 0x55, 1, 0x66, 0, 0x44, 0]], [0x48, [0, 3, 0x99, 0]], [0x49, [0, 1]], [0x3d, [0, ...a('INSRC!!!')]],
    ];
    for (const [c, d] of cmds) sim.request(c, d);
    const base = sim.image();
    sim.request(0x2a, [2, 5]); sim.request(0x2a, [0, 1]);
    const cfg = sim.image();
    const hex = (v: number) => '0x' + v.toString(16);
    const O4 = L.outBase(3), O1 = L.outBase(0), INB = L.inBase(1);
    const changed = (o: number, n: number) => Array.from({ length: n }, (_, i) => i).filter((i) => base[o + i] !== cfg[o + i]).map(hex);
    // results of emulator/tools/test_copy.py on the real firmware
    expect(changed(O4, 0x64)).toEqual(['0x1a', '0x1c', '0x1d', '0x1e', '0x1f', '0x4a', '0x4c', '0x4e', '0x4f', '0x50', '0x52', '0x5c', '0x5e', '0x60', '0x61']);
    expect(changed(INB, 0x8c)).toEqual(['0x8', '0xa', '0xb', '0xc', '0xe', '0x16', '0x84']);
    expect(Array.from({ length: 0x20 }, (_, i) => 0x380 + i).filter((i) => base[i] !== cfg[i]).map((i) => [hex(i), base[i], cfg[i]]))
      .toEqual([['0x382', 1, 9], ['0x38e', 0, 2], ['0x39c', 1, 9], ['0x39e', 1, 3]]);
    expect(Array.from({ length: 0x64 }, (_, i) => i).filter((i) => cfg[O4 + i] !== cfg[O1 + i]).map(hex))
      .toEqual(['0x0', '0x1', '0x2', '0x3', '0x4', '0x5', '0x6', '0x7', '0x8', '0xc', '0x62']);
  });
});

describe('preset memory behaves like the firmware', () => {
  for (const id of ['dsp206', 'dsp408'] as const) {
    it(`${id}: a recall stops the test tone, clears PEQ/GEQ bypass and keeps the delay unit`, () => {
      // emulator/tools/test_volatile.py: identical on both models
      const sim = new VirtualDsp({ model: id });
      const nin = MODELS[id].inputs;
      sim.request(0x10); sim.request(0x20, [0]);
      sim.request(0x39, [3, 5]); sim.request(0x15, [2]);
      sim.request(0x3c, [0, 1]); sim.request(0x3c, [nin, 1]); sim.request(0x49, [0, 1]); sim.request(0x35, [nin, 1]);
      sim.request(0x26, [...'VOLATILE TEST '].map((c) => c.charCodeAt(0))); sim.request(0x21, [1]);
      for (const n of [0, 1]) {
        sim.request(0x20, [n]);
        const c = sim.config;
        expect([c.toneSource, c.toneFreq, c.delayUnit]).toEqual([0, 0, 2]);
        expect(c.inputs[0].peqBypass || c.outputs[0].peqBypass || c.inputs[0].geqBypass).toBe(false);
        expect(c.header).toEqual(n === 0 ? [0xff, 0] : [0xff, 0xff]);
        expect(c.outputs[0].mute).toBe(n === 1); // mutes are part of the preset
      }
    });
    it(`${id}: 0x25 writes a stored preset page by page without touching the live sound`, () => {
      const sim = new VirtualDsp({ model: id });
      const m = MODELS[id];
      sim.request(0x10); sim.request(0x20, [0]);
      const live = sim.image();
      const img = defaultConfig(id); img.presetName = 'WRITTEN-PAGE14'; img.inputs[0].gain = 0x123;
      const bytes = serializeConfig(img);
      for (let p = 0; p < m.pages; p++) {
        const r = sim.request(0x25, [p, 2, ...Array.from({ length: 50 }, (_, i) => bytes[p * 50 + i] ?? 0)]);
        expect(r.map((x) => [x.cmd, ...x.data])).toEqual([[0x25, p]]);
      }
      expect(diffOf(live, sim.image())).toEqual([]);
      expect(Array.from(sim.request(0x22)[0].data)[2]).toBe(0xff);
      expect(String.fromCharCode(...sim.request(0x29, [2])[0].data.subarray(1))).toBe('WRITTEN-PAGE14');
      sim.request(0x20, [3]);
      expect(sim.config.inputs[0].gain).toBe(0x123);
    });
  }
});
