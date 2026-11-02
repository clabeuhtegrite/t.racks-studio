// Channel linking, as implemented by the firmware (function at 0x1068 in the 206 image):
// - inputs and outputs form two separate groups of bits (bit i = input i, bit j = output j);
// - a channel whose own bit is set in its own mask "leads" the group described by that mask;
// - the other members store 0 and are found by scanning the earlier channels of the same kind.
// Every DSP parameter sent to one member is applied by the firmware to the whole group.

import type { DeviceConfig } from './config.ts';
import { MODELS } from './models.ts';

/** Group mask (in the channel's own bit space) the firmware uses for a channel. */
export function effectiveLinkMask(cfg: DeviceConfig, ch: number): number {
  const m = MODELS[cfg.model];
  const isIn = ch < m.inputs;
  const list = isIn ? cfg.inputs : cfg.outputs;
  const idx = isIn ? ch : ch - m.inputs;
  const own = list[idx].link;
  if ((own >> idx) & 1) return own;
  for (let k = 0; k < idx; k++) {
    const mk = list[k].link;
    if ((mk >> k) & 1 && (mk >> idx) & 1) return mk;
  }
  return 1 << idx; // not linked
}

/** Wire channel ids affected by a change sent to `ch`. */
export function linkedChannels(cfg: DeviceConfig, ch: number): number[] {
  const m = MODELS[cfg.model];
  const isIn = ch < m.inputs;
  const mask = effectiveLinkMask(cfg, ch);
  const n = isIn ? m.inputs : m.outputs;
  const base = isIn ? 0 : m.inputs;
  const out: number[] = [];
  for (let k = 0; k < n; k++) if ((mask >> k) & 1) out.push(base + k);
  if (!out.includes(ch)) out.unshift(ch);
  return out;
}

/** Leader index (0-based within its kind) for every channel of a kind. */
export function linkLeaders(cfg: DeviceConfig, kind: 'in' | 'out'): number[] {
  const m = MODELS[cfg.model];
  const n = kind === 'in' ? m.inputs : m.outputs;
  const base = kind === 'in' ? 0 : m.inputs;
  return Array.from({ length: n }, (_, k) => {
    const mask = effectiveLinkMask(cfg, base + k);
    for (let j = 0; j < n; j++) if ((mask >> j) & 1) return j;
    return k;
  });
}

/**
 * Masks to send (one LINK command per channel of the kind) for a given leader assignment,
 * exactly like the editor's "Link" dialog: leader gets the OR of its members, members get 0.
 * leaders[k] must be <= k.
 */
export function masksFromLeaders(leaders: number[]): number[] {
  const masks = leaders.map(() => 0);
  leaders.forEach((l, k) => { masks[l] |= 1 << k; });
  return masks.map((mk, k) => (leaders[k] === k ? mk : 0));
}
