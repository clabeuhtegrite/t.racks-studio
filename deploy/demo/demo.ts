#!/usr/bin/env node
// Demo instance of t.racks Studio, for a public test and demo server (the `demo` command of the
// Docker image): the real DSP 206 and DSP 408 firmware running in the emulator, a demo DSP with
// moving meters, and the bridge in sandbox mode, so visitors reach these DSPs and nothing else of
// the server's network. The instance starts from a clean state at each start, every night and once
// nobody has had it open for a while. Guide: docs/demo.md
//
//   node deploy/demo/demo.ts        (Node >= 22.18; the emulator needs Python 3.10+ and unicorn)
//
// Settings (environment variables):
//   PORT              HTTP port of the interface (8080)
//   DEMO_DIR          working folder: firmware cache and the state of the instance
//                     (/data in the Docker image, ~/.dsp-studio-demo otherwise)
//   DEMO_EMULATORS    DSPs running the real firmware: "206,408" (default) or "none"
//   DEMO_VIRTUAL      demo DSPs (simulated, with moving meters): "408" (default) or "none"
//   DEMO_RESET_AT     daily reset, local time (TZ variable): "04:00" (default) or "off"
//   DEMO_IDLE_RESET   minutes without any open screen before a reset: 30 (default), 0 = never
//   DSP_STUDIO_PIN, DSP_STUDIO_OPERATOR_PIN
//                     access codes (none: every visitor can change every setting)
//   PYTHON            Python of the emulator (python3)
//
// The firmware belongs to Thomann and is never part of the image: it is downloaded from Thomann's
// site at the first start (emulator/fetch_firmware.py) and kept in DEMO_DIR/firmware.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const MODELS = ['206', '408'] as const;
export type Model = (typeof MODELS)[number];
/** first TCP port of the emulated DSPs (9761 like the Ethernet module, then 9762...) */
export const EMULATOR_PORT = 9761;

export interface DemoConfig {
  port: number;
  dir: string;
  emulators: Model[];
  virtual: Model[];
  resetAt: { h: number; m: number } | null;
  idleMinutes: number;
  python: string;
}

const log = (msg: string): void => console.log(`[demo] ${msg}`);

function models(value: string | undefined, fallback: string, name: string): Model[] {
  const raw = (value?.trim() || fallback).toLowerCase();
  if (['', 'none', 'off', 'no', '0'].includes(raw)) return [];
  return raw.split(/[\s,;]+/).filter(Boolean).map((p) => {
    const m = p.replace(/^dsp\s*/, '');
    if (!(MODELS as readonly string[]).includes(m)) throw new Error(`${name}: unknown model "${p}" (206 or 408)`);
    return m as Model;
  });
}

/** "04:00" -> { h: 4, m: 0 }; "off" -> null */
export function parseTime(value: string): { h: number; m: number } | null {
  const v = value.trim().toLowerCase();
  if (['', 'off', 'none', 'never', 'no'].includes(v)) return null;
  const m = /^(\d{1,2})[:h](\d{2})$/.exec(v);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`DEMO_RESET_AT: "${value}" is not a time such as 04:00`);
  return { h: Number(m[1]), m: Number(m[2]) };
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): DemoConfig {
  const idle = env.DEMO_IDLE_RESET?.trim() ? Number(env.DEMO_IDLE_RESET) : 30;
  if (!Number.isFinite(idle) || idle < 0) throw new Error(`DEMO_IDLE_RESET: "${env.DEMO_IDLE_RESET}" is not a number of minutes`);
  const port = env.PORT?.trim() ? Number(env.PORT) : 8080;
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) throw new Error(`PORT: "${env.PORT}" is not a port number`);
  return {
    port,
    dir: resolve(env.DEMO_DIR || join(os.homedir(), '.dsp-studio-demo')),
    emulators: models(env.DEMO_EMULATORS, '206,408', 'DEMO_EMULATORS'),
    virtual: models(env.DEMO_VIRTUAL, '408', 'DEMO_VIRTUAL'),
    resetAt: parseTime(env.DEMO_RESET_AT?.trim() || '04:00'),
    idleMinutes: idle,
    python: env.PYTHON || 'python3',
  };
}

/** The next time it is h:m (local time) after `from`. */
export function nextAt(t: { h: number; m: number }, from = new Date()): Date {
  const d = new Date(from);
  d.setHours(t.h, t.m, 0, 0);
  if (d <= from) {
    d.setDate(d.getDate() + 1);
    d.setHours(t.h, t.m, 0, 0); // a change of summer time in between keeps the hour
  }
  return d;
}

