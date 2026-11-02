// French display of values, and parsing of what people type ("1,2k", "-3.5", "250 Hz"...), plus the
// parameter definitions used by every control (range, default, display, parsing). Raw values are
// the device's own units (see @dsp-studio/protocol codecs), exactly like the Windows editor.

import {
  DELAY_RAW_MAX, delayRawToUnit, delayUnitToRaw, eqGainDbToRaw, eqGainRawToDb, freqHzToRaw, freqRawToHz, gainDbToRaw,
  gainRawToDb, qRawToValue, qValueToRaw, RATIOS, RATIO_MAX, thrDbToRaw, thrRawToDb, timeMsToRaw, timeRawToMs, type DelayUnit,
} from '@dsp-studio/protocol';
import { t } from '../i18n.tsx';

const MINUS = '−';
const comma = (s: string): string => s.replace('.', ',');

export function fmtNumber(v: number, digits = 1): string {
  const s = comma(Math.abs(v).toFixed(digits));
  return (v < 0 && Number(s.replace(',', '.')) !== 0 ? MINUS : '') + s;
}
export function fmtSigned(v: number, digits = 1): string {
  const s = comma(Math.abs(v).toFixed(digits));
  if (Number(s.replace(',', '.')) === 0) return s;
  return (v < 0 ? MINUS : '+') + s;
}
export const fmtDb = (db: number, digits = 1): string => (db <= -140 ? t('{0}∞ dB', MINUS) : `${fmtSigned(db, digits)} dB`);
export function fmtHz(hz: number): string {
  if (hz >= 1000) return `${comma((hz / 1000).toFixed(hz >= 10000 ? 1 : 2))} kHz`;
  return `${comma(hz.toFixed(hz < 100 ? 1 : 0))} Hz`;
}
export const fmtHzShort = (hz: number): string => (hz >= 1000 ? `${comma(String(Math.round(hz / 100) / 10))}k` : String(Math.round(hz)));
/** ISO 1/3 octave labels (GEQ bands, test-tone sines): "31,5", "1,25k" / "31,5 Hz", "1,25 kHz" */
export const fmtIso = (hz: number): string => (hz >= 1000 ? `${comma(String(hz / 1000))}k` : comma(String(hz)));
export const fmtIsoHz = (hz: number): string => (hz >= 1000 ? `${comma(String(hz / 1000))} kHz` : `${comma(String(hz))} Hz`);
export const fmtMs = (ms: number, digits = 0): string => `${comma(ms.toFixed(digits))} ms`;

/** Number in what people type: comma or point, unicode minus, optional k / m suffix. */
export function parseNumber(text: string): number | null {
  const t = text.trim().toLowerCase().replace(/−/g, '-').replace(/,/g, '.').replace(/\s+/g, '');
  const m = /^([+-]?\d*\.?\d+)(k|m)?/.exec(t);
  if (!m) return null;
  let v = Number(m[1]);
  if (!Number.isFinite(v)) return null;
  if (m[2] === 'k') v *= 1000;
  return v;
}
export function parseHz(text: string): number | null {
  const v = parseNumber(text);
  if (v === null) return null;
  return /khz/i.test(text) && !/k/i.test(text.replace(/khz/i, '')) && v < 100 ? v * 1000 : v;
}

// ------------------------------------------------------------------------------------- params
export interface Param {
  min: number;
  max: number;
  /** value restored by a double click / long press */
  def: number;
  /** keyboard step in raw units (PageUp/PageDown = 10 steps) */
  step?: number;
  fmt: (raw: number) => string;
  /** text typed by the user -> raw value (null = not understood) */
  parse: (text: string) => number | null;
  /** the editable form of the value (what the input shows when focused) */
  edit: (raw: number) => string;
}

const round = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Math.round(v)));
const num = (f: (v: number) => number, lo: number, hi: number) => (t: string): number | null => {
  const v = parseNumber(t);
  return v === null ? null : round(f(v), lo, hi);
};
const editNum = (v: number, d = 1): string => comma(v.toFixed(d));

