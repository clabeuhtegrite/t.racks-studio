// Gain auto page: keeps the level steady from one record to the next. What the automatic gain hears
// and does right now (and its pause), its settings, the summary of the night with its history, the
// count of writes to the DSP's memory, and the way to the DJ screen.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  currentNight, LEVELER_DEFAULTS, LEVELER_LIMITS, LEVELER_SPEEDS, LEVELER_STEP_DB, MODELS, summarizeNight,
  type DeviceConfig, type LevelerSettings, type LevelerSpeed, type LevelerState, type MeterCheck, type MeterPosition, type NightSummary,
} from '@dsp-studio/protocol';
import type { DeviceMirror } from '../client/mirror.ts';
import { confirmDialog, toast, useApp, useDevice } from '../state/store.ts';
import {
  adviceOf, fmtDuration, levelerRequest, statusText, statusTone, useLeveler, useLevelerHistory, useLiveLevel, type Advice,
} from '../state/leveler.ts';
import { go } from '../state/route.ts';
import { Badge, Button, Card, Empty, HintIcon, Note, ParamRow, Segmented, Spinner, Toggle } from '../ui/kit.tsx';
import { Icon } from '../ui/icons.tsx';
import { LevelMeter } from '../ui/LevelMeter.tsx';
import { LevelHistory, LevelTable } from '../ui/LevelHistory.tsx';
import { LevelPause } from '../ui/LevelPause.tsx';
import { colorOf, labelOf } from '../ui/channels.tsx';
import { fmtNumber, fmtPercent, fmtSigned, parseNumber, type Param } from '../ui/format.ts';
import { locale, t, tn, tx } from '../i18n.tsx';

// ------------------------------------------------------------------------------------- params
/** A setting in half dB on a slider (raw = half dB from the low end). */
function halfDb([lo, hi]: readonly [number, number], def: number, show: (v: number) => string, abs = false): Param {
  return {
    min: 0, max: (hi - lo) * 2, def: (def - lo) * 2,
    fmt: (r) => show(lo + r / 2),
    parse: (text) => {
      const v = parseNumber(text);
      return v === null ? null : Math.round(((abs ? Math.abs(v) : v) - lo) * 2);
    },
    edit: (r) => fmtNumber(lo + r / 2),
  };
}
const D = LEVELER_DEFAULTS, LIM = LEVELER_LIMITS;
const TARGET = halfDb(LIM.target, D.target, (v) => `${fmtNumber(v)} dBFS`);
const TOLERANCE = halfDb(LIM.tolerance, D.tolerance, (v) => `± ${fmtNumber(v)} dB`, true);
const BOOST = halfDb(LIM.maxBoost, D.maxBoost, (v) => `${fmtSigned(v)} dB`, true);
const CUT = halfDb(LIM.maxCut, D.maxCut, (v) => `${fmtSigned(-v)} dB`, true);
const BUDGET: Param = {
  min: LIM.budget[0], max: LIM.budget[1], def: D.budget, step: 10,
  fmt: (r) => `${r} / h`,
  parse: (text) => { const v = parseNumber(text); return v === null ? null : Math.round(v); },
  edit: (r) => String(r),
};
const toRaw = ([lo]: readonly [number, number], v: number): number => Math.round((v - lo) * 2);
const fromRaw = ([lo]: readonly [number, number], r: number): number => lo + r / 2;

const secs = (ms: number): string => fmtNumber(ms / 1000, ms % 1000 ? 1 : 0);
const speedText = (v: LevelerSpeed): string => {
  const sp = LEVELER_SPEEDS[v];
  return t('Écoute {0} s avant d’agir, puis un pas toutes les {1} s pour monter, toutes les {2} s pour baisser.', secs(sp.loud), secs(sp.up), secs(sp.down));
};

// ------------------------------------------------------------------------------------- texts
export function adviceText(a: Advice): string | null {
  switch (a.kind) {
    case 'none': return null;
    case 'ok': return t('Rien à toucher, le niveau est dans la zone.');
    case 'quiet': return t('Rien à toucher : passage calme, le reste du disque est dans la zone.');
    case 'auto': return t('Rien à toucher, le gain automatique s’en occupe.');
    case 'break': return t('Break en cours : rien à toucher.');
    case 'limit': return t('Ne montez pas le gain : les limiteurs travaillent déjà.');
    case 'up': return t('Montez le gain de la table d’environ {0} dB.', a.db);
    case 'down': return t('Baissez le gain de la table d’environ {0} dB.', a.db);
  }
}

