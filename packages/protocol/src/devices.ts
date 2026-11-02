// How a DSP is reached, and how it is shown in device lists. Shared by the bridge (Node) and the web
// app (browser), so both describe devices the same way.

import { MODELS, type ModelId } from './models.ts';

export const DSP_TCP_PORT = 9761;
export const USB_VENDOR_ID = 0x0168;
export const USB_PRODUCT_ID = 0x0821;
/** UDP port of the Ethernet module's discovery ("Discovery: Who is out there?") */
export const DISCOVERY_PORT = 30303;

export type SourceSpec =
  | { kind: 'tcp'; host: string; port?: number; deviceId?: number }
  | { kind: 'usb'; path?: string; deviceId?: number }
  | { kind: 'serial'; path: string; baud?: number; deviceId?: number }
  | { kind: 'demo'; model: ModelId; deviceId?: number }
  // browser only (web app without bridge)
  | { kind: 'webhid'; name?: string; serial?: string; deviceId?: number }
  | { kind: 'webserial'; name?: string; baud?: number; deviceId?: number };

/** idle = remembered but not connected (connections are opened from the interface) */
export type DeviceState = 'idle' | 'connecting' | 'online' | 'offline' | 'locked';

export interface DeviceInfo {
  key: string;
  label: string;
  spec: SourceSpec;
  state: DeviceState;
  error: string | null;
  model: ModelId | null;
  presetName: string;
}

export interface FoundModule { host: string; name: string; mac: string; via: 'udp' | 'tcp' }

/** "Ethernet 192.168.1.101", "Démo DSP 408 · ID 3"... (French: the interfaces translate it). */
export function describeSource(spec: SourceSpec): string {
  const id = spec.deviceId && spec.deviceId !== 1 ? ` · ID ${spec.deviceId}` : '';
  const what = (() => {
    switch (spec.kind) {
      case 'tcp': { const at = spec.port && spec.port !== DSP_TCP_PORT ? `${spec.host}:${spec.port}` : spec.host; return `Ethernet ${at}`; }
      case 'usb': return spec.path ? `USB ${spec.path}` : 'USB';
      case 'serial': return `Série ${spec.path}`;
      case 'demo': return `Démo ${MODELS[spec.model].name}`;
      case 'webhid': return spec.name ? `USB ${spec.name}` : 'USB';
      case 'webserial': return spec.name ? `Série ${spec.name}` : 'Série';
    }
  })();
  return what + id;
}

export function sourceKey(spec: SourceSpec): string {
  const id = spec.deviceId ?? 1;
  switch (spec.kind) {
    case 'tcp': return `tcp:${spec.host}:${spec.port ?? DSP_TCP_PORT}:${id}`;
    case 'usb': return `usb:${spec.path ?? 'auto'}:${id}`;
    case 'serial': return `serial:${spec.path}:${id}`;
    case 'demo': return `demo:${spec.model}:${id}`;
    case 'webhid': return `webhid:${spec.serial || spec.name || 'auto'}:${id}`;
    case 'webserial': return `webserial:${spec.name || 'port'}:${id}`;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';
const optId = (v: unknown): number | undefined => {
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 250) throw new Error('ID d’appareil invalide (1..250)');
  return n;
};

/** Validates a source coming from the network or a settings file. */
export function validateSource(v: unknown, allowBrowser = false): SourceSpec {
  if (!isObj(v)) throw new Error('source invalide');
  const deviceId = optId(v.deviceId);
  switch (v.kind) {
    case 'tcp': {
      const host = String(v.host ?? '').trim();
      if (!/^[a-zA-Z0-9.\-:[\]_]{1,253}$/.test(host)) throw new Error('adresse invalide');
      const port = v.port === undefined || v.port === null ? undefined : Number(v.port);
      if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) throw new Error('port invalide');
      return { kind: 'tcp', host, port, deviceId };
    }
    case 'usb': return { kind: 'usb', path: v.path ? String(v.path) : undefined, deviceId };
    case 'serial': {
      const path = String(v.path ?? '').trim();
      if (!path) throw new Error('port série manquant');
      const baud = v.baud === undefined || v.baud === null ? undefined : Number(v.baud);
      if (baud !== undefined && !(Number.isInteger(baud) && baud >= 1200 && baud <= 1_000_000)) throw new Error('débit invalide');
      return { kind: 'serial', path, baud, deviceId };
    }
    case 'demo': {
      if (v.model !== 'dsp206' && v.model !== 'dsp408') throw new Error('modèle inconnu');
      return { kind: 'demo', model: v.model, deviceId };
    }
    case 'webhid': if (allowBrowser) return { kind: 'webhid', name: v.name ? String(v.name) : undefined, serial: v.serial ? String(v.serial) : undefined, deviceId }; break;
    case 'webserial': if (allowBrowser) return { kind: 'webserial', name: v.name ? String(v.name) : undefined, baud: v.baud ? Number(v.baud) : undefined, deviceId }; break;
  }
  throw new Error('type de source inconnu');
}