export const P = {
  gain: { min: 0, max: 400, def: 280, fmt: (r) => fmtDb(gainRawToDb(r)), parse: num(gainDbToRaw, 0, 400), edit: (r) => editNum(gainRawToDb(r)) },
  mix: { min: 0, max: 280, def: 280, fmt: (r) => fmtDb(gainRawToDb(r)), parse: num(gainDbToRaw, 0, 280), edit: (r) => editNum(gainRawToDb(r)) },
  eqGain: { min: 0, max: 240, def: 120, step: 5, fmt: (r) => fmtDb(eqGainRawToDb(r)), parse: num(eqGainDbToRaw, 0, 240), edit: (r) => editNum(eqGainRawToDb(r)) },
  freq: {
    min: 0, max: 300, def: 170, fmt: (r) => fmtHz(freqRawToHz(r)),
    parse: (t) => { const v = parseHz(t); return v === null ? null : freqHzToRaw(v); }, edit: (r) => editNum(freqRawToHz(r), freqRawToHz(r) < 100 ? 1 : 0),
  },
  q: { min: 0, max: 100, def: 35, fmt: (r) => comma(qRawToValue(r).toFixed(2)), parse: (t) => { const v = parseNumber(t); return v === null || v <= 0 ? null : qValueToRaw(v); }, edit: (r) => editNum(qRawToValue(r), 2) },
  thr: { min: 0, max: 220, def: 220, step: 1, fmt: (r) => fmtDb(thrRawToDb(r)), parse: num(thrDbToRaw, 0, 220), edit: (r) => editNum(thrRawToDb(r)) },
  gateThr: { min: 0, max: 180, def: 0, fmt: (r) => fmtDb(thrRawToDb(r)), parse: num(thrDbToRaw, 0, 180), edit: (r) => editNum(thrRawToDb(r)) },
  attack: { min: 0, max: 998, def: 49, fmt: (r) => fmtMs(timeRawToMs(r)), parse: num(timeMsToRaw, 0, 998), edit: (r) => String(timeRawToMs(r)) },
  gateAttack: { min: 0, max: 998, def: 0, fmt: (r) => fmtMs(timeRawToMs(r)), parse: num(timeMsToRaw, 0, 998), edit: (r) => String(timeRawToMs(r)) },
  release: { min: 9, max: 2999, def: 499, step: 10, fmt: (r) => fmtMs(timeRawToMs(r)), parse: num(timeMsToRaw, 9, 2999), edit: (r) => String(timeRawToMs(r)) },
  gateRelease: { min: 9, max: 2999, def: 99, step: 10, fmt: (r) => fmtMs(timeRawToMs(r)), parse: num(timeMsToRaw, 9, 2999), edit: (r) => String(timeRawToMs(r)) },
  hold: { min: 9, max: 998, def: 99, step: 10, fmt: (r) => fmtMs(timeRawToMs(r)), parse: num(timeMsToRaw, 9, 998), edit: (r) => String(timeRawToMs(r)) },
  knee: { min: 0, max: 12, def: 0, fmt: (r) => `${r} dB`, parse: num((v) => v, 0, 12), edit: (r) => String(r) },
  ratio: {
    min: 0, max: RATIO_MAX, def: 0, fmt: (r) => (r >= RATIO_MAX ? t('Limite (∞:1)') : `${comma(RATIOS[r].toFixed(1))}:1`),
    parse: (t) => {
      if (/lim|inf|∞/i.test(t)) return RATIO_MAX;
      const v = parseNumber(t.split(':')[0]);
      if (v === null) return null;
      let best = 0;
      RATIOS.forEach((x, i) => { if (Math.abs(x - v) < Math.abs(RATIOS[best] - v)) best = i; });
      return best;
    },
    edit: (r) => (r >= RATIO_MAX ? t('Limite') : comma(RATIOS[r].toFixed(1))),
  },
} satisfies Record<string, Param>;

export const DELAY_UNIT_LABELS = ['ms', 'm', 'ft'] as const;
export function delayParam(unit: DelayUnit): Param {
  const label = DELAY_UNIT_LABELS[unit];
  return {
    min: 0, max: DELAY_RAW_MAX, def: 0, step: 10,
    fmt: (r) => `${comma(delayRawToUnit(r, unit).toFixed(unit === 0 ? 2 : 3))} ${label}`,
    parse: (t) => { const v = parseNumber(t); return v === null || v < 0 ? null : delayUnitToRaw(v, unit); },
    edit: (r) => comma(delayRawToUnit(r, unit).toFixed(3)),
  };
}

/** Colours of the channels (curves, chips): inputs cool, outputs warm. */
export const IN_COLORS = ['#38bdf8', '#34d399', '#a78bfa', '#22d3ee'];
export const OUT_COLORS = ['#fb923c', '#f472b6', '#facc15', '#f87171', '#c084fc', '#4ade80', '#fda4af', '#fdba74'];
export function channelColor(nin: number, ch: number): string {
  return ch < nin ? IN_COLORS[ch % IN_COLORS.length] : OUT_COLORS[(ch - nin) % OUT_COLORS.length];
}

export const presetLabel = (n: number): string => (n === 0 ? 'F00' : `U${String(n).padStart(2, '0')}`);

export const stateLabel = (s: string): string =>
  s === 'online' ? t('en ligne') : s === 'connecting' ? t('connexion…') : s === 'locked' ? t('verrouillé') : s === 'idle' ? t('non connecté') : t('hors ligne');
