// Presets and files (the editor's Recall / Store buttons and its File menu):
// - recall F00 / U01..U20, store under a name, rename the current preset;
// - open a preset (.prs of the Windows editor or t.racks Studio .json) and send it, or write it into a
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
import { locale, t, tn, tx } from '../i18n.tsx';

export function PresetsView(): React.JSX.Element {
  const { mirror, snap, config } = useDevice();
  const canEdit = useCanEdit();
  const canOperate = useCanOperate();
  const [opened, setOpened] = useState<OpenedFile | null>(null);
  if (!mirror || !snap) return <></>;
  const m = snap.model ? MODELS[snap.model] : null;
  if (!m) return <></>;
  const presets = [{ slot: 0, name: t('Réglage d’usine (lecture seule)'), user: false }, ...snap.presets];

  const recall = async (n: number): Promise<void> => {
    await run(t('Rappel du preset {0}', presetLabel(n)), () => mirror.call('loadPreset', n), t('Preset {0} rappelé', presetLabel(n)));
    mirror.clearHistory();
  };
  const store = async (n: number): Promise<void> => {
    const slot = snap.presets.find((p) => p.slot === n);
    const name = await promptDialog({
      title: t('Enregistrer dans {0}', presetLabel(n)),
      message: slot?.user ? t('{0} contient déjà « {1} » : il sera remplacé par les réglages actuels.', presetLabel(n), slot.name) : t('Les réglages actuels seront mémorisés dans l’appareil.'),
      label: t('Nom du preset (14 caractères)'), value: config?.presetName ?? '', maxLength: 14, ok: t('Enregistrer'),
    });
    if (name === null) return;
    await run(t('Enregistrement dans {0}', presetLabel(n)), () => mirror.call('storePreset', n, name), t('Enregistré dans {0}', presetLabel(n)));
  };

  const openAny = async (): Promise<void> => {
    const f = await pickFile('.prs,.unt,.json,application/json');
    if (!f) return;
    try {
      const of = openFile(await fileBytes(f), f.name, mirror.config ?? undefined);
      if (of.model !== m.id) { toast(t('Ce fichier est destiné à un {0}, cet appareil est un {1}.', MODELS[of.model].name, m.name), 'error'); return; }
      setOpened(of);
    } catch (e) { toast(errorText(e), 'error'); }
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('Presets')}</h1>
        <div className="row">
          <Button icon="open" onClick={openAny} disabled={!canEdit}>{t('Ouvrir un fichier')}</Button>
          <SaveMenu config={config} />
        </div>
      </div>

      {config && (
        <Card title={t('Preset en cours')}>
          <div className="current-preset">
            <span className="preset-big">{presetLabel(snap.activePreset)}</span>
            <div className="grow">
              <strong>{config.presetName || t('Sans nom')}</strong>
              <p className="small muted">{t('Les réglages modifiés depuis le rappel ne sont mémorisés qu’après « Enregistrer ».')}</p>
            </div>
            <Button small icon="edit" disabled={!canEdit} onClick={async () => {
              const v = await promptDialog({ title: t('Nom du preset en cours'), label: t('Nom (14 caractères)'), value: config.presetName, maxLength: 14, ok: t('Renommer') });
              if (v !== null) mirror.apply({ t: 'presetName', name: v });
            }}>{t('Renommer')}</Button>
          </div>
        </Card>
      )}

      <Card title={t('Mémoires de l’appareil')} subtitle={t('F00 est le réglage d’usine ; U01 à U20 sont les mémoires utilisateur.')}>
        <div className="presets">
          {presets.map((p) => (
            <div key={p.slot} className={`preset ${p.slot === snap.activePreset ? 'is-on' : ''} ${p.user || p.slot === 0 ? '' : 'is-empty'}`}>
              <span className="preset-num">{presetLabel(p.slot)}</span>
              <span className="preset-name">{p.slot === 0 ? t('Réglage d’usine') : p.user ? p.name || t('Sans nom') : t('Vide (réglage d’usine)')}</span>
              {p.slot === snap.activePreset && <Badge tone="accent">{t('en cours')}</Badge>}
              <div className="preset-actions">
                <Button small icon="play" disabled={!canOperate} onClick={() => recall(p.slot)}>{t('Rappeler')}</Button>
                {p.slot > 0 && <Button small icon="save" disabled={!canEdit} onClick={() => store(p.slot)}>{t('Enregistrer ici')}</Button>}
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
  if (!await confirmDialog({ title: t('Réglages d’usine'), message: t('Remettre les 20 mémoires utilisateur au réglage d’usine ? Les presets enregistrés dans l’appareil seront perdus (sauvegardez-les avant).'), ok: t('Tout effacer'), danger: true })) return;
  await run(t('Retour aux réglages d’usine'), () => mirror.call('factoryReset'), t('Appareil remis aux réglages d’usine'));
  mirror.clearHistory();
}

function SaveMenu({ config }: { config: DeviceConfig | null }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  if (!config) return <></>;
  const base = safeName(config.presetName || 'preset');
  return (
    <>
      <Button icon="download" onClick={() => setOpen(true)}>{t('Enregistrer sur l’ordinateur')}</Button>
      {open && (
        <Modal title={t('Enregistrer le preset en cours')} onClose={() => setOpen(false)}>
          <p className="muted">{t('Deux formats au choix :')}</p>
          <div className="choice">
            <button type="button" className="choice-item" onClick={() => { downloadFile(`${base}.prs`, encodePrs(config) as Uint8Array<ArrayBuffer>); setOpen(false); }}>
              <strong>{t('.prs (logiciel Windows)')}</strong>
              <span className="small muted">{t('S’ouvre aussi dans l’éditeur officiel t.racks. Ne contient pas l’unité des délais, le générateur et les bypass globaux d’EQ (comme l’éditeur).')}</span>
            </button>
            <button type="button" className="choice-item" onClick={() => { downloadFile(`${base}.json`, encodeNative(presetToNative(config)), 'application/json'); setOpen(false); }}>
              <strong>{t('.json (t.racks Studio)')}</strong>
              <span className="small muted">{t('Garde absolument tous les réglages.')}</span>
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
      title: t('Sauvegarder tout l’appareil'),
      message: t('Pour lire les 20 mémoires, l’appareil les rappelle une à une (comme le logiciel Windows) : le son change pendant la lecture, puis le preset en cours est rappelé. Coupez les amplis ou faites-le hors spectacle.'),
      ok: t('Lancer la sauvegarde'),
    });
    if (!ok) return;
    const u = await run(t('Lecture des 20 presets'), () => mirror.call<UnitFile>('downloadUnit'));
    if (u) { setUnit(u); toast(t('Appareil lu : choisissez le format du fichier'), 'ok'); }
  };
  const restore = async (): Promise<void> => {
    const f = await pickFile('.unt,.json,application/json');
    if (!f) return;
    try {
      const of = openFile(await fileBytes(f), f.name, mirror.config ?? undefined);
      if (model && of.model !== model.id) { toast(t('Ce fichier est destiné à un {0}.', MODELS[of.model].name), 'error'); return; }
      onOpened(of);
    } catch (e) { toast(errorText(e), 'error'); }
  };
  const factory = (): Promise<void> => factoryReset(mirror);
  return (
    <Card title={t('Appareil complet')} subtitle={t('Sauvegarde et restauration des 20 mémoires et des réglages de verrouillage, compatibles avec les fichiers .unt du logiciel Windows.')}>
      <div className="row wrap">
        <Button icon="download" disabled={!canEdit} onClick={backup}>{t('Sauvegarder l’appareil')}</Button>
        <Button icon="upload" disabled={!canEdit} onClick={restore}>{t('Restaurer une sauvegarde')}</Button>
        <Button icon="trash" kind="danger" disabled={!canEdit} onClick={factory}>{t('Réglages d’usine')}</Button>
      </div>
      {unit && (
        <Modal title={t('Sauvegarde prête')} onClose={() => setUnit(null)}>
          <p>{tx('{0} mémoire(s) utilisateur lue(s).', unit.presets.filter(Boolean).length)}</p>
          <div className="choice">
            <button type="button" className="choice-item" onClick={() => { downloadFile(`${model?.name.replace(' ', '') ?? 'DSP'}_${stamp()}.unt`, encodeUnt(unit) as Uint8Array<ArrayBuffer>); setUnit(null); }}>
              <strong>{t('.unt (logiciel Windows)')}</strong><span className="small muted">{t('Se restaure aussi avec l’éditeur officiel.')}</span>
            </button>
            <button type="button" className="choice-item" onClick={() => {
              const n = unitToNative(unit, mirror.config, t('Sauvegarde {0}', new Date().toLocaleString(locale())));
              downloadFile(`${model?.name.replace(' ', '') ?? 'DSP'}_${stamp()}.json`, encodeNative(n), 'application/json'); setUnit(null);
            }}>
              <strong>{t('.json (t.racks Studio)')}</strong><span className="small muted">{t('Contient aussi le preset en cours.')}</span>
            </button>
            <button type="button" className="choice-item" onClick={async () => {
              const lib = getState().backend?.library;
              if (!lib || !model) return;
              const name = await promptDialog({ title: t('Nom de la sauvegarde'), label: t('Nom'), value: t('Sauvegarde {0}', new Date().toLocaleDateString(locale())), maxLength: 80 });
              if (name === null) return;
              await run(t('Enregistrement'), () => lib.save({ kind: 'unit', model: model.id, name, data: unitToNative(unit, mirror.config, name) }), t('Ajouté à la bibliothèque'));
              setUnit(null);
            }}>
              <strong>{t('Bibliothèque')}</strong><span className="small muted">{getState().backend?.library.shared ? t('Disponible depuis tous vos appareils.') : t('Gardée dans ce navigateur.')}</span>
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
      <Modal title={t('Preset « {0} »', cfg.presetName || file.name)} onClose={onClose} footer={<Button onClick={onClose}>{t('Fermer')}</Button>}>
        <p className="muted small">{file.source === 'prs' ? t('Fichier .prs du logiciel Windows') : t('Fichier t.racks Studio')} · {model.name}</p>
        <div className="choice">
          <button type="button" className="choice-item" onClick={async () => {
            onClose();
            await run(t('Envoi du preset'), () => mirror.call('pushConfig', cfg, t('Envoi du preset')), t('Preset envoyé : il joue maintenant (enregistrez-le pour le garder)'));
          }}>
            <strong>{t('Écouter maintenant')}</strong>
            <span className="small muted">{t('Remplace les réglages en cours (seuls les paramètres différents sont envoyés). Rien n’est mémorisé dans l’appareil.')}</span>
          </button>
          <div className="choice-item">
            <strong>{t('Écrire dans une mémoire sans changer le son')}</strong>
            <span className="small muted">{t('Le preset est copié dans l’appareil pendant que le son actuel continue.')}</span>
            <div className="row">
              <Select label={t('Mémoire')} value={slot} onChange={setSlot} options={(snap?.presets ?? []).map((p) => ({ value: p.slot, label: `${presetLabel(p.slot)} · ${p.user ? p.name : t('vide')}` }))} />
              <Button kind="primary" onClick={async () => {
                const sl = snap?.presets.find((p) => p.slot === slot);
                if (sl?.user && !await confirmDialog({ title: t('Remplacer la mémoire'), message: t('{0} contient « {1} ». Le remplacer ?', presetLabel(slot), sl.name), ok: t('Remplacer'), danger: true })) return;
                onClose();
                await run(t('Écriture dans {0}', presetLabel(slot)), () => mirror.call('writePresetSlot', slot, cfg, cfg.presetName), t('Preset écrit dans {0}', presetLabel(slot)));
              }}>{t('Écrire')}</Button>
            </div>
          </div>
          {!inLibrary && <button type="button" className="choice-item" onClick={async () => {
            const lib = getState().backend?.library;
            if (!lib) return;
            onClose();
            await run(t('Enregistrement'), () => lib.save({ kind: 'preset', model: cfg.model, name: cfg.presetName || file.name, data: presetToNative(cfg) }), t('Ajouté à la bibliothèque'));
          }}>
            <strong>{t('Ajouter à la bibliothèque')}</strong>
            <span className="small muted">{mode === 'bridge' ? t('Partagée par tous les appareils connectés au pont.') : t('Gardée dans ce navigateur.')}</span>
          </button>}
        </div>
      </Modal>
    );
  }
  const used = file.unit.presets.map((p, i) => ({ p, i })).filter((x): x is { p: UnitPreset; i: number } => !!x.p);
  return (
    <Modal wide title={t('Sauvegarde « {0} »', file.name)} onClose={onClose} footer={<Button onClick={onClose}>{t('Fermer')}</Button>}>
      <p className="muted small">{tn(used.length, '{1} · {2} · {0} mémoire utilisée', '{1} · {2} · {0} mémoires utilisées', file.source === 'unt' ? t('Fichier .unt du logiciel Windows') : t('Fichier t.racks Studio'), model.name)}</p>
      <div className="table-wrap"><table className="table">
        <thead><tr><th /><th>{t('Mémoire')}</th><th>{t('Nom')}</th></tr></thead>
        <tbody>{used.map(({ p, i }) => (
          <tr key={i}>
            <td><input type="checkbox" checked={chosen[i]} aria-label={t('Choisir {0}', presetLabel(p.slot))} onChange={(e) => setChosen(chosen.map((v, k) => (k === i ? e.target.checked : v)))} /></td>
            <td>{presetLabel(p.slot)}</td><td>{p.name}</td>
          </tr>
        ))}</tbody>
      </table></div>
      <div className="choice">
        <div className="choice-item">
          <strong>{t('Restaurer tout l’appareil')}</strong>
          <span className="small muted">{t('Comme le logiciel Windows : les 20 mémoires sont d’abord remises à zéro, puis celles du fichier sont écrites. Le son en cours n’est pas modifié.')}</span>
          <label className="check">
            <input type="checkbox" checked={restoreSystem} onChange={(e) => setRestoreSystem(e.target.checked)} />
            <span>{file.unit.system.locked ? t('Restaurer aussi le verrouillage et le compteur PTS du fichier (le fichier contient un appareil verrouillé !)') : t('Restaurer aussi le verrouillage et le compteur PTS du fichier')}</span>
          </label>
          {restoreSystem && <Note tone="warn">{tx('Le mot de passe de verrouillage du fichier ({0}) et le réglage PTS seront appliqués. L’ID de l’appareil n’est jamais modifié.', file.unit.system.lockPassword)}</Note>}
          <div className="row end">
            <Button kind="danger" onClick={async () => {
              if (!await confirmDialog({ title: t('Restaurer l’appareil'), message: t('Toutes les mémoires utilisateur seront remplacées par celles du fichier. Continuer ?'), ok: t('Restaurer'), danger: true })) return;
              onClose();
              await run(t('Restauration de l’appareil'), () => mirror.call('uploadUnit', file.unit, { restoreSystem }), t('Appareil restauré'));
            }}>{t('Restaurer tout')}</Button>
          </div>
        </div>
        <div className="choice-item">
          <strong>{t('Écrire seulement les mémoires cochées')}</strong>
          <span className="small muted">{t('Les autres mémoires de l’appareil ne sont pas touchées.')}</span>
          <div className="row end">
            <Button kind="primary" disabled={!chosen.some((v, i) => v && file.unit.presets[i])} onClick={async () => {
              const list = used.filter(({ i }) => chosen[i]).map(({ p }) => ({ slot: p.slot, name: p.name, config: p.config }));
              onClose();
              await run(t('Écriture des mémoires'), () => mirror.call('writePresets', list), tn(list.length, '{0} mémoire écrite', '{0} mémoires écrites'));
            }}>{t('Écrire la sélection')}</Button>
          </div>
        </div>
        {file.live && (
          <button type="button" className="choice-item" onClick={async () => {
            onClose();
            await run(t('Envoi du preset'), () => mirror.call('pushConfig', file.live, t('Envoi du preset')), t('Preset en cours de la sauvegarde envoyé'));
          }}>
            <strong>{t('Écouter le preset en cours de la sauvegarde')}</strong>
          </button>
        )}
      </div>
    </Modal>
  );
}

export function PresetPicker(p: { value: number; onChange: (n: number) => void; withFactory?: boolean }): React.JSX.Element {
  const { snap } = useDevice();
  const opts = [...(p.withFactory ? [{ value: 0, label: t('F00 · usine') }] : []), ...(snap?.presets ?? []).map((x) => ({ value: x.slot, label: `${presetLabel(x.slot)} · ${x.user ? x.name : t('vide')}` }))];
  return <Field label={t('Mémoire')}><Select label={t('Mémoire')} value={p.value} onChange={p.onChange} options={opts} /></Field>;
}
