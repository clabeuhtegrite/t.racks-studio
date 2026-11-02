// Automatic gain for DJ sets played on vinyl, and the level figures of the DJ screen.
//
// Records are cut at very different levels. The level of the mix reaching the DSP inputs is taken
// from the meters (4 readings a second); when the level of the record stays outside a tolerance
// zone around a target, the input gain is moved by small steps, like a sound engineer's hand on the
// fader: slowly up, faster down. A record only goes up when even its loud parts (its loudest 3 s
// blocks over the last tens of seconds: the drops, the choruses) are too quiet, so intros,
// transitions and quiet passages are left alone. After a sudden drop (a breakdown) nothing goes up
// until the music comes back, or for a couple of minutes when it does not (a quieter record). Nothing goes up while an input clips or an output
// limiter acts, and what the automatic gain added is taken back when that lasts. The DJ can pause it
// for a few minutes (scratching, a microphone, a live act).
//
// The firmware writes every setting change to its EEPROM at once (measured on firmware v1.04: one
// byte per gain step and input, no write when the value does not change), so the corrections are
// few: 0.5 dB steps, only outside the zone, with a budget of steps per hour; the steps are counted,
// for the night (in the history) and since the start.
//
// Whether the input meters read the signal before or after the input gain is not known for the
// real hardware yet. "unknown" is handled like "pre": if the meter actually reads after the gain,
// the correction only reaches half of what is needed. The other way round ("post" assumed on a
// meter that reads before the gain) the correction would run to its limit, so it is never
// assumed: `Leveler.checkMeter()` finds out with a short 6 dB dip.

import { clamp, gainDbToRaw, gainRawToDb } from './codecs.ts';
import { dynamicsActive, meterZones, type Meters } from './meters.ts';
import type { DeviceConfig } from './config.ts';
import { linkedChannels } from './links.ts';
import { MODELS } from './models.ts';
import type { DeviceSession } from './session.ts';
import type { Action } from './state.ts';

export type MeterPosition = 'unknown' | 'pre' | 'post';
export type LevelerSpeed = 'slow' | 'normal' | 'fast';

export interface LevelerSettings {
  /** automatic gain on (the levels are measured in any case, for the DJ screen) */
  enabled: boolean;
  /** inputs fed by the DJ mixer (0 = InA) */
  inputs: number[];
  /** wanted level of the mix after the input gain, dBFS (average of the meter readings) */
  target: number;
  /** half width of the zone around the target where nothing is corrected, dB */
  tolerance: number;
  /** the correction stays between -maxCut and +maxBoost around the reference gain, dB */
  maxBoost: number;
  maxCut: number;
  speed: LevelerSpeed;
  /** where the input meters read the signal */
  meter: MeterPosition;
  /** most gain steps per hour (each one is written to the DSP's memory) */
  budget: number;
}

export const LEVELER_DEFAULTS: Readonly<LevelerSettings> = Object.freeze({
  enabled: false, inputs: [0, 1], target: -14, tolerance: 2, maxBoost: 6, maxCut: 6, speed: 'normal', meter: 'unknown', budget: 120,
});

export const LEVELER_LIMITS = {
  target: [-40, 0], tolerance: [1, 6], maxBoost: [0, 12], maxCut: [0, 12], budget: [20, 600],
} as const;

interface SpeedSpec {
  /** window of the level that decides to lower, and when to stop */
  mid: number;
  /** window of the average a sudden drop is measured against */
  long: number;
  /** window of the loud parts of the record, that decide to raise */
  loud: number;
  /** time between two steps up / down */
  up: number;
  down: number;
  /** after a sudden drop (a breakdown), no raising until the music comes back, at most this long */
  breakMax: number;
}
export const LEVELER_SPEEDS: Readonly<Record<LevelerSpeed, SpeedSpec>> = {
  slow: { mid: 20_000, long: 60_000, loud: 60_000, up: 8_000, down: 3_000, breakMax: 180_000 },
  normal: { mid: 10_000, long: 30_000, loud: 40_000, up: 4_000, down: 1_500, breakMax: 120_000 },
  fast: { mid: 5_000, long: 15_000, loud: 20_000, up: 2_000, down: 1_000, breakMax: 90_000 },
};

/** size of one correction step, dB */
export const LEVELER_STEP_DB = 0.5;
/** pause asked by the DJ, minutes: the button's, and the longest */
export const LEVELER_PAUSE_MIN = 5;
const PAUSE_MAX_MIN = 30;
/** one history point every 10 s, kept 12 hours: a whole night */
export const LEVELER_HISTORY_EVERY_MS = 10_000;
export const LEVELER_HISTORY_MS = 12 * 3_600_000;
const HISTORY_MAX = LEVELER_HISTORY_MS / LEVELER_HISTORY_EVERY_MS;
/** this long without music separates two nights */
export const NIGHT_GAP_MS = 3 * 3_600_000;
/** window of the level shown to the DJ */
const SHORT_MS = 3_000;
/** below this level (after the gain) the input counts as silent */
const SILENCE_DB = -50;
/** readings this far below the window's average are left out (fades, quiet passages) */
const REL_GATE_DB = 10;
/** share of non-silent readings a window needs */
const MIN_FILL = 0.5;
/** the loud parts of a record: this share of its loudest 3 s blocks */
const BLOCK_MS = 3_000;
const LOUD_SHARE = 0.4;
/** a level this far below the average is a breakdown, not a quieter record (yet)... */
const BREAK_DB = 6;
/** ...and the breakdown is over when the level comes back this close to the level before it */
const BACK_DB = 3;
/** clipping or limiting during this share of the last 10 s: the correction added is taken back */
const PROTECT_MS = 10_000;
const PROTECT_SHARE = 0.5;
/** pause after someone moved the gain by hand */
const MANUAL_HOLD_MS = 20_000;
const HOUR_MS = 3_600_000;
const GAIN_MAX_DB = 12;
const GAIN_MIN_DB = -60;
/** comparisons of levels ignore rounding noise */
const EPS = 0.05;
/** meter check: dip, phases */
const CHECK_DIP_DB = 6;
const CHECK_PHASE_MS = 2_000;
const CHECK_SETTLE_MS = 500;

