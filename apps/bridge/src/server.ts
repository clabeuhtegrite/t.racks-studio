// HTTP + WebSocket server of the bridge. Serves the web app and exposes the devices of the hub to
// any number of browsers, which all stay in sync (an edit made on a phone shows up at once on the
// laptop). Optional PIN codes give an "admin" or an "operator" role.

import http from 'node:http';
import https from 'node:https';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { t } from '@dsp-studio/i18n';
import {
  callSession, canApply, canCall, DSP_TCP_PORT, sourceKey, validateAction, validateSource, type Action, type FoundModule, type Role, type SessionSnapshot, type SourceSpec,
} from '@dsp-studio/protocol';
import { discover, probeIds } from './discovery.ts';
import { Hub } from './hub.ts';
import type { Levelers } from './leveler.ts';
import { Library } from './library.ts';
import { listSerial, listUsb, serialTransport, tcpTransport, usbTransport } from './transports.ts';

export const BRIDGE_VERSION = '0.1.0';
export type { Role };
const HEARTBEAT_MS = 30_000;

/**
 * Demo instance open to anyone (--sandbox): visitors may only use the Ethernet devices remembered
 * when the bridge started (the emulated DSPs of the demo) and demo DSPs. Nothing else of the
 * server's network is reachable: no other address, no network search, no USB or serial port.
 */
export interface Sandbox {
  /** Ethernet devices the visitors may use (the network search lists them) */
  endpoints: { host: string; port: number; name: string }[];
  /** devices in the list at most (each demo DSP takes processor time) */
  maxDevices: number;
  /** library entries at most (2 MB each at most: 100 MB) */
  maxLibrary: number;
  /** devices are disconnected once no screen has been open for this long, so the emulators rest */
  idleDisconnectMs: number;
}

/** The sandbox of a bridge whose remembered devices are `devices`. */
export function sandboxOf(devices: { spec: SourceSpec; label?: string }[]): Sandbox {
  const endpoints: Sandbox['endpoints'] = [];
  for (const d of devices) {
    if (d.spec.kind === 'tcp') endpoints.push({ host: d.spec.host, port: d.spec.port ?? DSP_TCP_PORT, name: d.label ?? 'Module Ethernet' });
  }
  return { endpoints, maxDevices: Math.max(8, devices.length + 2), maxLibrary: 50, idleDisconnectMs: 2 * 60_000 };
}

export interface ServerOptions {
  port: number;
  host: string;
  webDir: string | null;
  library: Library;
  hub: Hub;
  /** automatic gain of each device */
  levelers?: Levelers;
  pins?: { admin?: string; operator?: string };
  /** HTTPS (needed by browsers for the microphone / WebHID when not on localhost) */
  tls?: { cert: Buffer | string; key: Buffer | string };
  /** extra web origins allowed to connect (e.g. the app hosted on GitHub Pages), '*' = any */
  allowOrigins?: string[];
  /** demo instance open to anyone: see Sandbox */
  sandbox?: Sandbox;
  onDevicesChanged?: () => void;
  log?: (msg: string) => void;
}

interface Client {
  id: number;
  ip: string;
  ws: WebSocket;
  role: Role;
  name: string;
  subs: Set<string>;
  debug: Set<string>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json',
};

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Browsers let any web page open a WebSocket to any address, so a page from the internet could try
 * to drive the DSP through the bridge. Only the app served by the bridge itself, a dev server on
 * this computer and the origins given with --allow-origin may connect (tools without an Origin
 * header, like the CLI tests, are allowed).
 */
export function originAllowed(origin: string | undefined, host: string | undefined, allowed: string[] = []): boolean {
  if (!origin) return true;
  let u: URL;
  try { u = new URL(origin); } catch { return false; }
  if (host && u.host === host) return true;
  if (LOCAL_HOSTS.has(u.hostname)) return true;
  return allowed.includes('*') || allowed.includes(u.origin);
}

