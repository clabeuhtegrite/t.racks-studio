// Integration tests against the real firmware running in the emulator (emulator/server.py).
// Skipped unless DSP_EMULATOR lists the emulated units, for example:
//   python3 emulator/server.py 206 & python3 emulator/server.py 408 --port 9762 &
//   DSP_EMULATOR=localhost:9761,localhost:9762 npm run test:emulator
// Each unit is left as it was found (settings, presets, network), except for the lock and PTS
// passwords, which go back to the factory values.

import { describe, expect, it } from 'vitest';
import { DeviceSession, GAIN_RAW_0DB, masksFromLeaders, MODELS, type DeviceConfig } from '@dsp-studio/protocol';
import { tcpTransport } from '../src/transports.ts';

const targets = (process.env.DSP_EMULATOR ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const T = 120_000;

async function open(target: string): Promise<DeviceSession> {
  const [host, port] = target.split(':');
  const s = new DeviceSession(await tcpTransport(host, Number(port || 9761)), { meterIntervalMs: 60_000 });
  await s.connect();
  return s;
}
const outGain = (c: DeviceConfig, i: number): number => c.outputs[i].gain;
/** Every channel on its own: the firmware applies an edit to the whole link group. */
async function unlinkAll(s: DeviceSession): Promise<void> {
  const m = MODELS[s.snap.model!];
  const own = (n: number): number[] => masksFromLeaders(Array.from({ length: n }, (_, i) => i));
  await s.apply({ t: 'link', kind: 'in', masks: own(m.inputs) });
  await s.apply({ t: 'link', kind: 'out', masks: own(m.outputs) });
}
/** The live config, apart from the header bytes, which tell where it was loaded from. */
const settings = (c: DeviceConfig): Omit<DeviceConfig, 'header'> => { const { header: _h, ...rest } = c; return rest; };

describe.skipIf(!targets.length)('real firmware (emulator)', () => {
  for (const target of targets) {
    describe(target, () => {
      it('connects, reads everything, edits and stores like the Windows editor', async () => {
        const s = await open(target);
        try {
          expect(s.snap.status).toBe('ready');
          const m = MODELS[s.snap.model!];
          expect(s.snap.version).toMatch(/^DSP(206|408) V0104/);
          expect(s.snap.presets).toHaveLength(20);
          expect(s.snap.system?.ip).toBeDefined();
          const before = structuredClone(s.config!);
          await unlinkAll(s);

          // live edit, read back from the firmware
          await s.apply({ t: 'gain', ch: m.inputs, raw: GAIN_RAW_0DB - 30 });
          expect(outGain(await s.readConfig(), 0)).toBe(GAIN_RAW_0DB - 30);

          // preset written page by page (0x25) into U20 without touching the sound, then recalled
          const target20 = structuredClone(s.config!);
          target20.outputs[1].gain = GAIN_RAW_0DB - 60;
          await s.writePresetSlot(20, target20, 'INTEGRATION');
          expect(outGain(s.config!, 1)).toBe(before.outputs[1].gain);
          await s.loadPreset(20);
          expect(s.snap.activePreset).toBe(20);
          expect(s.config!.presetName.trim()).toBe('INTEGRATION');
          expect(outGain(s.config!, 1)).toBe(GAIN_RAW_0DB - 60);
          expect(outGain(s.config!, 0)).toBe(GAIN_RAW_0DB - 30);

          // back to what the unit had
          await s.pushConfig(before);
          expect(settings(await s.readConfig())).toEqual(settings(before));
        } finally { await s.close(); }
      }, T);

      it('backs up and restores the whole unit (.unt), with a factory reset in between', async () => {
        const s = await open(target);
        try {
          const live = structuredClone(s.config!);
          await unlinkAll(s);
          const cfg = structuredClone(s.config!);
          cfg.inputs[0].gain = GAIN_RAW_0DB - 12;
          await s.writePresetSlot(7, cfg, 'SAUVEGARDE');
          const unit = await s.downloadUnit();
          expect(unit.presets[6]?.name.trim()).toBe('SAUVEGARDE');
          expect(unit.presets[6]?.config.inputs[0].gain).toBe(GAIN_RAW_0DB - 12);

          await s.factoryReset();
          expect(s.snap.presets[6].user).toBe(false);

          await s.uploadUnit(unit);
          expect(s.snap.presets[6].user).toBe(true);
          expect(s.snap.presets[6].name.trim()).toBe('SAUVEGARDE');
          await s.loadPreset(7);
          expect(s.config!.inputs[0].gain).toBe(GAIN_RAW_0DB - 12);
          await s.pushConfig(live);
        } finally { await s.close(); }
      }, T * 3);

      it('locks with a password and refuses a wrong one', async () => {
        const s = await open(target);
        try {
          await s.lock('5678');
          expect(s.snap.status).toBe('locked');
          expect(await s.unlock('1111')).toBe(false);
          expect(s.snap.lock?.locked).toBe(true);
          expect(await s.unlock('5678')).toBe(true);
          expect(s.snap.status).toBe('ready');
        } finally { await s.close(); }
      }, T);

      it('sets up the power-on counter (PTS) and checks its password', async () => {
        const s = await open(target);
        try {
          await s.ptsSetup('4321', 50, true);
          expect(s.snap.lock).toMatchObject({ ptsOn: true, ptsLimit: 50 });
          expect(await s.unlockPts('0000')).toBe(false);
          expect(await s.unlockPts('4321')).toBe(true);
          await s.ptsSetup('0000', 9999, false);
          expect(s.snap.lock?.ptsOn).toBe(false);
        } finally { await s.close(); }
      }, T);

      it('stores the device id and IP address (used at the next power on)', async () => {
        const s = await open(target);
        try {
          const { deviceId, ip } = s.snap.system!;
          await s.setNetwork(deviceId, [10, 0, 0, 42]);
          expect(s.snap.system!.ip).toEqual([10, 0, 0, 42]);
          await s.setNetwork(deviceId, ip);
          expect(s.snap.system!.ip).toEqual(ip);
        } finally { await s.close(); }
      }, T);

      it('copies a channel inside the firmware', async () => {
        const s = await open(target);
        try {
          const m = MODELS[s.snap.model!];
          const live = structuredClone(s.config!);
          await unlinkAll(s);
          await s.apply({ t: 'hpf', ch: m.inputs, x: { ...s.config!.outputs[0].hpf, freq: 120, slope: 4 } });
          await s.apply({ t: 'copy', src: m.inputs, dst: m.inputs + 2 });
          const read = await s.readConfig();
          expect(read.outputs[2].hpf).toEqual(read.outputs[0].hpf);
          expect(read.outputs[2].name).toBe(live.outputs[2].name);
          await s.pushConfig(live);
        } finally { await s.close(); }
      }, T);
    });
  }
});