export interface SeedDevice {
  spec: { kind: 'tcp'; host: string; port: number } | { kind: 'demo'; model: 'dsp206' | 'dsp408'; deviceId?: number };
  label?: string;
}

/**
 * What the bridge remembers at start, as if they had been added from the interface: the emulated
 * DSPs (Ethernet on this computer only), then the demo DSPs. Nothing is connected: visitors connect
 * them from the interface. The labels are French texts that the interface translates.
 */
export function seedDevices(emulators: Model[], virtual: Model[]): SeedDevice[] {
  const seen = new Map<Model, number>();
  return [
    ...emulators.map((m, i): SeedDevice => ({ spec: { kind: 'tcp', host: '127.0.0.1', port: EMULATOR_PORT + i }, label: `DSP ${m} émulé` })),
    ...virtual.map((m): SeedDevice => {
      const n = (seen.get(m) ?? 0) + 1;
      seen.set(m, n);
      return { spec: { kind: 'demo', model: `dsp${m}`, ...(n > 1 ? { deviceId: n } : {}) } };
    }),
  ];
}

const firmwareFile = (dir: string, m: Model): string => join(dir, 'firmware', `dsp${m}-v0104p.bin`);

// ------------------------------------------------------------------------------------ processes

class Child {
  readonly name: string;
  private readonly cmd: string;
  private readonly args: string[];
  private readonly env: NodeJS.ProcessEnv;
  private proc: ChildProcess | null = null;
  private wanted = false;
  private delay = 3000;
  private startedAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(name: string, cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
    this.name = name;
    this.cmd = cmd;
    this.args = args;
    this.env = env;
  }

