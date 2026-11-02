// Editing operations ("actions"), the commands they send, and how the firmware applies them to the
// configuration (link groups, copy semantics...). The same code runs in the bridge, in the browser
// and in the virtual DSP, so every view of a device stays identical to what the hardware holds.

import { cmd, type Command } from './commands.ts';
import { defaultPeq, type Comp, type DeviceConfig, type Gate, type Limiter, type PeqBand, type Xover } from './config.ts';
import {
  ATTACK_RAW, DELAY_RAW_MAX, deviceAscii, EQ_GAIN_0DB, EQ_GAIN_MAX, FREQ_STEPS, GAIN_RAW_MAX, GATE_THR_MAX_RAW, GEQ_FREQS, HOLD_RAW,
  KNEE_MAX, PEQ_TYPES, Q_MAX, RATIO_MAX, RELEASE_RAW, THR_MAX_RAW, TEST_SOURCES,
} from './codecs.ts';
import { linkedChannels } from './links.ts';
import { MODELS } from './models.ts';

export type Action =
  | { t: 'gain'; ch: number; raw: number }
  | { t: 'mute'; ch: number; on: boolean }
  | { t: 'phase'; ch: number; inv: boolean }
  | { t: 'delay'; ch: number; raw: number }
  | { t: 'delayUnit'; unit: number }
  | { t: 'hpf'; ch: number; x: Xover }
  | { t: 'lpf'; ch: number; x: Xover }
  | { t: 'peq'; ch: number; band: number; p: PeqBand }
  | { t: 'peqBypass'; ch: number; on: boolean }
  | { t: 'peqReset'; ch: number }
  | { t: 'geq'; ch: number; band: number; raw: number }
  | { t: 'geqBypass'; ch: number; on: boolean }
  | { t: 'geqReset'; ch: number }
  | { t: 'gate'; ch: number; g: Gate }
  | { t: 'comp'; ch: number; c: Comp }
  | { t: 'limiter'; ch: number; l: Limiter }
  | { t: 'route'; ch: number; mask: number }
  | { t: 'mix'; ch: number; input: number; raw: number }
  | { t: 'name'; ch: number; name: string }
  | { t: 'link'; kind: 'in' | 'out'; masks: number[] }
  | { t: 'copy'; src: number; dst: number }
  | { t: 'testTone'; source: number; freq: number }
  | { t: 'presetName'; name: string };

const isIn = (cfg: DeviceConfig, ch: number): boolean => ch < MODELS[cfg.model].inputs;
const chan = (cfg: DeviceConfig, ch: number) => (isIn(cfg, ch) ? cfg.inputs[ch] : cfg.outputs[ch - MODELS[cfg.model].inputs]);

/** Frames to send for an action (on the wire, in order). */
export function actionCommands(cfg: DeviceConfig, a: Action): Command[] {
  const m = MODELS[cfg.model];
  switch (a.t) {
    case 'gain': return [cmd.gain(a.ch, a.raw)];
    case 'mute': return [cmd.mute(a.ch, a.on)];
    case 'phase': return [cmd.phase(a.ch, a.inv)];
    case 'delay': return [cmd.delay(a.ch, a.raw)];
    case 'delayUnit': return [cmd.delayUnit(a.unit)];
    case 'hpf': return [cmd.hpf(a.ch, a.x.freq, a.x.slope)];
    case 'lpf': return [cmd.lpf(a.ch, a.x.freq, a.x.slope)];
    case 'peq': return [cmd.peq(a.ch, a.band, a.p)];
    case 'peqBypass': return [cmd.peqBypass(a.ch, a.on)];
    case 'peqReset': {
      const n = isIn(cfg, a.ch) ? m.inPeqBands : m.outPeqBands;
      return defaultPeq(n, isIn(cfg, a.ch)).map((p, k) => cmd.peq(a.ch, k, p));
    }
    case 'geq': return [cmd.geq(a.ch, a.band, a.raw)];
    case 'geqBypass': return [cmd.geqBypass(a.ch, a.on)];
    case 'geqReset': return Array.from({ length: m.geqBands }, (_, k) => cmd.geq(a.ch, k, EQ_GAIN_0DB));
    case 'gate': return [cmd.gate(a.ch, a.g)];
    case 'comp': return [cmd.comp(a.ch, a.c)];
    case 'limiter': return [cmd.limiter(a.ch, a.l)];
    case 'route': return [cmd.route(a.ch, a.mask)];
    case 'mix': return [cmd.mix(a.ch, a.input, a.raw)];
    case 'name': return [cmd.channelName(a.ch, a.name)];
    case 'link': {
      const base = a.kind === 'in' ? 0 : m.inputs;
      return a.masks.map((mask, k) => cmd.link(base + k, mask));
    }
    case 'copy': return [cmd.copyChannel(a.src, a.dst)];
    case 'testTone': return [cmd.testTone(a.source, a.freq)];
    case 'presetName': return [cmd.setPresetName(a.name)];
  }
}

