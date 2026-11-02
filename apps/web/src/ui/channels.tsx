// Channel helpers and the channel picker (InA .. Out8), shared by the editors.

import {
  channelLabel, channelResponse, effectiveLinkMask, freqRawToHz, MODELS, thrRawToDb,
  type AnyChannel, type DelayUnit, type DeviceConfig, type InputChannel, type OutputChannel,
} from '@dsp-studio/protocol';
import { channelColor, delayParam, fmtDb, fmtHz, fmtHzShort, P } from './format.ts';
import { Icon } from './icons.tsx';
import { t, tn } from '../i18n.tsx';

export const isIn = (cfg: DeviceConfig, ch: number): boolean => ch < MODELS[cfg.model].inputs;
export function chan(cfg: DeviceConfig, ch: number): AnyChannel {
  const m = MODELS[cfg.model];
  return ch < m.inputs ? cfg.inputs[ch] : cfg.outputs[ch - m.inputs];
}
export const inputOf = (cfg: DeviceConfig, ch: number): InputChannel => cfg.inputs[ch];
export const outputOf = (cfg: DeviceConfig, ch: number): OutputChannel => cfg.outputs[ch - MODELS[cfg.model].inputs];
export const colorOf = (cfg: DeviceConfig, ch: number): string => channelColor(MODELS[cfg.model].inputs, ch);
export const labelOf = (cfg: DeviceConfig, ch: number): string => channelLabel(MODELS[cfg.model], ch);
export function titleOf(cfg: DeviceConfig, ch: number): string {
  const n = chan(cfg, ch).name.trim();
  const l = labelOf(cfg, ch);
  return n && n !== l ? `${l} · ${n}` : l;
}
export function allChannels(cfg: DeviceConfig): number[] {
  const m = MODELS[cfg.model];
  return Array.from({ length: m.inputs + m.outputs }, (_, i) => i);
}
/** Other channels of the same link group (empty when not linked). */
export function linkMates(cfg: DeviceConfig, ch: number): number[] {
  const m = MODELS[cfg.model];
  const input = ch < m.inputs;
  const mask = effectiveLinkMask(cfg, ch);
  const base = input ? 0 : m.inputs;
  const n = input ? m.inputs : m.outputs;
  const out: number[] = [];
  for (let k = 0; k < n; k++) if ((mask >> k) & 1 && base + k !== ch) out.push(base + k);
  return out;
}

export function responseOf(cfg: DeviceConfig, ch: number, freqs: number[], parts: { peq?: boolean; xover?: boolean; geq?: boolean } = {}): { mag: number[]; phase: number[] } {
  const c = chan(cfg, ch);
  const withPeq = parts.peq ?? true, withX = parts.xover ?? true, withGeq = parts.geq ?? true;
  return channelResponse({
    peq: withPeq ? c.peq : [], peqBypass: c.peqBypass,
    hpf: withX ? c.hpf : undefined, lpf: withX ? c.lpf : undefined,
    geq: withGeq && 'geq' in c ? c.geq : undefined, geqBypass: 'geq' in c ? c.geqBypass : true,
    invert: !!c.phase,
  }, freqs);
}

