// Automatic gain in the bridge: one per device, remembered across restarts, shared with every screen,
// with the rights of each role.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import type { LevelerState } from '@dsp-studio/protocol';
import { Hub } from '../src/hub.ts';
import { Levelers } from '../src/leveler.ts';
import { Library } from '../src/library.ts';
import { startServer } from '../src/server.ts';

type Msg = Record<string, unknown> & { t: string };
const KEY = 'demo:dsp206:1';

class Client {
  ws: WebSocket;
  msgs: Msg[] = [];
  private rid = 0;
  private waiters: { f: (m: Msg) => boolean; res: (m: Msg) => void }[] = [];
  constructor(url: string) {
    this.ws = new WebSocket(url);
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

async function waitFor(f: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('automatic gain in the bridge', () => {
  let dir: string;
  let hub: Hub;
  let levelers: Levelers;
  let server: Awaited<ReturnType<typeof startServer>>;
  let url: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsp-leveler-'));
    const library = new Library(join(dir, 'lib'));
    await library.init();
    hub = new Hub();
    hub.add({ kind: 'demo', model: 'dsp206' });
    levelers = new Levelers(hub, join(dir, 'leveler.json'));
    await levelers.init();
    server = await startServer({ port: 0, host: '127.0.0.1', webDir: null, library, hub, levelers, pins: { admin: '1111', operator: '2222' }, log: () => {} });
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
    await waitFor(() => hub.get(KEY)?.state === 'online');
  });

  afterAll(async () => {
    server.close();
    await hub.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('follows the device connection', async () => {
    const lv = levelers.get(KEY);
    expect(lv.attached).toBe(hub.get(KEY)!.session);
    await waitFor(() => lv.state().level !== null); // the demo device plays something
    await hub.disconnect(KEY);
    expect(lv.attached).toBeNull();
    expect(lv.state().status).toBe('offline');
    hub.connect(KEY);
    await waitFor(() => hub.get(KEY)?.state === 'online');
    expect(lv.attached).toBe(hub.get(KEY)!.session);
  });

  it('gives its state to every screen, and the rights of each role', async () => {
    const admin = new Client(url), operator = new Client(url), viewer = new Client(url);
    await Promise.all([admin.open(), operator.open(), viewer.open()]);
    expect((await admin.req({ t: 'hello', pin: '1111' })).ok).toBe(true);
    expect((await operator.req({ t: 'hello', pin: '2222' })).ok).toBe(true);
    expect((await viewer.req({ t: 'hello' })).ok).toBe(true);
    const sub = await viewer.req({ t: 'subscribe', key: KEY });
    expect((sub.value as { leveler: LevelerState }).leveler.settings.enabled).toBe(false);
    await operator.req({ t: 'subscribe', key: KEY });

    // settings: admin only
    expect((await operator.req({ t: 'leveler', key: KEY, op: 'set', value: { target: -12 } })).error).toBe('action réservée à l’administrateur');
    const set = await admin.req({ t: 'leveler', key: KEY, op: 'set', value: { target: -12, tolerance: 3, speed: 'slow' } });
    expect(set.ok).toBe(true);
    expect((set.value as LevelerState).settings).toMatchObject({ target: -12, tolerance: 3, speed: 'slow' });
    expect((await admin.req({ t: 'leveler', key: KEY, op: 'set', value: { speed: 'turbo' } })).error).toBe('vitesse invalide');

    // on / off: operator too, not a viewer
    expect((await viewer.req({ t: 'leveler', key: KEY, op: 'enable', value: true })).error).toBe('action non autorisée pour ce rôle');
    expect((await operator.req({ t: 'leveler', key: KEY, op: 'enable', value: true })).ok).toBe(true);
    const seen = await viewer.wait((m) => m.t === 'leveler' && (m.state as LevelerState).settings.enabled === true);
    expect(seen.key).toBe(KEY);
    expect((await viewer.req({ t: 'leveler', key: KEY, op: 'state' })).ok).toBe(true);
    expect(Array.isArray((await viewer.req({ t: 'leveler', key: KEY, op: 'history' })).value)).toBe(true);
    expect((await viewer.req({ t: 'leveler', key: KEY, op: 'check' })).error).toBe('action réservée à l’administrateur');
    expect((await viewer.req({ t: 'leveler', key: 'nope', op: 'state' })).error).toBe('appareil inconnu');
    expect((await operator.req({ t: 'leveler', key: KEY, op: 'enable', value: false })).ok).toBe(true);
    for (const c of [admin, operator, viewer]) c.close();
  });

  it('remembers its settings for the next start, and forgets a removed device', async () => {
    levelers.get(KEY).update({ target: -16, enabled: true });
    await levelers.flush();
    const saved = JSON.parse(await readFile(join(dir, 'leveler.json'), 'utf8')) as { devices: Record<string, { settings: { target: number } }> };
    expect(saved.devices[KEY].settings.target).toBe(-16);

    const hub2 = new Hub();
    hub2.add({ kind: 'demo', model: 'dsp206' }, undefined, false);
    const again = new Levelers(hub2, join(dir, 'leveler.json'));
    await again.init();
    expect(again.get(KEY).settings).toMatchObject({ target: -16, enabled: true });

    await hub2.remove(KEY);
    expect(again.find(KEY)).toBeUndefined();
    await again.flush();
    const after = JSON.parse(await readFile(join(dir, 'leveler.json'), 'utf8')) as { devices: Record<string, unknown> };
    expect(after.devices[KEY]).toBeUndefined();
    await hub2.close();
  });
});
