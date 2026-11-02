// Binary framing used by the t.racks DSP 206 / 408 (Musicrown OEM family) on every transport
// (USB HID, TCP 9761 through the Ethernet module, RS-485 / RS-232 UART at 115200 8N1).
//
//   10 02 | src | dst | len | cmd | data... | 10 03 | chk
//
// - host -> DSP: src=0x00 dst=0x01 ; DSP -> host: src=0x01 dst=0x00
// - len = 1 + data.length (counts the cmd byte and the data)
// - chk = XOR of every byte before it (equivalently seed 1 XOR src..data, the 0x10 bytes cancel)
// - no byte stuffing: framing relies on `len`.

export const STX0 = 0x10;
export const STX1 = 0x02;
export const ETX0 = 0x10;
export const ETX1 = 0x03;
export const HOST = 0x00;
export const DEVICE = 0x01;
export const MAX_DATA = 254;

export interface Frame {
  src: number;
  dst: number;
  cmd: number;
  data: Uint8Array;
}

export function checksum(bytes: ArrayLike<number>, end = bytes.length): number {
  let c = 0;
  for (let i = 0; i < end; i++) c ^= bytes[i];
  return c & 0xff;
}

export function encodeFrame(cmd: number, data: ArrayLike<number> = [], src = HOST, dst = DEVICE): Uint8Array {
  if (data.length > MAX_DATA) throw new RangeError(`frame data too long (${data.length})`);
  const out = new Uint8Array(data.length + 9);
  out[0] = STX0; out[1] = STX1; out[2] = src & 0xff; out[3] = dst & 0xff;
  out[4] = (1 + data.length) & 0xff; out[5] = cmd & 0xff;
  for (let i = 0; i < data.length; i++) out[6 + i] = data[i] & 0xff;
  const n = 6 + data.length;
  out[n] = ETX0; out[n + 1] = ETX1;
  out[n + 2] = checksum(out, n + 2);
  return out;
}

export function frameToBytes(f: Frame): Uint8Array {
  return encodeFrame(f.cmd, f.data, f.src, f.dst);
}

export function toHex(bytes: ArrayLike<number>): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += (i ? ' ' : '') + (bytes[i] & 0xff).toString(16).padStart(2, '0');
  return s;
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

/**
 * Streaming parser: feed arbitrary chunks (USB reports, TCP segments, UART bytes) and get whole frames.
 * Resynchronises on garbage and drops frames with a bad checksum (reported through `onError`).
 */
export class FrameParser {
  private buf: number[] = [];
  onError?: (reason: string, bytes: Uint8Array) => void;

  push(chunk: ArrayLike<number>): Frame[] {
    for (let i = 0; i < chunk.length; i++) this.buf.push(chunk[i] & 0xff);
    const frames: Frame[] = [];
    for (;;) {
      // find start
      let s = 0;
      while (s + 1 < this.buf.length && !(this.buf[s] === STX0 && this.buf[s + 1] === STX1)) s++;
      if (s > 0) {
        // USB reports are zero padded: silently drop padding, report other garbage
        const junk = this.buf.splice(0, s);
        if (junk.some((b) => b !== 0) && this.onError) this.onError('garbage', Uint8Array.from(junk));
      }
      if (this.buf.length < 5) break;
      const len = this.buf[4];
      const total = len + 8;
      if (len === 0) { this.buf.splice(0, 2); continue; }
      if (this.buf.length < total) break;
      const raw = this.buf.slice(0, total);
      if (raw[total - 3] !== ETX0 || raw[total - 2] !== ETX1 || checksum(raw, total - 1) !== raw[total - 1]) {
        this.onError?.('bad frame', Uint8Array.from(raw));
        this.buf.splice(0, 2);
        continue;
      }
      this.buf.splice(0, total);
      frames.push({ src: raw[2], dst: raw[3], cmd: raw[5], data: Uint8Array.from(raw.slice(6, 5 + len)) });
    }
    return frames;
  }

  reset(): void { this.buf = []; }
}

/** USB HID: 64-byte reports; on write the report id 0x00 is prepended (65 bytes). */
export function toHidReports(frame: Uint8Array, reportSize = 64): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let o = 0; o < frame.length; o += reportSize) {
    const r = new Uint8Array(reportSize);
    r.set(frame.subarray(o, o + reportSize));
    out.push(r);
  }
  return out;
}