function checkText(c: MeterCheck): string {
  const drop = fmtNumber(c.drop);
  if (c.result === 'post') return t('Les vumètres mesurent après le gain (baisse vue : {0} dB).', drop);
  if (c.result === 'pre') return t('Les vumètres mesurent avant le gain (baisse vue : {0} dB).', drop);
  return t('Résultat incertain (baisse vue : {0} dB) : réessayez sur une musique plus régulière.', drop);
}

const levelOrDash = (v: number | null): string => (v === null ? '—' : `${fmtNumber(v)} dBFS`);

// ------------------------------------------------------------------------------------- draft
/**
 * Settings shown while they travel to the bridge: a slider moves at once, the change is sent
 * 250 ms after the last move, and the value from the bridge takes over when it comes back.
 */
function useSettings(mirror: DeviceMirror, st: LevelerState): [LevelerSettings, (patch: Partial<LevelerSettings>) => void] {
  const [draft, setDraft] = useState<Partial<LevelerSettings>>({});
  const pending = useRef<Partial<LevelerSettings>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const send = useRef<() => void>(() => {});
  send.current = () => {
    timer.current = null;
    const sent = pending.current;
    pending.current = {};
    if (!Object.keys(sent).length) return;
    void levelerRequest(mirror, 'set', sent).finally(() => {
      setDraft((d) => {
        const next: Partial<LevelerSettings> = { ...d };
        for (const k of Object.keys(sent) as (keyof LevelerSettings)[]) if (next[k] === sent[k]) delete next[k];
        return next;
      });
    });
  };
  useEffect(() => () => { if (timer.current) { clearTimeout(timer.current); send.current(); } }, []);
  const change = (patch: Partial<LevelerSettings>): void => {
    setDraft((d) => ({ ...d, ...patch }));
    pending.current = { ...pending.current, ...patch };
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => send.current(), 250);
  };
  return [{ ...st.settings, ...draft }, change];
}

// ------------------------------------------------------------------------------------- page
export function LevelView(): React.JSX.Element {
  const { mirror, config } = useDevice();
  const st = useLeveler();
  if (!mirror || !config) return <Empty icon="plug" title={t('Appareil non connecté')} />;
  return (
    <div className="page dense lv-page">
      <div className="page-head">
        <div>
          <h1>{t('Gain automatique')}</h1>
          <p className="muted small">{t('Garde le même niveau d’un disque à l’autre en ajustant doucement le gain des entrées de la table de mixage.')}</p>
        </div>
        <div className="row">
          <Button kind="primary" icon="turntable" onClick={() => go('dj')}>{t('Écran DJ')}</Button>
        </div>
      </div>
      {!st ? (
        <Empty icon="refresh" title={t('Lecture…')}><Spinner /></Empty>
      ) : (
        <LevelCards key={mirror.key} mirror={mirror} config={config} st={st} />
      )}
    </div>
  );
}

function LevelCards({ mirror, config, st }: { mirror: DeviceMirror; config: DeviceConfig; st: LevelerState }): React.JSX.Element {
  const role = useApp((s) => s.role);
  const [settings, change] = useSettings(mirror, st);
  const admin = role === 'admin';
  const operate = role !== 'viewer';
  return (
    // on a computer: what happens now across the top, then the settings, the advanced ones and the night
    <div className="cards lv-cards">
      <NowCard mirror={mirror} st={st} config={config} operate={operate} />
      <AutoCard mirror={mirror} config={config} st={st} settings={settings} change={change} admin={admin} operate={operate} />
      <NightCard mirror={mirror} st={st} />
      <AdvancedCard mirror={mirror} st={st} settings={settings} change={change} admin={admin} />
    </div>
  );
}

