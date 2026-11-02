// The web app talks to DSPs through a "backend": the t.racks Studio bridge (WebSocket, shared by every
// phone / tablet / computer on the network) or the browser itself (WebHID, Web Serial, demo).
// Both expose exactly the same operations and events.

import type { Action, DeviceInfo, FoundModule, LevelerState, ModelId, Role, SessionSnapshot, SourceSpec } from '@dsp-studio/protocol';

export type BackendStatus = 'connecting' | 'online' | 'offline';

export interface BackendEvents {
  status: BackendStatus;
  devices: DeviceInfo[];
  snapshot: { key: string; snap: SessionSnapshot };
  action: { key: string; action: Action; origin: number; seq: number };
  meters: { key: string; db: number[]; status: number };
  frame: { key: string; dir: 'tx' | 'rx'; hex: string; at: number };
  leveler: { key: string; state: LevelerState };
}

/** Requests to the automatic gain of a device (see packages/protocol/src/leveler.ts). */
export type LevelerOp = 'state' | 'history' | 'enable' | 'pause' | 'set' | 'target' | 'check';

export interface PortsInfo {
  usb: { path: string; product: string; serial: string }[] | null;
  serial: { path: string; label: string }[] | null;
}

export type LibraryKind = 'preset' | 'unit' | 'scene';
export interface LibraryEntry {
  id: string;
  kind: LibraryKind;
  model: ModelId;
  name: string;
  notes: string;
  tags: string[];
  savedAt: string;
  data: unknown;
}
export type LibrarySummary = Omit<LibraryEntry, 'data'>;
export type LibraryDraft = Partial<LibraryEntry> & Pick<LibraryEntry, 'kind' | 'model' | 'name' | 'data'>;

export interface LibraryApi {
  /** true when the library lives on the bridge (shared by every device of the network) */
  readonly shared: boolean;
  list(): Promise<LibrarySummary[]>;
  get(id: string): Promise<LibraryEntry>;
  save(e: LibraryDraft): Promise<LibrarySummary>;
  remove(id: string): Promise<void>;
}

export interface Backend {
  readonly kind: 'bridge' | 'local';
  readonly clientId: number;
  readonly role: Role;
  readonly pinRequired: boolean;
  readonly version: string;
  readonly status: BackendStatus;
  readonly devices: DeviceInfo[];
  readonly library: LibraryApi;
  readonly features: { discover: boolean; ports: boolean; probe: boolean; webhid: boolean; webserial: boolean; demo: boolean };
  on<K extends keyof BackendEvents>(k: K, f: (v: BackendEvents[K]) => void): () => void;
  start(): Promise<void>;
  login(pin: string): Promise<Role>;
  subscribe(key: string, debug?: boolean): Promise<{ info: DeviceInfo; snap: SessionSnapshot | null; leveler?: LevelerState | null }>;
  unsubscribe(key: string): void;
  action(key: string, a: Action, seq: number): Promise<void>;
  call<T = unknown>(key: string, method: string, args?: unknown[]): Promise<T>;
  /** automatic gain: state, history, on / off (operator), settings, target, meter check (admin) */
  leveler<T = unknown>(key: string, op: LevelerOp, value?: unknown): Promise<T>;
  addDevice(spec: SourceSpec, label?: string): Promise<DeviceInfo>;
  removeDevice(key: string): Promise<void>;
  renameDevice(key: string, label: string): Promise<void>;
  /** opens the connection to a remembered device (or retries at once) */
  connectDevice(key: string): Promise<void>;
  /** closes it; the device stays in the list */
  disconnectDevice(key: string): Promise<void>;
  discover(sweep: boolean): Promise<FoundModule[]>;
  ports(): Promise<PortsInfo>;
  probe(spec: SourceSpec, max?: number): Promise<{ id: number; version: string }[]>;
  /** browser only: asks the user to pick a USB DSP (WebHID) */
  requestUsb?(deviceId?: number): Promise<DeviceInfo | null>;
  /** browser only: asks the user to pick a serial port (Web Serial) */
  requestSerial?(baud?: number, deviceId?: number): Promise<DeviceInfo | null>;
  close(): void;
}

type Listener<T> = (v: T) => void;
export class Emitter<E> {
  private l: { [K in keyof E]?: Set<Listener<E[K]>> } = {};
  on<K extends keyof E>(k: K, f: Listener<E[K]>): () => void {
    (this.l[k] ??= new Set()).add(f);
    return () => { this.l[k]?.delete(f); };
  }
  emit<K extends keyof E>(k: K, v: E[K]): void {
    this.l[k]?.forEach((f) => { try { f(v); } catch (e) { console.error(e); } });
  }
}

export const APP_VERSION = '0.1.0';
