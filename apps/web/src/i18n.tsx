// Translations of the screens (see packages/i18n): t() for a text, tn() for a text with a number,
// tx() for a sentence with elements in it. In French, the space before « : ; ! ? » » and after
// « « » becomes a narrow no-break space, so a line never starts with a colon or a lone guillemet.

import { Fragment, type ReactNode } from 'react';
import { getLang, t as text, tm as message, tn as plural } from '@dsp-studio/i18n';

export { getLang, LANGS, locale, type Lang } from '@dsp-studio/i18n';

const NNBSP = ' ';
/** French typography of a text shown on screen (other languages: unchanged). */
export function typo(s: string): string {
  if (getLang() !== 'fr' || !s) return s;
  return s.replace(/[  ]([:;!?»])/g, `${NNBSP}$1`).replace(/«[  ]/g, `«${NNBSP}`);
}

export const t = (key: string, ...args: (string | number)[]): string => typo(text(key, ...args));
export const tn = (n: number, one: string, other: string, ...args: (string | number)[]): string => typo(plural(n, one, other, ...args));
export const tm = (s: string): string => typo(message(s));

/** Like t(), with elements for {0}, {1}...: tx('Ouvrez {0}, puis {1}.', <b>Presets</b>, <code>npm start</code>). */
export function tx(key: string, ...args: ReactNode[]): ReactNode {
  const s = t(key);
  if (!args.length) return s;
  return s.split(/\{(\d+)\}/).map((part, i) => (i % 2 ? <Fragment key={i}>{args[Number(part)]}</Fragment> : part));
}