export type LevelerStatus =
  | 'off' // automatic gain off (the levels are still measured)
  | 'offline' // device not connected, or locked
  | 'waiting' // gathering readings (start, preset, settings, end of a pause)
  | 'ok' // in the zone
  | 'raising'
  | 'lowering'
  | 'limit' // the correction is at its limit and the level is still out of the zone
  | 'silence' // no music
  | 'break' // sudden drop (breakdown): no raising until the music comes back
  | 'protect' // an input clips or an output limiter acts: no raising
  | 'manual' // someone moved the gain: short pause, then the new gain is the reference
  | 'paused' // the DJ asked for a pause
  | 'tone' // test generator on
  | 'muted' // the chosen inputs are muted
  | 'budget' // too many steps in the last hour
  | 'checking'; // meter check running

export interface MeterCheck { result: 'pre' | 'post' | 'unclear'; drop: number; at: number }

/** The automatic gain every 10 s, for the history and the summary of the night. */
export interface LevelerPoint {
  t: number;
  /** level after the gain over the last 10 s, dBFS (null: silence) */
  level: number | null;
  /** dB added by the automatic gain */
  correction: number;
  /** the music against the zone, as the automatic gain judges it: -1 too quiet (even its loud parts), 0 fine,
   *  1 too loud; null: no music, or a breakdown */
  zone: -1 | 0 | 1 | null;
  /** gain steps written to the DSP's memory since the previous point */
  steps: number;
  /** an input clipped / an output limiter acted since the previous point */
  clip: boolean;
  limit: boolean;
}

/** Gain steps the automatic gain has written to the DSP's memory, since `since` (null: none yet). */
export interface LevelerTotals { steps: number; since: number | null }

export interface LevelerState {
  settings: LevelerSettings;
  status: LevelerStatus;
  /** level of the mix after the input gain over the last 3 s, dBFS (null: silence, no reading) */
  level: number | null;
  /** the same over the decision window */
  average: number | null;
  /** level of the loud parts of the record (its loudest 3 s blocks): a record goes up only when they are too quiet */
  loud: number | null;
  /** dB added to the reference gain by the automatic gain */
  correction: number;
  /** gain steps in the last hour (the budget counts them) */
  writes: number;
  /** every step written so far */
  totals: LevelerTotals;
  /** a chosen input reached the red zone of its meter (clipping) in the last 3 s */
  clip: boolean;
  /** an output limiter acted in the last 3 s */
  limiting: boolean;
  /** the level dropped suddenly and has not come back yet (a breakdown) */
  breakdown: boolean;
  /** seconds left of a pause asked by the DJ (0: none) */
  pause: number;
  check: MeterCheck | null;
  at: number;
}

const round1 = (v: number): number => Math.round(v * 10) / 10;
const toNumber = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
/** `error` is a full sentence, listed for translation in packages/i18n/scripts/keys.ts */
function step(v: unknown, [lo, hi]: readonly [number, number], q: number, error: string): number {
  const n = toNumber(v);
  if (!Number.isFinite(n)) throw new Error(error);
  return clamp(Math.round(n / q) * q, lo, hi);
}

/** Copy of the settings (the arrays are not shared). */
export const cloneLevelerSettings = (s: Readonly<LevelerSettings>): LevelerSettings => ({ ...s, inputs: [...s.inputs] });

/** Merges settings received from a screen (all fields optional) into `prev`, checking each one. */
export function mergeLevelerSettings(prev: Readonly<LevelerSettings>, patch: unknown, inputCount = 4): LevelerSettings {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('réglages invalides');
  const p = patch as Record<string, unknown>;
  const s = cloneLevelerSettings(prev);
  if ('enabled' in p) s.enabled = p.enabled === true;
  if ('inputs' in p) {
    if (!Array.isArray(p.inputs)) throw new Error('entrées invalides');
    const list = [...new Set(p.inputs.map(toNumber))].filter((i) => Number.isInteger(i) && i >= 0 && i < inputCount).sort((a, b) => a - b);
    if (!list.length) throw new Error('choisissez au moins une entrée');
    s.inputs = list;
  }
  if ('target' in p) s.target = step(p.target, LEVELER_LIMITS.target, 0.5, 'niveau cible invalide');
  if ('tolerance' in p) s.tolerance = step(p.tolerance, LEVELER_LIMITS.tolerance, 0.5, 'tolérance invalide');
  if ('maxBoost' in p) s.maxBoost = step(p.maxBoost, LEVELER_LIMITS.maxBoost, 0.5, 'correction maximale invalide');
  if ('maxCut' in p) s.maxCut = step(p.maxCut, LEVELER_LIMITS.maxCut, 0.5, 'correction maximale invalide');
  if ('budget' in p) s.budget = step(p.budget, LEVELER_LIMITS.budget, 1, 'nombre de corrections invalide');
  if ('speed' in p) {
    if (p.speed !== 'slow' && p.speed !== 'normal' && p.speed !== 'fast') throw new Error('vitesse invalide');
    s.speed = p.speed;
  }
  if ('meter' in p) {
    if (p.meter !== 'unknown' && p.meter !== 'pre' && p.meter !== 'post') throw new Error('position du vumètre invalide');
    s.meter = p.meter;
  }
  return s;
}

