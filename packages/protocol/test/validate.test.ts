import { describe, expect, it } from 'vitest';
import { configToActions, defaultConfig, MODELS, parseConfig, validateAction, normalizeUnit, ActionError, type ModelId } from '../src/index.ts';
import { loadProbes } from './helpers.ts';

describe('validateAction', () => {
  for (const model of ['dsp206', 'dsp408'] as ModelId[]) {
    it(`accepts every action that rebuilds a ${MODELS[model].name} preset`, () => {
      for (const a of configToActions(defaultConfig(model))) expect(validateAction(model, JSON.parse(JSON.stringify(a)))).toEqual(a);
    });
  }
  it('accepts the configurations measured on the real firmware', () => {
    for (const id of ['206', '408'] as const) {
      const p = loadProbes(id);
      const model: ModelId = id === '206' ? 'dsp206' : 'dsp408';
      for (const a of configToActions(parseConfig(model, p.baseBytes))) expect(() => validateAction(model, a)).not.toThrow();
    }
  });
  it('rejects out of range or malformed values', () => {
    const bad: unknown[] = [
      null, 'x', { t: 'gain', ch: 8, raw: 10 }, { t: 'gain', ch: 0, raw: 401 }, { t: 'gain', ch: 0, raw: 1.5 },
      { t: 'mute', ch: 0, on: 1 }, { t: 'peq', ch: 0, band: 8, p: { gain: 120, freq: 10, q: 1, type: 0, bypass: false } },
      { t: 'peq', ch: 2, band: 8, p: { gain: 120, freq: 10, q: 1, type: 9, bypass: false } },
      { t: 'geq', ch: 2, band: 0, raw: 120 }, { t: 'comp', ch: 0, c: {} }, { t: 'route', ch: 2, mask: 4 },
      { t: 'link', kind: 'in', masks: [1] }, { t: 'copy', src: 0, dst: 2 }, { t: 'copy', src: 3, dst: 3 },
      { t: 'testTone', source: 4, freq: 0 }, { t: 'delay', ch: 0, raw: 70000 }, { t: 'hpf', ch: 0, x: { freq: 301, slope: 1 } },
    ];
    for (const b of bad) expect(() => validateAction('dsp206', b), JSON.stringify(b)).toThrow(ActionError);
  });
  it('cleans names', () => {
    expect(validateAction('dsp206', { t: 'name', ch: 0, name: 'Graveé\u0001 gauche' })).toEqual({ t: 'name', ch: 0, name: 'Gravee g' });
    expect(validateAction('dsp408', { t: 'presetName', name: 'x'.repeat(30) })).toEqual({ t: 'presetName', name: 'x'.repeat(14) });
    expect(validateAction('dsp408', { t: 'presetName', name: 'Église – œuvre’s' })).toEqual({ t: 'presetName', name: "Eglise - oeuvr" });
  });
  it('normalizes unit backups', () => {
    const cfg = defaultConfig('dsp206');
    const u = normalizeUnit({ model: 'dsp206', system: { raw: [1] }, presets: [{ name: 'A', config: cfg }] });
    expect(u.presets.length).toBe(20);
    expect(u.presets[0]?.slot).toBe(1);
    expect(u.presets[1]).toBeNull();
    expect(() => normalizeUnit({ model: 'dsp206', presets: [] }, 'dsp408')).toThrow();
  });
});