/**
 * Applies an action to a configuration exactly like the firmware does (mutates `cfg`).
 * Returns the wire channel ids that changed (empty for global changes).
 */
export function applyAction(cfg: DeviceConfig, a: Action): number[] {
  const m = MODELS[cfg.model];
  const each = (ch: number, f: (c: ReturnType<typeof chan>) => void): number[] => {
    const group = linkedChannels(cfg, ch);
    for (const k of group) f(chan(cfg, k));
    return group;
  };
  switch (a.t) {
    case 'gain': return each(a.ch, (c) => { c.gain = a.raw; });
    case 'mute': return each(a.ch, (c) => { c.mute = a.on; });
    case 'phase': return each(a.ch, (c) => { c.phase = a.inv ? 1 : 0; });
    case 'delay': return each(a.ch, (c) => { c.delay = a.raw; });
    case 'delayUnit': cfg.delayUnit = a.unit; return [];
    case 'hpf': return each(a.ch, (c) => { c.hpf = { ...a.x }; });
    case 'lpf': return each(a.ch, (c) => { c.lpf = { ...a.x }; });
    case 'peq': return each(a.ch, (c) => { if (a.band < c.peq.length) c.peq[a.band] = { ...a.p }; });
    case 'peqBypass': return each(a.ch, (c) => { c.peqBypass = a.on; });
    case 'peqReset': return each(a.ch, (c) => { c.peq = defaultPeq(c.peq.length, 'gate' in c); });
    case 'geq': return each(a.ch, (c) => { if ('geq' in c) c.geq[a.band] = a.raw; });
    case 'geqBypass': return each(a.ch, (c) => { if ('geq' in c) c.geqBypass = a.on; });
    case 'geqReset': return each(a.ch, (c) => { if ('geq' in c) c.geq = c.geq.map(() => EQ_GAIN_0DB); });
    case 'gate': return each(a.ch, (c) => { if ('gate' in c) c.gate = { ...a.g }; });
    case 'comp': return each(a.ch, (c) => { if ('comp' in c) c.comp = { ...a.c }; });
    case 'limiter': return each(a.ch, (c) => { if ('limiter' in c) c.limiter = { ...a.l }; });
    case 'route': { const c = chan(cfg, a.ch); if ('route' in c) c.route = a.mask; return [a.ch]; }
    case 'mix': { const c = chan(cfg, a.ch); if ('mix' in c) c.mix[a.input] = a.raw; return [a.ch]; }
    case 'name': chan(cfg, a.ch).name = a.name.slice(0, 8); return [a.ch];
    case 'link': {
      const list = a.kind === 'in' ? cfg.inputs : cfg.outputs;
      a.masks.forEach((mk, k) => { if (list[k]) list[k].link = mk; });
      const base = a.kind === 'in' ? 0 : m.inputs;
      return list.map((_, k) => base + k);
    }
    case 'copy': {
      // firmware copy: everything except name, link, routing and mix levels
      const s = chan(cfg, a.src), d = chan(cfg, a.dst);
      if (isIn(cfg, a.src) !== isIn(cfg, a.dst)) return [];
      const keep = { name: d.name, link: d.link, route: (d as { route?: number }).route, mix: (d as { mix?: number[] }).mix };
      const copy = structuredClone(s);
      Object.assign(d, copy, { name: keep.name, link: keep.link });
      if (keep.route !== undefined) Object.assign(d, { route: keep.route, mix: keep.mix });
      return [a.dst];
    }
    case 'testTone': cfg.toneSource = a.source; cfg.toneFreq = a.freq; return [];
    case 'presetName': cfg.presetName = a.name.slice(0, 14); return [];
  }
}

/** Describes an action for logs / undo history (French UI strings live in the web app). */
export function actionKey(a: Action): string {
  switch (a.t) {
    case 'peq': case 'geq': return `${a.t}:${a.ch}:${a.band}`;
    case 'mix': return `mix:${a.ch}:${a.input}`;
    case 'link': return `link:${a.kind}`;
    case 'copy': return `copy:${a.src}:${a.dst}`;
    case 'delayUnit': case 'testTone': case 'presetName': return a.t;
    default: return `${a.t}:${a.ch}`;
  }
}

