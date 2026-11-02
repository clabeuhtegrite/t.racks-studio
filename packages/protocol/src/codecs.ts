// Value encodings of the t.racks DSP 206 / 408 parameters, and display formatting identical to the
// official Windows editor (format strings recovered from the editor binary, tables from the firmware).

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const r1 = (v: number): number => Math.round(v * 10) / 10;

// ---------------------------------------------------------------------------------------------
// Channel gain (0x34) and matrix mix gain (0x41): raw 0..400, two segments
//   raw 0..80   : -60 .. -20 dB in 0.5 dB steps
//   raw 80..400 : -20 .. +12 dB in 0.1 dB steps   (raw 280 = 0 dB)
export const GAIN_RAW_MAX = 400;
export const GAIN_RAW_0DB = 280;
export const MIX_RAW_MAX = 280; // mix gain is limited to 0 dB in the editor
export function gainRawToDb(raw: number): number {
  raw = clamp(Math.round(raw), 0, GAIN_RAW_MAX);
  return raw <= 80 ? -60 + raw * 0.5 : r1(-20 + (raw - 80) / 10);
}
export function gainDbToRaw(db: number): number {
  const v = db <= -20 ? Math.round((db + 60) * 2) : Math.round(80 + (db + 20) * 10);
  return clamp(v, 0, GAIN_RAW_MAX);
}
export function fmtGain(raw: number): string {
  const db = gainRawToDb(raw);
  return (db < 0 ? '-' : '+') + Math.abs(db).toFixed(1) + 'dB';
}

// ---------------------------------------------------------------------------------------------
// PEQ band gain and GEQ band level: raw 0..240 = -12..+12 dB, 0.1 dB steps (120 = 0 dB)
export const EQ_GAIN_MAX = 240;
export const EQ_GAIN_0DB = 120;
export const eqGainRawToDb = (raw: number): number => r1((clamp(raw, 0, EQ_GAIN_MAX) - 120) / 10);
export const eqGainDbToRaw = (db: number): number => clamp(Math.round(db * 10 + 120), 0, EQ_GAIN_MAX);
export function fmtEqGain(raw: number): string {
  const db = eqGainRawToDb(raw);
  return (db >= 0 ? '+' : '') + db.toFixed(1) + 'dB';
}

// ---------------------------------------------------------------------------------------------
// Frequency (PEQ, HPF, LPF): raw 0..300, logarithmic 19.7 Hz .. 20.16 kHz (1/30 octave)
export const FREQ_MIN = 19.7;
export const FREQ_MAX = 20160;
export const FREQ_STEPS = 300;
const LN_FR = Math.log(FREQ_MAX / FREQ_MIN);
export function freqRawToHz(raw: number): number {
  raw = clamp(Math.round(raw), 0, FREQ_STEPS);
  return FREQ_MIN * Math.exp((LN_FR * raw) / FREQ_STEPS);
}
export function freqHzToRaw(hz: number): number {
  if (!(hz > FREQ_MIN)) return 0;
  if (hz >= FREQ_MAX) return FREQ_STEPS;
  return clamp(Math.round((Math.log(hz / FREQ_MIN) / LN_FR) * FREQ_STEPS), 0, FREQ_STEPS);
}
export function fmtFreqHz(hz: number): string {
  return hz >= 1000 ? (hz / 1000).toFixed(2) + 'KHz' : hz.toFixed(1) + 'Hz';
}
export const fmtFreq = (raw: number): string => fmtFreqHz(freqRawToHz(raw));

// ---------------------------------------------------------------------------------------------
// Q (bandwidth): raw 0..100 indexes this table (copied from the DSP firmware, identical in 206/408)
export const Q_TABLE: readonly number[] = [
  0.4, 0.42, 0.45, 0.47, 0.5, 0.53, 0.56, 0.59, 0.63, 0.67, 0.71, 0.75, 0.79, 0.84, 0.89, 0.94, 1.0, 1.06,
  1.12, 1.19, 1.26, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2.0, 2.1, 2.2, 2.4, 2.5, 2.7, 2.8, 3.0, 3.2, 3.4,
  3.6, 3.8, 4.0, 4.2, 4.5, 4.8, 5.0, 5.3, 5.7, 6.0, 6.3, 6.7, 7.1, 7.6, 8.0, 8.5, 9.0, 9.5, 10.1, 10.7,
  11.3, 12.0, 12.7, 13.5, 14.0, 15.0, 16.0, 17.0, 18.0, 19.0, 20.0, 21.0, 23.0, 24.0, 25.0, 27.0, 29.0,
  30.0, 32.0, 34.0, 36.0, 38.0, 40.0, 43.0, 45.0, 48.0, 51.0, 54.0, 57.0, 60.0, 64.0, 68.0, 72.0, 76.0,
  81.0, 85.0, 91.0, 96.0, 102.0, 108.0, 114.0, 121.0, 128.0,
];
export const Q_MAX = Q_TABLE.length - 1;
export const qRawToValue = (raw: number): number => Q_TABLE[clamp(Math.round(raw), 0, Q_MAX)];
export function qValueToRaw(q: number): number {
  let best = 0;
  for (let i = 1; i <= Q_MAX; i++) if (Math.abs(Math.log(Q_TABLE[i] / q)) < Math.abs(Math.log(Q_TABLE[best] / q))) best = i;
  return best;
}
export const fmtQ = (raw: number): string => qRawToValue(raw).toFixed(2);

