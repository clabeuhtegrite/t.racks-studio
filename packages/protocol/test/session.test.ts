import { describe, expect, it } from 'vitest';
import { cmd } from '../src/commands.ts';
import { defaultConfig, serializeConfig } from '../src/config.ts';
import { masksFromLeaders } from '../src/links.ts';
import { DeviceSession } from '../src/session.ts';
import { VirtualDsp } from '../src/sim.ts';

const setup = async (model: 'dsp206' | 'dsp408' = 'dsp206', opts: { deviceId?: number; simId?: number } = {}) => {
  const sim = new VirtualDsp({ model, deviceId: opts.simId ?? 1, latencyMs: 0 });
  const s = new DeviceSession(sim.transport(), { deviceId: opts.deviceId ?? 1, meterIntervalMs: 20, timeoutMs: 100, retries: 1 });
  return { sim, s };
};

describe('DeviceSession against the virtual DSP', () => {
  it('connects, detects the model and downloads the configuration', async () => {
    for (const model of ['dsp206', 'dsp408'] as const) {
      const { sim, s } = await setup(model);
      await s.connect();
      expect(s.snap.status).toBe('ready');
      expect(s.snap.model).toBe(model);
      expect(s.snap.version).toBe(model === 'dsp206' ? 'DSP206 V0104P' : 'DSP408 V0104P');
      expect(s.snap.presets).toHaveLength(20);
      expect(serializeConfig(s.config!)).toEqual(sim.image());
      expect(s.snap.system?.ip).toEqual([192, 168, 1, 100]);
      await s.close();
    }
  });

  it('sends edits and keeps its copy identical to the device, link groups included', async () => {
    const { sim, s } = await setup('dsp408');
    await s.connect();
    await s.apply({ t: 'link', kind: 'out', masks: masksFromLeaders([0, 0, 2, 3, 4, 5, 6, 7]) });
    await s.apply({ t: 'gain', ch: 5, raw: 250 }); // Out2, member of the Out1 group
    await s.apply({ t: 'peq', ch: 0, band: 3, p: { gain: 150, freq: 200, q: 40, type: 0, bypass: false } });
    await s.apply({ t: 'route', ch: 4, mask: 0b1010 });
    expect(sim.config.outputs[0].gain).toBe(250);
    expect(sim.config.outputs[1].gain).toBe(250);
    expect(s.config!.outputs[0].gain).toBe(250);
    expect(serializeConfig(s.config!)).toEqual(sim.image());
    await s.close();
  });

  it('coalesces fast repeated edits of one parameter', async () => {
    const { sim, s } = await setup();
    await s.connect();
    s.stopMeters();
    const sent: string[] = [];
    s.on('frame', (f) => { if (f.dir === 'tx') sent.push(f.hex); });
    await Promise.all([200, 210, 220, 230, 240].map((raw) => s.apply({ t: 'gain', ch: 2, raw })));
    expect(sim.config.outputs[0].gain).toBe(240);
    expect(sent.length).toBeLessThan(5);
    await s.close();
  });

  it('stores and recalls presets', async () => {
    const { sim, s } = await setup();
    await s.connect();
    await s.apply({ t: 'gain', ch: 0, raw: 300 });
    await s.storePreset(3, 'Concert');
    expect(sim.slots[2].name).toBe('Concert');
    expect(s.snap.presets[2]).toEqual({ slot: 3, name: 'Concert', user: true });
    await s.loadPreset(0);
    expect(s.config!.inputs[0].gain).toBe(280);
    await s.loadPreset(3);
    expect(s.config!.inputs[0].gain).toBe(300);
    expect(s.snap.activePreset).toBe(3);
    await expect(s.loadPreset(21)).rejects.toThrow();
    await s.close();
  });

  it('writes presets straight into memory (0x25) and round-trips a whole unit', async () => {
    const { sim, s } = await setup();
    await s.connect();
    const cfg = defaultConfig('dsp206');
    cfg.outputs[2].delay = 960;
    await s.writePresetSlot(7, cfg, 'Sub delay');
    expect(sim.slots[6].config?.outputs[2].delay).toBe(960);
    expect(sim.config.outputs[2].delay).toBe(0); // live sound untouched
    const unit = await s.downloadUnit();
    expect(unit.presets.filter(Boolean).map((p) => p!.slot)).toEqual([7]);
    expect(unit.presets[6]?.name).toBe('Sub delay');

    const other = await setup();
    await other.s.connect();
    await other.s.uploadUnit(unit);
    expect(other.sim.slots[6].config?.outputs[2].delay).toBe(960);
    expect(other.sim.slots.filter((x) => x.config).length).toBe(1);
    await s.close(); await other.s.close();
  });

  it('handles the lock: connects locked, refuses a wrong password, unlocks', async () => {
    const { sim, s } = await setup();
    sim.request(0x10); sim.request(0x2f, [...'1234'].map((c) => c.charCodeAt(0))); sim.request(0x11);
    await s.connect();
    expect(s.snap.status).toBe('locked');
    expect(await s.unlock('0000')).toBe(false);
    expect(await s.unlock('1234')).toBe(true);
    expect(s.snap.status).toBe('ready');
    await s.close();
  });

  it('goes to the locked state when locked from an open session, and back after unlocking', async () => {
    const { s } = await setup();
    await s.connect();
    expect(s.snap.status).toBe('ready');
    await s.lock('4321');
    expect(s.snap.status).toBe('locked');
    expect(s.snap.lock?.locked).toBe(true);
    expect(await s.unlock('4321')).toBe(true);
    expect(s.snap.status).toBe('ready');
    expect(s.snap.lock?.locked).toBe(false);
    await s.close();
  });

  it('never sends the production / bootloader opcodes', async () => {
    const { s } = await setup();
    await s.connect();
    await expect(s.request({ cmd: 0x04, data: [] })).rejects.toThrow(/interdite/);
    await expect(s.request({ cmd: 0xa2, data: [] })).rejects.toThrow(/interdite/);
    await s.close();
  });

  it('only talks to the device id it was given', async () => {
    const { s } = await setup('dsp206', { deviceId: 2, simId: 1 });
    await expect(s.connect()).rejects.toThrow(/pas de réponse/);
    const ok = await setup('dsp206', { deviceId: 2, simId: 2 });
    await ok.s.connect();
    expect(ok.s.snap.status).toBe('ready');
    await ok.s.close();
  });

  it('polls the meters', async () => {
    const { s } = await setup();
    await s.connect();
    const m = await new Promise<{ db: number[] }>((r) => s.on('meters', r));
    expect(m.db).toHaveLength(8);
    expect(m.db[0]).toBeGreaterThan(-60);
    await s.close();
  });

  it('changes the device id and IP in EEPROM', async () => {
    const { sim, s } = await setup();
    await s.connect();
    await s.setNetwork(5, [10, 0, 0, 7]);
    expect(sim.eeprom[0]).toBe(5);
    expect(Array.from(sim.eeprom.subarray(0x13, 0x17))).toEqual([10, 0, 0, 7]);
    expect(s.snap.system).toMatchObject({ deviceId: 5, ip: [10, 0, 0, 7] });
    expect(cmd.setDeviceId(5)).toEqual({ cmd: 0x1a, data: [0, 0, 1, 5] });
    await s.close();
  });
});

