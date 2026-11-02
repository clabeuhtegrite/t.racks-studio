import { describe, expect, it } from 'vitest';
import { gainDbToRaw, gainRawToDb } from '../src/codecs.ts';
import { defaultConfig, type DeviceConfig } from '../src/config.ts';
import {
  Leveler, LevelerCore, LEVELER_DEFAULTS, mergeLevelerSettings, restoreLevelerSettings, type LevelerSettings,
} from '../src/leveler.ts';
import { masksFromLeaders } from '../src/links.ts';
import { DeviceSession } from '../src/session.ts';
import { VirtualDsp } from '../src/sim.ts';
import { applyAction } from '../src/state.ts';

const settings = (p: Partial<LevelerSettings> = {}): LevelerSettings => ({ ...LEVELER_DEFAULTS, inputs: [0, 1], enabled: true, ...p });

/** Where the hardware meter reads: after the input gain ('post') or before it ('pre'). */
type Hw = 'pre' | 'post';

/**
 * Plays a source (level of the mixer, dBFS, null = silence) into the inputs for `seconds`, one meter
 * reading every 250 ms, and applies the edits the core asks for, like the session would.
 */
function play(core: LevelerCore, cfg: DeviceConfig, from: number, seconds: number, src: (t: number) => number | null, hw: Hw = 'post') {
  let writes = 0;
  const statuses = new Set<string>();
  let t = from;
  for (; t < from + seconds * 1000; t += 250) {
    const db = Array<number>(12).fill(-140);
    const s = src(t);
    for (let i = 0; i < cfg.inputs.length; i++) db[i] = s === null ? -140 : hw === 'post' ? s + gainRawToDb(cfg.inputs[i].gain) : s;
    core.observe(t, db, cfg, 0);
    const next = core.decide(t, cfg);
    statuses.add(core.status);
    if (next !== null) {
      const acts = core.actionsFor(next, cfg);
      for (const a of acts) applyAction(cfg, a);
      core.commit(t, next, cfg, acts.length);
      writes += acts.length;
    }
  }
  return { t, writes, statuses };
}

const gainOf = (cfg: DeviceConfig, i: number): number => gainRawToDb(cfg.inputs[i].gain);

describe('automatic gain settings', () => {
  it('checks and rounds what a screen sends', () => {
    const s = mergeLevelerSettings(LEVELER_DEFAULTS, { target: '-17.3', tolerance: 9, maxBoost: -2, speed: 'slow', inputs: [1, 1, 0, 7] }, 4);
    expect(s).toMatchObject({ target: -17.5, tolerance: 6, maxBoost: 0, speed: 'slow', inputs: [0, 1] });
    expect(LEVELER_DEFAULTS.inputs).toEqual([0, 1]); // the defaults are never modified
    expect(() => mergeLevelerSettings(LEVELER_DEFAULTS, { target: 'fort' })).toThrow('niveau cible invalide');
    expect(() => mergeLevelerSettings(LEVELER_DEFAULTS, { inputs: [] })).toThrow('au moins une entrée');
    expect(() => mergeLevelerSettings(LEVELER_DEFAULTS, { speed: 'turbo' })).toThrow('vitesse invalide');
    expect(() => mergeLevelerSettings(LEVELER_DEFAULTS, null)).toThrow('réglages invalides');
    expect(() => mergeLevelerSettings(LEVELER_DEFAULTS, { inputs: [3] }, 2)).toThrow('au moins une entrée'); // InD on a DSP 206
  });

  it('restores what was saved, defaults for anything damaged', () => {
    expect(restoreLevelerSettings({ enabled: true, target: -12, speed: 'x', inputs: 'a' })).toEqual({ ...LEVELER_DEFAULTS, enabled: true, target: -12 });
    expect(restoreLevelerSettings(undefined)).toEqual(LEVELER_DEFAULTS);
  });
});