export function startServer(o: ServerOptions): Promise<http.Server | https.Server> {
  const log = o.log ?? ((m: string) => console.log(m));
  const clients = new Map<number, Client>();
  let nextId = 1;
  /** WebSocket connections since the start (a demo instance knows from it whether anyone came) */
  let connections = 0;
  // device key -> client (and its sequence number) whose action is being applied right now
  const origin = new Map<string, { client: number; seq: number }>();

  const send = (c: Client, msg: unknown): void => {
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(msg));
  };
  const toSubs = (key: string, msg: unknown, filter?: (c: Client) => boolean): void => {
    const text = JSON.stringify(msg);
    for (const c of clients.values()) if (c.subs.has(key) && (!filter || filter(c)) && c.ws.readyState === c.ws.OPEN) c.ws.send(text);
  };

  // ----------------------------------------------------------------- hub events -> clients
  const snapTimers = new Map<string, { timer: ReturnType<typeof setTimeout> | null; last: number; pending: SessionSnapshot | null }>();
  const pushSnapshot = (key: string, snap: SessionSnapshot): void => {
    const st = snapTimers.get(key) ?? { timer: null, last: 0, pending: null };
    snapTimers.set(key, st);
    st.pending = snap;
    const flush = (): void => {
      st.timer = null; st.last = Date.now();
      if (st.pending) toSubs(key, { t: 'snapshot', key, snap: st.pending });
      st.pending = null;
    };
    const wait = 100 - (Date.now() - st.last);
    if (wait <= 0) flush();
    else st.timer ??= setTimeout(flush, wait);
  };
  o.hub.on('snapshot', (key: string, snap: SessionSnapshot) => pushSnapshot(key, snap));
  o.hub.on('action', (key: string, a: { action: Action; channels: number[] }) => {
    const from = origin.get(key);
    toSubs(key, { t: 'action', key, action: a.action, origin: from?.client ?? 0, seq: from?.seq ?? 0 });
  });
  o.hub.on('meters', (key: string, m: { db: number[]; status: number }) => toSubs(key, { t: 'meters', key, db: m.db.map((v) => Math.round(v * 10) / 10), status: m.status }));
  o.hub.on('frame', (key: string, f: { dir: string; hex: string; t: number }) => toSubs(key, { t: 'frame', key, dir: f.dir, hex: f.hex, at: f.t }, (c) => c.debug.has(key)));
  o.levelers?.on('state', (key: string, state: unknown) => toSubs(key, { t: 'leveler', key, state }));
  o.hub.on('devices', (list) => {
    for (const c of clients.values()) send(c, { t: 'devices', list });
    o.onDevicesChanged?.();
  });

  // ----------------------------------------------------------------- requests
  // a few wrong PINs from one address lock that address out for a while (4-digit PINs are short)
  const failures = new Map<string, { count: number; until: number }>();
  const checkPin = (c: Client, ip: string, pin: unknown): Role => {
    const f = failures.get(ip);
    if (f && f.until > Date.now()) throw new Error('trop de codes erronés, réessayez dans une minute');
    const role = roleOf(pin);
    const pinGiven = pin !== undefined && pin !== null && pin !== '';
    if (pinGiven && role === 'viewer') {
      const n = (f?.count ?? 0) + 1;
      failures.set(ip, { count: n, until: n >= 5 ? Date.now() + 60_000 : 0 });
      if (n >= 5) log(`trop de codes erronés depuis ${ip}`);
      throw new Error('code incorrect');
    }
    failures.delete(ip);
    c.role = role;
    return role;
  };
  const roleOf = (pin: unknown): Role => {
    const p = o.pins;
    if (!p || (!p.admin && !p.operator)) return 'admin';
    if (p.admin && pin === p.admin) return 'admin';
    if (p.operator && pin === p.operator) return 'operator';
    return 'viewer';
  };
  const deviceOf = (key: unknown) => {
    const d = o.hub.get(String(key));
    if (!d) throw new Error('appareil inconnu');
    return d;
  };
  const sessionOf = (key: unknown) => {
    const s = deviceOf(key).session;
    if (!s) throw new Error("l'appareil n'est pas connecté");
    return s;
  };
  const needAdmin = (c: Client): void => { if (c.role !== 'admin') throw new Error('action réservée à l’administrateur'); };
  const needOperator = (c: Client): void => { if (c.role === 'viewer') throw new Error('action non autorisée pour ce rôle'); };

  // ----------------------------------------------------------------- demo instance (sandbox)
  const sb = o.sandbox;
  /** Refuses, on a demo instance, any device but its emulated DSPs and demo DSPs. */
  const sandboxed = (spec: SourceSpec, use: 'add' | 'probe'): void => {
    if (!sb) return;
    if (spec.kind === 'tcp') {
      const port = spec.port ?? DSP_TCP_PORT;
      if (!sb.endpoints.some((e) => e.host === spec.host && e.port === port)) throw new Error('instance de démonstration : seuls ses DSP émulés sont accessibles (Rechercher sur le réseau les affiche)');
      // an Ethernet module (and the emulator) takes one connection at a time: one device per address
      const key = sourceKey(spec);
      const busy = [...o.hub.devices.values()].some((d) => d.spec.kind === 'tcp' && d.spec.host === spec.host && (d.spec.port ?? DSP_TCP_PORT) === port && (use === 'probe' || d.key !== key));
      if (busy) throw new Error('cet appareil est déjà dans la liste des appareils mémorisés');
    } else if (spec.kind !== 'demo') {
      throw new Error('instance de démonstration : seuls ses DSP émulés et les DSP de démonstration sont accessibles');
    }
    if (use === 'add' && !o.hub.get(sourceKey(spec)) && o.hub.devices.size >= sb.maxDevices) {
      throw new Error(`instance de démonstration : ${sb.maxDevices} appareils au plus`);
    }
  };
  /** On a demo instance, the devices are disconnected once nobody has had a screen open for a while. */
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const nobodyLeft = (): void => {
    if (!sb) return;
    if (clients.size > 0) {
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      return;
    }
    if (idleTimer) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (clients.size > 0) return;
      for (const d of o.hub.devices.values()) if (d.state !== 'idle') void o.hub.disconnect(d.key).catch(() => {});
    }, sb.idleDisconnectMs);
    idleTimer.unref();
  };
  /** The "network search" of a demo instance: its emulated DSPs, without touching the network. */
  const sandboxFound = (): FoundModule[] => (sb?.endpoints ?? []).map((e) => ({
    host: e.host, port: e.port === DSP_TCP_PORT ? undefined : e.port, name: e.name, mac: '', via: 'tcp',
  }));

  async function handle(c: Client, m: Record<string, unknown>): Promise<unknown> {
    switch (m.t) {
      case 'hello':
        checkPin(c, c.ip, m.pin);
        c.name = String(m.name ?? '').slice(0, 40);
        return { version: BRIDGE_VERSION, role: c.role, devices: o.hub.list(), pinRequired: !!(o.pins?.admin || o.pins?.operator), sandbox: !!sb };
      case 'devices': return o.hub.list();
      case 'add': {
        needAdmin(c);
        const spec = validateSource(m.spec);
        sandboxed(spec, 'add');
        const d = o.hub.add(spec, typeof m.label === 'string' ? m.label.slice(0, 60) : undefined);
        return d.info();
      }
      case 'remove': needAdmin(c); await o.hub.remove(String(m.key)); return true;
      case 'rename': {
        needAdmin(c);
        const d = deviceOf(m.key); d.label = String(m.label).slice(0, 60) || d.label;
        o.hub.emit('devices', o.hub.list());
        return true;
      }
      case 'connect': needOperator(c); o.hub.connect(String(deviceOf(m.key).key)); return true;
      case 'disconnect': needOperator(c); await o.hub.disconnect(String(deviceOf(m.key).key)); return true;
      case 'subscribe': {
        const key = String(m.key);
        const d = deviceOf(key);
        c.subs.add(key);
        if (m.debug) c.debug.add(key); else c.debug.delete(key);
        return { info: d.info(), snap: d.snapshot(), leveler: o.levelers?.find(key)?.state() ?? null };
      }
      case 'unsubscribe': c.subs.delete(String(m.key)); c.debug.delete(String(m.key)); return true;
      case 'action': {
        const s = sessionOf(m.key);
        if (!s.snap.model) throw new Error("l'appareil n'est pas prêt");
        const a = validateAction(s.snap.model, m.action);
        if (!canApply(c.role, a)) throw new Error('action non autorisée pour ce rôle');
        if (s.snap.status === 'locked') throw new Error("l'appareil est verrouillé");
        origin.set(String(m.key), { client: c.id, seq: Number(m.seq) || 0 });
        let p: Promise<void>;
        try { p = s.apply(a); } finally { origin.delete(String(m.key)); }
        await p;
        return true;
      }
      case 'call': {
        const method = String(m.method);
        const s = sessionOf(m.key);
        if (!canCall(c.role, method)) throw new Error('action non autorisée pour ce rôle');
        return await callSession(s, method, Array.isArray(m.args) ? m.args : []);
      }
      case 'leveler': {
        // automatic gain: anyone sees it, an operator switches it on and off or pauses it, the admin sets it up
        const lv = o.levelers?.get(String(deviceOf(m.key).key));
        if (!lv) throw new Error('requête inconnue');
        switch (m.op) {
          case 'state': return lv.state();
          case 'history': return lv.history(typeof m.value === 'number' ? m.value : undefined);
          case 'enable': needOperator(c); return lv.enable(m.value === true);
          case 'pause': needOperator(c); return lv.pause(m.value);
          case 'set': needAdmin(c); return lv.update(m.value);
          case 'target': needAdmin(c); return lv.takeTarget();
          case 'check': needAdmin(c); return await lv.checkMeter();
          default: throw new Error('requête inconnue');
        }
      }
      case 'discover': needAdmin(c); return sb ? sandboxFound() : discover({ sweep: !!m.sweep });
      case 'ports': return sb ? { usb: [], serial: [] } : { usb: await listUsb(), serial: await listSerial() };
      case 'probe': {
        needAdmin(c);
        const spec = validateSource(m.spec);
        sandboxed(spec, 'probe');
        const t = spec.kind === 'tcp' ? await tcpTransport(spec.host, spec.port) : spec.kind === 'usb' ? await usbTransport(spec.path) : spec.kind === 'serial' ? await serialTransport(spec.path, spec.baud) : null;
        if (!t) return [];
        try { return await probeIds(t, Number(m.max ?? 16)); } finally { await t.close(); }
      }
      case 'library.list': return o.library.list();
      case 'library.get': return o.library.get(String(m.id));
      case 'library.save': {
        needAdmin(c);
        if (sb) {
          const id = (m.entry as { id?: unknown } | null)?.id;
          const list = await o.library.list();
          if (list.length >= sb.maxLibrary && !list.some((e) => e.id === id)) throw new Error('bibliothèque pleine sur cette instance de démonstration');
        }
        return o.library.save(m.entry as Parameters<Library['save']>[0]);
      }
      case 'library.remove': needAdmin(c); await o.library.remove(String(m.id)); return true;
      default: throw new Error('requête inconnue');
    }
  }

  // ----------------------------------------------------------------- HTTP
  const webRoot = o.webDir ? resolve(o.webDir) : null;
  const onRequest = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      // `clients`: screens open right now, `connections`: since the start (a demo instance starts again
      // from scratch once nobody has come for a while)
      res.end(JSON.stringify({ ok: true, version: BRIDGE_VERSION, devices: o.hub.list(), clients: clients.size, connections }));
      return;
    }
    if (!webRoot) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end(t('interface web non compilée (npm run build)')); return; }
    let p = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
    let file = join(webRoot, p);
    if (!file.startsWith(webRoot + sep) && file !== webRoot) { res.writeHead(403); res.end(); return; }
    try {
      const st = await stat(file);
      if (st.isDirectory()) file = join(file, 'index.html');
    } catch { p = 'index.html'; file = join(webRoot, p); } // SPA fallback
    try {
      const body = await readFile(file);
      const type = MIME[extname(file)] ?? 'application/octet-stream';
      const cache = file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache';
      res.writeHead(200, { 'content-type': type, 'cache-control': cache });
      res.end(body);
    } catch { res.writeHead(404); res.end('introuvable'); }
  };
  const server = o.tls ? https.createServer({ cert: o.tls.cert, key: o.tls.key }, onRequest) : http.createServer(onRequest);

  const wss = new WebSocketServer({
    server, path: '/ws', maxPayload: 4 * 1024 * 1024,
    verifyClient: (info: { origin: string; req: http.IncomingMessage }) => {
      const ok = originAllowed(info.origin || undefined, info.req.headers.host, o.allowOrigins);
      if (!ok) log(`connexion refusée depuis l'origine ${info.origin}`);
      return ok;
    },
  });
  // A ping every 30 s: a screen gone without closing its connection (a phone out of reach) is
  // dropped after a minute, and reverse proxies that close quiet connections keep this one open.
  const alive = new WeakSet<WebSocket>();
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) { ws.terminate(); continue; }
      alive.delete(ws);
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();
  server.on('close', () => { clearInterval(heartbeat); if (idleTimer) clearTimeout(idleTimer); });

  wss.on('connection', (ws, req) => {
    const c: Client = { id: nextId++, ip: req.socket.remoteAddress ?? '?', ws, role: roleOf(undefined), name: '', subs: new Set(), debug: new Set() };
    clients.set(c.id, c);
    connections++;
    nobodyLeft();
    alive.add(ws);
    ws.on('pong', () => alive.add(ws));
    log(`client ${c.id} connecté (${req.socket.remoteAddress})`);
    ws.on('message', (raw) => {
      let m: Record<string, unknown>;
      try { m = JSON.parse(String(raw)) as Record<string, unknown>; } catch { return; }
      const rid = m.rid;
      handle(c, m).then(
        (value) => { if (rid !== undefined) send(c, { t: 'result', rid, ok: true, value }); },
        (e: Error) => { if (rid !== undefined) send(c, { t: 'result', rid, ok: false, error: e.message }); },
      );
    });
    ws.on('close', () => { clients.delete(c.id); log(`client ${c.id} parti`); nobodyLeft(); });
    send(c, { t: 'welcome', id: c.id, version: BRIDGE_VERSION, pinRequired: !!(o.pins?.admin || o.pins?.operator) });
  });

  return new Promise((res, rej) => {
    server.once('error', rej);
    server.listen(o.port, o.host, () => res(server));
  });
}
