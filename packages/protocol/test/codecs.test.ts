import { describe, expect, it } from 'vitest';
import * as C from '../src/codecs.ts';

describe('codecs', () => {
  it('channel gain uses the two-segment scale of the firmware', () => {
    expect(C.gainRawToDb(0)).toBe(-60);
    expect(C.gainRawToDb(80)).toBe(-20);
    expect(C.gainRawToDb(280)).toBe(0);
    expect(C.gainRawToDb(400)).toBe(12);
    expect(C.gainRawToDb(250)).toBe(-3); // RS-232 help example "Out2 -3.0dB" = 0x00FA
    expect(C.fmtGain(280)).toBe('+0.0dB');
    for (let r = 0; r <= 400; r++) expect(C.gainDbToRaw(C.gainRawToDb(r))).toBe(r);
  });
  it('EQ gain is 0.1 dB around 120', () => {
    expect(C.eqGainRawToDb(0)).toBe(-12);
    expect(C.eqGainRawToDb(240)).toBe(12);
    expect(C.fmtEqGain(135)).toBe('+1.5dB');
    expect(C.fmtEqGain(100)).toBe('-2.0dB');
  });
  it('frequency is 300 log steps from 19.7 Hz to 20.16 kHz', () => {
    expect(C.freqRawToHz(0)).toBeCloseTo(19.7, 5);
    expect(C.freqRawToHz(300)).toBeCloseTo(20160, 3);
    expect(C.freqRawToHz(170)).toBeCloseTo(1000, -1);
    expect(C.fmtFreq(300)).toBe('20.16KHz');
    for (let r = 0; r <= 300; r++) expect(C.freqHzToRaw(C.freqRawToHz(r))).toBe(r);
  });
  it('Q table has 101 entries from 0.4 to 128', () => {
    expect(C.Q_TABLE.length).toBe(101);
    expect(C.qRawToValue(0)).toBe(0.4);
    expect(C.qRawToValue(100)).toBe(128);
    expect(C.qValueToRaw(1.0)).toBe(16);
    expect(C.fmtQ(35)).toBe('3.00');
  });
  it('slopes: 0 = off, then the 20-step ladder', () => {
    expect(C.slopeInfo(0)).toBeNull();
    expect(C.slopeInfo(1)).toEqual({ family: 'BW', order: 1, dbPerOct: 6 });
    expect(C.slopeInfo(10)).toEqual({ family: 'LK', order: 4, dbPerOct: 24 });
    expect(C.slopeInfo(20)).toEqual({ family: 'LK', order: 8, dbPerOct: 48 });
  });
  it('delay: samples at 96 kHz, distance with c = 343.5 m/s', () => {
    expect(C.delayRawToMs(96)).toBe(1);
    expect(C.delayRawToMs(C.DELAY_RAW_MAX)).toBe(680);
    expect(C.delayRawToUnit(96000 / 1000 * 10, 1)).toBeCloseTo(3.435, 6);
    expect(C.delayUnitToRaw(3.435, 1)).toBe(960);
    expect(C.fmtDelay(960, 0)).toBe('10.000ms');
  });
  it('dynamics: threshold byte = 2 dB + 180, times = ms - 1', () => {
    expect(C.thrRawToDb(180)).toBe(0);
    expect(C.thrRawToDb(220)).toBe(20);
    expect(C.thrRawToDb(0)).toBe(-90);
    expect(C.thrDbToRaw(-10)).toBe(160);
    expect(C.timeRawToMs(49)).toBe(50);
    expect(C.fmtRatio(15)).toBe('Limit');
    expect(C.fmtRatio(5)).toBe('1:2.0');
  });
});

import { ext, extHex } from '../src/rs232.ts';
describe('RS-232 extended protocol', () => {
  it('builds the frames of the editor help (9 bytes)', () => {
    expect(extHex(ext.step(1, 0, 0, true))).toBe('7B7D01410000007D7B');
    expect(extHex(ext.mute(1, 1, 0, true))).toBe('7B7D01420100017D7B');
    expect(extHex(ext.volume(1, 0, 0, 0))).toBe('7B7D01440001187D7B');
    expect(extHex(ext.volume(1, 1, 1, -3))).toBe('7B7D01450100FA7D7B');
    expect(extHex(ext.getVolume(1, 0, 0))).toBe('7B7D01480000007D7B');
    expect(ext.getPreset(1).length).toBe(9);
  });
});
