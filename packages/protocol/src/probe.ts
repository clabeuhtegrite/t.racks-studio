// Finding which device ids answer on a link (several units can share one RS-485 bus or one
// Ethernet module): like the editor's connect dialog, ids are tried one after the other.

import { CMD } from './commands.ts';
import { encodeFrame, FrameParser } from './frame.ts';
import type { Transport } from './session.ts';

/**
 * Asks which device ids answer on a transport (login + version). Returns the ids and versions.
 * The transport is left open; ids 1..max are tried one after the other like the editor does.
 */
export async function probeIds(
  t: Transport, max = 16, perIdMs = 250, onProgress?: (id: number, max: number) => void,
): Promise<{ id: number; version: string }[]> {
  const parser = new FrameParser();
  let waiting: ((f: { src: number; cmd: number; data: Uint8Array }) => void) | null = null;
  t.onData((c) => { for (const f of parser.push(c)) waiting?.(f); });
  const ask = (id: number, cmd: number): Promise<Uint8Array | null> => new Promise((res) => {
    const timer = setTimeout(() => { waiting = null; res(null); }, perIdMs);
    waiting = (f) => { if (f.src === id && f.cmd === cmd) { clearTimeout(timer); waiting = null; res(f.data); } };
    void t.send(encodeFrame(cmd, [], 0, id));
  });
  const out: { id: number; version: string }[] = [];
  for (let id = 1; id <= max; id++) {
    onProgress?.(id, max);
    if (!(await ask(id, CMD.LOGIN))) continue;
    const v = await ask(id, CMD.VERSION);
    out.push({ id, version: v ? String.fromCharCode(...v).trim() : '?' });
  }
  return out;
}