function NowCard({ mirror, st, config, operate }: { mirror: DeviceMirror; st: LevelerState; config: DeviceConfig; operate: boolean }): React.JSX.Element {
  const live = useLiveLevel(mirror, st, config);
  const advice = adviceText(adviceOf(st));
  const budget = st.settings.budget;
  return (
    <Card title={t('En ce moment')} className="lv-now" actions={<span className="lv-status"><Badge tone={statusTone(st.status)}>{statusText(st.status)}</Badge></span>}>
      <div className="lv-now-main">
        <LevelMeter st={st} level={live} label={t('Niveau des entrées suivies')} showState />
        <dl className="lv-figures">
          <div><dt>{t('Moyenne')}</dt><dd>{levelOrDash(st.average)}</dd></div>
          <div><dt>{t('Passages forts')}</dt><dd>{levelOrDash(st.loud)}</dd></div>
          <div><dt>{t('Correction')}</dt><dd>{`${fmtSigned(st.correction)} dB`}</dd></div>
          <div><dt>{t('Corrections (1 h)')}</dt><dd>{`${st.writes} / ${budget}`}</dd></div>
        </dl>
      </div>
      <div className="lv-now-notes">
        {advice && <p className="lv-advice"><Icon name="info" size={18} /><span><b>{t('Conseil au DJ')}</b> · {advice}</span></p>}
        {st.clip && <Note tone="danger">{t('Saturation à l’entrée : le vumètre est dans le rouge. Baissez la sortie de la table de mixage.')}</Note>}
        {st.limiting && <Note tone="warn">{t('Le limiteur d’une sortie travaille.')}</Note>}
        {operate && <LevelPause mirror={mirror} st={st} />}
      </div>
    </Card>
  );
}

function AutoCard(p: {
  mirror: DeviceMirror; config: DeviceConfig; st: LevelerState; settings: LevelerSettings; change: (patch: Partial<LevelerSettings>) => void; admin: boolean; operate: boolean;
}): React.JSX.Element {
  const { mirror, config, st, settings, change, admin, operate } = p;
  const local = useApp((s) => s.mode) === 'local';
  const inputs = MODELS[config.model].inputs;
  const offline = st.status === 'offline';
  const toggleInput = (i: number): void => {
    const on = settings.inputs.includes(i);
    if (on && settings.inputs.length === 1) { toast(t('Choisissez au moins une entrée'), 'warn'); return; }
    change({ inputs: on ? settings.inputs.filter((k) => k !== i) : [...settings.inputs, i].sort((a, b) => a - b) });
  };
  const takeTarget = async (): Promise<void> => {
    const r = await levelerRequest(mirror, 'target');
    if (r) toast(t('Niveau cible : {0}', `${fmtNumber(r.settings.target)} dBFS`), 'ok');
  };
  return (
    <Card title={t('Gain automatique')} className="lv-auto" subtitle={t('Corrige par pas de {0} dB, sans jamais dépasser les limites choisies.', fmtNumber(LEVELER_STEP_DB))}>
      <div className="row wrap">
        <Toggle on={settings.enabled} disabled={!operate} onChange={(v) => { void levelerRequest(mirror, 'enable', v); }} icon="wave">
          {settings.enabled ? t('Gain automatique activé') : t('Gain automatique désactivé')}
        </Toggle>
      </div>
      {local && <Note>{t('Mode navigateur : le gain automatique ne tourne que tant que cette page reste ouverte. Avec le pont (Raspberry Pi), il tourne sans écran.')}</Note>}
      {!operate && <p className="small muted">{t('Accès en lecture : un code PIN opérateur ou administrateur permet d’activer le gain automatique.')}</p>}
      {operate && !admin && <p className="small muted">{t('Les réglages sont réservés à l’administrateur.')}</p>}
      {settings.meter === 'unknown' && !offline && (
        <Note tone="warn">{tx('Position des vumètres pas encore vérifiée : la correction risque de n’aller qu’à moitié. Lancez {0} pendant la musique.', <b>{t('Vérifier')}</b>)}</Note>
      )}

      <div className="field">
        <span className="field-label">{t('Entrées suivies')}<HintIcon text={t('Les entrées où arrive la table de mixage. Les entrées liées bougent ensemble.')} size={13} /></span>
        <div className="lv-inputs" role="group" aria-label={t('Entrées suivies')}>
          {Array.from({ length: inputs }, (_, i) => {
            const on = settings.inputs.includes(i);
            const name = config.inputs[i]?.name ?? '';
            return (
              <button
                key={i} type="button" role="checkbox" aria-checked={on} disabled={!admin}
                className={`chip ${on ? 'is-on' : ''}`} style={{ ['--ch' as string]: colorOf(config, i) }} onClick={() => toggleInput(i)}
              >
                <span className="chip-id">{on && <Icon name="check" size={12} />}{labelOf(config, i)}</span>
                <span className="chip-name">{name && name !== labelOf(config, i) ? name : ' '}</span>
              </button>
            );
          })}
        </div>
        <span className="field-hint">{t('Les entrées où arrive la table de mixage. Les entrées liées bougent ensemble.')}</span>
      </div>

      <div className="lv-target">
        <ParamRow
          label={t('Niveau cible')} param={TARGET} value={toRaw(LIM.target, settings.target)} disabled={!admin}
          onChange={(r) => change({ target: fromRaw(LIM.target, r) })} hint={t('Niveau moyen visé après le gain d’entrée')}
        />
        <div className="row end">
          <Button
            small icon="ruler" className="btn-take" title={t('Prendre le niveau actuel')}
            disabled={!admin || (st.average === null && st.level === null)} onClick={() => { void takeTarget(); }}
          >
            {t('Prendre le niveau actuel')}
          </Button>
        </div>
      </div>
    </Card>
  );
}