  start(): void {
    this.wanted = true;
    this.startedAt = Date.now();
    const p = spawn(this.cmd, this.args, { cwd: ROOT, env: this.env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = p;
    for (const stream of [p.stdout, p.stderr]) {
      if (stream) createInterface({ input: stream }).on('line', (line) => console.log(`[${this.name}] ${line}`));
    }
    p.on('error', (e) => log(`${this.name}: ${e.message}`));
    p.on('exit', (code, signal) => {
      if (this.proc !== p) return;
      this.proc = null;
      if (!this.wanted) return;
      // a process that keeps failing is started again less and less often (at most once a minute)
      if (Date.now() - this.startedAt > 60_000) this.delay = 3000;
      log(`${this.name} stopped (${signal ?? `code ${code}`}), starting it again in ${this.delay / 1000} s`);
      this.timer = setTimeout(() => { this.timer = null; if (this.wanted) this.start(); }, this.delay);
      this.delay = Math.min(this.delay * 2, 60_000);
    });
  }

  /** Stops the process: SIGTERM, then SIGKILL after 8 s. */
  async stop(): Promise<void> {
    this.wanted = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const p = this.proc;
    if (!p || p.exitCode !== null || p.signalCode !== null) { this.proc = null; return; }
    await new Promise<void>((res) => {
      const kill = setTimeout(() => p.kill('SIGKILL'), 8000);
      p.once('exit', () => { clearTimeout(kill); res(); });
      p.kill('SIGTERM');
    });
    this.proc = null;
  }
}

// ------------------------------------------------------------------------------------ the demo

export class Demo {
  readonly cfg: DemoConfig;
  private children: Child[] = [];
  private busy = false;
  private stopped = false;
  /** a screen was open since the last reset */
  private visited = false;
  private lastSeen = Date.now();
  private dailyTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(cfg: DemoConfig) { this.cfg = cfg; }

  private emulatorReady(): boolean {
    const r = spawnSync(this.cfg.python, ['-c', 'import unicorn'], { stdio: 'ignore' });
    return r.status === 0;
  }

  /** The models whose firmware is here, downloading the missing ones from Thomann's site. */
  private emulatorModels(): Model[] {
    const want = this.cfg.emulators;
    if (!want.length) return [];
    if (!this.emulatorReady()) {
      log(`the firmware emulator needs Python 3 with unicorn (${this.cfg.python} -m pip install unicorn): demo DSPs only`);
      return [];
    }
    const missing = [...new Set(want)].filter((m) => !existsSync(firmwareFile(this.cfg.dir, m)));
    if (missing.length) {
      log(`downloading the official firmware of the DSP ${missing.join(' and ')} from Thomann's site (once)`);
      const r = spawnSync(this.cfg.python, [join(ROOT, 'emulator/fetch_firmware.py'), '--out', join(this.cfg.dir, 'firmware'), ...missing], {
        cwd: ROOT, stdio: 'inherit', env: { ...process.env, PYTHONUNBUFFERED: '1' }, timeout: 180_000,
      });
      if (r.status !== 0) log('the firmware could not be downloaded: those DSPs are left out until the next reset');
    }
    return want.filter((m) => existsSync(firmwareFile(this.cfg.dir, m)));
  }

  /** Starts the emulators and the bridge from a clean state. */
  async start(): Promise<void> {
    const { cfg } = this;
    const run = join(cfg.dir, 'run');
    await rm(run, { recursive: true, force: true });
    await mkdir(join(run, 'bridge'), { recursive: true });
    const emulators = this.emulatorModels();
    const devices = seedDevices(emulators, cfg.virtual);
    await writeFile(join(run, 'bridge', 'bridge.json'), JSON.stringify({ devices }, null, 1));

    const pyEnv = { ...process.env, PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1' };
    this.children = emulators.map((m, i) => new Child(`dsp${m}${emulators.length > new Set(emulators).size ? `-${i + 1}` : ''}`, cfg.python, [
      join(ROOT, 'emulator/server.py'), m, '--host', '127.0.0.1', '--port', String(EMULATOR_PORT + i),
      '--firmware', firmwareFile(cfg.dir, m), '--state', join(run, `emulator-${i + 1}`), '--pause-when-idle',
    ], pyEnv));
    this.children.push(new Child('bridge', process.execPath, [
      join(ROOT, 'apps/bridge/src/main.ts'), '--data', join(run, 'bridge'), '--port', String(cfg.port), '--sandbox',
    ]));
    for (const c of this.children) c.start();
    this.visited = false;
    this.lastSeen = Date.now();
    const list = [
      ...emulators.map((m, i) => `DSP ${m} (real firmware, emulated on port ${EMULATOR_PORT + i})`),
      ...cfg.virtual.map((m) => `demo DSP ${m}`),
    ];
    log(`ready on port ${cfg.port}: ${list.join(', ') || 'no DSP'}`);
  }

  private async stopChildren(): Promise<void> {
    await Promise.all(this.children.map((c) => c.stop()));
    this.children = [];
  }

  /** Everything back to the start: devices, settings in the DSPs, library, automatic gain. */
  async reset(why: string): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      log(`reset (${why})`);
      await this.stopChildren();
      if (!this.stopped) await this.start();
    } finally { this.busy = false; }
  }

  private armDaily(): void {
    const at = this.cfg.resetAt;
    if (!at || this.stopped) return;
    const next = nextAt(at);
    this.dailyTimer = setTimeout(() => {
      this.dailyTimer = null;
      const go = this.visited ? this.reset(`daily, ${String(at.h).padStart(2, '0')}:${String(at.m).padStart(2, '0')}`) : Promise.resolve();
      void go.finally(() => this.armDaily());
    }, next.getTime() - Date.now());
  }

  /** Counts the open screens (the bridge's /api/health) and resets once nobody is left for a while. */
  private async checkIdle(): Promise<void> {
    if (this.busy || this.stopped) return;
    let clients: number;
    try {
      const r = await fetch(`http://127.0.0.1:${this.cfg.port}/api/health`, { signal: AbortSignal.timeout(5000) });
      clients = Number(((await r.json()) as { clients?: unknown }).clients) || 0;
    } catch { return; } // the bridge is starting
    if (clients > 0) { this.visited = true; this.lastSeen = Date.now(); return; }
    const idle = this.cfg.idleMinutes;
    if (this.visited && idle > 0 && Date.now() - this.lastSeen >= idle * 60_000) await this.reset(`nobody for ${idle} min`);
  }

  async run(): Promise<void> {
    const { cfg } = this;
    await mkdir(cfg.dir, { recursive: true });
    const daily = cfg.resetAt ? `every day at ${String(cfg.resetAt.h).padStart(2, '0')}:${String(cfg.resetAt.m).padStart(2, '0')}` : '';
    const idle = cfg.idleMinutes > 0 ? `after ${cfg.idleMinutes} min without visitors` : '';
    log(`t.racks Studio demo instance; data in ${cfg.dir}; reset at each start${daily ? `, ${daily}` : ''}${idle ? `, ${idle}` : ''}`);
    await this.start();
    this.armDaily();
    this.idleTimer = setInterval(() => { void this.checkIdle(); }, 20_000);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.dailyTimer) clearTimeout(this.dailyTimer);
    if (this.idleTimer) clearInterval(this.idleTimer);
    await this.stopChildren();
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let demo: Demo;
  try {
    demo = new Demo(readConfig());
  } catch (e) {
    console.error(`[demo] ${(e as Error).message}`);
    process.exit(2);
  }
  let stopping = false;
  const stop = (): void => {
    if (stopping) process.exit(1);
    stopping = true;
    log('stopping');
    void demo.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  demo.run().catch((e: Error) => { console.error(e); process.exit(1); });
}
