// Shared library on the bridge: presets, whole-unit backups and scenes, stored as JSON files so
// every phone / tablet / computer on the network sees the same library.

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ModelId } from '@dsp-studio/protocol';

export type LibraryKind = 'preset' | 'unit' | 'scene';
export interface LibraryEntry {
  id: string;
  kind: LibraryKind;
  model: ModelId;
  name: string;
  notes: string;
  tags: string[];
  savedAt: string;
  /** native file content (see protocol/files.ts) or a scene */
  data: unknown;
}
export type LibrarySummary = Omit<LibraryEntry, 'data'>;

const safeId = (id: string): string => {
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(id)) throw new Error('identifiant invalide');
  return id;
};

export class Library {
  private readonly dir: string;
  constructor(dir: string) { this.dir = dir; }

  async init(): Promise<void> { await mkdir(this.dir, { recursive: true }); }

  async list(): Promise<LibrarySummary[]> {
    const out: LibrarySummary[] = [];
    for (const f of await readdir(this.dir).catch(() => [] as string[])) {
      if (!f.endsWith('.json')) continue;
      try {
        const { data: _data, ...meta } = JSON.parse(await readFile(join(this.dir, f), 'utf8')) as LibraryEntry;
        out.push(meta);
      } catch { /* skip unreadable file */ }
    }
    return out.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }

  async get(id: string): Promise<LibraryEntry> {
    return JSON.parse(await readFile(join(this.dir, safeId(id) + '.json'), 'utf8')) as LibraryEntry;
  }

  async save(e: Partial<LibraryEntry> & Pick<LibraryEntry, 'kind' | 'model' | 'name' | 'data'>): Promise<LibrarySummary> {
    if (!['preset', 'unit', 'scene'].includes(e.kind)) throw new Error('type invalide');
    if (e.model !== 'dsp206' && e.model !== 'dsp408') throw new Error('modèle invalide');
    const entry: LibraryEntry = {
      id: e.id ? safeId(e.id) : randomUUID(),
      kind: e.kind, model: e.model, name: String(e.name).slice(0, 80) || 'Sans nom',
      notes: String(e.notes ?? '').slice(0, 4000), tags: (e.tags ?? []).map(String).slice(0, 20),
      savedAt: new Date().toISOString(), data: e.data,
    };
    const text = JSON.stringify(entry);
    if (text.length > 2_000_000) throw new Error('entrée trop grande');
    await writeFile(join(this.dir, entry.id + '.json'), text);
    const { data: _data, ...meta } = entry;
    return meta;
  }

  async remove(id: string): Promise<void> { await rm(join(this.dir, safeId(id) + '.json'), { force: true }); }
}
