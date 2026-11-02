// Automatic gain for DJ sets played on vinyl, and the level figures of the DJ screen.
//
// Records are cut at very different levels. The level of the mix reaching the DSP inputs is taken
// from the meters (4 readings a second); when it stays outside a tolerance zone around a target,
// the input gain is moved by small steps, like a sound engineer's hand on the fader: slowly up
// (a breakdown must not be pushed), faster down. The dynamics inside a record are left alone.
//
// The firmware writes every setting change to its EEPROM at once (measured on firmware v1.04: one
// byte per gain step, no write when the value does not change), so the corrections are few: 0.5 dB
// steps, only outside the zone, with a budget of changes per hour.
//
// Whether the input meters read the signal before or after the input gain is not known for the
// real hardware yet. "unknown" is handled like "pre": if the meter actually reads after the gain,
// the correction only reaches half of what is needed. The other way round ("post" assumed on a
// meter that reads before the gain) the correction would run to its limit, so it is never
// assumed: `Leveler.checkMeter()` finds out with a short 6 dB dip.

import { clamp, gainDbToRaw, gainRawToDb } from './codecs.ts';
import type { Meters } from './commands.ts';
import type { DeviceConfig } from './config.ts';
import { linkedChannels } from './links.ts';
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
  /** most gain changes per hour (each one is written to the DSP's memory) */
  budget: number;
}

export const LEVELER_DEFAULTS: Readonly<LevelerSettings> = Object.freeze({
  enabled: false, inputs: [0, 1], target: -14, tolerance: 2, maxBoost: 6, maxCut: 6, speed: 'normal', meter: 'unknown', budget: 120,
});

export const LEVELER_LIMITS = {
  target: [-40, 0], tolerance: [1, 6], maxBoost: [0, 12], maxCut: [0, 12], budget: [20, 600],
} as const;

interface SpeedSpec {
  /** window of the level that decides to raise */
  long: number;
  /** window of the level that decides to lower, and when to stop */
  mid: number;
  /** time between two steps up / down */
  up: number;
  down: number;
  /** after a sudden drop of the level (a breakdown, the end of a mix), no raising during this time */
  breakHold: number;
}
export const LEVELER_SPEEDS: Readonly<Record<LevelerSpeed, SpeedSpec>> = {
  slow: { long: 60_000, mid: 20_000, up: 8_000, down: 3_000, breakHold: 60_000 },
  normal: { long: 30_000, mid: 10_000, up: 4_000, down: 1_500, breakHold: 40_000 },
  fast: { long: 15_000, mid: 5_000, up: 2_000, down: 1_000, breakHold: 20_000 },
};

/** size of one correction step, dB */
export const LEVELER_STEP_DB = 0.5;
/** window of the level shown to the DJ */
const SHORT_MS = 3_000;
/** below this level (after the gain) the input counts as silent */
const SILENCE_DB = -50;
/** readings this far below the window's average are left out (fades, quiet passages) */
const REL_GATE_DB = 10;
/** share of non-silent readings a window needs */
const MIN_FILL = 0.5;
/** a level this far below the long average is a breakdown, not a quieter record (yet) */
const BREAK_DB = 6;
/** pause after someone moved the gain by hand */
const MANUAL_HOLD_MS = 20_000;
const HISTORY_EVERY_MS = 10_000;
const HISTORY_MAX = 720; // 2 hours
const HOUR_MS = 3_600_000;
const CLIP_DB = -0.5;
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
  | 'waiting' // gathering readings (start, preset, settings)
  | 'ok' // in the zone
  | 'raising'
  | 'lowering'
  | 'limit' // the correction is at its limit and the level is still out of the zone
  | 'silence' // no music
  | 'break' // sudden drop (breakdown): no raising for a moment
  | 'manual' // someone moved the gain: short pause, then the new gain is the reference
  | 'tone' // test generator on
  | 'muted' // the chosen inputs are muted
  | 'budget' // too many changes in the last hour
  | 'checking'; // meter check running

export interface MeterCheck { result: 'pre' | 'post' | 'unclear'; drop: number; at: number }
export interface LevelerPoint { t: number; level: number | null; correction: number }

