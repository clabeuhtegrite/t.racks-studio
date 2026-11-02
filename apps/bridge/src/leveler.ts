// Automatic gain of every device (see packages/protocol/src/leveler.ts). It runs in the bridge, so it
// works with no screen open, and follows each device's connection. Settings, reference gains and the
// count of steps written to the DSP's memory are kept in <data>/leveler.json; the history of the
// night (one point every 10 s, 12 hours) in <data>/leveler-history/<device>.jsonl, a line added per
// point once a minute (gentle on a Raspberry Pi's SD card), so it survives a restart.

import { EventEmitter } from 'node:events';
import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  GAIN_RAW_MAX, Leveler, LEVELER_HISTORY_EVERY_MS, LEVELER_HISTORY_MS, restoreLevelerPoint, restoreLevelerSettings, restoreLevelerTotals,
  type LevelerPoint, type LevelerSettings, type LevelerTotals,
} from '@dsp-studio/protocol';
import type { Hub } from './hub.ts';

interface Remembered { settings: LevelerSettings; base: number[] | null; totals: LevelerTotals | null }

const validBase = (v: unknown): number[] | null =>
  Array.isArray(v) && v.length >= 1 && v.length <= 4 && v.every((x) => Number.isInteger(x) && x >= 0 && x <= GAIN_RAW_MAX) ? (v as number[]) : null;

/** history points written once a minute; a file twice as long as the history is written again */
const HISTORY_WRITE_MS = 60_000;
const HISTORY_LINES = LEVELER_HISTORY_MS / LEVELER_HISTORY_EVERY_MS;
const historyName = (key: string): string => `${encodeURIComponent(key)}.jsonl`;

export class Levelers extends EventEmitter {
  private readonly map = new Map<string, Leveler>();
  private remembered: Record<string, Remembered> = {};
  /** history read at start, until its device's automatic gain is created */
  private loaded = new Map<string, LevelerPoint[]>();
  /** per device: time of the last point written, lines in its file */
  private written = new Map<string, { t: number; lines: number }>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private historyTimer: ReturnType<typeof setInterval> | null = null;
  private writing: Promise<void> = Promise.resolve();
  private readonly hub: Hub;
  private readonly file: string | null;
  private readonly historyDir: string | null;
  private readonly log: (m: string) => void;

  constructor(hub: Hub, file: string | null, log: (m: string) => void = () => {}) {
    super();
    this.hub = hub;
    this.file = file;
    this.historyDir = file ? join(dirname(file), 'leveler-history') : null;
    this.log = log;
  }

  async init(): Promise<void> {
    if (this.file) {
      try {
        const j = JSON.parse(await readFile(this.file, 'utf8')) as { devices?: Record<string, { settings?: unknown; base?: unknown; totals?: unknown }> };
        for (const [key, v] of Object.entries(j.devices ?? {})) {
          this.remembered[key] = { settings: restoreLevelerSettings(v?.settings), base: validBase(v?.base), totals: restoreLevelerTotals(v?.totals) };
        }
      } catch { /* nothing remembered yet */ }
    }
    await this.readHistories();
    this.hub.on('devices', () => this.sync());
    this.sync();
    if (this.historyDir) {
      this.historyTimer = setInterval(() => { void this.writeHistories(); }, HISTORY_WRITE_MS);
      this.historyTimer.unref?.();
    }
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
        const history = this.loaded.get(key);
        this.loaded.delete(key);
        lv = new Leveler({
          settings: r?.settings, base: r?.base ?? null, totals: r?.totals ?? null, history,
          save: (settings, base, totals) => this.remember(key, settings, base, totals),
        });
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
      this.forgetHistory(key);
    }
  }

  private remember(key: string, settings: LevelerSettings, base: number[] | null, totals: LevelerTotals): void {
    this.remembered[key] = { settings, base, totals };
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

  // ----------------------------------------------------------------- history of the night
  private async readHistories(): Promise<void> {
    const dir = this.historyDir;
    if (!dir) return;
    let names: string[] = [];
    try { names = await readdir(dir); } catch { return; /* nothing yet */ }
    const from = Date.now() - LEVELER_HISTORY_MS;
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      let key: string;
      try { key = decodeURIComponent(name.slice(0, -6)); } catch { continue; }
      try {
        const lines = (await readFile(join(dir, name), 'utf8')).split('\n').filter((l) => l.trim());
        const points: LevelerPoint[] = [];
        for (const line of lines) {
          let p: LevelerPoint | null = null;
          try { p = restoreLevelerPoint(JSON.parse(line)); } catch { /* damaged line (power cut while writing) */ }
          if (p && p.t > from) points.push(p);
        }
        this.loaded.set(key, points);
        this.written.set(key, { t: points.length ? points[points.length - 1].t : 0, lines: lines.length });
      } catch (e) { this.log(`impossible de lire ${join(dir, name)} : ${(e as Error).message}`); }
    }
  }

  /** Adds the new history points of every device to its file (the whole file again when it got long). */
  private writeHistories(): Promise<void> {
    const dir = this.historyDir;
    if (!dir) return Promise.resolve();
    const jobs: { file: string; text: string; whole: boolean }[] = [];
    for (const [key, lv] of this.map) {
      const w = this.written.get(key) ?? { t: 0, lines: 0 };
      const fresh = lv.history(w.t);
      if (!fresh.length) continue;
      const whole = w.lines + fresh.length > 2 * HISTORY_LINES;
      const points = whole ? lv.history() : fresh;
      jobs.push({ file: join(dir, historyName(key)), text: points.map((p) => JSON.stringify(p)).join('\n') + '\n', whole });
      this.written.set(key, { t: fresh[fresh.length - 1].t, lines: whole ? points.length : w.lines + fresh.length });
    }
    if (!jobs.length) return this.writing;
    this.writing = this.writing.then(async () => {
      try {
        await mkdir(dir, { recursive: true });
        for (const j of jobs) {
          if (!j.whole) await appendFile(j.file, j.text);
          else { await writeFile(j.file + '.tmp', j.text); await rename(j.file + '.tmp', j.file); }
        }
      } catch (e) { this.log(`impossible d’enregistrer ${dir} : ${(e as Error).message}`); }
    });
    return this.writing;
  }

  private forgetHistory(key: string): void {
    this.written.delete(key);
    this.loaded.delete(key);
    const dir = this.historyDir;
    if (!dir) return;
    const file = join(dir, historyName(key));
    this.writing = this.writing.then(() => rm(file, { force: true })).catch(() => {});
  }

  /** Writes what is pending (at shutdown). */
  async flush(): Promise<void> {
    for (const lv of this.map.values()) lv.flush();
    if (this.timer) { clearTimeout(this.timer); this.timer = null; await this.write(); }
    await this.writeHistories();
    await this.writing;
  }

  /** Stops writing the history once a minute (the bridge stops). */
  close(): void {
    if (this.historyTimer) { clearInterval(this.historyTimer); this.historyTimer = null; }
  }
}