export function ChannelChips(p: {
  cfg: DeviceConfig; value: number; onChange: (ch: number) => void; only?: 'in' | 'out'; label?: string;
}): React.JSX.Element {
  const m = MODELS[p.cfg.model];
  const list = allChannels(p.cfg).filter((ch) => (p.only === 'in' ? ch < m.inputs : p.only === 'out' ? ch >= m.inputs : true));
  return (
    <div className="chips" role="tablist" aria-label={p.label ?? t('Canal')}>
      {list.map((ch) => {
        const c = chan(p.cfg, ch);
        const linked = linkMates(p.cfg, ch).length > 0;
        return (
          <button
            key={ch} type="button" role="tab" aria-selected={ch === p.value}
            className={`chip ${ch === p.value ? 'is-on' : ''} ${ch === m.inputs && !p.only ? 'chip-gap' : ''}`}
            style={{ ['--ch' as string]: colorOf(p.cfg, ch) }}
            onClick={() => p.onChange(ch)}
            title={titleOf(p.cfg, ch)}
          >
            <span className="chip-id">{labelOf(p.cfg, ch)}{linked && <Icon name="link" size={12} />}</span>
            <span className="chip-name">{c.name && c.name !== labelOf(p.cfg, ch) ? c.name : ' '}</span>
            {c.mute && <span className="chip-mute">{t('M')}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** One processing block of a channel, in the order of the signal (the editor's block diagram). */
export interface ChannelBlock {
  key: string;
  /** where its editor is on the channel page */
  id: string;
  label: string;
  /** what it does, and its settings */
  title: string;
  /** active (not at its neutral settings, not bypassed) */
  on: boolean;
  /** main setting, shown under the label when active */
  info?: string;
  /** label and setting in a few characters ("HP 90 Hz", "Délai 2,10 ms"), for the overview */
  short: string;
  mute?: boolean;
}

/** Bands of the parametric EQ that change the sound (not bypassed, with gain, or a filter type). */
export function activePeqBands(c: AnyChannel): number {
  if (c.peqBypass) return 0;
  return c.peq.filter((b) => !b.bypass && (b.gain !== 120 || b.type > 2)).length;
}

export function channelBlocks(cfg: DeviceConfig, ch: number): ChannelBlock[] {
  const m = MODELS[cfg.model];
  const c = chan(cfg, ch);
  const unit = cfg.delayUnit as DelayUnit;
  const peq = activePeqBands(c);
  const hp = c.hpf.slope > 0 ? freqRawToHz(c.hpf.freq) : null;
  const lp = c.lpf.slope > 0 ? freqRawToHz(c.lpf.freq) : null;
  const xInfo = hp !== null && lp !== null ? `${fmtHzShort(hp)} – ${fmtHzShort(lp)}` : hp !== null ? `HP ${fmtHz(hp)}` : lp !== null ? `LP ${fmtHz(lp)}` : '';
  const block = (b: Omit<ChannelBlock, 'short'> & { short?: string }): ChannelBlock => ({ ...b, short: b.short ?? (b.info ? `${b.label} ${b.info}` : b.label) });
  const gain = block({ key: 'gain', id: 'blk-level', label: t('Volume'), title: t('Volume : {0}', P.gain.fmt(c.gain)), on: c.gain !== 280, info: P.gain.fmt(c.gain) });
  const xover = block({
    key: 'xover', id: 'blk-xover', label: t('HP / LP'), title: t('Filtres passe-haut et passe-bas'), on: hp !== null || lp !== null, info: xInfo,
    short: hp !== null && lp !== null ? `HP/LP ${xInfo}` : xInfo || t('HP / LP'),
  });
  const peqB = block({ key: 'peq', id: 'blk-peq', label: 'PEQ', title: t('Égaliseur paramétrique'), on: peq > 0, info: tn(peq, '{0} bande', '{0} bandes') });
  const delay = block({ key: 'delay', id: 'blk-level', label: t('Délai'), title: t('Délai : {0}', delayParam(unit).fmt(c.delay)), on: c.delay > 0, info: delayParam(unit).fmt(c.delay) });
  const phase = block({ key: 'phase', id: 'blk-level', label: t('Polarité'), title: c.phase ? t('Polarité inversée') : t('Polarité normale'), on: !!c.phase, info: t('inversée'), short: t('Polarité inversée') });
  const mute = block({ key: 'mute', id: 'blk-level', label: t('Mute'), title: c.mute ? t('Canal coupé') : t('Canal actif'), on: c.mute, mute: true });
  if (ch < m.inputs) {
    const i = c as InputChannel;
    const geq = i.geqBypass ? 0 : i.geq.filter((g) => g !== 120).length;
    return [
      gain,
      block({ key: 'gate', id: 'blk-gate', label: t('Gate'), title: t('Noise gate'), on: i.gate.threshold > 0, info: fmtDb(thrRawToDb(i.gate.threshold), 0) }),
      block({ key: 'geq', id: 'blk-geq', label: 'GEQ', title: t('Égaliseur graphique 31 bandes'), on: geq > 0, info: tn(geq, '{0} bande', '{0} bandes') }),
      peqB, xover, delay, phase, mute,
    ];
  }
  const o = c as OutputChannel;
  const src = cfg.inputs.map((_, k) => ((o.route >> k) & 1 ? m.inputLabels[k].slice(2) : '')).filter(Boolean).join('+');
  return [
    block({ key: 'route', id: 'blk-route', label: t('Sources'), title: src ? t('Entrées mélangées sur cette sortie : {0}', src) : t('Aucune entrée n’arrive sur cette sortie'), on: o.route !== 0, info: src }),
    xover, peqB,
    block({ key: 'comp', id: 'blk-comp', label: t('Compresseur'), title: t('Compresseur'), on: o.comp.threshold < 220 && o.comp.ratio > 0, info: `${fmtDb(thrRawToDb(o.comp.threshold), 0)} · ${P.ratio.fmt(o.comp.ratio)}`, short: `${t('Comp.')} ${fmtDb(thrRawToDb(o.comp.threshold), 0)} · ${P.ratio.fmt(o.comp.ratio)}` }),
    block({ key: 'limit', id: 'blk-limit', label: t('Limiteur'), title: t('Limiteur'), on: o.limiter.threshold < 220, info: fmtDb(thrRawToDb(o.limiter.threshold), 0) }),
    delay, phase, gain, mute,
  ];
}