export interface LevelerState {
  settings: LevelerSettings;
  status: LevelerStatus;
  /** level of the mix after the input gain over the last 3 s, dBFS (null: silence, no reading) */
  level: number | null;
  /** the same over the decision window */
  average: number | null;
  /** what the mixer sends, without the automatic correction: the advice to the DJ comes from it */
  source: number | null;
  /** dB added to the reference gain by the automatic gain */
  correction: number;
  /** gain changes in the last hour */
  writes: number;
  /** an input reached 0 dBFS in the last 3 s */
  clip: boolean;
  /** an output limiter acted in the last 3 s */
  limiting: boolean;
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

interface Sample { t: number; l0: number | null; clip: boolean; limit: boolean }

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
  /** set when the reference gains change (the owner remembers them) */
  baseChanged = false;
  /** 'checking' or 'offline': no readings kept, no decisions */
  paused: LevelerStatus | null = null;
  lastCheck: MeterCheck | null = null;
  readonly history: LevelerPoint[] = [];
  private samples: Sample[] = [];
  private expected: number[] | null = null;
  private holdUntil = 0;
  private holdStatus: LevelerStatus = 'waiting';
  private breakUntil = 0;
  private mode: 'idle' | 'raising' | 'lowering' = 'idle';
  private lastStep = -Infinity;
  private writeTimes: number[] = [];
  private lastPoint = -Infinity;

  constructor(settings: Readonly<LevelerSettings> = LEVELER_DEFAULTS, base: number[] | null = null) {
    this.settings = cloneLevelerSettings(settings);
    this.base = settings.enabled && base ? base.slice() : null;
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
    this.holdUntil = now; this.breakUntil = 0;
  }

  private channels(cfg: DeviceConfig): number[] { return this.settings.inputs.filter((i) => i < cfg.inputs.length); }

