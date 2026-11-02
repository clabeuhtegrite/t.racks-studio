// Simulated vinyl nights through the automatic gain: records cut at different levels, with intros,
// breakdowns and transitions, read by meters 4 times a second with the jitter of real music. Checks
// what the night sounds like (time in the zone) and how much the DSP's memory is written.

import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/state.ts';
import { defaultConfig } from '../src/config.ts';
import { gainRawToDb } from '../src/codecs.ts';
import { LevelerCore, LEVELER_DEFAULTS, type LevelerSettings } from '../src/leveler.ts';

const TARGET = -14;
type Part = 'intro' | 'main' | 'break' | 'outro';
const PART_DB: Record<Part, number> = { intro: -3, main: 0, break: -10, outro: -3 };
interface Rec { start: number; len: number; off: number; brk: [number, number] }

function random(seed: number): { next: () => number; gauss: () => number } {
  let s = seed;
  const next = (): number => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  return { next, gauss: () => { let u = 0; for (let i = 0; i < 6; i++) u += next(); return (u - 3) / Math.sqrt(0.5); } };
}

/** Records of 4 to 6 minutes mixed over their last 32 s, `off` dB from the target, one breakdown each. */
function night(hours: number, seed: number, off: [number, number], brk: [number, number]): Rec[] {
  const r = random(seed);
  const recs: Rec[] = [];
  for (let t = 0; t < hours * 3600;) {
    const len = 240 + r.next() * 120;
    const at = len * (0.4 + r.next() * 0.15);
    recs.push({ start: t, len, off: off[0] + r.next() * (off[1] - off[0]), brk: [at, at + brk[0] + r.next() * (brk[1] - brk[0])] });
    t += len - 32;
  }
  return recs;
}

function partOf(r: Rec, x: number): Part {
  if (x < 32) return 'intro';
  if (x >= r.len - 32) return 'outro';
  return x >= r.brk[0] && x < r.brk[1] ? 'break' : 'main';
}

/** Level the mixer sends at `t` (s), and whether a record is in its main part alone. */
function mix(recs: Rec[], t: number): { db: number; main: boolean } {
  const on = recs.filter((r) => t >= r.start && t < r.start + r.len);
  const level = (r: Rec): number => TARGET + r.off + PART_DB[partOf(r, t - r.start)];
  if (on.length === 1) return { db: level(on[0]), main: partOf(on[0], t - on[0].start) === 'main' };
  const p = Math.min(1, (t - on[1].start) / 32); // equal power crossfade
  return { db: 10 * Math.log10(10 ** (level(on[0]) / 10) * (1 - p) + 10 ** (level(on[1]) / 10) * p), main: false };
}

/** Plays the night; meters read after the gain. Time in the zone is judged on 10 s averages of the main parts. */
function play(recs: Rec[], s: Partial<LevelerSettings>): { inZone: number; stepsPerHour: number } {
  const cfg = defaultConfig('dsp206');
  const core = new LevelerCore({ ...LEVELER_DEFAULTS, inputs: [0, 1], meter: 'post', ...s });
  const r = random(99);
  const end = recs[recs.length - 1].start + recs[recs.length - 1].len;
  const win: number[] = [];
  let steps = 0, judged = 0, inZone = 0;
  for (let ms = 0; ms < end * 1000; ms += 250) {
    const m = mix(recs, ms / 1000);
    const gain = gainRawToDb(cfg.inputs[0].gain);
    const level = m.db + r.gauss() * 2.5 + gain;
    const db = Array<number>(12).fill(-140);
    db[0] = db[1] = level;
    core.observe(ms, db, cfg, 0);
    const next = core.decide(ms, cfg);
    if (next !== null) {
      const acts = core.actionsFor(next, cfg);
      for (const a of acts) applyAction(cfg, a);
      core.commit(ms, next, cfg, acts.length);
      steps++;
    }
    win.push(10 ** (level / 10));
    if (win.length > 40) win.shift();
    if (m.main && win.length === 40 && ms % 1000 === 0) {
      judged++;
      if (Math.abs(10 * Math.log10(win.reduce((a, x) => a + x, 0) / 40) - TARGET) <= 2) inZone++;
    }
  }
  return { inZone: inZone / judged, stepsPerHour: steps / (end / 3600) };
}

describe('automatic gain over a simulated night', () => {
  it('brings records cut 6 dB under to 3 dB over the target into the zone, with few writes', () => {
    const recs = night(2, 7, [-6, 3], [30, 64]);
    const off = play(recs, { enabled: false });
    const on = play(recs, { enabled: true });
    expect(off.inZone).toBeLessThan(0.6);
    expect(off.stepsPerHour).toBe(0);
    expect(on.inZone).toBeGreaterThan(0.8);
    expect(on.stepsPerHour).toBeLessThan(90);
  }, 30_000);

  it('leaves records already at the target alone, long breakdowns included', () => {
    const recs = night(1.5, 11, [-1, 1], [60, 96]);
    const on = play(recs, { enabled: true });
    expect(on.inZone).toBeGreaterThan(0.9);
    expect(on.stepsPerHour).toBeLessThan(30); // 60 to 120 before breakdowns were waited out
    const fast = play(recs, { enabled: true, speed: 'fast' });
    expect(fast.inZone).toBeGreaterThan(0.9);
  }, 30_000);
});
