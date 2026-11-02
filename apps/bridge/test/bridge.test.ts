// End-to-end tests of the bridge: real HTTP / WebSocket server, demo devices, several clients.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { GAIN_RAW_0DB } from '@dsp-studio/protocol';
import { Hub } from '../src/hub.ts';
import { Library } from '../src/library.ts';
import { originAllowed, sandboxOf, startServer } from '../src/server.ts';
import { parseArgs } from '../src/main.ts';

type Msg = Record<string, unknown> & { t: string };

class TestClient {
  ws: WebSocket;
  msgs: Msg[] = [];
  private rid = 0;
  private waiters: { f: (m: Msg) => boolean; res: (m: Msg) => void }[] = [];
  constructor(url: string, origin?: string) {
    this.ws = new WebSocket(url, origin ? { origin } : undefined);
    this.ws.on('message', (raw) => {
      const m = JSON.parse(String(raw)) as Msg;
      this.msgs.push(m);
      for (const w of [...this.waiters]) if (w.f(m)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.res(m); }
    });
  }
  open(): Promise<void> { return new Promise((res, rej) => { this.ws.once('open', () => res()); this.ws.once('error', rej); }); }
  wait(f: (m: Msg) => boolean, ms = 3000): Promise<Msg> {
    const found = this.msgs.find(f);
    if (found) return Promise.resolve(found);
    return new Promise((res, rej) => {
      const w = { f, res: (m: Msg) => { clearTimeout(t); res(m); } };
      const t = setTimeout(() => { this.waiters.splice(this.waiters.indexOf(w), 1); rej(new Error('timeout')); }, ms);
      this.waiters.push(w);
    });
  }
  async req(msg: Record<string, unknown>): Promise<{ ok: boolean; value?: unknown; error?: string }> {
    const rid = ++this.rid;
    const p = new Promise<Msg>((res) => this.waiters.push({ f: (m) => m.t === 'result' && m.rid === rid, res }));
    this.ws.send(JSON.stringify({ ...msg, rid }));
    return (await p) as unknown as { ok: boolean; value?: unknown; error?: string };
  }
  close(): void { this.ws.close(); }
}

async function waitOnline(hub: Hub, key: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (hub.get(key)?.state === 'online') return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('device not online');
}