const percent = (part: number, whole: number): string => fmtPercent(whole ? (100 * part) / whole : 0);

function NightFigures({ sum }: { sum: NightSummary }): React.JSX.Element {
  const judged = sum.inZone + sum.low + sum.high;
  return (
    <dl className="lv-figures lv-six">
      <div><dt>{t('Musique')}</dt><dd>{fmtDuration(sum.music)}</dd></div>
      <div title={t('Trop faible : {0} · trop fort : {1}', percent(sum.low, judged), percent(sum.high, judged))}>
        <dt>{t('Dans la zone')}</dt><dd>{judged ? percent(sum.inZone, judged) : '—'}</dd>
      </div>
      <div><dt>{t('Corrections')}</dt><dd>{sum.steps.toLocaleString(locale())}</dd></div>
      <div><dt>{t('Plage de correction')}</dt><dd>{`${fmtSigned(sum.minCorrection)} / ${fmtSigned(sum.maxCorrection)} dB`}</dd></div>
      <div><dt>{t('Saturation')}</dt><dd>{sum.clip ? fmtDuration(sum.clip) : t('aucune')}</dd></div>
      <div><dt>{t('Limiteurs')}</dt><dd>{sum.limit ? fmtDuration(sum.limit) : t('jamais')}</dd></div>
    </dl>
  );
}

function nightSubtitle(sum: NightSummary | null, kept: boolean): string | undefined {
  const since = sum ? new Intl.DateTimeFormat(locale(), { weekday: 'long', hour: '2-digit', minute: '2-digit' }).format(sum.from) : null;
  // in the browser, the history lives as long as the page
  if (!kept) return since === null ? undefined : t('Depuis {0}.', since);
  return since === null ? t('Gardé 12 heures, même si le Raspberry Pi redémarre.') : t('Depuis {0}. Gardé 12 heures, même si le Raspberry Pi redémarre.', since);
}

function NightCard({ mirror, st }: { mirror: DeviceMirror; st: LevelerState }): React.JSX.Element {
  const all = useLevelerHistory(mirror);
  const points = useMemo(() => currentNight(all), [all]);
  const sum = summarizeNight(points);
  const kept = useApp((s) => s.mode) !== 'local';
  const [mode, setMode] = useState<'chart' | 'table'>('chart');
  return (
    <Card
      className="span2 lv-hist" title={t('Bilan de la soirée')} subtitle={nightSubtitle(sum, kept)}
      actions={
        <Segmented
          small label={t('Affichage')} value={mode} onChange={setMode}
          options={[{ value: 'chart', label: t('Graphique') }, { value: 'table', label: t('Tableau') }]}
        />
      }
    >
      {sum && sum.music > 0 && <NightFigures sum={sum} />}
      {points.length < 2 ? (
        <p className="muted">{t('Le bilan se remplit pendant la musique, même quand le gain automatique est désactivé.')}</p>
      ) : mode === 'chart' ? (
        <LevelHistory points={points} settings={st.settings} label={t('Niveau et correction pendant la soirée')} fill />
      ) : (
        <LevelTable points={points} />
      )}
    </Card>
  );
}

