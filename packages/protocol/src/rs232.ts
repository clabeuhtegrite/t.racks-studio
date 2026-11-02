// "Processor Extend Remote Control Protocol": the simple RS-232 protocol for control systems
// (Crestron, AMX, home automation...) documented in the editor's Help > RS232 Code page.
//
//   7B 7D | id | cmd | d1 | d2 | d3 | 7D 7B        always 9 bytes, no checksum
//
// Behaviour of firmware v1.04 (emulator/tools/test_ext.py, and the receiver code itself):
// - the device only answers frames whose id is its device id (no broadcast); it answers on the
//   RS-232 and RS-485 ports, in PC mode or not;
// - set commands answer "OK" (4F 4B); 0x48 answers the level as 2 bytes (big endian);
//   0x49 answers [type, index, state]; 0x4A answers the active preset (1 byte, 0 = F00);
// - 0x43 recalls F00 with d1 d2 d3 = 0 0 0 and a user preset with 1, n - 1, 0 (U01 = 1 0 0,
//   U20 = 1 19 0); any other value is ignored;
// - a frame that starts with 7B 7D but is not exactly a 9-byte frame for this id (another id, or
//   the 8-byte 0x4A example of the original help) is never consumed: the receiver then ignores
//   everything, the normal protocol too, until its 128-byte buffer overflows. 128 bytes 0x00 sent
//   after such a frame always clear it, and disturb neither protocol (EXT_FLUSH).

import { gainDbToRaw, gainRawToDb } from './codecs.ts';

export const EXT_HEAD = [0x7b, 0x7d] as const;
export const EXT_TAIL = [0x7d, 0x7b] as const;

/** Channel type used by the extended protocol: 0 = input, 1 = output. */
export type ExtKind = 0 | 1;

export interface ExtCommand {
  cmd: number;
  name: string;
  /** French description shown in the app */
  description: string;
  /** meaning of d1 d2 d3 */
  data: string;
  reply: string;
  verified: boolean;
}

export const EXT_COMMANDS: ExtCommand[] = [
  { cmd: 0x41, name: 'Gain +/-', description: 'Monte ou baisse le volume d’un canal d’un pas de 0,5 dB.', data: 'type (0 entrée, 1 sortie), canal (0 = A / Out1), sens (0 monter, 1 baisser)', reply: '"OK"', verified: true },
  { cmd: 0x42, name: 'Mute', description: 'Coupe ou rétablit un canal.', data: 'type, canal, état (0 actif, 1 coupé)', reply: '"OK"', verified: true },
  { cmd: 0x43, name: 'Rappel de preset', description: 'Rappelle le preset d’usine F00 ou un preset utilisateur.', data: 'F00 : 0, 0, 0 ; U01 … U20 : 1, numéro − 1, 0', reply: '"OK"', verified: true },
  { cmd: 0x44, name: 'Volume d’entrée', description: 'Règle le volume d’une entrée.', data: 'canal, valeur (2 octets, gros-boutiste, 0..400, 280 = 0 dB)', reply: '"OK"', verified: true },
  { cmd: 0x45, name: 'Volume de sortie', description: 'Règle le volume d’une sortie.', data: 'canal, valeur (2 octets, gros-boutiste, 0..400, 280 = 0 dB)', reply: '"OK"', verified: true },
  { cmd: 0x48, name: 'Lire le volume', description: 'Renvoie le volume d’un canal.', data: 'type, canal, 0', reply: 'valeur sur 2 octets (gros-boutiste)', verified: true },
  { cmd: 0x49, name: 'Lire le mute', description: 'Renvoie l’état du mute d’un canal.', data: 'type, canal, 0', reply: 'type, canal, état', verified: true },
  { cmd: 0x4a, name: 'Preset courant', description: 'Renvoie le numéro du preset actif.', data: '0, 0, 0', reply: '1 octet : 0 = F00, 1 … 20 = U01 … U20', verified: true },
];

/** Sent after an Extend frame on a line shared by several units: brings back the receivers that
 * saw a frame for another id (see above). */
export const EXT_FLUSH = new Uint8Array(128);

export function extFrame(id: number, cmd: number, d1 = 0, d2 = 0, d3 = 0): Uint8Array {
  return Uint8Array.from([...EXT_HEAD, id & 0xff, cmd & 0xff, d1 & 0xff, d2 & 0xff, d3 & 0xff, ...EXT_TAIL]);
}

export const ext = {
  step: (id: number, kind: ExtKind, ch: number, up: boolean) => extFrame(id, 0x41, kind, ch, up ? 0 : 1),
  mute: (id: number, kind: ExtKind, ch: number, on: boolean) => extFrame(id, 0x42, kind, ch, on ? 1 : 0),
  /** preset 0 = F00, 1..20 = U01..U20 */
  recall: (id: number, preset: number) => (preset <= 0 ? extFrame(id, 0x43, 0, 0, 0) : extFrame(id, 0x43, 1, Math.min(preset, 20) - 1, 0)),
  volume: (id: number, kind: ExtKind, ch: number, db: number) => {
    const raw = gainDbToRaw(db);
    return extFrame(id, kind === 0 ? 0x44 : 0x45, ch, raw >> 8, raw & 0xff);
  },
  getVolume: (id: number, kind: ExtKind, ch: number) => extFrame(id, 0x48, kind, ch, 0),
  getMute: (id: number, kind: ExtKind, ch: number) => extFrame(id, 0x49, kind, ch, 0),
  getPreset: (id: number) => extFrame(id, 0x4a, 0, 0, 0),
};

/** Decodes the answer to 0x48 (level) into dB. */
export const extLevelToDb = (hi: number, lo: number): number => gainRawToDb((hi << 8) | lo);

export function extHex(bytes: ArrayLike<number>): string {
  return Array.from(bytes, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');
}