describe('bridge server (open access)', () => {
  let dir: string;
  let hub: Hub;
  let url: string;
  let base: string;
  let server: Awaited<ReturnType<typeof startServer>>;
  const KEY = 'demo:dsp206:1';

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsp-bridge-'));
    const web = join(dir, 'web');
    await mkdir(join(web, 'assets'), { recursive: true });
    await writeFile(join(web, 'index.html'), '<!doctype html><title>t.racks Studio</title>');
    await writeFile(join(web, 'assets', 'app.js'), 'console.log(1)');
    const library = new Library(join(dir, 'lib'));
    await library.init();
    hub = new Hub();
    hub.add({ kind: 'demo', model: 'dsp206' });
    server = await startServer({ port: 0, host: '127.0.0.1', webDir: web, library, hub, log: () => {} });
    const port = (server.address() as AddressInfo).port;
    url = `ws://127.0.0.1:${port}/ws`;
    base = `http://127.0.0.1:${port}`;
    await waitOnline(hub, KEY);
  });
  afterAll(async () => {
    server.close();
    await hub.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('serves the web app with an SPA fallback and the health endpoint', async () => {
    const h = await (await fetch(`${base}/api/health`)).json() as { ok: boolean; devices: { key: string }[] };
    expect(h.ok).toBe(true);
    expect(h.devices.map((d) => d.key)).toContain(KEY);
    const idx = await fetch(`${base}/`);
    expect(await idx.text()).toContain('t.racks Studio');
    const js = await fetch(`${base}/assets/app.js`);
    expect(js.headers.get('content-type')).toContain('javascript');
    expect(js.headers.get('cache-control')).toContain('immutable');
    const deep = await fetch(`${base}/presets/1`);
    expect(await deep.text()).toContain('t.racks Studio');
    const trav = await fetch(`${base}/..%2f..%2fpackage.json`);
    expect(await trav.text()).not.toContain('"name"');
  });

  it('greets, lists devices and gives the admin role without PIN', async () => {
    const c = new TestClient(url);
    await c.open();
    const w = await c.wait((m) => m.t === 'welcome');
    expect(w.pinRequired).toBe(false);
    const r = await c.req({ t: 'hello', name: 'test' });
    expect(r.ok).toBe(true);
    expect((r.value as { role: string }).role).toBe('admin');
    c.close();
  });

  it('keeps every client in sync and tags actions with their origin', async () => {
    const a = new TestClient(url), b = new TestClient(url);
    await Promise.all([a.open(), b.open()]);
    const wa = await a.wait((m) => m.t === 'welcome');
    await a.req({ t: 'hello' }); await b.req({ t: 'hello' });
    const sub = await a.req({ t: 'subscribe', key: KEY });
    expect(sub.ok).toBe(true);
    const snap = (sub.value as { snap: { config: { inputs: { gain: number }[] } } }).snap;
    expect(snap.config.inputs[0].gain).toBe(GAIN_RAW_0DB);
    await b.req({ t: 'subscribe', key: KEY });

    const r = await a.req({ t: 'action', key: KEY, seq: 7, action: { t: 'gain', ch: 0, raw: 250 } });
    expect(r).toMatchObject({ ok: true });
    const echoA = await a.wait((m) => m.t === 'action' && (m.action as { t: string }).t === 'gain');
    const echoB = await b.wait((m) => m.t === 'action' && (m.action as { t: string }).t === 'gain');
    expect(echoA).toMatchObject({ origin: wa.id, seq: 7, action: { t: 'gain', ch: 0, raw: 250 } });
    expect(echoB).toMatchObject({ origin: wa.id, seq: 7 });
    expect(hub.get(KEY)!.session!.config!.inputs[0].gain).toBe(250);
    expect(hub.get(KEY)!.sim!.config.inputs[0].gain).toBe(250);

    // meters stream to subscribers
    const meters = await b.wait((m) => m.t === 'meters');
    expect((meters.db as number[]).length).toBe(8);
    a.close(); b.close();
  });

  it('validates actions and calls', async () => {
    const c = new TestClient(url);
    await c.open();
    await c.req({ t: 'hello' });
    expect(await c.req({ t: 'action', key: KEY, action: { t: 'gain', ch: 0, raw: 9999 } })).toMatchObject({ ok: false, error: 'gain invalide' });
    expect(await c.req({ t: 'action', key: KEY, action: { t: 'geq', ch: 3, band: 0, raw: 120 } })).toMatchObject({ ok: false, error: 'entrée invalide' });
    expect(await c.req({ t: 'action', key: KEY, action: { t: 'boom' } })).toMatchObject({ ok: false, error: 'action inconnue' });
    expect(await c.req({ t: 'call', key: KEY, method: 'constructor' })).toMatchObject({ ok: false, error: 'méthode inconnue' });
    expect(await c.req({ t: 'call', key: KEY, method: 'loadPreset', args: [99] })).toMatchObject({ ok: false, error: 'preset invalide' });
    expect(await c.req({ t: 'call', key: KEY, method: 'pushConfig', args: [{ model: 'dsp408' }] })).toMatchObject({ ok: false });
    expect(await c.req({ t: 'action', key: 'nope', action: { t: 'mute', ch: 0, on: true } })).toMatchObject({ ok: false, error: 'appareil inconnu' });
    c.close();
  });

  it('stores and recalls presets through calls', async () => {
    const c = new TestClient(url);
    await c.open();
    await c.req({ t: 'hello' });
    await c.req({ t: 'action', key: KEY, action: { t: 'mute', ch: 2, on: true } });
    expect(await c.req({ t: 'call', key: KEY, method: 'storePreset', args: [3, 'Concert'] })).toMatchObject({ ok: true });
    expect(await c.req({ t: 'call', key: KEY, method: 'loadPreset', args: [0] })).toMatchObject({ ok: true });
    expect(hub.get(KEY)!.session!.config!.outputs[0].mute).toBe(false);
    expect(await c.req({ t: 'call', key: KEY, method: 'loadPreset', args: [3] })).toMatchObject({ ok: true });
    const s = hub.get(KEY)!.session!;
    expect(s.config!.outputs[0].mute).toBe(true);
    expect(s.config!.presetName).toBe('Concert');
    expect(s.snap.presets[2]).toMatchObject({ slot: 3, name: 'Concert', user: true });
    c.close();
  });

  it('shares a library between clients', async () => {
    const c = new TestClient(url);
    await c.open();
    await c.req({ t: 'hello' });
    const saved = await c.req({ t: 'library.save', entry: { kind: 'preset', model: 'dsp206', name: 'Salle A', data: { x: 1 }, tags: ['salle'] } });
    expect(saved.ok).toBe(true);
    const id = (saved.value as { id: string }).id;
    const list = await c.req({ t: 'library.list' });
    expect((list.value as { id: string; name: string }[]).find((e) => e.id === id)?.name).toBe('Salle A');
    const got = await c.req({ t: 'library.get', id });
    expect((got.value as { data: unknown }).data).toEqual({ x: 1 });
    expect(await c.req({ t: 'library.get', id: '../../etc/passwd' })).toMatchObject({ ok: false, error: 'identifiant invalide' });
    expect(await c.req({ t: 'library.remove', id })).toMatchObject({ ok: true });
    c.close();
  });

  it('refuses web pages from other origins', async () => {
    const c = new TestClient(url, 'https://evil.example');
    await expect(c.open()).rejects.toThrow();
    expect(originAllowed(undefined, 'x')).toBe(true);
    expect(originAllowed('http://192.168.1.5:8080', '192.168.1.5:8080')).toBe(true);
    expect(originAllowed('http://localhost:5173', '192.168.1.5:8080')).toBe(true);
    expect(originAllowed('https://evil.example', '192.168.1.5:8080')).toBe(false);
    expect(originAllowed('https://ad.github.io', '192.168.1.5:8080', ['https://ad.github.io'])).toBe(true);
  });
});

