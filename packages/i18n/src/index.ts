// Translations. The French text is both the source and the key: t('Annuler') gives "Cancel" in
// English and "Abbrechen" in German. {0}, {1}... are filled with the extra arguments. en.json and
// de.json hold the translations; a missing entry shows the French text (test/dictionaries.test.ts
// lists them). To add a language: copy en.json, translate the values, add it to LANGS and DICTS.

import en from './en.json' with { type: 'json' };
import de from './de.json' with { type: 'json' };

export type Lang = 'fr' | 'en' | 'de';
export type Dict = Record<string, string>;

export const LANGS: readonly { id: Lang; name: string }[] = [
  { id: 'en', name: 'English' },
  { id: 'fr', name: 'Français' },
  { id: 'de', name: 'Deutsch' },
];
export const DICTS: Record<Lang, Dict> = { fr: {}, en, de };

let lang: Lang = 'fr';
let patterns: { re: RegExp; key: string; order: number[] }[] | null = null;

export const isLang = (v: unknown): v is Lang => v === 'fr' || v === 'en' || v === 'de';

/** First supported language of a list such as navigator.languages ("de-AT", "en-US"...), else English. */
export function pickLang(wanted: readonly (string | undefined)[]): Lang {
  for (const w of wanted) {
    const l = (w ?? '').slice(0, 2).toLowerCase();
    if (isLang(l)) return l;
  }
  return 'en';
}

export function setLang(l: Lang): void {
  lang = l;
  patterns = null;
}
export const getLang = (): Lang => lang;

/** BCP 47 tag of a language, for dates, times and plural rules. */
export const locale = (l: Lang = lang): string => (l === 'fr' ? 'fr-FR' : l === 'de' ? 'de-DE' : 'en-GB');

function fill(s: string, args: readonly unknown[]): string {
  if (!args.length) return s;
  return s.replace(/\{(\d+)\}/g, (m, i: string) => (Number(i) < args.length ? String(args[Number(i)]) : m));
}

/** Text in the current language. */
export function t(key: string, ...args: (string | number)[]): string {
  return fill(DICTS[lang][key] ?? key, args);
}

/** Singular or plural form ("{0} preset" / "{0} presets") by the rules of the current language; {0} is n. */
export function tn(n: number, one: string, other: string, ...args: (string | number)[]): string {
  return t(new Intl.PluralRules(locale()).select(n) === 'one' ? one : other, n, ...args);
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Translates a text written elsewhere in French: an error of the bridge or of the protocol, a
 * progress label... Either a key as is, or a key with placeholders whose values are translated too
 * ("Configuration invalide : {0}"). Unknown texts are returned unchanged.
 */
export function tm(text: string): string {
  if (lang === 'fr' || !text) return text;
  // a French screen may have put no-break spaces before the colons ("Scène : …")
  text = text.replace(/[  ]/g, ' ');
  const d = DICTS[lang];
  const hit = d[text];
  if (hit !== undefined) return hit;
  patterns ??= Object.keys(d)
    .filter((k) => /\{\d+\}/.test(k))
    .map((key) => ({
      key,
      order: [...key.matchAll(/\{(\d+)\}/g)].map((m) => Number(m[1])),
      re: new RegExp(`^${key.split(/\{\d+\}/).map(escape).join('(.+?)')}$`, 's'),
    }))
    // longest keys first: "Fichier unité incomplet : {0}" before "{0} : {1}"
    .sort((a, b) => b.key.replace(/\{\d+\}/g, '').length - a.key.replace(/\{\d+\}/g, '').length);
  for (const p of patterns) {
    const m = p.re.exec(text);
    if (!m) continue;
    const args: string[] = [];
    p.order.forEach((i, j) => { args[i] = tm(m[j + 1]); });
    return fill(d[p.key], args);
  }
  return text;
}