/** Settings read back from storage: anything invalid falls back to the defaults. */
export function restoreLevelerSettings(v: unknown): LevelerSettings {
  let s = cloneLevelerSettings(LEVELER_DEFAULTS);
  if (!v || typeof v !== 'object') return s;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    try { s = mergeLevelerSettings(s, { [k]: val }); } catch { /* keep the default */ }
  }
  return s;
}

/** Totals read back from storage (null when damaged). */
export function restoreLevelerTotals(v: unknown): LevelerTotals | null {
  if (!v || typeof v !== 'object') return null;
  const { steps, since } = v as Record<string, unknown>;
  if (!Number.isSafeInteger(steps) || (steps as number) < 0) return null;
  if (since !== null && !(typeof since === 'number' && Number.isFinite(since))) return null;
  return { steps: steps as number, since: since as number | null };
}

/** A history point read back from storage (null when damaged). */
export function restoreLevelerPoint(v: unknown): LevelerPoint | null {
  if (!v || typeof v !== 'object') return null;
  const p = v as Record<string, unknown>;
  const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
  if (!num(p.t) || !num(p.correction) || !(p.level === null || num(p.level))) return null;
  const zone = p.zone === -1 || p.zone === 0 || p.zone === 1 ? p.zone : null;
  const steps = Number.isSafeInteger(p.steps) && (p.steps as number) >= 0 ? (p.steps as number) : 0;
  return { t: p.t, level: p.level, correction: p.correction, zone, steps, clip: p.clip === true, limit: p.limit === true };
}

interface Sample { t: number; l0: number | null; clip: boolean; limit: boolean }

/** Is the limiter of an output acting (not its compressor), as the editors show it? */
function limiting(status: number, cfg: DeviceConfig): boolean {
  const inputs = MODELS[cfg.model].inputs;
  return cfg.outputs.some((_, j) => dynamicsActive(status, cfg, inputs + j).limit);
}

const powerMean = (xs: readonly number[]): number => 10 * Math.log10(xs.reduce((a, x) => a + 10 ** (x / 10), 0) / xs.length);

/**
 * The decisions, without any I/O: fed with meter readings and the device configuration, it says
 * when to move the gain and by how much. Times are in ms (any clock).
 */
export class LevelerCore {
  settings: LevelerSettings;
  /** reference gains (raw) of every input; the automatic gain adds `correction` to them */
  base: number[] | null;
  /** dB added to the reference gains */
  correction = 0;
  status: LevelerStatus = 'off';
  /** set when the reference gains change (the owner remembers them at once) */
  baseChanged = false;
  /** set when steps were written (the owner remembers the totals now and then) */
  totalsChanged = false;
  /** 'checking' or 'offline': no readings kept, no decisions */
  paused: LevelerStatus | null = null;
  lastCheck: MeterCheck | null = null;
  readonly history: LevelerPoint[] = [];
  readonly totals: LevelerTotals;
  private samples: Sample[] = [];
  private expected: number[] | null = null;
  private holdUntil = 0;
  private holdStatus: LevelerStatus = 'waiting';
  private mode: 'idle' | 'raising' | 'lowering' = 'idle';
  private lastStep = -Infinity;
  private writeTimes: number[] = [];
  private lastPoint = -Infinity;
  /** what the decisions use, without the correction (see measure()) */
  private short: number | null = null;
  private mid: number | null = null;
  private loudLevel: number | null = null;
  /** level before a sudden drop while the music has not come back, and until when to wait for it */
  private breakRef: number | null = null;
  private breakUntil = 0;
  /** pause asked by the DJ: nothing moves until then, and the readings before do not count */
  private pausedUntil = 0;
  /** since the previous history point */
  private pointSteps = 0;
  private pointClip = false;
  private pointLimit = false;

  constructor(settings: Readonly<LevelerSettings> = LEVELER_DEFAULTS, base: number[] | null = null, totals: LevelerTotals | null = null) {
    this.settings = cloneLevelerSettings(settings);
    this.base = settings.enabled && base ? base.slice() : null;
    this.totals = totals ? { ...totals } : { steps: 0, since: null };
  }

  /** Applies new settings. Turning on, or changing the inputs or the meter position, starts again
   *  from the current gains; turning off leaves the gains where they are. */
  configure(next: LevelerSettings, now: number): void {
    const prev = this.settings;
    this.settings = cloneLevelerSettings(next);
    const measure = next.meter !== prev.meter || next.inputs.join() !== prev.inputs.join();
    if (!measure && next.enabled === prev.enabled) return;
    if (measure) this.samples = [];
    // turned off: the correction stays in the gains, so the readings move up by it
    else if (!next.enabled) for (const x of this.samples) if (x.l0 !== null) x.l0 += this.correction;
    this.base = null; this.expected = null; this.correction = 0; this.mode = 'idle'; this.baseChanged = true;
    this.holdUntil = now; this.breakRef = null;
  }

  private channels(cfg: DeviceConfig): number[] { return this.settings.inputs.filter((i) => i < cfg.inputs.length); }