function AdvancedCard(p: {
  mirror: DeviceMirror; st: LevelerState; settings: LevelerSettings; change: (patch: Partial<LevelerSettings>) => void; admin: boolean;
}): React.JSX.Element {
  const { mirror, st, settings, change, admin } = p;
  const check = async (): Promise<void> => {
    const ok = await confirmDialog({
      title: t('Vérifier les vumètres'),
      message: t('Pendant la musique, le gain des entrées suivies baisse de 6 dB pendant 2 secondes, puis revient : la baisse s’entend. Mieux vaut le faire avant l’ouverture, sur un morceau de test. Continuer ?'),
      ok: t('Vérifier'),
    });
    if (!ok) return;
    const r = await levelerRequest<MeterCheck>(mirror, 'check');
    if (r) toast(checkText(r), r.result === 'unclear' ? 'warn' : 'ok');
  };
  return (
    <Card title={t('Réglages avancés')} className="lv-adv">
      <ParamRow
        label={t('Zone tolérée')} param={TOLERANCE} value={toRaw(LIM.tolerance, settings.tolerance)} disabled={!admin}
        onChange={(r) => change({ tolerance: fromRaw(LIM.tolerance, r) })} hint={t('Écart autour de la cible où rien ne bouge')}
      />
      <ParamRow
        label={t('Remontée maximale')} param={BOOST} value={toRaw(LIM.maxBoost, settings.maxBoost)} disabled={!admin}
        onChange={(r) => change({ maxBoost: fromRaw(LIM.maxBoost, r) })}
      />
      <ParamRow
        label={t('Baisse maximale')} param={CUT} value={toRaw(LIM.maxCut, settings.maxCut)} disabled={!admin}
        onChange={(r) => change({ maxCut: fromRaw(LIM.maxCut, r) })}
      />
      <div className="field field-inline">
        <span className="field-label">{t('Vitesse')}<HintIcon text={speedText(settings.speed)} size={13} /></span>
        <Segmented<LevelerSpeed>
          label={t('Vitesse')} value={settings.speed} disabled={!admin} onChange={(v) => change({ speed: v })}
          options={(['slow', 'normal', 'fast'] as const).map((v) => ({ value: v, label: v === 'slow' ? t('Lente') : v === 'normal' ? t('Normale') : t('Rapide'), title: speedText(v) }))}
        />
        <span className="field-hint">{speedText(settings.speed)}</span>
      </div>
      <ParamRow
        label={t('Limite de corrections')} param={BUDGET} value={settings.budget} disabled={!admin} onChange={(v) => change({ budget: v })}
        hint={t('Chaque correction est écrite dans la mémoire du DSP : cette limite la ménage.')}
      />
      <WritesField st={st} />
      <div className="field">
        <div className="field-label-row">
          <span className="field-label">{t('Vumètres des entrées')}<HintIcon text={t('Le gain automatique doit savoir si les vumètres du DSP mesurent avant ou après le gain d’entrée. La vérification le trouve toute seule.')} size={13} /></span>
          <Button small icon="refresh" disabled={!admin || st.status === 'offline' || st.status === 'checking'} onClick={() => { void check(); }}>{t('Vérifier')}</Button>
        </div>
        <Segmented<MeterPosition>
          label={t('Vumètres des entrées')} value={settings.meter} disabled={!admin} onChange={(v) => change({ meter: v })}
          options={[{ value: 'unknown', label: t('Pas vérifié') }, { value: 'pre', label: t('Avant le gain') }, { value: 'post', label: t('Après le gain') }]}
        />
        <span className={st.check ? 'field-hint is-result' : 'field-hint'}>
          {st.check ? checkText(st.check) : t('Le gain automatique doit savoir si les vumètres du DSP mesurent avant ou après le gain d’entrée. La vérification le trouve toute seule.')}
        </span>
      </div>
    </Card>
  );
}

/** a DSP memory of this kind is usually rated for at least a million writes per place */
const MEMORY_WRITES = 1_000_000;

function WritesField({ st }: { st: LevelerState }): React.JSX.Element {
  const { steps, since } = st.totals;
  const share = (100 * steps) / MEMORY_WRITES;
  const date = since === null ? null : new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'long', year: 'numeric' }).format(since);
  const hint = t('Chaque pas du gain automatique écrit une fois le gain de chaque entrée suivie. Une mémoire de ce type tient en général au moins un million d’écritures : {0} utilisés.', fmtPercent(share, share < 1 ? 2 : 1));
  return (
    <div className="field lv-writes">
      <span className="field-label">{t('Écritures dans la mémoire du DSP')}<HintIcon text={hint} size={13} /></span>
      <p className="lv-total">
        <b>{tn(steps, '{1} écriture', '{1} écritures', steps.toLocaleString(locale()))}</b>
        {date && <span className="muted"> · {t('depuis le {0}', date)}</span>}
      </p>
      <span className="field-hint">{hint}</span>
    </div>
  );
}