/** Actions that rebuild a whole configuration on a device (used to push a file or a scene). */
export function configToActions(cfg: DeviceConfig): Action[] {
  const m = MODELS[cfg.model];
  const out: Action[] = [];
  // links first, cleared, so every channel is written individually; restored at the end
  out.push({ t: 'link', kind: 'in', masks: cfg.inputs.map((_, k) => 1 << k) });
  out.push({ t: 'link', kind: 'out', masks: cfg.outputs.map((_, k) => 1 << k) });
  const common = (ch: number, c: DeviceConfig['inputs'][number] | DeviceConfig['outputs'][number]): void => {
    out.push({ t: 'name', ch, name: c.name });
    out.push({ t: 'gain', ch, raw: c.gain }, { t: 'mute', ch, on: c.mute }, { t: 'phase', ch, inv: !!c.phase }, { t: 'delay', ch, raw: c.delay });
    out.push({ t: 'hpf', ch, x: c.hpf }, { t: 'lpf', ch, x: c.lpf });
    c.peq.forEach((p, band) => out.push({ t: 'peq', ch, band, p }));
    out.push({ t: 'peqBypass', ch, on: c.peqBypass });
  };
  cfg.inputs.forEach((c, i) => {
    common(i, c);
    out.push({ t: 'gate', ch: i, g: c.gate });
    c.geq.forEach((raw, band) => out.push({ t: 'geq', ch: i, band, raw }));
    out.push({ t: 'geqBypass', ch: i, on: c.geqBypass });
  });
  cfg.outputs.forEach((c, j) => {
    const ch = m.inputs + j;
    common(ch, c);
    out.push({ t: 'route', ch, mask: c.route });
    c.mix.forEach((raw, input) => out.push({ t: 'mix', ch, input, raw }));
    out.push({ t: 'comp', ch, c: c.comp }, { t: 'limiter', ch, l: c.limiter });
  });
  out.push({ t: 'delayUnit', unit: cfg.delayUnit });
  // the test tone is deliberately not pushed: a file must never start pink noise on a PA
  out.push({ t: 'presetName', name: cfg.presetName });
  out.push({ t: 'link', kind: 'in', masks: cfg.inputs.map((c) => c.link) });
  out.push({ t: 'link', kind: 'out', masks: cfg.outputs.map((c) => c.link) });
  return out;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * The shortest list of actions that turns `from` into `to` (used for A/B comparisons, undo and to
 * recall scenes quickly). Link groups are cleared while the channels are written one by one, then
 * restored, exactly like configToActions, but only when links are involved.
 */
export function diffActions(from: DeviceConfig, to: DeviceConfig): Action[] {
  if (from.model !== to.model) throw new Error('modèles différents');
  const m = MODELS[to.model];
  const linked = (c: DeviceConfig): boolean =>
    c.inputs.some((x, k) => x.link !== 1 << k) || c.outputs.some((x, k) => x.link !== 1 << k);
  const viaClear = linked(from) || linked(to);
  const out: Action[] = [];
  if (viaClear) {
    out.push({ t: 'link', kind: 'in', masks: to.inputs.map((_, k) => 1 << k) });
    out.push({ t: 'link', kind: 'out', masks: to.outputs.map((_, k) => 1 << k) });
  }
  type Ch = DeviceConfig['inputs'][number] | DeviceConfig['outputs'][number];
  const common = (ch: number, a: Ch, b: Ch): void => {
    if (a.name !== b.name) out.push({ t: 'name', ch, name: b.name });
    if (a.gain !== b.gain) out.push({ t: 'gain', ch, raw: b.gain });
    if (a.mute !== b.mute) out.push({ t: 'mute', ch, on: b.mute });
    if (a.phase !== b.phase) out.push({ t: 'phase', ch, inv: !!b.phase });
    if (a.delay !== b.delay) out.push({ t: 'delay', ch, raw: b.delay });
    if (!same(a.hpf, b.hpf)) out.push({ t: 'hpf', ch, x: b.hpf });
    if (!same(a.lpf, b.lpf)) out.push({ t: 'lpf', ch, x: b.lpf });
    b.peq.forEach((p, band) => { if (!same(a.peq[band], p)) out.push({ t: 'peq', ch, band, p }); });
    if (a.peqBypass !== b.peqBypass) out.push({ t: 'peqBypass', ch, on: b.peqBypass });
  };
  to.inputs.forEach((b, i) => {
    const a = from.inputs[i];
    common(i, a, b);
    if (!same(a.gate, b.gate)) out.push({ t: 'gate', ch: i, g: b.gate });
    b.geq.forEach((raw, band) => { if (a.geq[band] !== raw) out.push({ t: 'geq', ch: i, band, raw }); });
    if (a.geqBypass !== b.geqBypass) out.push({ t: 'geqBypass', ch: i, on: b.geqBypass });
  });
  to.outputs.forEach((b, j) => {
    const a = from.outputs[j];
    const ch = m.inputs + j;
    common(ch, a, b);
    if (a.route !== b.route) out.push({ t: 'route', ch, mask: b.route });
    b.mix.forEach((raw, input) => { if (a.mix[input] !== raw) out.push({ t: 'mix', ch, input, raw }); });
    if (!same(a.comp, b.comp)) out.push({ t: 'comp', ch, c: b.comp });
    if (!same(a.limiter, b.limiter)) out.push({ t: 'limiter', ch, l: b.limiter });
  });
  if (from.delayUnit !== to.delayUnit) out.push({ t: 'delayUnit', unit: to.delayUnit });
  if (from.presetName !== to.presetName) out.push({ t: 'presetName', name: to.presetName });
  if (viaClear) {
    out.push({ t: 'link', kind: 'in', masks: to.inputs.map((c) => c.link) });
    out.push({ t: 'link', kind: 'out', masks: to.outputs.map((c) => c.link) });
  }
  return out;
}

/** Actions that undo `a` when applied to the state `before` it ran (for undo/redo). */
export function inverseActions(before: DeviceConfig, a: Action): Action[] {
  const after = structuredClone(before);
  applyAction(after, a);
  return diffActions(after, before);
}

// ----------------------------------------------------------------------------------------------
// Validation of actions coming from the network (bridge) or from files: every number is checked
// against the range the editor allows, so a malformed request can never corrupt the shared state.

export class ActionError extends Error {
  constructor(message: string) { super(message); this.name = 'ActionError'; }
}

const int = (v: unknown, lo: number, hi: number, what: string): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < lo || n > hi) throw new ActionError(`${what} invalide`);
  return n;
};
const bool = (v: unknown, what: string): boolean => {
  if (typeof v !== 'boolean') throw new ActionError(`${what} invalide`);
  return v;
};
const text = (v: unknown, max: number): string => {
  if (typeof v !== 'string') throw new ActionError('nom invalide');
  return deviceAscii(v, max);
};
const obj = (v: unknown, what: string): Record<string, unknown> => {
  if (!v || typeof v !== 'object') throw new ActionError(`${what} invalide`);
  return v as Record<string, unknown>;
};

