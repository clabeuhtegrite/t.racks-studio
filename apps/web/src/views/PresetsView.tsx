// Presets and files (the editor's Recall / Store buttons and its File menu):
// - recall F00 / U01..U20, store under a name, rename the current preset;
// - open a preset (.prs of the Windows editor or DSP Studio .json) and send it, or write it into a
//   memory without changing what is playing;
// - save the current preset (.prs compatible with the editor, or .json);
// - back up the whole unit (.unt compatible with the editor, or .json) and restore it;
// - factory default.

import { useState } from 'react';
import {
  encodeNative, encodePrs, encodeUnt, MODELS, openFile, presetToNative, unitToNative,
  type DeviceConfig, type OpenedFile, type UnitFile, type UnitPreset,
} from '@dsp-studio/protocol';
import { confirmDialog, promptDialog, run, toast, useApp, useCanEdit, useCanOperate, useDevice, errorText, getState } from '../state/store.ts';
import { downloadFile, fileBytes, pickFile, safeName, stamp } from '../app/files.ts';
import { Badge, Button, Card, Field, Modal, Note, Select } from '../ui/kit.tsx';
import { presetLabel } from '../ui/format.ts';
import type { DeviceMirror } from '../client/mirror.ts';

export function PresetsView(): React.JSX.Element {
  const { mirror, snap, config } = useDevice();
  const canEdit = useCanEdit();
  const canOperate = useCanOperate();
  const [opened, setOpened] = useState<OpenedFile | null>(null);
  if (!mirror || !snap) return <></>;
  const m = snap.model ? MODELS[snap.model] : null;
  if (!m) return <></>;
  const presets = [{ slot: 0, name: 'Réglage d’usine (lecture seule)', user: false }, ...snap.presets];

  const recall = async (n: number): Promise<void> => {
    await run(`Rappel du preset ${presetLabel(n)}`, () => mirror.call('loadPreset', n), `Preset ${presetLabel(n)} rappelé`);
    mirror.clearHistory();
  };
  const store = async (n: number): Promise<void> => {
    const slot = snap.presets.find((p) => p.slot === n);
    const name = await promptDialog({
      title: `Enregistrer dans ${presetLabel(n)}`,
      message: slot?.user ? `${presetLabel(n)} contient déjà « ${slot.name} » : il sera remplacé par les réglages actuels.` : 'Les réglages actuels seront mémorisés dans l’appareil.',
      label: 'Nom du preset (14 caractères)', value: config?.presetName ?? '', maxLength: 14, ok: 'Enregistrer',
    });
    if (name === null) return;
    await run(`Enregistrement dans ${presetLabel(n)}`, () => mirror.call('storePreset', n, name), `Enregistré dans ${presetLabel(n)}`);
  };

  const openAny = async (): Promise<void> => {
    const f = await pickFile('.prs,.unt,.json,application/json');
    if (!f) return;
    try {
      const of = openFile(await fileBytes(f), f.name, mirror.config ?? undefined);
      if (of.model !== m.id) { toast(`Ce fichier est destiné à un ${MODELS[of.model].name}, cet appareil est un ${m.name}.`, 'error'); return; }
      setOpened(of);
    } catch (e) { toast(errorText(e), 'error'); }
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1>Presets</h1>
        <div className="row">
          <Button icon="open" onClick={openAny} disabled={!canEdit}>Ouvrir un fichier</Button>
          <SaveMenu config={config} />
        </div>
      </div>

      {config && (
        <Card title="Preset en cours">
          <div className="current-preset">
            <span className="preset-big">{presetLabel(snap.activePreset)}</span>
            <div className="grow">
              <strong>{config.presetName || 'Sans nom'}</strong>
              <p className="small muted">Les réglages modifiés depuis le rappel ne sont mémorisés qu’après « Enregistrer ».</p>
            </div>
            <Button small icon="edit" disabled={!canEdit} onClick={async () => {
              const v = await promptDialog({ title: 'Nom du preset en cours', label: 'Nom (14 caractères)', value: config.presetName, maxLength: 14, ok: 'Renommer' });
              if (v !== null) mirror.apply({ t: 'presetName', name: v });
            }}>Renommer</Button>
          </div>
        </Card>
      )}

      <Card title="Mémoires de l’appareil" subtitle="F00 est le réglage d’usine ; U01 à U20 sont les mémoires utilisateur.">
        <div className="presets">
          {presets.map((p) => (
            <div key={p.slot} className={`preset ${p.slot === snap.activePreset ? 'is-on' : ''} ${p.user || p.slot === 0 ? '' : 'is-empty'}`}>
              <span className="preset-num">{presetLabel(p.slot)}</span>
              <span className="preset-name">{p.slot === 0 ? 'Réglage d’usine' : p.user ? p.name || 'Sans nom' : 'Vide (réglage d’usine)'}</span>
              {p.slot === snap.activePreset && <Badge tone="accent">en cours</Badge>}
              <div className="preset-actions">
                <Button small icon="play" disabled={!canOperate} onClick={() => recall(p.slot)}>Rappeler</Button>
                {p.slot > 0 && <Button small icon="save" disabled={!canEdit} onClick={() => store(p.slot)}>Enregistrer ici</Button>}
              </div>
            </div>
          ))}
        </div>
      </Card>

      <UnitCard mirror={mirror} canEdit={canEdit} onOpened={setOpened} />

      {opened && <OpenedDialog file={opened} mirror={mirror} onClose={() => setOpened(null)} />}
    </div>
  );
}