  /**
   * One meter reading (dBFS per wire channel, inputs first) with the configuration at that time;
   * `status` is the status word of the meters (see meters.ts), for the output limiters.
   */
  observe(now: number, db: readonly number[], cfg: DeviceConfig, status = 0): void {
    if (this.paused) return;
    const s = this.settings;
    const chans = this.channels(cfg);
    if (s.enabled) this.track(now, cfg, chans);
    // level of the mix without the automatic correction ("l0")
    const levels: number[] = [];
    let clip = false;
    for (const i of chans) {
      const c = cfg.inputs[i];
      const m = db[i] ?? -140;
      // the red segment of the editors' bars (and of the app's meters): the input is clipping
      if (m > meterZones(cfg.model, i).red) clip = true;
      if (c.mute) continue;
      const g = gainRawToDb(c.gain);
      const pre = s.meter === 'post' ? m - g : m;
      const ref = s.enabled && this.base ? gainRawToDb(this.base[i]) : g;
      levels.push(pre + ref);
    }
    let l0: number | null = levels.length ? powerMean(levels) : null;
    if (l0 !== null && l0 + this.correction < SILENCE_DB) l0 = null;
    const limit = status !== 0 && limiting(status, cfg);
    this.samples.push({ t: now, l0, clip, limit });
    if (clip) this.pointClip = true;
    if (limit) this.pointLimit = true;
    const sp = LEVELER_SPEEDS[s.speed];
    const keep = now - Math.max(sp.long, sp.loud, SHORT_MS, PROTECT_MS) - 1000;
    let k = 0;
    while (k < this.samples.length && this.samples[k].t < keep) k++;
    if (k) this.samples.splice(0, k);
    this.measure(now, sp);
    if (now - this.lastPoint >= LEVELER_HISTORY_EVERY_MS) this.addPoint(now, sp);
  }

  /** Levels the decisions use (the readings of a pause left out), and the breakdowns. */
  private measure(now: number, sp: SpeedSpec): void {
    const from = this.pausedUntil;
    this.short = this.estimate(now, SHORT_MS, 0.8, from);
    const mid = this.estimate(now, sp.mid, 0.8, from);
    const long = this.estimate(now, sp.long, 0.8, from);
    this.mid = mid;
    this.loudLevel = this.loud(now, sp.loud, 0.8, from);
    if (this.breakRef === null) {
      if (mid !== null && long !== null && mid < long - BREAK_DB) { this.breakRef = long; this.breakUntil = now + sp.breakMax; }
    } else if ((mid !== null && mid >= this.breakRef - BACK_DB) || now >= this.breakUntil) this.breakRef = null;
  }

  private addPoint(now: number, sp: SpeedSpec): void {
    this.lastPoint = now;
    const c = this.correction;
    const { target, tolerance } = this.settings;
    const avg = this.estimate(now, sp.mid, 0.3);
    const loud = this.loud(now, sp.loud, 0.3) ?? avg;
    let zone: LevelerPoint['zone'] = null;
    if (avg !== null && loud !== null && this.breakRef === null) {
      zone = avg + c > target + tolerance ? 1 : avg + c < target - tolerance && loud + c < target - tolerance ? -1 : 0;
    }
    this.history.push({
      t: now, level: avg === null ? null : round1(avg + c), correction: c, zone,
      steps: this.pointSteps, clip: this.pointClip, limit: this.pointLimit,
    });
    this.pointSteps = 0;
    this.pointClip = this.pointLimit = false;
    let k = Math.max(0, this.history.length - HISTORY_MAX);
    while (k < this.history.length && this.history[k].t <= now - LEVELER_HISTORY_MS) k++;
    if (k) this.history.splice(0, k);
  }

  /** History read back from storage (after a restart): the last 12 hours, in time order. */
  restoreHistory(points: readonly LevelerPoint[], now: number): void {
    const kept = points.filter((p) => p.t > now - LEVELER_HISTORY_MS && p.t <= now).sort((a, b) => a.t - b.t);
    this.history.splice(0, this.history.length, ...kept.slice(-HISTORY_MAX));
  }

  /** Follows the gains: reference at the start, and a change made by someone else becomes the new reference. */
  private track(now: number, cfg: DeviceConfig, chans: number[]): void {
    const gains = cfg.inputs.map((c) => c.gain);
    const s = this.settings;
    if (!this.base || this.base.length !== gains.length) { this.rebase(now, gains, 'waiting', 0, false); return; }
    if (!this.expected) {
      // reference remembered from an earlier run: keep the correction if the gains still match it
      const diffs = chans.map((i) => gainRawToDb(gains[i]) - gainRawToDb(this.base![i]));
      const c = diffs[0] ?? 0;
      if (diffs.every((d) => Math.abs(d - c) < 0.05) && c <= s.maxBoost + 0.05 && c >= -s.maxCut - 0.05) {
        this.correction = round1(c);
        this.expected = gains;
      } else this.rebase(now, gains, 'waiting', 0, false);
      return;
    }
    if (chans.some((i) => gains[i] !== this.expected![i])) this.rebase(now, gains, 'manual', MANUAL_HOLD_MS, true);
  }

  private rebase(now: number, gains: number[], why: LevelerStatus, holdMs: number, clear: boolean): void {
    this.base = gains.slice();
    this.expected = gains.slice();
    this.correction = 0;
    this.mode = 'idle';
    this.baseChanged = true;
    if (clear) this.samples = [];
    this.holdUntil = now + holdMs;
    this.holdStatus = why;
    this.breakRef = null;
  }

  /** Readings of a window, from `from` at the earliest; null when the window is not covered yet. */
  private window(now: number, windowMs: number, minCover: number, from: number): Sample[] | null {
    const start = Math.max(now - windowMs, from);
    let i = this.samples.length;
    while (i > 0 && this.samples[i - 1].t > start) i--;
    const all = this.samples.slice(i);
    return all.length < 4 || now - all[0].t < windowMs * minCover ? null : all;
  }