/** Checks an action against a model and returns a clean copy (throws ActionError). */
export function validateAction(model: keyof typeof MODELS, input: unknown): Action {
  const m = MODELS[model];
  const a = obj(input, 'action');
  const n = m.inputs + m.outputs;
  const ch = (): number => int(a.ch, 0, n - 1, 'canal');
  const inCh = (): number => int(a.ch, 0, m.inputs - 1, 'entrée');
  const outCh = (): number => int(a.ch, m.inputs, n - 1, 'sortie');
  const xover = (): Xover => {
    const x = obj(a.x, 'filtre');
    return { freq: int(x.freq, 0, FREQ_STEPS, 'fréquence'), slope: int(x.slope, 0, 20, 'pente') };
  };
  switch (a.t) {
    case 'gain': return { t: 'gain', ch: ch(), raw: int(a.raw, 0, GAIN_RAW_MAX, 'gain') };
    case 'mute': return { t: 'mute', ch: ch(), on: bool(a.on, 'mute') };
    case 'phase': return { t: 'phase', ch: ch(), inv: bool(a.inv, 'phase') };
    case 'delay': return { t: 'delay', ch: ch(), raw: int(a.raw, 0, DELAY_RAW_MAX, 'délai') };
    case 'delayUnit': return { t: 'delayUnit', unit: int(a.unit, 0, 2, 'unité') };
    case 'hpf': return { t: 'hpf', ch: ch(), x: xover() };
    case 'lpf': return { t: 'lpf', ch: ch(), x: xover() };
    case 'peq': {
      const c = ch();
      const bands = c < m.inputs ? m.inPeqBands : m.outPeqBands;
      const p = obj(a.p, 'bande');
      return {
        t: 'peq', ch: c, band: int(a.band, 0, bands - 1, 'bande'),
        p: {
          gain: int(p.gain, 0, EQ_GAIN_MAX, 'gain'), freq: int(p.freq, 0, FREQ_STEPS, 'fréquence'), q: int(p.q, 0, Q_MAX, 'Q'),
          type: int(p.type, 0, PEQ_TYPES.length - 1, 'type'), bypass: bool(p.bypass, 'bypass'),
        },
      };
    }
    case 'peqBypass': return { t: 'peqBypass', ch: ch(), on: bool(a.on, 'bypass') };
    case 'peqReset': return { t: 'peqReset', ch: ch() };
    case 'geq': return { t: 'geq', ch: inCh(), band: int(a.band, 0, GEQ_FREQS.length - 1, 'bande'), raw: int(a.raw, 0, EQ_GAIN_MAX, 'niveau') };
    case 'geqBypass': return { t: 'geqBypass', ch: inCh(), on: bool(a.on, 'bypass') };
    case 'geqReset': return { t: 'geqReset', ch: inCh() };
    case 'gate': {
      const g = obj(a.g, 'gate');
      return {
        t: 'gate', ch: inCh(),
        g: {
          attack: int(g.attack, ATTACK_RAW.min, ATTACK_RAW.max, 'attaque'), release: int(g.release, RELEASE_RAW.min, RELEASE_RAW.max, 'relâchement'),
          hold: int(g.hold, HOLD_RAW.min, HOLD_RAW.max, 'maintien'), threshold: int(g.threshold, 0, GATE_THR_MAX_RAW, 'seuil'),
        },
      };
    }
    case 'comp': {
      const k = obj(a.c, 'compresseur');
      return {
        t: 'comp', ch: outCh(),
        c: {
          ratio: int(k.ratio, 0, RATIO_MAX, 'ratio'), attack: int(k.attack, ATTACK_RAW.min, ATTACK_RAW.max, 'attaque'),
          release: int(k.release, RELEASE_RAW.min, RELEASE_RAW.max, 'relâchement'), knee: int(k.knee, 0, KNEE_MAX, 'genou'),
          threshold: int(k.threshold, 0, THR_MAX_RAW, 'seuil'),
        },
      };
    }
    case 'limiter': {
      const l = obj(a.l, 'limiteur');
      return {
        t: 'limiter', ch: outCh(),
        l: {
          attack: int(l.attack, ATTACK_RAW.min, ATTACK_RAW.max, 'attaque'), release: int(l.release, RELEASE_RAW.min, RELEASE_RAW.max, 'relâchement'),
          reserved: int(l.reserved ?? 0, 0, 0xffff, 'réservé'), threshold: int(l.threshold, 0, THR_MAX_RAW, 'seuil'),
        },
      };
    }
    case 'route': return { t: 'route', ch: outCh(), mask: int(a.mask, 0, (1 << m.inputs) - 1, 'routage') };
    case 'mix': return { t: 'mix', ch: outCh(), input: int(a.input, 0, m.inputs - 1, 'entrée'), raw: int(a.raw, 0, GAIN_RAW_MAX, 'niveau') };
    case 'name': return { t: 'name', ch: ch(), name: text(a.name, 8) };
    case 'link': {
      const kind = a.kind === 'in' || a.kind === 'out' ? a.kind : null;
      if (!kind) throw new ActionError('liaison invalide');
      const count = kind === 'in' ? m.inputs : m.outputs;
      if (!Array.isArray(a.masks) || a.masks.length !== count) throw new ActionError('liaison invalide');
      return { t: 'link', kind, masks: a.masks.map((v) => int(v, 0, (1 << count) - 1, 'liaison')) };
    }
    case 'copy': {
      const src = int(a.src, 0, n - 1, 'source'), dst = int(a.dst, 0, n - 1, 'destination');
      if ((src < m.inputs) !== (dst < m.inputs) || src === dst) throw new ActionError('copie impossible entre ces canaux');
      return { t: 'copy', src, dst };
    }
    case 'testTone': return { t: 'testTone', source: int(a.source, 0, TEST_SOURCES.length - 1, 'source'), freq: int(a.freq, 0, GEQ_FREQS.length - 1, 'fréquence') };
    case 'presetName': return { t: 'presetName', name: text(a.name, 14) };
    default: throw new ActionError('action inconnue');
  }
}
