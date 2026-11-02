// Finding DSPs:
// - Ethernet: the module answers the Microchip "Announce" broadcast on UDP 30303, exactly what the
//   Windows editor sends ("Discovery: Who is out there?"); a TCP probe of port 9761 on the local
//   /24 networks is used as a fallback for routers that drop broadcasts;
// - device id: units on one RS-485 bus / one module are told apart by their id (1..250); the
//   editor's connect dialog scans ids, so does probeIds().

import dgram from 'node:dgram';
import net from 'node:net';
import os from 'node:os';
import { DISCOVERY_PORT, DSP_TCP_PORT, probeIds, type FoundModule } from '@dsp-studio/protocol';

export type { FoundModule };

const DISCOVERY_MSG = 'Discovery: Who is out there?\0';

function broadcastAddresses(): string[] {
  const out = new Set<string>(['255.255.255.255']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const ip = a.address.split('.').map(Number), mask = a.netmask.split('.').map(Number);
      out.add(ip.map((b, i) => (b & mask[i]) | (~mask[i] & 0xff)).join('.'));
    }
  }
  return [...out];
}

export function udpDiscover(timeoutMs = 1500): Promise<FoundModule[]> {
  return new Promise((resolve) => {
    const found = new Map<string, FoundModule>();
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const done = (): void => { try { sock.close(); } catch { /* closed */ } resolve([...found.values()]); };
    sock.on('error', done);
    sock.on('message', (msg, rinfo) => {
      const text = msg.toString('latin1');
      if (text.startsWith('Discovery')) return; // our own broadcast
      const [name = '', mac = ''] = text.split(/\r?\n/).map((s) => s.replace(/\0/g, '').trim());
      found.set(rinfo.address, { host: rinfo.address, name: name || 'Module Ethernet', mac, via: 'udp' });
    });
    sock.bind(0, () => {
      sock.setBroadcast(true);
      for (const addr of broadcastAddresses()) sock.send(DISCOVERY_MSG, DISCOVERY_PORT, addr, () => { /* ignore */ });
      setTimeout(done, timeoutMs);
    });
  });
}

/** Probes TCP 9761 on every address of the local /24 networks (bounded concurrency). */
export async function tcpSweep(timeoutMs = 350, concurrency = 64): Promise<FoundModule[]> {
  const targets: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal || !a.netmask.startsWith('255.255.255')) continue;
      const p = a.address.split('.');
      for (let i = 1; i < 255; i++) { const h = `${p[0]}.${p[1]}.${p[2]}.${i}`; if (h !== a.address) targets.push(h); }
    }
  }
  const found: FoundModule[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < targets.length) {
      const host = targets[next++];
      const ok = await new Promise<boolean>((res) => {
        const s = net.createConnection({ host, port: DSP_TCP_PORT });
        const t = setTimeout(() => { s.destroy(); res(false); }, timeoutMs);
        s.once('connect', () => { clearTimeout(t); s.destroy(); res(true); });
        s.once('error', () => { clearTimeout(t); res(false); });
      });
      if (ok) found.push({ host, name: 'DSP (port 9761)', mac: '', via: 'tcp' });
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return found;
}

export async function discover(opts: { sweep?: boolean } = {}): Promise<FoundModule[]> {
  const udp = await udpDiscover();
  if (!opts.sweep) return udp;
  const tcp = await tcpSweep();
  const all = new Map(udp.map((m) => [m.host, m]));
  for (const m of tcp) if (!all.has(m.host)) all.set(m.host, m);
  return [...all.values()];
}

export { probeIds };
