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
// Other arguments go to the bridge, such as --allow-origin https://... when a proxy in front of the
// demo changes the Host header (see `node apps/bridge/src/main.ts --help`).
//
// The firmware belongs to Thomann and is never part of the image: it is downloaded from Thomann's
// site at the first start (emulator/fetch_firmware.py) and kept in DEMO_DIR/firmware. The download
// runs in the background: the interface answers at once with the demo DSP, and the emulated DSPs
// come in as soon as no screen is open. A failed download is tried again later, less and less often.

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
  /** more options of the bridge (the arguments of the demo command) */
  bridgeArgs: string[];
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

export function readConfig(env: NodeJS.ProcessEnv = process.env, argv: string[] = []): DemoConfig {
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
    bridgeArgs: argv,
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
/** a download of the firmware gives up after 3 min; after a failure, the next try comes 10 min later,
 *  then 20, 40... and at most every 4 hours */
const FETCH_TIMEOUT_MS = 3 * 60_000;
const FETCH_RETRY_MS = 10 * 60_000;
const FETCH_RETRY_MAX_MS = 4 * 60 * 60_000;

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
  /** connections the bridge had counted at the last look */
  private connections = 0;
  private dailyTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  /** Python and unicorn are there (null: not checked yet) */
  private runtime: boolean | null = null;
  /** the download of the firmware while it runs, and the next try after a failure */
  private fetcher: ChildProcess | null = null;
  private fetchTimer: ReturnType<typeof setTimeout> | null = null;
  private fetchDelay = FETCH_RETRY_MS;
  /** a reset that waits for the last screen to close (its reason) */
  private pending: string | null = null;

  constructor(cfg: DemoConfig) { this.cfg = cfg; }

  private emulatorReady(): boolean {
    if (this.runtime === null) {
      this.runtime = spawnSync(this.cfg.python, ['-c', 'import unicorn'], { stdio: 'ignore' }).status === 0;
      if (!this.runtime && this.cfg.emulators.length) {
        log(`the firmware emulator needs Python 3 with unicorn (${this.cfg.python} -m pip install unicorn): demo DSPs only`);
      }
    }
    return this.runtime;
  }

  /** The models whose firmware is here. */
  private emulatorModels(): Model[] {
    if (!this.cfg.emulators.length || !this.emulatorReady()) return [];
    return this.cfg.emulators.filter((m) => existsSync(firmwareFile(this.cfg.dir, m)));
  }

  /**
   * Downloads the missing firmware from Thomann's site in the background, then starts again with the
   * emulated DSPs once no screen is open. The bridge answers meanwhile: a slow or blocked download
   * never keeps the instance from starting (nor a probe of Kubernetes from finding it alive).
   */
  private fetchMissing(): void {
    if (this.fetcher || this.fetchTimer || this.stopped || !this.cfg.emulators.length || !this.emulatorReady()) return;
    const missing = [...new Set(this.cfg.emulators)].filter((m) => !existsSync(firmwareFile(this.cfg.dir, m)));
    if (!missing.length) return;
    log(`downloading the official firmware of the DSP ${missing.join(' and ')} from Thomann's site`);
    const p = spawn(this.cfg.python, [join(ROOT, 'emulator/fetch_firmware.py'), '--out', join(this.cfg.dir, 'firmware'), ...missing], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });
    this.fetcher = p;
    for (const stream of [p.stdout, p.stderr]) {
      if (stream) createInterface({ input: stream }).on('line', (line) => console.log(`[firmware] ${line}`));
    }
    const timer = setTimeout(() => p.kill('SIGKILL'), FETCH_TIMEOUT_MS);
    const done = (): void => {
      clearTimeout(timer);
      if (this.fetcher !== p) return;
      this.fetcher = null;
      if (this.stopped) return;
      const got = missing.filter((m) => existsSync(firmwareFile(this.cfg.dir, m)));
      if (got.length < missing.length) {
        log(`the firmware could not be downloaded: no emulated DSP for now, next try in ${this.fetchDelay / 60_000} min`);
        this.fetchTimer = setTimeout(() => { this.fetchTimer = null; this.fetchMissing(); }, this.fetchDelay);
        this.fetchDelay = Math.min(this.fetchDelay * 2, FETCH_RETRY_MAX_MS);
      }
      if (got.length) {
        // nobody loses what they are doing: the reset waits for the last screen to close
        this.pending = `firmware of the DSP ${got.join(' and ')} downloaded`;
        void this.checkIdle();
      }
    };
    p.on('exit', done);
    p.on('error', (e) => { log(`firmware download: ${e.message}`); done(); });
  }

  /** Starts the emulators and the bridge from a clean state. */
  async start(): Promise<void> {
    const { cfg } = this;
    const run = join(cfg.dir, 'run');
    await rm(run, { recursive: true, force: true });
    await mkdir(join(run, 'bridge'), { recursive: true });
    this.pending = null; // this start takes the firmware that is here
    const emulators = this.emulatorModels();
    const devices = seedDevices(emulators, cfg.virtual);
    await writeFile(join(run, 'bridge', 'bridge.json'), JSON.stringify({ devices }, null, 1));

    const pyEnv = { ...process.env, PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1' };
    this.children = emulators.map((m, i) => new Child(`dsp${m}${emulators.length > new Set(emulators).size ? `-${i + 1}` : ''}`, cfg.python, [
      join(ROOT, 'emulator/server.py'), m, '--host', '127.0.0.1', '--port', String(EMULATOR_PORT + i),
      '--firmware', firmwareFile(cfg.dir, m), '--state', join(run, `emulator-${i + 1}`), '--pause-when-idle',
    ], pyEnv));
    this.children.push(new Child('bridge', process.execPath, [
      join(ROOT, 'apps/bridge/src/main.ts'), '--data', join(run, 'bridge'), '--port', String(cfg.port), '--sandbox', ...cfg.bridgeArgs,
    ]));
    for (const c of this.children) c.start();
    this.visited = false;
    this.lastSeen = Date.now();
    this.connections = 0;
    const list = [
      ...emulators.map((m, i) => `DSP ${m} (real firmware, emulated on port ${EMULATOR_PORT + i})`),
      ...cfg.virtual.map((m) => `demo DSP ${m}`),
    ];
    log(`ready on port ${cfg.port}: ${list.join(', ') || 'no DSP'}`);
    this.fetchMissing();
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

  /**
   * Looks at the screens (the bridge's /api/health: open now, connections since its start) and resets
   * once nobody has come for a while, or as soon as no screen is open for a waiting reset. The bridge
   * itself disconnects the DSPs two minutes after the last screen, so the emulators rest in between.
   */
  private async checkIdle(): Promise<void> {
    if (this.busy || this.stopped) return;
    let clients: number, connections: number;
    try {
      const r = await fetch(`http://127.0.0.1:${this.cfg.port}/api/health`, { signal: AbortSignal.timeout(5000) });
      const h = (await r.json()) as { clients?: unknown; connections?: unknown };
      clients = Number(h.clients) || 0;
      connections = Number(h.connections) || 0;
    } catch { return; } // the bridge is starting
    if (this.pending && clients === 0) {
      await this.reset(this.pending);
      return;
    }
    if (clients > 0 || connections !== this.connections) {
      // someone is here, or came and left between two looks
      this.visited = true;
      this.lastSeen = Date.now();
      this.connections = connections;
      return;
    }
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
    if (this.fetchTimer) clearTimeout(this.fetchTimer);
    this.fetcher?.kill('SIGKILL');
    await this.stopChildren();
  }
}

const USAGE = `t.racks Studio demo instance: the DSP 206 and DSP 408 firmware in the emulator and a demo DSP,
behind a bridge in sandbox mode, back to the start by itself. Guide: docs/demo.md

  node deploy/demo/demo.ts [bridge options]       (in the Docker image: demo [bridge options])

Environment variables:
  PORT              HTTP port (8080)
  DEMO_DIR          firmware cache and state of the instance (/data in the image)
  DEMO_EMULATORS    DSPs running the real firmware: 206,408 (default) or none
  DEMO_VIRTUAL      demo DSPs with moving meters: 408 (default) or none
  DEMO_RESET_AT     daily reset, local time (TZ): 04:00 (default) or off
  DEMO_IDLE_RESET   minutes without visitors before a reset: 30 (default), 0 = never
  DSP_STUDIO_PIN, DSP_STUDIO_OPERATOR_PIN   access codes (none by default)

Bridge options, such as --allow-origin https://...: node apps/bridge/src/main.ts --help`;

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let demo: Demo;
  try {
    const argv = process.argv.slice(2);
    if (argv.includes('-h') || argv.includes('--help')) {
      console.log(USAGE);
      process.exit(0);
    }
    demo = new Demo(readConfig(process.env, argv));
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
