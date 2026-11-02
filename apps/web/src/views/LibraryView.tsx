// Library: presets, whole-unit backups and scenes, kept on the bridge (shared by every screen of the
// network) or in this browser. A scene is a snapshot of the current settings, recalled in one touch
// without using a memory of the device.

import { useEffect, useState } from 'react';
import {
  decodeNative, decodeUnitSystem, encodeNative, MODELS, openFile, presetToNative, unitToNative, type OpenedFile,
} from '@dsp-studio/protocol';
import { confirmDialog, errorText, promptDialog, run, toast, useApp, useCanEdit, useDevice } from '../state/store.ts';
import { Badge, Button, Card, Empty, Segmented, Spinner, TextInput } from '../ui/kit.tsx';
import { Icon } from '../ui/icons.tsx';
import { downloadFile, fileBytes, pickFile, safeName } from '../app/files.ts';
import { OpenedDialog } from './PresetsView.tsx';
import type { LibraryApi, LibraryEntry, LibraryKind, LibrarySummary } from '../client/types.ts';

const KIND_LABEL: Record<LibraryKind, string> = { scene: 'Scène', preset: 'Preset', unit: 'Sauvegarde' };

/** Library entry -> the same structure as an opened file. */
function entryToFile(e: LibraryEntry): OpenedFile {
  const f = decodeNative(JSON.stringify(e.data));
  if (f.kind === 'preset') return { kind: 'preset', source: 'native', model: f.model, config: f.config, name: e.name };
  return { kind: 'unit', source: 'native', model: f.model, unit: { model: f.model, system: f.system ?? decodeUnitSystem([]), presets: f.presets }, live: f.live, name: e.name };
}

export function LibraryView(): React.JSX.Element {
  const backend = useApp((s) => s.backend);
  const role = useApp((s) => s.role);
  const { mirror, config } = useDevice();
  const canEdit = useCanEdit();
  const [list, setList] = useState<LibrarySummary[] | null>(null);
  const [rev, setRev] = useState(0);
  const [kind, setKind] = useState<'all' | LibraryKind>('all');
  const [q, setQ] = useState('');
  const [allModels, setAllModels] = useState(false);
  const [opened, setOpened] = useState<OpenedFile | null>(null);
  const lib = backend?.library;
  useEffect(() => {
    if (!lib) return;
    let alive = true;
    lib.list().then((l) => { if (alive) setList(l); }, (e) => { if (alive) { setList([]); toast(errorText(e), 'error'); } });
    return () => { alive = false; };
  }, [lib, rev]);
  if (!lib) return <></>;
  const reload = (): void => setRev((x) => x + 1);
  const admin = role === 'admin';
  const model = config?.model ?? mirror?.snap?.model ?? null;
  const needle = q.trim().toLowerCase();
  const shown = (list ?? [])
    .filter((e) => (kind === 'all' || e.kind === kind) && (allModels || !model || e.model === model))
    .filter((e) => !needle || `${e.name} ${e.notes} ${e.tags.join(' ')}`.toLowerCase().includes(needle))
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt));

  const saveScene = async (): Promise<void> => {
    if (!config) return;
    const name = await promptDialog({
      title: 'Nouvelle scène',
      message: 'Les réglages actuels sont gardés dans la bibliothèque. Une scène se rappelle d’un geste, sans occuper de mémoire de l’appareil.',
      label: 'Nom de la scène', value: config.presetName || 'Scène', maxLength: 80, ok: 'Enregistrer',
    });
    if (name === null) return;
    await run('Enregistrement de la scène', () => lib.save({ kind: 'scene', model: config.model, name: name.trim() || 'Scène', data: presetToNative(config) }), 'Scène enregistrée');
    reload();
  };
  const importFile = async (): Promise<void> => {
    const f = await pickFile('.prs,.unt,.json,application/json');
    if (!f) return;
    try {
      const of = openFile(await fileBytes(f), f.name, config ?? undefined);
      const data = of.kind === 'preset' ? presetToNative(of.config) : unitToNative(of.unit, of.live, of.name);
      await run('Import', () => lib.save({ kind: of.kind, model: of.model, name: of.name || f.name, data }), 'Ajouté à la bibliothèque');
      reload();
    } catch (e) { toast(errorText(e), 'error'); }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Bibliothèque</h1>
          <p className="muted small">{lib.shared ? 'Partagée par tous les écrans connectés au pont.' : 'Gardée dans ce navigateur.'}</p>
        </div>
        <div className="row wrap">
          <Button icon="open" disabled={!admin} onClick={importFile}>Importer un fichier</Button>
          <Button kind="primary" icon="scene" disabled={!admin || !config} onClick={saveScene}>Nouvelle scène</Button>
        </div>
      </div>
      <Card>
        <div className="row wrap lib-filters">
          <Segmented label="Type" value={kind} onChange={setKind} options={[
            { value: 'all', label: 'Tout' }, { value: 'scene', label: 'Scènes' }, { value: 'preset', label: 'Presets' }, { value: 'unit', label: 'Sauvegardes' },
          ]} />
          <TextInput value={q} onChange={setQ} placeholder="Rechercher…" label="Rechercher dans la bibliothèque" className="grow" />
          {model && (
            <label className="check">
              <input type="checkbox" checked={allModels} onChange={(e) => setAllModels(e.target.checked)} />
              <span>Tous les modèles</span>
            </label>
          )}
        </div>
      </Card>
      {list === null && <Empty title="Chargement…"><Spinner /></Empty>}
      {list && shown.length === 0 && (
        <Empty icon="library" title={list.length ? 'Rien ne correspond' : 'Bibliothèque vide'}>
          <p className="muted">Enregistrez une scène à partir des réglages actuels, importez des fichiers .prs / .unt du logiciel Windows, ou ajoutez des sauvegardes depuis l’écran Presets.</p>
        </Empty>
      )}
      <div className="lib">
        {shown.map((e) => (
          <LibraryItem key={e.id} e={e} lib={lib} admin={admin} canEdit={canEdit} sameModel={e.model === model}
            onOpen={setOpened} onChanged={reload} hasDevice={!!mirror && !!config} />
        ))}
      </div>
      {opened && mirror && <OpenedDialog file={opened} mirror={mirror} inLibrary onClose={() => setOpened(null)} />}
    </div>
  );
}