import { diffActions, inverseActions, configToActions, applyAction } from '../src/state.ts';
import { cloneConfig } from '../src/config.ts';
describe('diffActions / inverseActions', () => {
  it('turns one config into another with only the needed commands', () => {
    const a = defaultConfig('dsp408');
    const b = cloneConfig(a);
    b.outputs[2].gain = 200; b.inputs[1].geq[5] = 130; b.outputs[0].route = 3;
    const d = diffActions(a, b);
    expect(d.map((x) => x.t)).toEqual(['geq', 'route', 'gain']);
    const c = cloneConfig(a);
    for (const x of d) applyAction(c, x);
    expect(serializeConfig(c)).toEqual(serializeConfig(b));
  });
  it('handles link groups (clears, writes, restores)', () => {
    const a = defaultConfig('dsp206');
    const b = cloneConfig(a);
    for (const x of configToActions(b)) applyAction(b, x);
    applyAction(b, { t: 'link', kind: 'out', masks: masksFromLeaders([0, 0, 2, 2, 4, 5]) });
    applyAction(b, { t: 'gain', ch: 2, raw: 150 });
    applyAction(b, { t: 'hpf', ch: 4, x: { freq: 120, slope: 10 } });
    const c = cloneConfig(a);
    for (const x of diffActions(a, b)) applyAction(c, x);
    expect(serializeConfig(c)).toEqual(serializeConfig(b));
    const back = cloneConfig(b);
    for (const x of diffActions(b, a)) applyAction(back, x);
    expect(serializeConfig(back)).toEqual(serializeConfig(a));
  });
  it('inverse of an edit restores the previous state', () => {
    const a = defaultConfig('dsp206');
    const act = { t: 'peq', ch: 3, band: 2, p: { gain: 60, freq: 100, q: 20, type: 1, bypass: false } } as const;
    const inv = inverseActions(a, act);
    const c = cloneConfig(a);
    applyAction(c, act);
    for (const x of inv) applyAction(c, x);
    expect(serializeConfig(c)).toEqual(serializeConfig(a));
  });
});