// ---------------------------------------------------------------------------------------------
// PEQ filter types
export const PEQ_TYPES = ['Peak', 'Low Shelf', 'High Shelf', 'LP -6dB', 'LP -12dB', 'HP -6dB', 'HP -12dB', 'All Pass 1', 'All Pass 2'] as const;
export type PeqTypeIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
/** Types for which the gain control is meaningful (the editor greys gain out for the others). */
export const peqTypeHasGain = (t: number): boolean => t <= 2;
/** Types for which Q is meaningful. */
export const peqTypeHasQ = (t: number): boolean => t === 0 || t === 1 || t === 2 || t === 4 || t === 6 || t === 8;

// ---------------------------------------------------------------------------------------------
// Crossover (HPF 0x32 / LPF 0x31) slope byte.
// 0 = filter off (bypass), 1..20 = this ladder (BW = Butterworth, BL = Bessel, LK = Linkwitz-Riley).
export const SLOPES = [
  'BW -6', 'BL -6', 'BW -12', 'BL -12', 'LK -12', 'BW -18', 'BL -18', 'BW -24', 'BL -24', 'LK -24',
  'BW -30', 'BL -30', 'BW -36', 'BL -36', 'LK -36', 'BW -42', 'BL -42', 'BW -48', 'BL -48', 'LK -48',
] as const;
export const SLOPE_OFF = 0;
export const slopeByteToIndex = (b: number): number => (b >= 1 && b <= 20 ? b - 1 : -1);
export const slopeIndexToByte = (i: number): number => clamp(Math.round(i), 0, 19) + 1;
export function slopeInfo(byte: number): { family: 'BW' | 'BL' | 'LK'; order: number; dbPerOct: number } | null {
  const i = slopeByteToIndex(byte);
  if (i < 0) return null;
  const [fam, db] = SLOPES[i].split(' ');
  const dbPerOct = Math.abs(parseInt(db, 10));
  return { family: fam as 'BW' | 'BL' | 'LK', order: dbPerOct / 6, dbPerOct };
}

// ---------------------------------------------------------------------------------------------
// Delay: raw = samples at 96 kHz, 0..65280 (680 ms). Distance uses c = 343.5 m/s (as the editor).
export const DELAY_RAW_MAX = 65280;
export const DELAY_FS = 96000;
export const SPEED_OF_SOUND = 343.5; // m/s
export const M_TO_FT = 3.28084;
export type DelayUnit = 0 | 1 | 2; // ms, m, ft
export const DELAY_UNITS = ['ms', 'm', 'ft'] as const;
export const delayRawToMs = (raw: number): number => (clamp(raw, 0, DELAY_RAW_MAX) * 1000) / DELAY_FS;
export const delayMsToRaw = (ms: number): number => clamp(Math.round((ms * DELAY_FS) / 1000), 0, DELAY_RAW_MAX);
export function delayRawToUnit(raw: number, unit: DelayUnit): number {
  const ms = delayRawToMs(raw);
  if (unit === 1) return (ms * SPEED_OF_SOUND) / 1000;
  if (unit === 2) return ((ms * SPEED_OF_SOUND) / 1000) * M_TO_FT;
  return ms;
}
export function delayUnitToRaw(v: number, unit: DelayUnit): number {
  if (unit === 1) return delayMsToRaw((v * 1000) / SPEED_OF_SOUND);
  if (unit === 2) return delayMsToRaw((v / M_TO_FT) * 1000 / SPEED_OF_SOUND);
  return delayMsToRaw(v);
}
export const fmtDelay = (raw: number, unit: DelayUnit): string => delayRawToUnit(raw, unit).toFixed(3) + DELAY_UNITS[unit];

