// Automatic gain of every device (see packages/protocol/src/leveler.ts). It runs in the bridge, so it
// works with no screen open, and follows each device's connection. Settings and reference gains
// are kept in <data>/leveler.json.

import { EventEmitter } from 'node:events';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { GAIN_RAW_MAX, Leveler, restoreLevelerSettings, type LevelerSettings } from '@dsp-studio/protocol';
import type { Hub } from './hub.ts';

interface Remembered { settings: LevelerSettings; base: number[] | null }

const validBase = (v: unknown): number[] | null =>
  Array.isArray(v) && v.length >= 1 && v.length <= 4 && v.every((x) => Number.isInteger(x) && x >= 0 && x <= GAIN_RAW_MAX) ? (v as number[]) : null;

export class Levelers extends EventEmitter {
  private readonly map = new Map<string, Leveler>();
  private remembered: Record<string, Remembered> = {};
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> = Promise.resolve();
  private readonly hub: Hub;
  private readonly file: string | null;
  private readonly log: (m: string) => void;

  constructor(hub: Hub, file: string | null, log: (m: string) => void = () => {}) {
    super();
    this.hub = hub;
    this.file = file;
    this.log = log;
  }

  async init(): Promise<void> {
    if (this.file) {
      try {
        const j = JSON.parse(await readFile(this.file, 'utf8')) as { devices?: Record<string, { settings?: unknown; base?: unknown }> };
        for (const [key, v] of Object.entries(j.devices ?? {})) {
          this.remembered[key] = { settings: restoreLevelerSettings(v?.settings), base: validBase(v?.base) };
        }
      } catch { /* nothing remembered yet */ }
    }
    this.hub.on('devices', () => this.sync());
    this.sync();
  }

  find(key: string): Leveler | undefined { return this.map.get(key); }

  get(key: string): Leveler {
    const lv = this.map.get(key);
    if (!lv) throw new Error('appareil inconnu');
    return lv;
  }

  /** One automatic gain per device, attached to its session while the device is online. */
  sync(): void {
    for (const d of this.hub.devices.values()) {
      let lv = this.map.get(d.key);
      if (!lv) {
        const r = this.remembered[d.key];
        const key = d.key;
        lv = new Leveler({ settings: r?.settings, base: r?.base ?? null, save: (settings, base) => this.remember(key, settings, base) });
        lv.onState((st) => this.emit('state', key, st));
        this.map.set(key, lv);
      }
      if (d.session && d.state === 'online') lv.attach(d.session);
      else if (lv.attached) lv.detach();
    }
    for (const [key, lv] of this.map) {
      if (this.hub.devices.has(key)) continue;
      lv.detach();
      this.map.delete(key);
      if (this.remembered[key]) { delete this.remembered[key]; this.schedule(); }
    }
  }

  private remember(key: string, settings: LevelerSettings, base: number[] | null): void {
    this.remembered[key] = { settings, base };
    this.schedule();
  }

  private schedule(): void {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; void this.write(); }, 1000);
  }

  private write(): Promise<void> {
    const file = this.file;
    if (!file) return Promise.resolve();
    const text = JSON.stringify({ devices: this.remembered }, null, 1);
    this.writing = this.writing.then(async () => {
      try {
        await writeFile(file + '.tmp', text);
        await rename(file + '.tmp', file);
      } catch (e) { this.log(`impossible d’enregistrer ${file} : ${(e as Error).message}`); }
    });
    return this.writing;
  }

  /** Writes what is pending (at shutdown). */
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; await this.write(); }
    await this.writing;
  }
}
