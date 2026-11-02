// The settings of the demo instance launcher (the processes themselves are tried in the Docker image).

import { describe, expect, it } from 'vitest';
import os from 'node:os';
import { join } from 'node:path';
import { sandboxOf } from '../../apps/bridge/src/server.ts';
import { nextAt, parseTime, readConfig, seedDevices } from './demo.ts';

describe('demo instance settings', () => {
  it('reads the reset time', () => {
    expect(parseTime('04:00')).toEqual({ h: 4, m: 0 });
    expect(parseTime('4h30')).toEqual({ h: 4, m: 30 });
    expect(parseTime(' 23:59 ')).toEqual({ h: 23, m: 59 });
    for (const off of ['off', 'none', 'never', '']) expect(parseTime(off)).toBeNull();
    for (const bad of ['24:00', '12:60', 'midnight', '4']) expect(() => parseTime(bad)).toThrow('DEMO_RESET_AT');
  });

  it('has defaults for a public demo', () => {
    expect(readConfig({})).toEqual({
      port: 8080, dir: join(os.homedir(), '.dsp-studio-demo'), emulators: ['206', '408'], virtual: ['408'],
      resetAt: { h: 4, m: 0 }, idleMinutes: 30, python: 'python3',
    });
    // an empty variable (a blank line of a Compose file) keeps the default
    expect(readConfig({ PORT: '', DEMO_DIR: '', DEMO_EMULATORS: ' ', DEMO_VIRTUAL: '', DEMO_RESET_AT: '', DEMO_IDLE_RESET: '' })).toEqual(readConfig({}));
  });

  it('takes its settings from the environment', () => {
    expect(readConfig({
      PORT: '9000', DEMO_DIR: '/data', DEMO_EMULATORS: 'none', DEMO_VIRTUAL: 'DSP206, 408 408',
      DEMO_RESET_AT: 'off', DEMO_IDLE_RESET: '0', PYTHON: '/opt/emulator/bin/python',
    })).toEqual({
      port: 9000, dir: '/data', emulators: [], virtual: ['206', '408', '408'],
      resetAt: null, idleMinutes: 0, python: '/opt/emulator/bin/python',
    });
    expect(() => readConfig({ DEMO_EMULATORS: '206,308' })).toThrow('DEMO_EMULATORS: unknown model "308"');
    expect(() => readConfig({ DEMO_IDLE_RESET: '-5' })).toThrow('DEMO_IDLE_RESET');
    expect(() => readConfig({ PORT: 'http' })).toThrow('PORT');
  });

  it('resets at the next given time', () => {
    const at = { h: 4, m: 0 };
    expect(nextAt(at, new Date(2026, 10, 2, 3, 59))).toEqual(new Date(2026, 10, 2, 4, 0));
    expect(nextAt(at, new Date(2026, 10, 2, 4, 0))).toEqual(new Date(2026, 10, 3, 4, 0));
    expect(nextAt(at, new Date(2026, 10, 2, 18, 30))).toEqual(new Date(2026, 10, 3, 4, 0));
    expect(nextAt(at, new Date(2026, 11, 31, 12, 0))).toEqual(new Date(2027, 0, 1, 4, 0));
  });

  it('remembers its DSPs as if they had been added from the interface', () => {
    const devices = seedDevices(['206', '408'], ['408', '408']);
    expect(devices).toEqual([
      { spec: { kind: 'tcp', host: '127.0.0.1', port: 9761 }, label: 'DSP 206 émulé' },
      { spec: { kind: 'tcp', host: '127.0.0.1', port: 9762 }, label: 'DSP 408 émulé' },
      { spec: { kind: 'demo', model: 'dsp408' } },
      { spec: { kind: 'demo', model: 'dsp408', deviceId: 2 } },
    ]);
    // the bridge in sandbox mode lets visitors reach exactly these emulated DSPs
    expect(sandboxOf(devices).endpoints).toEqual([
      { host: '127.0.0.1', port: 9761, name: 'DSP 206 émulé' },
      { host: '127.0.0.1', port: 9762, name: 'DSP 408 émulé' },
    ]);
  });
});