describe('automatic gain decisions', () => {
  it('raises a quiet record by 0.5 dB steps until it is back in the zone, then stops', () => {
    const cfg = defaultConfig('dsp206');
    const core = new LevelerCore(settings({ meter: 'post' }));
    const r = play(core, cfg, 0, 120, () => -20);
    expect(core.correction).toBe(5); // -20 + 5 = -15 = target - tolerance / 2
    expect(gainOf(cfg, 0)).toBe(5);
    expect(gainOf(cfg, 1)).toBe(5);
    expect(r.writes).toBe(20); // 10 steps on two inputs: nothing more
    expect(core.status).toBe('ok');
    expect(r.statuses).toContain('raising');
  });

  it('lowers a loud record faster than it raises a quiet one', () => {
    const cfg = defaultConfig('dsp206');
    const core = new LevelerCore(settings({ meter: 'post' }));
    play(core, cfg, 0, 30, () => -8);
    expect(core.correction).toBe(-5); // -8 - 5 = -13 = target + tolerance / 2
    const quiet = new LevelerCore(settings({ meter: 'post' }));
    play(quiet, defaultConfig('dsp206'), 0, 30, () => -20);
    expect(quiet.correction).toBeLessThan(2.5);
  });

  it('leaves a record inside the zone alone, and does nothing on silence', () => {
    const cfg = defaultConfig('dsp206');
    const core = new LevelerCore(settings({ meter: 'post' }));
    expect(play(core, cfg, 0, 60, () => -15.5).writes).toBe(0);
    expect(core.status).toBe('ok');
    const r = play(core, cfg, 60_000, 60, () => null);
    expect(r.writes).toBe(0);
    expect(core.status).toBe('silence');
  });

  it('stays within the limits', () => {
    const cfg = defaultConfig('dsp206');
    const core = new LevelerCore(settings({ meter: 'post' }));
    const r = play(core, cfg, 0, 200, () => -32);
    expect(core.correction).toBe(6);
    expect(core.status).toBe('limit');
    expect(r.writes).toBe(24);
    // limits lowered later: back inside them, step by step
    core.configure(settings({ meter: 'post', maxBoost: 2 }), r.t);
    play(core, cfg, r.t, 30, () => -32);
    expect(core.correction).toBe(2);
    expect(gainOf(cfg, 0)).toBe(2);
  });

  it('respects the budget of changes per hour', () => {
    const cfg = defaultConfig('dsp206');
    const core = new LevelerCore(settings({ meter: 'post', budget: 20 }));
    const r = play(core, cfg, 0, 200, () => -32);
    expect(r.writes).toBe(20);
    expect(core.correction).toBe(5);
    expect(core.status).toBe('budget');
    // an hour later it goes on
    play(core, cfg, 3_700_000, 60, () => -32);
    expect(core.correction).toBe(6);
  });

  it('sends one edit per link group', () => {
    const cfg = defaultConfig('dsp408');
    applyAction(cfg, { t: 'link', kind: 'in', masks: masksFromLeaders([0, 0, 2, 3]) });
    const core = new LevelerCore(settings({ meter: 'post' }));
    const r = play(core, cfg, 0, 120, () => -20);
    expect(core.correction).toBe(5);
    expect(r.writes).toBe(10);
    expect(gainOf(cfg, 1)).toBe(5);
    expect(gainOf(cfg, 2)).toBe(0); // InC is not part of the DJ mix
  });

  it('does not push a breakdown', () => {
    const cfg = defaultConfig('dsp206');
    const core = new LevelerCore(settings({ meter: 'post' }));
    const song = (t: number): number => (t >= 60_000 && t < 90_000 ? -26 : -14);
    const r = play(core, cfg, 0, 150, song);
    expect(r.writes).toBe(0);
    expect(r.statuses).toContain('break');
  });

  it('a gain moved by someone else becomes the new reference', () => {
    const cfg = defaultConfig('dsp206');
    const core = new LevelerCore(settings({ meter: 'post' }));
    let r = play(core, cfg, 0, 120, () => -20);
    expect(core.correction).toBe(5);
    applyAction(cfg, { t: 'gain', ch: 0, raw: gainDbToRaw(-2) }); // the sound engineer
    r = play(core, cfg, r.t, 10, () => -20);
    expect(core.status).toBe('manual');
    expect(core.correction).toBe(0);
    expect(core.base).toEqual([gainDbToRaw(-2), gainDbToRaw(5)]);
    expect(r.writes).toBe(0);
  });

  it('keeps its correction across a restart of the bridge', () => {
    const cfg = defaultConfig('dsp206');
    for (const i of [0, 1]) cfg.inputs[i].gain = gainDbToRaw(3);
    const core = new LevelerCore(settings({ meter: 'post' }), [280, 280]);
    const r = play(core, cfg, 0, 5, () => -14);
    expect(core.correction).toBe(3);
    expect(r.writes).toBe(0);
    // gains that no longer match the reference (changed while the bridge was off): new reference
    const other = new LevelerCore(settings({ meter: 'post' }), [280, 300]);
    play(other, cfg, 0, 5, () => -14);
    expect(other.correction).toBe(0);
    expect(other.base).toEqual([gainDbToRaw(3), gainDbToRaw(3)]);
  });

  it('pauses on the test generator and on muted inputs', () => {
    const cfg = defaultConfig('dsp206');
    cfg.toneSource = 1;
    const core = new LevelerCore(settings({ meter: 'post' }));
    expect(play(core, cfg, 0, 60, () => -25).writes).toBe(0);
    expect(core.status).toBe('tone');
    cfg.toneSource = 0;
    cfg.inputs[0].mute = cfg.inputs[1].mute = true;
    expect(play(core, cfg, 60_000, 60, () => -25).writes).toBe(0);
    expect(core.status).toBe('muted');
  });

  it('meter before the gain: corrects fully once known; unknown position can only under-correct', () => {
    const pre = new LevelerCore(settings({ meter: 'pre' }));
    const cfgPre = defaultConfig('dsp206');
    play(pre, cfgPre, 0, 120, () => -20, 'pre');
    expect(pre.correction).toBe(5);
    // position unknown on a meter that reads after the gain: half the correction, never more
    const unknown = new LevelerCore(settings({ meter: 'unknown' }));
    play(unknown, defaultConfig('dsp206'), 0, 200, () => -20, 'post');
    expect(unknown.correction).toBeGreaterThan(1.5);
    expect(unknown.correction).toBeLessThanOrEqual(3);
    // the reason 'post' is never assumed: on a meter that reads before the gain it runs to the limit
    const wrong = new LevelerCore(settings({ meter: 'post' }));
    play(wrong, defaultConfig('dsp206'), 0, 200, () => -15.5, 'pre');
    expect(wrong.correction).toBe(0); // in the zone: fine
    play(wrong, defaultConfig('dsp206'), 200_000, 200, () => -20, 'pre');
    expect(wrong.correction).toBe(6);
  });

  it('measures the level for the DJ screen even when switched off', () => {
    const cfg = defaultConfig('dsp206');
    const core = new LevelerCore(settings({ enabled: false, meter: 'post' }));
    const r = play(core, cfg, 0, 40, () => -20);
    expect(r.writes).toBe(0);
    const st = core.state(r.t);
    expect(st.status).toBe('off');
    expect(st.level).toBe(-20);
    expect(st.source).toBe(-20);
    expect(core.history.length).toBeGreaterThan(2);
  });

  it('turned off, the gains stay where they are', () => {
    const cfg = defaultConfig('dsp206');
    const core = new LevelerCore(settings({ meter: 'post' }));
    const r = play(core, cfg, 0, 120, () => -20);
    core.configure(settings({ enabled: false, meter: 'post' }), r.t);
    expect(core.correction).toBe(0);
    expect(gainOf(cfg, 0)).toBe(5);
    expect(core.state(r.t).level).toBe(-15);
  });
});