  /** Level without correction over a window (power average, quiet passages left out); null when
   *  the window is not covered yet or mostly silent. */
  estimate(now: number, windowMs: number, minCover = 0.8, from = 0): number | null {
    const all = this.window(now, windowMs, minCover, from);
    if (!all) return null;
    const valid: number[] = [];
    for (const x of all) if (x.l0 !== null) valid.push(x.l0);
    if (valid.length < all.length * MIN_FILL) return null;
    const m = powerMean(valid);
    return powerMean(valid.filter((v) => v >= m - REL_GATE_DB));
  }

  /** Level of the loud parts without correction: the loudest 3 s blocks of a window (the drops,
   *  the choruses), so intros, breakdowns and transitions do not pull it down. */
  loud(now: number, windowMs: number, minCover = 0.8, from = 0): number | null {
    const all = this.window(now, windowMs, minCover, from);
    if (!all) return null;
    const blocks: number[] = [];
    let first = all[0].t, vals: number[] = [], n = 0;
    const close = (): void => { if (n >= 4 && vals.length >= n * MIN_FILL) blocks.push(powerMean(vals)); vals = []; n = 0; };
    for (const x of all) {
      if (x.t - first >= BLOCK_MS) { close(); first = x.t; }
      n++;
      if (x.l0 !== null) vals.push(x.l0);
    }
    close();
    if (!blocks.length || blocks.length < ((now - all[0].t) / BLOCK_MS) * MIN_FILL) return null;
    blocks.sort((a, b) => b - a);
    return powerMean(blocks.slice(0, Math.max(1, Math.round(blocks.length * LOUD_SHARE))));
  }

  private recent(now: number, f: (x: Sample) => boolean): boolean {
    for (let i = this.samples.length - 1; i >= 0 && this.samples[i].t > now - SHORT_MS; i--) if (f(this.samples[i])) return true;
    return false;
  }

  /** Share of the readings of the last `ms` for which `f` holds. */
  private share(now: number, ms: number, f: (x: Sample) => boolean): number {
    let all = 0, hit = 0;
    for (let i = this.samples.length - 1; i >= 0 && this.samples[i].t > now - ms; i--) { all++; if (f(this.samples[i])) hit++; }
    return all ? hit / all : 0;
  }

  private silent(now: number): boolean {
    let all = 0, quiet = 0;
    for (let i = this.samples.length - 1; i >= 0 && this.samples[i].t > now - SHORT_MS; i--) { all++; if (this.samples[i].l0 === null) quiet++; }
    return all >= 4 && quiet > all / 2;
  }

  /** Bounds of the correction for the current reference gains. */
  private bounds(chans: number[]): [number, number] {
    const s = this.settings;
    const bases = chans.map((i) => gainRawToDb(this.base![i]));
    const hi = Math.min(s.maxBoost, GAIN_MAX_DB - Math.max(...bases));
    const lo = Math.max(-s.maxCut, GAIN_MIN_DB - Math.min(...bases));
    return [lo, Math.max(lo, hi)];
  }

  writesInLastHour(now: number): number {
    let k = 0;
    while (k < this.writeTimes.length && this.writeTimes[k] <= now - HOUR_MS) k++;
    if (k) this.writeTimes.splice(0, k);
    return this.writeTimes.length;
  }

  /** The correction to apply now (one step), or null. Updates `status`. */
  decide(now: number, cfg: DeviceConfig): number | null {
    const s = this.settings;
    if (this.paused) { this.status = this.paused; return null; }
    if (!s.enabled) { this.status = 'off'; return null; }
    const chans = this.channels(cfg);
    if (!this.base || !this.expected || !chans.length) { this.status = 'waiting'; return null; }
    if (cfg.toneSource !== 0) { this.status = 'tone'; this.mode = 'idle'; return null; }
    if (chans.every((i) => cfg.inputs[i].mute)) { this.status = 'muted'; this.mode = 'idle'; return null; }
    if (now < this.holdUntil) { this.status = this.holdStatus; return null; }
    if (now < this.pausedUntil) { this.status = 'paused'; this.mode = 'idle'; return null; }
    const sp = LEVELER_SPEEDS[s.speed];
    const c = this.correction;
    const [lo, hi] = this.bounds(chans);
    const go = (mode: 'raising' | 'lowering', next: number, every: number): number | null => {
      this.status = mode;
      if (now - this.lastStep < every) return null;
      if (this.writesInLastHour(now) >= s.budget) { this.status = 'budget'; return null; }
      return round1(next);
    };
    // limits lowered in the settings: come back inside them first
    if (c > hi + 0.01) return go('lowering', Math.max(c - LEVELER_STEP_DB, hi), sp.down);
    if (c < lo - 0.01) return go('raising', Math.min(c + LEVELER_STEP_DB, lo), sp.up);
    // an input clips or an output limiter acts: never up, and what was added goes if it lasts
    const strained = (x: Sample): boolean => x.clip || x.limit;
    const guard = this.recent(now, strained);
    if (c > 0.01 && this.share(now, PROTECT_MS, strained) >= PROTECT_SHARE) {
      this.mode = 'idle';
      return go('lowering', Math.max(c - LEVELER_STEP_DB, 0), sp.down);
    }
    if (this.silent(now)) { this.status = 'silence'; this.mode = 'idle'; return null; }
    if (this.mid === null) { this.status = 'waiting'; return null; }
    const T = s.target, tol = s.tolerance;
    const aMid = this.mid + c;
    const aShort = this.short === null ? null : this.short + c;
    const aLoud = this.loudLevel === null ? null : this.loudLevel + c;
    const held = this.breakRef !== null;
    // hysteresis: start outside the zone, stop half way back in
    if (this.mode === 'lowering' && aMid <= T + tol / 2 + EPS) this.mode = 'idle';
    if (this.mode === 'raising' && (held || guard || aMid >= T - tol / 2 - EPS || (aLoud !== null && aLoud >= T - tol / 2 - EPS))) this.mode = 'idle';
    // a start needs the last seconds on the same side too (not the tail of a drop or of a breakdown)
    if (this.mode === 'idle' && aShort !== null) {
      if (aMid > T + tol + EPS && aShort > T + tol + EPS) this.mode = 'lowering';
      else if (aMid < T - tol - EPS && aShort < T - tol - EPS) {
        if (aLoud === null) { this.status = 'waiting'; return null; }
        if (aLoud < T - tol - EPS) {
          if (held) { this.status = 'break'; return null; }
          if (guard) { this.status = 'protect'; return null; }
          this.mode = 'raising';
        }
      }
    }
    if (this.mode === 'idle') { this.status = 'ok'; return null; }
    if (this.mode === 'lowering') {
      if (c <= lo + 0.01) { this.status = 'limit'; return null; }
      return go('lowering', Math.max(c - LEVELER_STEP_DB, lo), sp.down);
    }
    if (c >= hi - 0.01) { this.status = 'limit'; return null; }
    return go('raising', Math.min(c + LEVELER_STEP_DB, hi), sp.up);
  }