describe('bridge server (PIN roles)', () => {
  let dir: string;
  let hub: Hub;
  let url: string;
  let server: Awaited<ReturnType<typeof startServer>>;
  const KEY = 'demo:dsp408:1';

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsp-bridge-'));
    const library = new Library(join(dir, 'lib'));
    await library.init();
    hub = new Hub();
    hub.add({ kind: 'demo', model: 'dsp408' });
    server = await startServer({ port: 0, host: '127.0.0.1', webDir: null, library, hub, pins: { admin: '4321', operator: '1111' }, log: () => {} });
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
    await waitOnline(hub, KEY);
  });
  afterAll(async () => {
    server.close();
    await hub.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('viewer, operator and admin rights', async () => {
    const v = new TestClient(url);
    await v.open();
    expect((await v.wait((m) => m.t === 'welcome')).pinRequired).toBe(true);
    expect((await v.req({ t: 'hello' })).value).toMatchObject({ role: 'viewer' });
    expect(await v.req({ t: 'subscribe', key: KEY })).toMatchObject({ ok: true });
    expect(await v.req({ t: 'action', key: KEY, action: { t: 'mute', ch: 0, on: true } })).toMatchObject({ ok: false, error: 'action non autorisée pour ce rôle' });

    const o = new TestClient(url);
    await o.open();
    expect((await o.req({ t: 'hello', pin: '1111' })).value).toMatchObject({ role: 'operator' });
    expect(await o.req({ t: 'action', key: KEY, action: { t: 'gain', ch: 4, raw: 200 } })).toMatchObject({ ok: true });
    expect(await o.req({ t: 'action', key: KEY, action: { t: 'phase', ch: 4, inv: true } })).toMatchObject({ ok: false });
    expect(await o.req({ t: 'call', key: KEY, method: 'loadPreset', args: [0] })).toMatchObject({ ok: true });
    expect(await o.req({ t: 'call', key: KEY, method: 'factoryReset' })).toMatchObject({ ok: false });
    expect(await o.req({ t: 'add', spec: { kind: 'demo', model: 'dsp206' } })).toMatchObject({ ok: false });

    const a = new TestClient(url);
    await a.open();
    expect((await a.req({ t: 'hello', pin: '4321' })).value).toMatchObject({ role: 'admin' });
    expect(await a.req({ t: 'action', key: KEY, action: { t: 'phase', ch: 4, inv: true } })).toMatchObject({ ok: true });
    v.close(); o.close(); a.close();
  });

  it('locks an address out after repeated wrong PINs', async () => {
    const c = new TestClient(url);
    await c.open();
    for (let i = 0; i < 5; i++) expect(await c.req({ t: 'hello', pin: '0000' })).toMatchObject({ ok: false, error: 'code incorrect' });
    expect(await c.req({ t: 'hello', pin: '4321' })).toMatchObject({ ok: false, error: 'trop de codes erronés, réessayez dans une minute' });
    c.close();
  });
});