  /** One meter reading (dBFS per wire channel, inputs first) with the configuration at that time. */
  observe(now: number, db: readonly number[], cfg: DeviceConfig, limitBits = 0): void {
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
      if (m > CLIP_DB) clip = true;
      if (c.mute) continue;
      const g = gainRawToDb(c.gain);
      const pre = s.meter === 'post' ? m - g : m;
      const ref = s.enabled && this.base ? gainRawToDb(this.base[i]) : g;
      levels.push(pre + ref);
    }
    let l0: number | null = levels.length ? powerMean(levels) : null;
    if (l0 !== null && l0 + this.correction < SILENCE_DB) l0 = null;
    this.samples.push({ t: now, l0, clip, limit: limitBits !== 0 });
    const keep = now - Math.max(LEVELER_SPEEDS[s.speed].long, SHORT_MS) - 1000;
    let k = 0;
    while (k < this.samples.length && this.samples[k].t < keep) k++;
    if (k) this.samples.splice(0, k);
    if (now - this.lastPoint >= HISTORY_EVERY_MS) {
      this.lastPoint = now;
      const avg = this.estimate(now, LEVELER_SPEEDS[s.speed].mid, 0.3);
      this.history.push({ t: now, level: avg === null ? null : round1(avg + this.correction), correction: this.correction });
      if (this.history.length > HISTORY_MAX) this.history.splice(0, this.history.length - HISTORY_MAX);
    }
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
    this.breakUntil = 0;
  }

  /** Level without correction over a window (power average, quiet passages left out); null when
   *  the window is not covered yet or mostly silent. */
  estimate(now: number, windowMs: number, minCover = 0.8): number | null {
    const from = now - windowMs;
    let i = this.samples.length;
    while (i > 0 && this.samples[i - 1].t > from) i--;
    const all = this.samples.slice(i);
    if (all.length < 4 || now - all[0].t < windowMs * minCover) return null;
    const valid: number[] = [];
    for (const x of all) if (x.l0 !== null) valid.push(x.l0);
    if (valid.length < all.length * MIN_FILL) return null;
    const m = powerMean(valid);
    return powerMean(valid.filter((v) => v >= m - REL_GATE_DB));
  }

  private recent(now: number, f: (x: Sample) => boolean): boolean {
    for (let i = this.samples.length - 1; i >= 0 && this.samples[i].t > now - SHORT_MS; i--) if (f(this.samples[i])) return true;
    return false;
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
    if (this.silent(now)) { this.status = 'silence'; this.mode = 'idle'; return null; }
    const mid = this.estimate(now, sp.mid);
    if (mid === null) { this.status = 'waiting'; return null; }
    const long = this.estimate(now, sp.long);
    const T = s.target, tol = s.tolerance;
    const aMid = mid + c, aLong = long === null ? null : long + c;
    if (aLong !== null && aMid < aLong - BREAK_DB) {
      this.breakUntil = Math.max(this.breakUntil, now + sp.breakHold);
      if (this.mode === 'raising') this.mode = 'idle';
    }
    // hysteresis: start outside the zone, stop half way back in
    if (this.mode === 'lowering' && aMid <= T + tol / 2 + EPS) this.mode = 'idle';
    if (this.mode === 'raising' && (aMid >= T - tol / 2 - EPS || (aLong !== null && aLong >= T - tol / 2 - EPS))) this.mode = 'idle';
    if (this.mode === 'idle') {
      if (aMid > T + tol + EPS) this.mode = 'lowering';
      else if (aLong !== null && aLong < T - tol - EPS && aMid < T - tol - EPS) {
        if (now < this.breakUntil) { this.status = 'break'; return null; }
        this.mode = 'raising';
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
  commit(now: number, correction: number, cfg: DeviceConfig, writes: number): void {
    this.correction = correction;
    this.expected = cfg.inputs.map((c) => c.gain);
    this.lastStep = now;
    for (let k = 0; k < writes; k++) this.writeTimes.push(now);
  }

  /** The gains were changed on purpose (meter check): they are the expected ones again. */
  resync(cfg: DeviceConfig, now: number): void {
    if (this.expected) this.expected = cfg.inputs.map((c) => c.gain);
    this.samples = [];
    this.holdUntil = now;
  }

  state(now: number): Omit<LevelerState, 'check'> {
    const sp = LEVELER_SPEEDS[this.settings.speed];
    const c = this.correction;
    const short = this.estimate(now, SHORT_MS, 0.3);
    const mid = this.estimate(now, sp.mid, 0.3);
    const long = this.estimate(now, sp.long, 0.5) ?? mid;
    return {
      settings: cloneLevelerSettings(this.settings),
      status: this.status,
      level: short === null ? null : round1(short + c),
      average: long === null ? null : round1(long + c),
      source: long === null ? null : round1(long),
      correction: c,
      writes: this.writesInLastHour(now),
      clip: this.recent(now, (x) => x.clip),
      limiting: this.recent(now, (x) => x.limit),
      at: now,
    };
  }
}

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
  /** called when the settings or the reference gains change, to remember them */
  save?: (settings: LevelerSettings, base: number[] | null) => void;
  now?: () => number;
}

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
  private readonly now: () => number;
  private readonly saveFn?: LevelerOptions['save'];

  constructor(o: LevelerOptions = {}) {
    this.core = new LevelerCore(o.settings ?? LEVELER_DEFAULTS, o.base ?? null);
    this.core.paused = 'offline';
    this.core.status = 'offline';
    this.now = o.now ?? (() => Date.now());
    this.saveFn = o.save;
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
    this.emit(this.now(), true);
  }

  state(): LevelerState { return { ...this.core.state(this.now()), check: this.core.lastCheck }; }
  history(): LevelerPoint[] { return this.core.history.slice(); }

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
    if (this.core.baseChanged) this.persist();
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
      this.send(this.gainEdits(cfg, (i) => gainDbToRaw(gainRawToDb(r.saved[i]) - CHECK_DIP_DB)));
      r.phase = 'during'; r.skipUntil = now + CHECK_SETTLE_MS; r.until = r.skipUntil + CHECK_PHASE_MS;
    } else if (r.phase === 'during') {
      this.send(this.gainEdits(cfg, (i) => r.saved[i]));
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

  private persist(): void {
    this.core.baseChanged = false;
    this.saveFn?.(this.settings, this.core.base ? this.core.base.slice() : null);
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