  /** Gain edits that give `correction` (one per link group). */
  actionsFor(correction: number, cfg: DeviceConfig): Action[] {
    const out: Action[] = [];
    if (!this.base) return out;
    const done = new Set<number>();
    for (const i of this.channels(cfg)) {
      if (done.has(i)) continue;
      for (const k of linkedChannels(cfg, i)) done.add(k);
      const raw = gainDbToRaw(gainRawToDb(this.base[i]) + correction);
      if (raw !== cfg.inputs[i].gain) out.push({ t: 'gain', ch: i, raw });
    }
    return out;
  }

  /** The edits of `actionsFor` were applied to `cfg`. */
  commit(now: number, correction: number, cfg: DeviceConfig, edits: number): void {
    this.correction = correction;
    this.expected = cfg.inputs.map((c) => c.gain);
    this.lastStep = now;
    if (edits > 0) this.countStep(now);
  }

  /**
   * One step written to the DSP's memory. Each input's gain has its own place there, and a step
   * writes each place once, whether the inputs are linked or not: the budget and the totals count
   * steps, which is what wears the memory.
   */
  countStep(now: number): void {
    this.writeTimes.push(now);
    this.pointSteps++;
    this.totals.steps++;
    if (this.totals.since === null) this.totals.since = now;
    this.totalsChanged = true;
  }

  /** The gains were changed on purpose (meter check): they are the expected ones again. */
  resync(cfg: DeviceConfig, now: number): void {
    if (this.expected) this.expected = cfg.inputs.map((c) => c.gain);
    this.samples = [];
    this.holdUntil = now;
    this.breakRef = null;
  }

  /** Pause asked by the DJ (0: resume now). Afterwards it listens again before correcting. */
  pause(ms: number, now: number): void {
    this.pausedUntil = ms > 0 ? now + ms : Math.min(this.pausedUntil, now);
    this.mode = 'idle';
  }

  state(now: number): Omit<LevelerState, 'check'> {
    const sp = LEVELER_SPEEDS[this.settings.speed];
    const c = this.correction;
    const short = this.estimate(now, SHORT_MS, 0.3);
    const mid = this.estimate(now, sp.mid, 0.3);
    const long = this.estimate(now, sp.long, 0.5) ?? mid;
    const loud = this.loud(now, sp.loud, 0.3) ?? long;
    return {
      settings: cloneLevelerSettings(this.settings),
      status: this.status,
      level: short === null ? null : round1(short + c),
      average: long === null ? null : round1(long + c),
      loud: loud === null ? null : round1(loud + c),
      correction: c,
      writes: this.writesInLastHour(now),
      totals: { ...this.totals },
      clip: this.recent(now, (x) => x.clip),
      limiting: this.recent(now, (x) => x.limit),
      breakdown: this.breakRef !== null,
      pause: this.pausedUntil > now ? Math.ceil((this.pausedUntil - now) / 1000) : 0,
      at: now,
    };
  }
}

// ------------------------------------------------------------------------------------- night
/** What happened during a night, from its history points (each one stands for 10 s). */
export interface NightSummary {
  /** first and last point */
  from: number;
  to: number;
  /** ms with music, and how the records stood against the zone (breakdowns are not judged) */
  music: number;
  inZone: number;
  low: number;
  high: number;
  /** gain steps written to the DSP's memory */
  steps: number;
  /** range of the correction */
  minCorrection: number;
  maxCorrection: number;
  /** ms with an input clipping, with an output limiter acting */
  clip: number;
  limit: number;
}

/** Points of the latest night: after the last stretch of 3 hours without music, and without the
 *  silence before its first record (nor after its last one, once it is over). */
export function currentNight(points: readonly LevelerPoint[]): LevelerPoint[] {
  let start = 0;
  let last: number | null = null; // latest point with music
  let next: number | null = null; // the point with music after the one being looked at
  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i].level === null) continue;
    if (next !== null && next - points[i].t >= NIGHT_GAP_MS) { start = i + 1; break; }
    next = points[i].t;
    last ??= next;
  }
  while (start < points.length && points[start].level === null) start++;
  let end = points.length;
  if (last !== null && points[end - 1].t - last >= NIGHT_GAP_MS) {
    // the night is over: leave out the silence after it
    while (end > start && points[end - 1].level === null) end--;
  }
  return points.slice(start, end);
}