describe('bridge server (demo instance open to anyone)', () => {
  let dir: string;
  let hub: Hub;
  let url: string;
  let base: string;
  let server: Awaited<ReturnType<typeof startServer>>;
  const EMULATED = { kind: 'tcp', host: '127.0.0.1', port: 19761 } as const;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsp-bridge-'));
    const library = new Library(join(dir, 'lib'));
    await library.init();
    hub = new Hub();
    hub.add(EMULATED, 'DSP 206 émulé', false);
    hub.add({ kind: 'demo', model: 'dsp408' }, undefined, false);
    const sandbox = { ...sandboxOf([{ spec: EMULATED, label: 'DSP 206 émulé' }, { spec: { kind: 'demo', model: 'dsp408' } }]), maxDevices: 3, maxLibrary: 2 };
    server = await startServer({ port: 0, host: '127.0.0.1', webDir: null, library, hub, sandbox, log: () => {} });
    const port = (server.address() as AddressInfo).port;
    url = `ws://127.0.0.1:${port}/ws`;
    base = `http://127.0.0.1:${port}`;
  });
  afterAll(async () => {
    server.close();
    await hub.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('takes its emulated DSPs from the remembered devices', () => {
    expect(sandboxOf([
      { spec: { kind: 'tcp', host: '127.0.0.1', port: 9761 }, label: 'DSP 206 émulé' },
      { spec: { kind: 'tcp', host: '127.0.0.1' } },
      { spec: { kind: 'demo', model: 'dsp206' } },
    ])).toEqual({
      endpoints: [{ host: '127.0.0.1', port: 9761, name: 'DSP 206 émulé' }, { host: '127.0.0.1', port: 9761, name: 'Module Ethernet' }],
      maxDevices: 8, maxLibrary: 50,
    });
  });

  it('says so, and searches the network without touching it', async () => {
    const c = new TestClient(url);
    await c.open();
    expect((await c.req({ t: 'hello' })).value).toMatchObject({ role: 'admin', sandbox: true });
    expect((await c.req({ t: 'discover', sweep: true })).value).toEqual([{ host: '127.0.0.1', port: 19761, name: 'DSP 206 émulé', mac: '', via: 'tcp' }]);
    expect((await c.req({ t: 'ports' })).value).toEqual({ usb: [], serial: [] });
    c.close();
  });

  it('reaches its emulated DSPs and demo DSPs, nothing else', async () => {
    const c = new TestClient(url);
    await c.open();
    await c.req({ t: 'hello' });
    const lan = 'instance de démonstration : seuls ses DSP émulés sont accessibles (Rechercher sur le réseau les affiche)';
    expect(await c.req({ t: 'add', spec: { kind: 'tcp', host: '192.168.1.101' } })).toMatchObject({ ok: false, error: lan });
    expect(await c.req({ t: 'add', spec: { kind: 'tcp', host: '127.0.0.1', port: 8080 } })).toMatchObject({ ok: false, error: lan });
    expect(await c.req({ t: 'probe', spec: { kind: 'tcp', host: '10.0.0.1' } })).toMatchObject({ ok: false, error: lan });
    const local = 'instance de démonstration : seuls ses DSP émulés et les DSP de démonstration sont accessibles';
    expect(await c.req({ t: 'add', spec: { kind: 'serial', path: '/dev/ttyUSB0' } })).toMatchObject({ ok: false, error: local });
    expect(await c.req({ t: 'probe', spec: { kind: 'usb', path: '/dev/hidraw0' } })).toMatchObject({ ok: false, error: local });
    // the emulator takes one connection at a time: no second device on its address
    const taken = 'cet appareil est déjà dans la liste des appareils mémorisés';
    expect(await c.req({ t: 'add', spec: { ...EMULATED, deviceId: 2 } })).toMatchObject({ ok: false, error: taken });
    expect(await c.req({ t: 'probe', spec: EMULATED })).toMatchObject({ ok: false, error: taken });
    // demo DSPs, up to the limit of the instance
    expect(await c.req({ t: 'add', spec: { kind: 'demo', model: 'dsp206' } })).toMatchObject({ ok: true });
    expect(await c.req({ t: 'add', spec: { kind: 'demo', model: 'dsp206', deviceId: 2 } })).toMatchObject({ ok: false, error: 'instance de démonstration : 3 appareils au plus' });
    // removed, the emulated DSP comes back through the network search
    const key = hub.list().find((d) => d.spec.kind === 'tcp')!.key;
    expect(await c.req({ t: 'remove', key })).toMatchObject({ ok: true });
    expect(await c.req({ t: 'add', spec: EMULATED, label: 'DSP 206 émulé' })).toMatchObject({ ok: true });
    c.close();
  });

  it('keeps the library small', async () => {
    const c = new TestClient(url);
    await c.open();
    await c.req({ t: 'hello' });
    const entry = { kind: 'preset', model: 'dsp206', name: 'Salle', data: { x: 1 } };
    const first = await c.req({ t: 'library.save', entry });
    expect(await c.req({ t: 'library.save', entry })).toMatchObject({ ok: true });
    expect(await c.req({ t: 'library.save', entry })).toMatchObject({ ok: false, error: 'bibliothèque pleine sur cette instance de démonstration' });
    // an entry already there can still be saved again
    const id = (first.value as { id: string }).id;
    expect(await c.req({ t: 'library.save', entry: { ...entry, id, name: 'Salle B' } })).toMatchObject({ ok: true });
    c.close();
  });

  it('counts the open screens', async () => {
    const health = async (): Promise<number> => ((await (await fetch(`${base}/api/health`)).json()) as { clients: number }).clients;
    const c = new TestClient(url);
    await c.open();
    await c.wait((m) => m.t === 'welcome');
    expect(await health()).toBe(1);
    c.close();
    await vi.waitFor(async () => expect(await health()).toBe(0));
  });
});

