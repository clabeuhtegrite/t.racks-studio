// Channel helpers and the channel picker (InA .. Out8), shared by the editors.

import {
  channelLabel, channelResponse, effectiveLinkMask, MODELS, type AnyChannel, type DeviceConfig, type InputChannel, type OutputChannel,
} from '@dsp-studio/protocol';
import { channelColor } from './format.ts';
import { Icon } from './icons.tsx';

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
    <div className="chips" role="tablist" aria-label={p.label ?? 'Canal'}>
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
            {c.mute && <span className="chip-mute">M</span>}
          </button>
        );
      })}
    </div>
  );
}