describe('automatic gain on a session', () => {
  const setup = async () => {
    const sim = new VirtualDsp({ model: 'dsp206', latencyMs: 0, signalDb: -26 });
    const s = new DeviceSession(sim.transport(), { meterIntervalMs: 4, timeoutMs: 200, retries: 1 });
    let clock = 0;
    s.on('meters', () => { clock += 250; }); // registered first: each reading is 250 ms later
    await s.connect();
    const saved: { settings: LevelerSettings; base: number[] | null }[] = [];
    const lv = new Leveler({ settings: settings({ meter: 'post' }), now: () => clock, save: (st, base) => saved.push({ settings: st, base }) });
    return { sim, s, lv, saved, until: async (f: () => boolean, ms = 8000) => {
      const end = Date.now() + ms;
      while (!f() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
      return f();
    } };
  };

  it('corrects the gain through the session, so every screen sees it', async () => {
    const { sim, s, lv, saved, until } = await setup();
    const edits: number[] = [];
    s.on('action', (a) => { if (a.action.t === 'gain') edits.push(a.action.raw); });
    const states: string[] = [];
    lv.onState((st) => states.push(st.status));
    lv.attach(s);
    expect(await until(() => lv.core.correction >= 3)).toBe(true);
    lv.detach();
    expect(edits.length).toBeGreaterThan(0);
    expect(await until(() => gainRawToDb(sim.config.inputs[0].gain) === lv.core.correction)).toBe(true);
    expect(saved.at(-1)?.base).toEqual([280, 280]);
    expect(states).toContain('raising');
    expect(lv.state().status).toBe('offline');
    await s.close();
  });

  it('finds out where the meters read with a short dip, and restores the gain', async () => {
    const { sim, s, lv, until } = await setup();
    lv.update({ enabled: false, meter: 'unknown' });
    lv.attach(s);
    expect(await until(() => lv.state().level !== null)).toBe(true);
    const before = sim.config.inputs[0].gain;
    const check = await lv.checkMeter();
    expect(check.result).toBe('post'); // the virtual DSP meters after the gain, like most
    expect(check.drop).toBeGreaterThan(4);
    expect(lv.settings.meter).toBe('post');
    expect(await until(() => sim.config.inputs[0].gain === before)).toBe(true);
    expect(lv.state().check?.result).toBe('post');
    await s.close();
  });

  it('takes the level of the moment as the target', async () => {
    const { s, lv, until } = await setup();
    lv.update({ enabled: false });
    expect(() => lv.takeTarget()).toThrow('aucune musique');
    lv.attach(s);
    expect(await until(() => lv.state().average !== null)).toBe(true);
    const st = lv.takeTarget();
    expect(Math.abs(st.settings.target - st.average!)).toBeLessThanOrEqual(0.5);
    await s.close();
  });
});
