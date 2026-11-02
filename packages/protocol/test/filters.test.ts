import { describe, expect, it } from 'vitest';
import { biquadAt, channelResponse, compressorCurve, crossoverAt, peqBiquad } from '../src/filters.ts';
import { defaultPeq } from '../src/config.ts';

const db = (h: { re: number; im: number }) => 20 * Math.log10(Math.hypot(h.re, h.im));

describe('filters', () => {
  it('peak filter reaches its gain at f0', () => {
    expect(db(biquadAt(peqBiquad(0, 1000, 6, 2), 1000))).toBeCloseTo(6, 3);
    expect(db(biquadAt(peqBiquad(0, 1000, -9, 1), 1000))).toBeCloseTo(-9, 3);
  });
  it('crossovers: Butterworth -3 dB, Linkwitz-Riley -6 dB at fc', () => {
    expect(db(crossoverAt(8, 100, 100, true))).toBeCloseTo(-3.01, 1); // BW-24
    expect(db(crossoverAt(10, 100, 100, false))).toBeCloseTo(-6.02, 1); // LK-24
    expect(db(crossoverAt(20, 100, 100, true))).toBeCloseTo(-6.02, 1); // LK-48
    expect(db(crossoverAt(0, 100, 10, true))).toBe(0); // off
    expect(db(crossoverAt(8, 1000, 125, true))).toBeCloseTo(-72, 0); // 24 dB/oct, 3 octaves below
  });
  it('a flat channel is flat', () => {
    const r = channelResponse({ peq: defaultPeq(9, false), hpf: { freq: 0, slope: 0 }, lpf: { freq: 300, slope: 0 } }, [20, 1000, 20000]);
    r.mag.forEach((v) => expect(Math.abs(v)).toBeLessThan(1e-6));
  });
  it('compressor static curve', () => {
    expect(compressorCurve(-20, 4, 0, [-30, -20, 0])).toEqual([-30, -20, -15]);
    expect(compressorCurve(-10, Infinity, 0, [0])[0]).toBeCloseTo(-10, 6);
  });
});
