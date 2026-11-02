// Frequency-response maths for the curves drawn by the UI (magnitude and phase, like the editor's
// "Mag / Phase" view). PEQ bands are RBJ biquads at the DSP sample rate; crossovers use the classic
// Butterworth / Bessel / Linkwitz-Riley analog prototypes the firmware designs from.

import { GEQ_FREQS, eqGainRawToDb, freqRawToHz, qRawToValue, slopeInfo } from './codecs.ts';

export const FS = 96000;

export interface Complex { re: number; im: number }
const cmul = (a: Complex, b: Complex): Complex => ({ re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re });
const cdiv = (a: Complex, b: Complex): Complex => {
  const d = b.re * b.re + b.im * b.im || 1e-30;
  return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d };
};

export interface Biquad { b0: number; b1: number; b2: number; a0: number; a1: number; a2: number }
const UNITY: Biquad = { b0: 1, b1: 0, b2: 0, a0: 1, a1: 0, a2: 0 };

/** RBJ cookbook biquads. type = PEQ type index (0 Peak .. 8 All Pass 2). */
export function peqBiquad(type: number, f0: number, gainDb: number, q: number, fs = FS): Biquad {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * Math.min(f0, fs * 0.49)) / fs;
  const cw = Math.cos(w0), sw = Math.sin(w0);
  const alpha = sw / (2 * Math.max(q, 0.05));
  switch (type) {
    case 0: // peak
      return { b0: 1 + alpha * A, b1: -2 * cw, b2: 1 - alpha * A, a0: 1 + alpha / A, a1: -2 * cw, a2: 1 - alpha / A };
    case 1: { // low shelf
      const s = 2 * Math.sqrt(A) * alpha;
      return {
        b0: A * (A + 1 - (A - 1) * cw + s), b1: 2 * A * (A - 1 - (A + 1) * cw), b2: A * (A + 1 - (A - 1) * cw - s),
        a0: A + 1 + (A - 1) * cw + s, a1: -2 * (A - 1 + (A + 1) * cw), a2: A + 1 + (A - 1) * cw - s,
      };
    }
    case 2: { // high shelf
      const s = 2 * Math.sqrt(A) * alpha;
      return {
        b0: A * (A + 1 + (A - 1) * cw + s), b1: -2 * A * (A - 1 + (A + 1) * cw), b2: A * (A + 1 + (A - 1) * cw - s),
        a0: A + 1 - (A - 1) * cw + s, a1: 2 * (A - 1 - (A + 1) * cw), a2: A + 1 - (A - 1) * cw - s,
      };
    }
    case 3: { // LP 6 dB/oct (1st order, bilinear)
      const k = Math.tan(w0 / 2);
      return { b0: k, b1: k, b2: 0, a0: 1 + k, a1: k - 1, a2: 0 };
    }
    case 4: // LP 12 dB/oct
      return { b0: (1 - cw) / 2, b1: 1 - cw, b2: (1 - cw) / 2, a0: 1 + alpha, a1: -2 * cw, a2: 1 - alpha };
    case 5: { // HP 6 dB/oct
      const k = Math.tan(w0 / 2);
      return { b0: 1, b1: -1, b2: 0, a0: 1 + k, a1: k - 1, a2: 0 };
    }
    case 6: // HP 12 dB/oct
      return { b0: (1 + cw) / 2, b1: -(1 + cw), b2: (1 + cw) / 2, a0: 1 + alpha, a1: -2 * cw, a2: 1 - alpha };
    case 7: { // all-pass 1st order
      const k = Math.tan(w0 / 2);
      return { b0: k - 1, b1: k + 1, b2: 0, a0: k + 1, a1: k - 1, a2: 0 };
    }
    case 8: // all-pass 2nd order
      return { b0: 1 - alpha, b1: -2 * cw, b2: 1 + alpha, a0: 1 + alpha, a1: -2 * cw, a2: 1 - alpha };
    default:
      return UNITY;
  }
}

export function biquadAt(bq: Biquad, f: number, fs = FS): Complex {
  const w = (2 * Math.PI * f) / fs;
  const z1 = { re: Math.cos(-w), im: Math.sin(-w) };
  const z2 = { re: Math.cos(-2 * w), im: Math.sin(-2 * w) };
  const num = { re: bq.b0 + bq.b1 * z1.re + bq.b2 * z2.re, im: bq.b1 * z1.im + bq.b2 * z2.im };
  const den = { re: bq.a0 + bq.a1 * z1.re + bq.a2 * z2.re, im: bq.a1 * z1.im + bq.a2 * z2.im };
  return cdiv(num, den);
}

