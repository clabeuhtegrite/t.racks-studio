// Byte transports for the DSP: TCP (Ethernet module, port 9761, also used by the firmware
// emulator), USB HID (node-hid, optional), RS-232 / RS-485 (serialport, optional) and the
// virtual DSP. All of them carry the same frames (see @dsp-studio/protocol).

import net from 'node:net';
import { DSP_TCP_PORT, toHidReports, USB_PRODUCT_ID, USB_VENDOR_ID, VirtualDsp, type ModelId, type Transport } from '@dsp-studio/protocol';

export { DSP_TCP_PORT, USB_PRODUCT_ID, USB_VENDOR_ID };

type DataCb = (chunk: Uint8Array) => void;
type CloseCb = (err?: Error) => void;

class Callbacks {
  data: DataCb[] = [];
  close: CloseCb[] = [];
  closed = false;
  emitData(c: Uint8Array): void { for (const f of this.data) f(c); }
  emitClose(e?: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const f of this.close) f(e);
  }
}

/** TCP connection to the Ethernet module (or to the firmware emulator). */
export function tcpTransport(host: string, port = DSP_TCP_PORT, timeoutMs = 4000): Promise<Transport> {
  return new Promise((resolve, reject) => {
    const cb = new Callbacks();
    const sock = net.createConnection({ host, port });
    sock.setNoDelay(true);
    const timer = setTimeout(() => { sock.destroy(); reject(new Error(`pas de réponse de ${host}:${port}`)); }, timeoutMs);
    sock.once('connect', () => {
      clearTimeout(timer);
      sock.setKeepAlive(true, 5000);
      resolve({
        kind: 'tcp',
        send: (b) => new Promise<void>((res, rej) => sock.write(b, (e) => (e ? rej(e) : res()))),
        onData: (f) => { cb.data.push(f); },
        onClose: (f) => { cb.close.push(f); },
        close: () => { sock.end(); sock.destroy(); },
      });
    });
    sock.on('data', (d) => cb.emitData(new Uint8Array(d.buffer, d.byteOffset, d.byteLength)));
    sock.on('error', (e) => { clearTimeout(timer); reject(e); cb.emitClose(e); });
    sock.on('close', () => cb.emitClose());
  });
}

// ------------------------------------------------------------------------------------------ USB
interface HidModule {
  devices(): { path?: string; vendorId: number; productId: number; product?: string; serialNumber?: string; manufacturer?: string }[];
  HID: new (path: string) => {
    on(ev: 'data', f: (d: Buffer) => void): void;
    on(ev: 'error', f: (e: Error) => void): void;
    write(d: number[]): number;
    close(): void;
  };
}
async function loadHid(): Promise<HidModule | null> {
  try {
    const m = (await import('node-hid')) as unknown as Partial<HidModule> & { default?: HidModule };
    return typeof m.devices === 'function' ? (m as HidModule) : m.default ?? null;
  } catch { return null; }
}

export interface UsbDeviceInfo { path: string; product: string; serial: string }
export async function listUsb(): Promise<UsbDeviceInfo[] | null> {
  const hid = await loadHid();
  if (!hid) return null;
  return hid.devices()
    .filter((d) => d.vendorId === USB_VENDOR_ID && d.productId === USB_PRODUCT_ID && d.path)
    .map((d) => ({ path: d.path!, product: d.product ?? 'DSP', serial: d.serialNumber ?? '' }));
}

export async function usbTransport(path?: string): Promise<Transport> {
  const hid = await loadHid();
  if (!hid) throw new Error("le module USB (node-hid) n'est pas installé sur ce pont");
  const list = await listUsb();
  const p = path ?? list?.[0]?.path;
  if (!p) throw new Error('aucun DSP branché en USB');
  const dev = new hid.HID(p);
  const cb = new Callbacks();
  dev.on('data', (d) => cb.emitData(new Uint8Array(d.buffer, d.byteOffset, d.byteLength)));
  dev.on('error', (e) => cb.emitClose(e));
  return {
    kind: 'usb',
    send: (frame) => {
      for (const r of toHidReports(frame, 64)) dev.write([0x00, ...r]);
    },
    onData: (f) => { cb.data.push(f); },
    onClose: (f) => { cb.close.push(f); },
    close: () => { try { dev.close(); } catch { /* already closed */ } cb.emitClose(); },
  };
}

// ------------------------------------------------------------------------------------- serial
interface SerialModule {
  SerialPort: {
    new (o: { path: string; baudRate: number; autoOpen?: boolean }): {
      open(cb: (e: Error | null) => void): void;
      on(ev: 'data', f: (d: Buffer) => void): void;
      on(ev: 'close' | 'error', f: (e?: Error) => void): void;
      write(d: Uint8Array, cb?: (e: Error | null | undefined) => void): boolean;
      close(cb?: (e: Error | null) => void): void;
    };
    list(): Promise<{ path: string; manufacturer?: string; serialNumber?: string; vendorId?: string; productId?: string }[]>;
  };
}
async function loadSerial(): Promise<SerialModule | null> {
  try { return (await import('serialport')) as unknown as SerialModule; } catch { return null; }
}
export async function listSerial(): Promise<{ path: string; label: string }[] | null> {
  const s = await loadSerial();
  if (!s) return null;
  return (await s.SerialPort.list()).map((p) => ({ path: p.path, label: [p.manufacturer, p.serialNumber].filter(Boolean).join(' ') || p.path }));
}
/** RS-232 (or RS-485 through an adapter) at 115200 8N1, as the firmware's UARTs. */
export async function serialTransport(path: string, baudRate = 115200): Promise<Transport> {
  const s = await loadSerial();
  if (!s) throw new Error("le module série (serialport) n'est pas installé sur ce pont");
  const port = new s.SerialPort({ path, baudRate, autoOpen: false });
  await new Promise<void>((res, rej) => port.open((e) => (e ? rej(e) : res())));
  const cb = new Callbacks();
  port.on('data', (d) => cb.emitData(new Uint8Array(d.buffer, d.byteOffset, d.byteLength)));
  port.on('close', (e) => cb.emitClose(e));
  port.on('error', (e) => cb.emitClose(e));
  return {
    kind: 'serial',
    send: (b) => new Promise<void>((res, rej) => { port.write(b, (e) => (e ? rej(e) : res())); }),
    onData: (f) => { cb.data.push(f); },
    onClose: (f) => { cb.close.push(f); },
    close: () => { port.close(); },
  };
}

// ------------------------------------------------------------------------------------- virtual
export function demoTransport(model: ModelId, deviceId = 1): { transport: Transport; sim: VirtualDsp } {
  const sim = new VirtualDsp({ model, deviceId, latencyMs: 3 });
  return { transport: sim.transport(), sim };
}