export function summarizeNight(points: readonly LevelerPoint[]): NightSummary | null {
  if (!points.length) return null;
  const d = LEVELER_HISTORY_EVERY_MS;
  const s: NightSummary = {
    from: points[0].t, to: points[points.length - 1].t, music: 0, inZone: 0, low: 0, high: 0,
    steps: 0, minCorrection: 0, maxCorrection: 0, clip: 0, limit: 0,
  };
  for (const p of points) {
    s.steps += p.steps;
    s.minCorrection = Math.min(s.minCorrection, p.correction);
    s.maxCorrection = Math.max(s.maxCorrection, p.correction);
    if (p.clip) s.clip += d;
    if (p.limit) s.limit += d;
    if (p.level === null) continue;
    s.music += d;
    if (p.zone === 0) s.inZone += d;
    else if (p.zone === -1) s.low += d;
    else if (p.zone === 1) s.high += d;
  }
  return s;
}

// ------------------------------------------------------------------------------------- device
interface CheckRun {
  phase: 'before' | 'during' | 'after';
  until: number;
  skipUntil: number;
  saved: number[];
  acc: { before: number[]; during: number[]; after: number[] };
  resolve: (r: MeterCheck) => void;
  reject: (e: Error) => void;
}

export interface LevelerOptions {
  settings?: Readonly<LevelerSettings>;
  /** reference gains remembered from an earlier run */
  base?: number[] | null;
  /** steps written so far, remembered from an earlier run */
  totals?: LevelerTotals | null;
  /** history remembered from an earlier run */
  history?: readonly LevelerPoint[];
  /** called when the settings, the reference gains or the totals change, to remember them */
  save?: (settings: LevelerSettings, base: number[] | null, totals: LevelerTotals) => void;
  now?: () => number;
}

/** the totals are remembered at most once a minute (the reference gains and settings at once) */
const TOTALS_SAVE_MS = 60_000;

/**
 * The automatic gain of one device: follows its session (meters, configuration) and sends the gain
 * edits through it, so every screen sees them like any other edit.
 */
export class Leveler {
  readonly core: LevelerCore;
  private session: DeviceSession | null = null;
  private offs: (() => void)[] = [];
  private busy = false;
  private run: CheckRun | null = null;
  private listeners = new Set<(s: LevelerState) => void>();
  private lastEmit = -Infinity;
  private lastStatus = '';
  private lastSave = -Infinity;
  private readonly now: () => number;
  private readonly saveFn?: LevelerOptions['save'];

  constructor(o: LevelerOptions = {}) {
    this.core = new LevelerCore(o.settings ?? LEVELER_DEFAULTS, o.base ?? null, o.totals ?? null);
    this.core.paused = 'offline';
    this.core.status = 'offline';
    this.now = o.now ?? (() => Date.now());
    this.saveFn = o.save;
    if (o.history?.length) this.core.restoreHistory(o.history, this.now());
  }

  get settings(): LevelerSettings { return cloneLevelerSettings(this.core.settings); }
  get attached(): DeviceSession | null { return this.session; }

  onState(f: (s: LevelerState) => void): () => void { this.listeners.add(f); return () => { this.listeners.delete(f); }; }

  attach(session: DeviceSession): void {
    if (this.session === session) return;
    this.detach();
    this.session = session;
    this.core.paused = null;
    this.offs.push(
      session.on('meters', (m) => this.onMeters(m)),
      session.on('status', (st) => { if (st === 'closed' && this.session === session) this.detach(); }),
    );
    this.emit(this.now(), true);
  }

  detach(): void {
    for (const off of this.offs) off();
    this.offs = [];
    this.session = null;
    this.busy = false;
    if (this.run) { const r = this.run; this.run = null; r.reject(new Error('liaison perdue')); }
    this.core.paused = 'offline';
    this.core.status = 'offline';
    this.flush();
    this.emit(this.now(), true);
  }

  state(): LevelerState { return { ...this.core.state(this.now()), check: this.core.lastCheck }; }

  /** History points (those after `since` only, when given). */
  history(since?: number): LevelerPoint[] {
    const h = this.core.history;
    if (typeof since !== 'number' || !Number.isFinite(since)) return h.slice();
    let i = h.length;
    while (i > 0 && h[i - 1].t > since) i--;
    return h.slice(i);
  }

  /** Changes settings (all fields optional, checked). */
  update(patch: unknown): LevelerState {
    const cfg = this.session?.config;
    const next = mergeLevelerSettings(this.core.settings, patch, cfg?.inputs.length ?? 4);
    this.core.configure(next, this.now());
    this.persist();
    const st = this.state();
    this.emit(this.now(), true);
    return st;
  }

  enable(on: boolean): LevelerState { return this.update({ enabled: on }); }

  /** Pause asked by the DJ, in minutes (0: resume now). */
  pause(minutes: unknown): LevelerState {
    const m = toNumber(minutes);
    if (!Number.isFinite(m) || m < 0 || m > PAUSE_MAX_MIN) throw new Error('durée de pause invalide');
    if (m > 0 && !this.core.settings.enabled) throw new Error('le gain automatique est désactivé');
    this.core.pause(Math.round(m * 60_000), this.now());
    const st = this.state();
    this.emit(this.now(), true);
    return st;
  }

  /** The level measured now becomes the target. */
  takeTarget(): LevelerState {
    const st = this.state();
    const lv = st.average ?? st.level;
    if (lv === null) throw new Error('aucune musique mesurée sur les entrées choisies');
    return this.update({ target: lv });
  }

