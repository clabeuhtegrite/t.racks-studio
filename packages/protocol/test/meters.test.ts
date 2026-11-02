import { describe, expect, it } from 'vitest';
import { CMD } from '../src/commands.ts';
import { defaultConfig } from '../src/config.ts';
import { compDbfs, decodeLevel, decodeMeters, dynamicsActive, dynamicsHeadroom, encodeLevel, levelOnThresholdScale, limiterDbfs, meterZones } from '../src/meters.ts';
import { VirtualDsp } from '../src/sim.ts';

describe('meters (0x40), read like the official editors', () => {
  it('rebuilds each level from the three high bytes of a 32-bit float', () => {
    expect(encodeLevel(1)).toEqual([0x80, 0x3f, 0x00]); // 1.0 = 0x3F800000
    expect(decodeLevel(0x80, 0x3f, 0x00)).toBe(1);
    expect(decodeLevel(...encodeLevel(0.5))).toBe(0.5);
    // measured on the real firmware: the DSP chip word 0x11223344 is sent as 22 11 33
    const v = new DataView(new ArrayBuffer(4));
    v.setUint32(0, 0x11223300);
    expect(decodeLevel(0x22, 0x11, 0x33)).toBe(v.getFloat32(0));
  });

  it('maps the groups to the channels of each model and reads the status word', () => {
    const data = Array(38).fill(0);
    const put = (g: number, level: number): void => { data.splice(g * 3, 3, ...encodeLevel(level)); };
    put(0, 1); put(1, 0.1); put(4, 0.5); put(9, 0.25); put(11, 2);
    data[36] = 0b0000_0001; data[37] = 0b0010_0000; // compressor of Out1, limiter of Out6
    const m206 = decodeMeters(data, 2, 6);
    expect(m206.levels).toEqual([1, expect.closeTo(0.1, 4), 0.5, 0, 0, 0, 0, 0.25]);
    expect(m206.db[0]).toBe(0);
    expect(m206.db[2]).toBeCloseTo(-6.02, 2);
    expect(m206.status).toBe(0x2001);
    const m408 = decodeMeters(data, 4, 8);
    expect(m408.levels[4]).toBe(0.5);
    expect(m408.levels[11]).toBe(2);
    expect(decodeMeters(data.slice(0, 36), 4, 8).status).toBe(0);
  });

  it('counts the compressor and the limiter only when they are switched on, as the editors do', () => {
    const cfg = defaultConfig('dsp206');
    const all = 0xffff;
    expect(dynamicsActive(all, cfg, 2)).toEqual({ comp: false, limit: false }); // ratio 1:1, threshold +20 dB
    cfg.outputs[0].comp.ratio = 5;
    cfg.outputs[0].limiter.threshold = 200;
    expect(dynamicsActive(all, cfg, 2)).toEqual({ comp: true, limit: true });
    expect(dynamicsActive(0x0100, cfg, 2)).toEqual({ comp: false, limit: true });
    expect(dynamicsActive(all, cfg, 0)).toEqual({ comp: false, limit: false }); // an input
    expect(meterZones('dsp408', 0)).toEqual({ yellow: -13, red: -3 });
    expect(meterZones('dsp408', 4)).toEqual({ yellow: -24, red: -10 });
  });

  it('places the thresholds on the meter like the firmware does, with the output volume after them', () => {
    expect(limiterDbfs(180)).toBe(-15); // 0 dB: the firmware sends −15 to the DSP
    expect(limiterDbfs(140)).toBe(-35);
    expect(compDbfs(180)).toBeCloseTo(-17.8, 6);
    const cfg = defaultConfig('dsp408');
    const ch = 4; // Out1
    expect(dynamicsHeadroom(cfg, ch, -10, 0)).toEqual({ comp: null, limit: null }); // both off
    cfg.outputs[0].limiter.threshold = 170; // −5 dB → −20 dBFS
    cfg.outputs[0].comp = { ...cfg.outputs[0].comp, ratio: 9, threshold: 150 }; // −15 dB → −32.8 dBFS
    cfg.outputs[0].gain = 260; // −2 dB after them
    const h = dynamicsHeadroom(cfg, ch, -30, 0x0001);
    expect(h.limit).toEqual({ at: -22, margin: 8, acting: false });
    expect(h.comp?.at).toBeCloseTo(-34.8, 6);
    expect(h.comp?.margin).toBeCloseTo(-4.8, 6);
    expect(h.comp?.acting).toBe(true);
    expect(dynamicsHeadroom(cfg, ch, -100, 0).limit?.margin).toBeNull(); // no signal
    // a compressor left at +20 dB with a ratio is still on (only its ratio counts, as in the editors)
    cfg.outputs[1].comp = { ...cfg.outputs[1].comp, ratio: 9 };
    expect(dynamicsHeadroom(cfg, ch + 1, -10, 0).comp?.at).toBeCloseTo(2.2, 6);
    // the curves of the editors: −22 dBFS on the meter is the limiter's threshold (−5 dB as set)
    expect(levelOnThresholdScale(cfg, ch, -22, 'limit')).toBe(-5);
    expect(levelOnThresholdScale(cfg, ch, -34.8, 'comp')).toBeCloseTo(-15, 6);
    expect(levelOnThresholdScale(cfg, 0, -54, 'gate')).toBe(-40); // the gate gets its threshold minus 14 dB
    expect(dynamicsHeadroom(cfg, 0, -10, 0xffff)).toEqual({ comp: null, limit: null }); // an input
  });

  it('the virtual DSP limits, compresses and says so in the status word', () => {
    for (const model of ['dsp206', 'dsp408'] as const) {
      const sim = new VirtualDsp({ model, signalDb: -6, latencyMs: 0 });
      const nin = model === 'dsp206' ? 2 : 4;
      sim.config.outputs[0].limiter.threshold = 160; // −10 dB: acts at −25 dBFS
      sim.config.outputs[0].gain = 300; // +2 dB after the limiter
      sim.config.outputs[1].comp = { ...sim.config.outputs[1].comp, ratio: 14, threshold: 140 }; // 1:20 above −20 dB (−37.8 dBFS)
      sim.request(CMD.LOGIN);
      const [f] = sim.request(CMD.METERS);
      expect(f.data).toHaveLength(38);
      const m = decodeMeters(f.data, nin, model === 'dsp206' ? 6 : 8);
      expect(m.db[nin]).toBeCloseTo(-23, 3);
      expect(m.db[nin + 1]).toBeLessThan(-36);
      expect(dynamicsHeadroom(sim.config, nin, m.db[nin], m.status).limit).toEqual({ at: -23, margin: expect.closeTo(0, 3), acting: true });
      expect(m.status & 0x0100).toBe(0x0100);
      expect(m.status & 0x0002).toBe(0x0002);
      expect(m.status & 0x0201).toBe(0);
    }
  });
});