/** File > Factory Default of the editor, after a confirmation. */
export async function factoryReset(mirror: DeviceMirror): Promise<void> {
  if (!await confirmDialog({ title: 'Réglages d’usine', message: 'Remettre les 20 mémoires utilisateur au réglage d’usine ? Les presets enregistrés dans l’appareil seront perdus (sauvegardez-les avant).', ok: 'Tout effacer', danger: true })) return;
  await run('Retour aux réglages d’usine', () => mirror.call('factoryReset'), 'Appareil remis aux réglages d’usine');
  mirror.clearHistory();
}

function SaveMenu({ config }: { config: DeviceConfig | null }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  if (!config) return <></>;
  const base = safeName(config.presetName || 'preset');
  return (
    <>
      <Button icon="download" onClick={() => setOpen(true)}>Enregistrer sur l’ordinateur</Button>
      {open && (
        <Modal title="Enregistrer le preset en cours" onClose={() => setOpen(false)}>
          <p className="muted">Deux formats au choix :</p>
          <div className="choice">
            <button type="button" className="choice-item" onClick={() => { downloadFile(`${base}.prs`, encodePrs(config) as Uint8Array<ArrayBuffer>); setOpen(false); }}>
              <strong>.prs (logiciel Windows)</strong>
              <span className="small muted">S’ouvre aussi dans l’éditeur officiel t.racks. Ne contient pas l’unité des délais, le générateur et les bypass globaux d’EQ (comme l’éditeur).</span>
            </button>
            <button type="button" className="choice-item" onClick={() => { downloadFile(`${base}.json`, encodeNative(presetToNative(config)), 'application/json'); setOpen(false); }}>
              <strong>.json (DSP Studio)</strong>
              <span className="small muted">Garde absolument tous les réglages.</span>
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

function UnitCard({ mirror, canEdit, onOpened }: { mirror: DeviceMirror; canEdit: boolean; onOpened: (f: OpenedFile) => void }): React.JSX.Element {
  const [unit, setUnit] = useState<UnitFile | null>(null);
  const model = mirror.model;
  const backup = async (): Promise<void> => {
    const ok = await confirmDialog({
      title: 'Sauvegarder tout l’appareil',
      message: 'Pour lire les 20 mémoires, l’appareil les rappelle une à une (comme le logiciel Windows) : le son change pendant la lecture, puis le preset en cours est rappelé. Coupez les amplis ou faites-le hors spectacle.',
      ok: 'Lancer la sauvegarde',
    });
    if (!ok) return;
    const u = await run('Lecture des 20 presets', () => mirror.call<UnitFile>('downloadUnit'));
    if (u) { setUnit(u); toast('Appareil lu : choisissez le format du fichier', 'ok'); }
  };
  const restore = async (): Promise<void> => {
    const f = await pickFile('.unt,.json,application/json');
    if (!f) return;
    try {
      const of = openFile(await fileBytes(f), f.name, mirror.config ?? undefined);
      if (model && of.model !== model.id) { toast(`Ce fichier est destiné à un ${MODELS[of.model].name}.`, 'error'); return; }
      onOpened(of);
    } catch (e) { toast(errorText(e), 'error'); }
  };
  const factory = (): Promise<void> => factoryReset(mirror);
  return (
    <Card title="Appareil complet" subtitle="Sauvegarde et restauration des 20 mémoires et des réglages de verrouillage, compatibles avec les fichiers .unt du logiciel Windows.">
      <div className="row wrap">
        <Button icon="download" disabled={!canEdit} onClick={backup}>Sauvegarder l’appareil</Button>
        <Button icon="upload" disabled={!canEdit} onClick={restore}>Restaurer une sauvegarde</Button>
        <Button icon="trash" kind="danger" disabled={!canEdit} onClick={factory}>Réglages d’usine</Button>
      </div>
      {unit && (
        <Modal title="Sauvegarde prête" onClose={() => setUnit(null)}>
          <p>{unit.presets.filter(Boolean).length} mémoire(s) utilisateur lue(s).</p>
          <div className="choice">
            <button type="button" className="choice-item" onClick={() => { downloadFile(`${model?.name.replace(' ', '') ?? 'DSP'}_${stamp()}.unt`, encodeUnt(unit) as Uint8Array<ArrayBuffer>); setUnit(null); }}>
              <strong>.unt (logiciel Windows)</strong><span className="small muted">Se restaure aussi avec l’éditeur officiel.</span>
            </button>
            <button type="button" className="choice-item" onClick={() => {
              const n = unitToNative(unit, mirror.config, `Sauvegarde ${new Date().toLocaleString('fr-FR')}`);
              downloadFile(`${model?.name.replace(' ', '') ?? 'DSP'}_${stamp()}.json`, encodeNative(n), 'application/json'); setUnit(null);
            }}>
              <strong>.json (DSP Studio)</strong><span className="small muted">Contient aussi le preset en cours.</span>
            </button>
            <button type="button" className="choice-item" onClick={async () => {
              const lib = getState().backend?.library;
              if (!lib || !model) return;
              const name = await promptDialog({ title: 'Nom de la sauvegarde', label: 'Nom', value: `Sauvegarde ${new Date().toLocaleDateString('fr-FR')}`, maxLength: 80 });
              if (name === null) return;
              await run('Enregistrement', () => lib.save({ kind: 'unit', model: model.id, name, data: unitToNative(unit, mirror.config, name) }), 'Ajouté à la bibliothèque');
              setUnit(null);
            }}>
              <strong>Bibliothèque</strong><span className="small muted">{getState().backend?.library.shared ? 'Disponible depuis tous vos appareils.' : 'Gardée dans ce navigateur.'}</span>
            </button>
          </div>
        </Modal>
      )}
    </Card>
  );
}

/** What to do with an opened file or library entry: listen, write into memories, restore, keep. */
export function OpenedDialog({ file, mirror, onClose, inLibrary }: { file: OpenedFile; mirror: DeviceMirror; onClose: () => void; inLibrary?: boolean }): React.JSX.Element {
  const snap = mirror.snap;
  const model = MODELS[file.model];
  const [slot, setSlot] = useState(snap?.presets.find((p) => !p.user)?.slot ?? 1);
  const [restoreSystem, setRestoreSystem] = useState(false);
  const mode = useApp((s) => s.mode);
  const [chosen, setChosen] = useState<boolean[]>(() => (file.kind === 'unit' ? file.unit.presets.map((p) => !!p) : []));
  if (file.kind === 'preset') {
    const cfg = file.config;
    return (
      <Modal title={`Preset « ${cfg.presetName || file.name} »`} onClose={onClose} footer={<Button onClick={onClose}>Fermer</Button>}>
        <p className="muted small">{file.source === 'prs' ? 'Fichier .prs du logiciel Windows' : 'Fichier DSP Studio'} · {model.name}</p>
        <div className="choice">
          <button type="button" className="choice-item" onClick={async () => {
            onClose();
            await run('Envoi du preset', () => mirror.call('pushConfig', cfg, 'Envoi du preset'), 'Preset envoyé : il joue maintenant (enregistrez-le pour le garder)');
          }}>
            <strong>Écouter maintenant</strong>
            <span className="small muted">Remplace les réglages en cours (seuls les paramètres différents sont envoyés). Rien n’est mémorisé dans l’appareil.</span>
          </button>
          <div className="choice-item">
            <strong>Écrire dans une mémoire sans changer le son</strong>
            <span className="small muted">Le preset est copié dans l’appareil pendant que le son actuel continue.</span>
            <div className="row">
              <Select label="Mémoire" value={slot} onChange={setSlot} options={(snap?.presets ?? []).map((p) => ({ value: p.slot, label: `${presetLabel(p.slot)} · ${p.user ? p.name : 'vide'}` }))} />
              <Button kind="primary" onClick={async () => {
                const sl = snap?.presets.find((p) => p.slot === slot);
                if (sl?.user && !await confirmDialog({ title: 'Remplacer la mémoire', message: `${presetLabel(slot)} contient « ${sl.name} ». Le remplacer ?`, ok: 'Remplacer', danger: true })) return;
                onClose();
                await run(`Écriture dans ${presetLabel(slot)}`, () => mirror.call('writePresetSlot', slot, cfg, cfg.presetName), `Preset écrit dans ${presetLabel(slot)}`);
              }}>Écrire</Button>
            </div>
          </div>
          {!inLibrary && <button type="button" className="choice-item" onClick={async () => {
            const lib = getState().backend?.library;
            if (!lib) return;
            onClose();
            await run('Enregistrement', () => lib.save({ kind: 'preset', model: cfg.model, name: cfg.presetName || file.name, data: presetToNative(cfg) }), 'Ajouté à la bibliothèque');
          }}>
            <strong>Ajouter à la bibliothèque</strong>
            <span className="small muted">{mode === 'bridge' ? 'Partagée par tous les appareils connectés au pont.' : 'Gardée dans ce navigateur.'}</span>
          </button>}
        </div>
      </Modal>
    );
  }
  const used = file.unit.presets.map((p, i) => ({ p, i })).filter((x): x is { p: UnitPreset; i: number } => !!x.p);
  return (
    <Modal wide title={`Sauvegarde « ${file.name} »`} onClose={onClose} footer={<Button onClick={onClose}>Fermer</Button>}>
      <p className="muted small">{file.source === 'unt' ? 'Fichier .unt du logiciel Windows' : 'Fichier DSP Studio'} · {model.name} · {used.length} mémoire(s) utilisée(s)</p>
      <div className="table-wrap"><table className="table">
        <thead><tr><th /><th>Mémoire</th><th>Nom</th></tr></thead>
        <tbody>{used.map(({ p, i }) => (
          <tr key={i}>
            <td><input type="checkbox" checked={chosen[i]} aria-label={`Choisir ${presetLabel(p.slot)}`} onChange={(e) => setChosen(chosen.map((v, k) => (k === i ? e.target.checked : v)))} /></td>
            <td>{presetLabel(p.slot)}</td><td>{p.name}</td>
          </tr>
        ))}</tbody>
      </table></div>
      <div className="choice">
        <div className="choice-item">
          <strong>Restaurer tout l’appareil</strong>
          <span className="small muted">Comme le logiciel Windows : les 20 mémoires sont d’abord remises à zéro, puis celles du fichier sont écrites. Le son en cours n’est pas modifié.</span>
          <label className="check">
            <input type="checkbox" checked={restoreSystem} onChange={(e) => setRestoreSystem(e.target.checked)} />
            <span>Restaurer aussi le verrouillage et le compteur PTS du fichier{file.unit.system.locked ? ' (le fichier contient un appareil verrouillé !)' : ''}</span>
          </label>
          {restoreSystem && <Note tone="warn">Le mot de passe de verrouillage du fichier ({file.unit.system.lockPassword}) et le réglage PTS seront appliqués. L’ID de l’appareil n’est jamais modifié.</Note>}
          <div className="row end">
            <Button kind="danger" onClick={async () => {
              if (!await confirmDialog({ title: 'Restaurer l’appareil', message: 'Toutes les mémoires utilisateur seront remplacées par celles du fichier. Continuer ?', ok: 'Restaurer', danger: true })) return;
              onClose();
              await run('Restauration de l’appareil', () => mirror.call('uploadUnit', file.unit, { restoreSystem }), 'Appareil restauré');
            }}>Restaurer tout</Button>
          </div>
        </div>
        <div className="choice-item">
          <strong>Écrire seulement les mémoires cochées</strong>
          <span className="small muted">Les autres mémoires de l’appareil ne sont pas touchées.</span>
          <div className="row end">
            <Button kind="primary" disabled={!chosen.some((v, i) => v && file.unit.presets[i])} onClick={async () => {
              const list = used.filter(({ i }) => chosen[i]).map(({ p }) => ({ slot: p.slot, name: p.name, config: p.config }));
              onClose();
              await run('Écriture des mémoires', () => mirror.call('writePresets', list), `${list.length} mémoire(s) écrite(s)`);
            }}>Écrire la sélection</Button>
          </div>
        </div>
        {file.live && (
          <button type="button" className="choice-item" onClick={async () => {
            onClose();
            await run('Envoi du preset', () => mirror.call('pushConfig', file.live, 'Envoi du preset'), 'Preset en cours de la sauvegarde envoyé');
          }}>
            <strong>Écouter le preset en cours de la sauvegarde</strong>
          </button>
        )}
      </div>
    </Modal>
  );
}

export function PresetPicker(p: { value: number; onChange: (n: number) => void; withFactory?: boolean }): React.JSX.Element {
  const { snap } = useDevice();
  const opts = [...(p.withFactory ? [{ value: 0, label: 'F00 · usine' }] : []), ...(snap?.presets ?? []).map((x) => ({ value: x.slot, label: `${presetLabel(x.slot)} · ${x.user ? x.name : 'vide'}` }))];
  return <Field label="Mémoire"><Select label="Mémoire" value={p.value} onChange={p.onChange} options={opts} /></Field>;
}