  /**
   * Finds out whether the input meters read before or after the input gain: the gain of the chosen
   * inputs goes 6 dB down for 2 s while music plays, and the meters must follow if they read after it.
   */
  checkMeter(): Promise<MeterCheck> {
    const s = this.session;
    const cfg = s?.config;
    if (!s || !cfg || s.snap.status !== 'ready') return Promise.reject(new Error("l'appareil n'est pas connecté"));
    if (this.run) return Promise.reject(new Error('vérification déjà en cours'));
    if (this.core.state(this.now()).level === null) return Promise.reject(new Error('aucune musique mesurée sur les entrées choisies'));
    const now = this.now();
    return new Promise<MeterCheck>((resolve, reject) => {
      this.run = {
        phase: 'before', until: now + CHECK_PHASE_MS, skipUntil: now, saved: cfg.inputs.map((c) => c.gain),
        acc: { before: [], during: [], after: [] }, resolve, reject,
      };
      this.core.paused = 'checking';
      this.core.status = 'checking';
      this.emit(now, true);
    });
  }

  private onMeters(m: Meters): void {
    const s = this.session;
    const cfg = s?.config;
    if (!s || !cfg || s.snap.status !== 'ready') return;
    const now = this.now();
    this.core.observe(now, m.db, cfg, m.status);
    if (this.run) this.stepCheck(now, m.db, cfg);
    else if (!this.busy) {
      const next = this.core.decide(now, cfg);
      if (next !== null) this.applyCorrection(now, next, cfg);
    }
    if (this.core.baseChanged || (this.core.totalsChanged && now - this.lastSave >= TOTALS_SAVE_MS)) this.persist();
    this.emit(now, false);
  }

  private applyCorrection(now: number, next: number, cfg: DeviceConfig): void {
    const actions = this.core.actionsFor(next, cfg);
    const sent = this.send(actions);
    this.core.commit(now, next, cfg, actions.length);
    if (sent.length) {
      this.busy = true;
      void Promise.allSettled(sent).then(() => { this.busy = false; });
    }
  }

  private send(actions: Action[]): Promise<void>[] {
    const s = this.session;
    return s ? actions.map((a) => s.apply(a).catch((e: Error) => { console.error(e); })) : [];
  }

  /** Raw meter level of the chosen inputs (what the meters show, whatever the gains). */
  private meterLevel(db: readonly number[], cfg: DeviceConfig): number | null {
    const v: number[] = [];
    for (const i of this.core.settings.inputs) if (i < cfg.inputs.length && !cfg.inputs[i].mute && db[i] > SILENCE_DB) v.push(db[i]);
    return v.length ? powerMean(v) : null;
  }

  private gainEdits(cfg: DeviceConfig, raw: (i: number) => number): Action[] {
    const out: Action[] = [];
    const done = new Set<number>();
    for (const i of this.core.settings.inputs) {
      if (i >= cfg.inputs.length || done.has(i)) continue;
      for (const k of linkedChannels(cfg, i)) done.add(k);
      out.push({ t: 'gain', ch: i, raw: raw(i) });
    }
    return out;
  }

  private stepCheck(now: number, db: readonly number[], cfg: DeviceConfig): void {
    const r = this.run!;
    const lv = now >= r.skipUntil ? this.meterLevel(db, cfg) : null;
    if (lv !== null) r.acc[r.phase].push(lv);
    if (now < r.until) return;
    if (r.phase === 'before') {
      if (this.send(this.gainEdits(cfg, (i) => gainDbToRaw(gainRawToDb(r.saved[i]) - CHECK_DIP_DB))).length) this.core.countStep(now);
      r.phase = 'during'; r.skipUntil = now + CHECK_SETTLE_MS; r.until = r.skipUntil + CHECK_PHASE_MS;
    } else if (r.phase === 'during') {
      if (this.send(this.gainEdits(cfg, (i) => r.saved[i])).length) this.core.countStep(now);
      r.phase = 'after'; r.skipUntil = now + CHECK_SETTLE_MS; r.until = r.skipUntil + CHECK_PHASE_MS;
    } else {
      this.run = null;
      const { before, during, after } = r.acc;
      const mean = (xs: number[]): number => xs.reduce((a, x) => a + x, 0) / xs.length;
      const enough = before.length >= 4 && during.length >= 4 && after.length >= 4;
      const drop = enough ? round1((mean(before) + mean(after)) / 2 - mean(during)) : 0;
      const result: MeterCheck['result'] = !enough ? 'unclear' : drop >= CHECK_DIP_DB / 2 ? 'post' : drop <= CHECK_DIP_DB / 4 ? 'pre' : 'unclear';
      const check: MeterCheck = { result, drop, at: now };
      this.core.lastCheck = check;
      this.core.paused = null;
      this.core.resync(cfg, now);
      if (result !== 'unclear' && result !== this.core.settings.meter) this.update({ meter: result });
      r.resolve(check);
    }
    this.emit(now, true);
  }

  /** Remembers the totals if steps were written since the last time (at shutdown, on disconnection). */
  flush(): void { if (this.core.totalsChanged) this.persist(); }

  private persist(): void {
    this.core.baseChanged = false;
    this.core.totalsChanged = false;
    this.lastSave = this.now();
    this.saveFn?.(this.settings, this.core.base ? this.core.base.slice() : null, { ...this.core.totals });
  }

  private emit(now: number, force: boolean): void {
    if (!this.listeners.size) return;
    const status = this.core.status;
    if (!force && status === this.lastStatus && now - this.lastEmit < 1000) return;
    this.lastEmit = now;
    this.lastStatus = status;
    const st = this.state();
    for (const f of this.listeners) { try { f(st); } catch (e) { console.error(e); } }
  }
}