describe('bridge server (heartbeat)', () => {
  it('drops a screen that no longer answers', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const dir = await mkdtemp(join(tmpdir(), 'dsp-bridge-'));
    const library = new Library(join(dir, 'lib'));
    const hub = new Hub();
    const server = await startServer({ port: 0, host: '127.0.0.1', webDir: null, library, hub, log: () => {} });
    try {
      const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
      const live = new TestClient(url);
      const gone = new WebSocket(url, { autoPong: false });
      await Promise.all([live.open(), new Promise((res) => gone.once('open', res))]);
      const dropped = new Promise((res) => gone.once('close', res));
      vi.advanceTimersByTime(30_000); // ping
      await new Promise((res) => setTimeout(res, 200)); // the answers come back
      vi.advanceTimersByTime(30_000); // no answer since the last ping: dropped
      await dropped;
      expect(live.ws.readyState).toBe(WebSocket.OPEN);
      live.close();
    } finally {
      vi.useRealTimers();
      server.close();
      await hub.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('command line', () => {
  it('parses the server options, PINs also from the environment', () => {
    const a = parseArgs(['--port', '9090', '--pin', '1234', '--operator-pin', '5678', '--data', '/tmp/tracks-test', '--quiet']);
    expect(a).toMatchObject({ port: 9090, pin: '1234', operatorPin: '5678', data: '/tmp/tracks-test', quiet: true });
    process.env.DSP_STUDIO_PIN = '9999';
    try { expect(parseArgs([]).pin).toBe('9999'); } finally { delete process.env.DSP_STUDIO_PIN; }
  });

  it('opens a demo instance to anyone with --sandbox or DSP_STUDIO_SANDBOX', () => {
    expect(parseArgs([]).sandbox).toBe(false);
    expect(parseArgs(['--sandbox']).sandbox).toBe(true);
    process.env.DSP_STUDIO_SANDBOX = '1';
    try { expect(parseArgs([]).sandbox).toBe(true); } finally { delete process.env.DSP_STUDIO_SANDBOX; }
  });

  it('refuses devices on the command line: they are connected from the interface', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code: number) => { throw new Error(`exit ${code}`); }) as never);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const opt of ['--demo', '--tcp', '--usb', '--serial']) expect(() => parseArgs([opt, 'x'])).toThrow('exit 2');
      expect(String(err.mock.calls[0][0])).toContain('--demo');
    } finally { exit.mockRestore(); err.mockRestore(); }
  });
});

describe('remembered devices', () => {
  it('are listed without being connected, then connected and disconnected on request', async () => {
    const hub = new Hub();
    const d = hub.add({ kind: 'demo', model: 'dsp206' }, 'Façade', false);
    expect(d.info()).toMatchObject({ label: 'Façade', state: 'idle' });
    hub.connect(d.key);
    await vi.waitFor(() => expect(d.state).toBe('online'), { timeout: 5000 });
    hub.connect(d.key); // already connected: nothing happens
    expect(d.state).toBe('online');
    await hub.disconnect(d.key);
    expect(d.info()).toMatchObject({ state: 'idle', error: null });
    expect(d.session).toBeNull();
    await hub.close();
  });
});
