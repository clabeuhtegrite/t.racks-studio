import { describe, expect, it } from 'vitest';
import { checksum, encodeFrame, FrameParser, fromHex, toHex, toHidReports } from '../src/frame.ts';

describe('frame', () => {
  it('encodes exactly like the device (real replies captured from the firmware)', () => {
    expect(toHex(encodeFrame(0x01, [], 1, 0))).toBe('10 02 01 00 01 01 10 03 00'); // ACK
    const version = [...'DSP408 V0104P'].map((c) => c.charCodeAt(0));
    expect(toHex(encodeFrame(0x13, version, 1, 0))).toBe('10 02 01 00 0e 13 44 53 50 34 30 38 20 56 30 31 30 34 50 10 03 45');
  });
  it('checksum is the XOR of every byte before it', () => {
    const f = encodeFrame(0x34, [2, 0x15, 0x01]);
    expect(checksum(f, f.length - 1)).toBe(f[f.length - 1]);
  });
  it('parses frames split across chunks, with garbage and USB padding', () => {
    const p = new FrameParser();
    const errors: string[] = [];
    p.onError = (r) => errors.push(r);
    const a = encodeFrame(0x13, [0x41, 0x42], 1, 0);
    const b = encodeFrame(0x01, [], 1, 0);
    const stream = new Uint8Array([0x55, ...a, 0, 0, 0, ...b]);
    const got = [...p.push(stream.subarray(0, 5)), ...p.push(stream.subarray(5, 12)), ...p.push(stream.subarray(12))];
    expect(got.map((f) => f.cmd)).toEqual([0x13, 0x01]);
    expect(Array.from(got[0].data)).toEqual([0x41, 0x42]);
    expect(errors).toEqual(['garbage']);
  });
  it('drops a frame with a bad checksum and resynchronises', () => {
    const p = new FrameParser();
    const bad = encodeFrame(0x01, [], 1, 0); bad[bad.length - 1] ^= 0xff;
    const good = encodeFrame(0x12, [], 1, 0);
    expect(p.push(new Uint8Array([...bad, ...good])).map((f) => f.cmd)).toEqual([0x12]);
  });
  it('splits into 64-byte HID reports', () => {
    const f = encodeFrame(0x25, new Array(52).fill(7));
    const r = toHidReports(f);
    expect(r.length).toBe(1);
    expect(r[0].length).toBe(64);
    expect(Array.from(r[0].subarray(0, f.length))).toEqual(Array.from(f));
    expect(toHidReports(encodeFrame(0x25, new Array(60).fill(1))).length).toBe(2);
  });
  it('hex helpers round-trip', () => {
    expect(toHex(fromHex('10 02 00 01'))).toBe('10 02 00 01');
  });
});