// ---------------------------------------------------------------------------------------------
// Dynamics (gate, compressor, limiter)
//   threshold byte = 2*dB + 180 (gate -90..0 dB, comp/limiter -90..+20 dB)
//   attack / release / hold: raw = ms - 1
export const THR_MIN_RAW = 0; // -90 dB
export const THR_MAX_RAW = 220; // +20 dB
export const GATE_THR_MAX_RAW = 180; // 0 dB
export const thrRawToDb = (raw: number): number => (raw - 180) / 2;
export const thrDbToRaw = (db: number): number => clamp(Math.round(db * 2 + 180), 0, 255);
export const fmtThr = (raw: number): string => {
  const db = thrRawToDb(raw);
  return (db >= 0 ? '+' : '') + db.toFixed(1) + 'dB';
};
export const timeRawToMs = (raw: number): number => raw + 1;
export const timeMsToRaw = (ms: number): number => clamp(Math.round(ms) - 1, 0, 0xffff);
export const ATTACK_RAW = { min: 0, max: 998 } as const; // 1..999 ms
export const RELEASE_RAW = { min: 9, max: 2999 } as const; // 10..3000 ms
export const HOLD_RAW = { min: 9, max: 998 } as const; // 10..999 ms
export const fmtMs = (raw: number): string => `${timeRawToMs(raw)}ms`;
export const KNEE_MAX = 12; // dB, raw = dB
export const fmtKnee = (raw: number): string => `${raw}dB`;
/** Compressor ratio ladder (index 0..15) - identical in the firmware and the editor; 15 = limiter. */
export const RATIOS: readonly number[] = [1.0, 1.1, 1.3, 1.5, 1.7, 2.0, 2.5, 3.0, 3.5, 4.0, 5.0, 6.0, 8.0, 10.0, 20.0];
export const RATIO_MAX = 15;
export const ratioValue = (i: number): number => (i >= RATIO_MAX ? Infinity : RATIOS[clamp(i, 0, RATIOS.length - 1)]);
export const fmtRatio = (i: number): string => (i >= RATIO_MAX ? 'Limit' : '1:' + RATIOS[clamp(i, 0, 14)].toFixed(1));

// ---------------------------------------------------------------------------------------------
// 31-band GEQ and test-tone sine frequencies (same 1/3 octave ISO table)
export const GEQ_FREQS: readonly number[] = [
  20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000,
  2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000,
];
export function fmtGeqFreq(hz: number): string {
  if (hz >= 1000) {
    const k = hz / 1000;
    return (Number.isInteger(k) ? k.toFixed(0) : String(k)) + 'K';
  }
  return String(hz);
}

// Test tone (0x39): source 0 = analog input, 1 = pink noise, 2 = white noise, 3 = sine (+ index in GEQ_FREQS)
export const TEST_SOURCES = ['Analog Input', 'Pink Noise', 'White Noise', 'Sine Wave'] as const;

// ---------------------------------------------------------------------------------------------
// Little helpers for the binary layout
export const u16 = (b: ArrayLike<number>, o: number): number => (b[o] | (b[o + 1] << 8)) & 0xffff;
export function putU16(b: Uint8Array, o: number, v: number): void {
  b[o] = v & 0xff;
  b[o + 1] = (v >> 8) & 0xff;
}
export function readAscii(b: ArrayLike<number>, o: number, n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) {
    const c = b[o + i];
    if (c === 0 || c === 0xff) break;
    s += String.fromCharCode(c & 0x7f);
  }
  return s.replace(/\s+$/, '');
}
export function writeAscii(b: Uint8Array, o: number, n: number, s: string): void {
  for (let i = 0; i < n; i++) {
    const c = i < s.length ? s.charCodeAt(i) : 0;
    b[o + i] = c >= 0x20 && c < 0x7f ? c : 0;
  }
}
/**
 * Text as the device can store it (printable ASCII): accents are dropped ("Arrière" -> "Arriere"),
 * a few typographic characters are replaced, anything else is removed.
 */
export function deviceAscii(s: string, max: number): string {
  return s
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[œ]/g, 'oe').replace(/[Œ]/g, 'OE').replace(/[æ]/g, 'ae').replace(/[Æ]/g, 'AE').replace(/ß/g, 'ss')
    .replace(/[‘’‚′]/g, "'").replace(/[“”„″«»]/g, '"').replace(/[–—−]/g, '-').replace(/…/g, '...')
    .replace(/[\u00a0\u202f]/g, ' ')
    .replace(/[^\x20-\x7e]/g, '')
    .slice(0, max);
}

export function asciiBytes(s: string, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const c = i < s.length ? s.charCodeAt(i) : 0;
    out.push(c >= 0x20 && c < 0x7f ? c : 0);
  }
  return out;
}
