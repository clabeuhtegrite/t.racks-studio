// Translations of the screens (see packages/i18n): t() for a text, tn() for a text with a number,
// tx() for a sentence with elements in it.

import { Fragment, type ReactNode } from 'react';
import { t } from '@dsp-studio/i18n';

export { getLang, LANGS, locale, t, tm, tn, type Lang } from '@dsp-studio/i18n';

/** Like t(), with elements for {0}, {1}...: tx('Ouvrez {0}, puis {1}.', <b>Presets</b>, <code>npm start</code>). */
export function tx(key: string, ...args: ReactNode[]): ReactNode {
  const s = t(key);
  if (!args.length) return s;
  return s.split(/\{(\d+)\}/).map((part, i) => (i % 2 ? <Fragment key={i}>{args[Number(part)]}</Fragment> : part));
}
