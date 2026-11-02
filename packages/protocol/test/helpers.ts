import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fromHex } from '../src/frame.ts';

const here = dirname(fileURLToPath(import.meta.url));

export interface Probe { name: string; cmd: number; data: string; reply: string | null; diff: [number, number, number][]; /** the firmware restarted (production opcodes) */ reset?: boolean }
export interface ProbeFile { model: 'dsp206' | 'dsp408'; size: number; base: string; probes: Probe[] }

export function loadProbes(m: '206' | '408'): ProbeFile & { baseBytes: Uint8Array } {
  const f = JSON.parse(readFileSync(join(here, 'fixtures', `firmware-probes-${m}.json`), 'utf8')) as ProbeFile;
  return { ...f, baseBytes: fromHex(f.base) };
}

export const diffOf = (a: ArrayLike<number>, b: ArrayLike<number>): [number, number, number][] => {
  const out: [number, number, number][] = [];
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) out.push([i, a[i], b[i]]);
  return out;
};
