// Browser transports: WebHID (USB) and Web Serial (RS-232 / RS-485 adapters). Available in
// Chromium-based browsers (Chrome, Edge, Opera) on a secure page (https or localhost).

import { toHidReports, USB_PRODUCT_ID, USB_VENDOR_ID, type Transport } from '@dsp-studio/protocol';

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

export const hasWebHid = (): boolean => typeof navigator !== 'undefined' && 'hid' in navigator && window.isSecureContext;
export const hasWebSerial = (): boolean => typeof navigator !== 'undefined' && 'serial' in navigator && window.isSecureContext;

export const DSP_HID_FILTER: HIDDeviceFilter = { vendorId: USB_VENDOR_ID, productId: USB_PRODUCT_ID };

export async function grantedHidDevices(): Promise<HIDDevice[]> {
  if (!hasWebHid()) return [];
  return (await navigator.hid.getDevices()).filter((d) => d.vendorId === USB_VENDOR_ID && d.productId === USB_PRODUCT_ID);
}

export async function webHidTransport(dev: HIDDevice): Promise<Transport> {
  if (!dev.opened) await dev.open();
  const cb = new Callbacks();
  const onReport = (e: HIDInputReportEvent): void => {
    cb.emitData(new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength));
  };
  const onDisconnect = (e: HIDConnectionEvent): void => { if (e.device === dev) cb.emitClose(new Error('DSP débranché')); };
  dev.addEventListener('inputreport', onReport);
  navigator.hid.addEventListener('disconnect', onDisconnect);
  let chain: Promise<void> = Promise.resolve();
  return {
    kind: 'webhid',
    send: (frame) => {
      // reports of one frame must not interleave with the next one
      chain = chain.then(async () => {
        for (const r of toHidReports(frame, 64)) await dev.sendReport(0, r as Uint8Array<ArrayBuffer>);
      });
      return chain;
    },
    onData: (f) => { cb.data.push(f); },
    onClose: (f) => { cb.close.push(f); },
    close: async () => {
      dev.removeEventListener('inputreport', onReport);
      navigator.hid.removeEventListener('disconnect', onDisconnect);
      try { await dev.close(); } catch { /* already closed */ }
      cb.emitClose();
    },
  };
}

export async function webSerialTransport(port: SerialPort, baudRate = 115200): Promise<Transport> {
  await port.open({ baudRate, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' });
  if (!port.readable || !port.writable) throw new Error('port série inutilisable');
  const cb = new Callbacks();
  const writer = port.writable.getWriter();
  const reader = port.readable.getReader();
  let closing = false;
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) cb.emitData(value);
      }
    } catch (e) {
      if (!closing) cb.emitClose(e as Error);
    } finally {
      cb.emitClose();
    }
  })();
  return {
    kind: 'webserial',
    send: (b) => writer.write(b),
    onData: (f) => { cb.data.push(f); },
    onClose: (f) => { cb.close.push(f); },
    close: async () => {
      closing = true;
      try { await reader.cancel(); } catch { /* ignore */ }
      try { reader.releaseLock(); writer.releaseLock(); } catch { /* ignore */ }
      try { await port.close(); } catch { /* ignore */ }
      cb.emitClose();
    },
  };
}

export function serialPortName(port: SerialPort): string {
  const i = port.getInfo();
  return i.usbVendorId ? `USB ${i.usbVendorId.toString(16).padStart(4, '0')}:${(i.usbProductId ?? 0).toString(16).padStart(4, '0')}` : 'port série';
}