// ------------------------------- crossover prototypes ---------------------------------------
// Each prototype is a list of sections (normalised to 1 rad/s): first order {q: 0, w: w0} or
// second order {q, w}. Bessel tables are the -3 dB normalised ones.
interface Section { q: number; w: number }
function butterworth(order: number): Section[] {
  const out: Section[] = [];
  for (let k = 1; k <= Math.floor(order / 2); k++) {
    const theta = ((2 * k - 1) * Math.PI) / (2 * order);
    out.push({ q: 1 / (2 * Math.sin(theta)), w: 1 });
  }
  if (order % 2) out.push({ q: 0, w: 1 });
  return out;
}
const BESSEL: Record<number, Section[]> = {
  1: [{ q: 0, w: 1 }],
  2: [{ q: 0.5773, w: 1.2720 }],
  3: [{ q: 0.6910, w: 1.4476 }, { q: 0, w: 1.3270 }],
  4: [{ q: 0.5219, w: 1.4302 }, { q: 0.8055, w: 1.6034 }],
  5: [{ q: 0.5635, w: 1.5554 }, { q: 0.9165, w: 1.7581 }, { q: 0, w: 1.5069 }],
  6: [{ q: 0.5103, w: 1.6060 }, { q: 0.6112, w: 1.6913 }, { q: 1.0234, w: 1.9071 }],
  7: [{ q: 0.5324, w: 1.7174 }, { q: 0.6608, w: 1.8235 }, { q: 1.1262, w: 2.0507 }, { q: 0, w: 1.6853 }],
  8: [{ q: 0.5060, w: 1.7837 }, { q: 0.5596, w: 1.8376 }, { q: 0.7109, w: 1.9591 }, { q: 1.2258, w: 2.1953 }],
};
function prototype(family: 'BW' | 'BL' | 'LK', order: number): Section[] {
  if (family === 'BL') return BESSEL[order] ?? butterworth(order);
  if (family === 'LK') { const h = butterworth(order / 2); return [...h, ...h]; }
  return butterworth(order);
}
function sectionAt(s: Section, x: number, high: boolean): Complex {
  // x = f / fc ; s-plane variable p = j*x (normalised)
  if (s.q === 0) {
    const den = { re: s.w, im: x };
    return high ? cdiv({ re: 0, im: x }, den) : cdiv({ re: s.w, im: 0 }, den);
  }
  const w2 = s.w * s.w;
  const den = { re: w2 - x * x, im: (s.w * x) / s.q };
  return high ? cdiv({ re: -x * x, im: 0 }, den) : cdiv({ re: w2, im: 0 }, den);
}
export function crossoverAt(slopeByte: number, fc: number, f: number, high: boolean): Complex {
  const info = slopeInfo(slopeByte);
  if (!info) return { re: 1, im: 0 };
  let h: Complex = { re: 1, im: 0 };
  for (const s of prototype(info.family, info.order)) h = cmul(h, sectionAt(s, f / fc, high));
  return h;
}

// ------------------------------- channel response ------------------------------------------
export interface PeqBandLike { gain: number; freq: number; q: number; type: number; bypass: boolean }
export interface XoverLike { freq: number; slope: number }
export interface ResponseInput {
  peq: PeqBandLike[];
  peqBypass?: boolean;
  hpf?: XoverLike;
  lpf?: XoverLike;
  geq?: number[]; // raw band levels
  geqBypass?: boolean;
  invert?: boolean;
}

export function logFreqs(n = 256, fmin = 20, fmax = 20000): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(fmin * Math.pow(fmax / fmin, i / (n - 1)));
  return out;
}

const GEQ_Q = 4.32; // 1/3 octave constant-Q

export function bandResponse(b: PeqBandLike, f: number): Complex {
  if (b.bypass) return { re: 1, im: 0 };
  return biquadAt(peqBiquad(b.type, freqRawToHz(b.freq), eqGainRawToDb(b.gain), qRawToValue(b.q)), f);
}

export function channelResponse(inp: ResponseInput, freqs: number[]): { mag: number[]; phase: number[] } {
  const bqs: Biquad[] = [];
  if (!inp.peqBypass) {
    for (const b of inp.peq) if (!b.bypass) bqs.push(peqBiquad(b.type, freqRawToHz(b.freq), eqGainRawToDb(b.gain), qRawToValue(b.q)));
  }
  if (inp.geq && !inp.geqBypass) {
    inp.geq.forEach((raw, i) => { if (raw !== 120) bqs.push(peqBiquad(0, GEQ_FREQS[i], eqGainRawToDb(raw), GEQ_Q)); });
  }
  const mag: number[] = []; const phase: number[] = [];
  for (const f of freqs) {
    let h: Complex = { re: inp.invert ? -1 : 1, im: 0 };
    for (const bq of bqs) h = cmul(h, biquadAt(bq, f));
    if (inp.hpf) h = cmul(h, crossoverAt(inp.hpf.slope, freqRawToHz(inp.hpf.freq), f, true));
    if (inp.lpf) h = cmul(h, crossoverAt(inp.lpf.slope, freqRawToHz(inp.lpf.freq), f, false));
    mag.push(20 * Math.log10(Math.hypot(h.re, h.im) || 1e-12));
    phase.push((Math.atan2(h.im, h.re) * 180) / Math.PI);
  }
  return { mag, phase };
}

/** Static compressor / limiter transfer curve (input dB -> output dB), soft knee. */
export function compressorCurve(thrDb: number, ratio: number, kneeDb: number, inputs: number[]): number[] {
  return inputs.map((x) => {
    const r = Number.isFinite(ratio) ? ratio : 1e9;
    const d = x - thrDb;
    if (kneeDb > 0 && Math.abs(d) <= kneeDb / 2) return x + ((1 / r - 1) * (d + kneeDb / 2) ** 2) / (2 * kneeDb);
    return d > 0 ? thrDb + d / r : x;
  });
}