function LibraryItem(p: {
  e: LibrarySummary; lib: LibraryApi; admin: boolean; canEdit: boolean; sameModel: boolean; hasDevice: boolean;
  onOpen: (f: OpenedFile) => void; onChanged: () => void;
}): React.JSX.Element {
  const { e, lib } = p;
  const { mirror } = useDevice();
  const fetchFile = async (): Promise<{ entry: LibraryEntry; file: OpenedFile } | null> => {
    try {
      const entry = await lib.get(e.id);
      return { entry, file: entryToFile(entry) };
    } catch (err) { toast(errorText(err), 'error'); return null; }
  };
  const recall = async (): Promise<void> => {
    const r = await fetchFile();
    if (!r || r.file.kind !== 'preset' || !mirror) return;
    const cfg = r.file.config;
    await run(`Rappel de « ${e.name} »`, () => mirror.call('pushConfig', cfg, `Scène ${e.name}`), `« ${e.name} » rappelé`);
  };
  const open = async (): Promise<void> => { const r = await fetchFile(); if (r) p.onOpen(r.file); };
  const download = async (): Promise<void> => {
    const r = await fetchFile();
    if (!r) return;
    const f = decodeNative(JSON.stringify(r.entry.data));
    downloadFile(`${safeName(e.name)}.json`, encodeNative(f), 'application/json');
  };
  const rename = async (): Promise<void> => {
    const r = await fetchFile();
    if (!r) return;
    const name = await promptDialog({ title: 'Renommer', label: 'Nom', value: e.name, maxLength: 80, ok: 'Renommer' });
    if (name === null || !name.trim()) return;
    await run('Renommage', () => lib.save({ ...r.entry, name: name.trim() }));
    p.onChanged();
  };
  const notes = async (): Promise<void> => {
    const r = await fetchFile();
    if (!r) return;
    const text = await promptDialog({ title: 'Notes', label: 'Notes (lieu, artiste, matériel…)', value: e.notes, maxLength: 400, ok: 'Enregistrer' });
    if (text === null) return;
    await run('Enregistrement', () => lib.save({ ...r.entry, notes: text.trim() }));
    p.onChanged();
  };
  const remove = async (): Promise<void> => {
    if (!await confirmDialog({ title: 'Supprimer', message: `Supprimer « ${e.name} » de la bibliothèque ?`, ok: 'Supprimer', danger: true })) return;
    await run('Suppression', () => lib.remove(e.id), 'Supprimé');
    p.onChanged();
  };
  const usable = p.hasDevice && p.sameModel;
  return (
    <div className={`lib-item lib-${e.kind}`}>
      <div className="lib-icon"><Icon name={e.kind === 'scene' ? 'scene' : e.kind === 'unit' ? 'device' : 'presets'} /></div>
      <div className="grow lib-main">
        <div className="lib-title">
          <strong>{e.name}</strong>
          <Badge tone={e.kind === 'scene' ? 'accent' : 'muted'}>{KIND_LABEL[e.kind]}</Badge>
          <Badge>{MODELS[e.model]?.name ?? e.model}</Badge>
        </div>
        <div className="small muted">{new Date(e.savedAt).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' })}{e.notes ? ` · ${e.notes}` : ''}</div>
      </div>
      <div className="lib-actions">
        {e.kind !== 'unit' && <Button small kind="primary" icon="play" disabled={!usable || !p.canEdit} title={!p.sameModel ? 'Autre modèle' : undefined} onClick={recall}>Rappeler</Button>}
        <Button small icon="open" disabled={!usable || !p.canEdit} onClick={open}>{e.kind === 'unit' ? 'Restaurer…' : 'Plus…'}</Button>
        <Button small icon="download" title="Télécharger (.json)" onClick={download} />
        {p.admin && <Button small icon="edit" title="Renommer" onClick={rename} />}
        {p.admin && <Button small icon="info" title="Notes" onClick={notes} />}
        {p.admin && <Button small icon="trash" title="Supprimer" onClick={remove} />}
      </div>
    </div>
  );
}
