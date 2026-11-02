import { afterEach, describe, expect, it } from 'vitest';
import { collectKeys, placeholders, uniqueKeys } from '../scripts/keys.ts';
import { DICTS, locale, pickLang, setLang, t, tm, tn, type Lang } from '../src/index.ts';

const keys = uniqueKeys(collectKeys());

describe('dictionaries', () => {
  it('finds the texts of the sources', () => {
    expect(keys.length).toBeGreaterThan(500);
    expect(keys).toContain('Annuler');
    expect(keys).toContain('configuration trop courte : {0} octets au lieu de {1}');
  });

  for (const lang of ['en', 'de'] as const) {
    const dict = DICTS[lang];
    it(`${lang}: every text is translated`, () => {
      expect(keys.filter((k) => !(k in dict))).toEqual([]);
    });
    it(`${lang}: no translation is left without its text`, () => {
      expect(Object.keys(dict).filter((k) => !keys.includes(k))).toEqual([]);
    });
    it(`${lang}: placeholders and line breaks are kept`, () => {
      expect(Object.entries(dict).filter(([k, v]) => placeholders(k) !== placeholders(v))).toEqual([]);
      expect(Object.entries(dict).filter(([k, v]) => k.split('\n').length !== v.split('\n').length)).toEqual([]);
    });
    it(`${lang}: no French typography left (« », space before a colon)`, () => {
      expect(Object.values(dict).filter((v) => /[«»]|\s[:;!?](\s|$)/.test(v))).toEqual([]);
    });
  }
});

describe('translation', () => {
  afterEach(() => setLang('fr'));
  const inLang = (l: Lang): void => setLang(l);

  it('shows the French source by default and for unknown texts', () => {
    expect(t('Annuler')).toBe('Annuler');
    inLang('en');
    expect(t('Annuler')).toBe('Cancel');
    expect(t('texte inconnu {0}', 3)).toBe('texte inconnu 3');
  });

  it('fills the placeholders', () => {
    inLang('de');
    expect(t('Groupe {0} : {1}', 1, 'Out1 + Out2')).toBe('Gruppe 1: Out1 + Out2');
  });

  it('picks the plural form of the language', () => {
    expect(tn(0, '{0} mémoire écrite', '{0} mémoires écrites')).toBe('0 mémoire écrite');
    inLang('en');
    expect(tn(0, '{0} mémoire écrite', '{0} mémoires écrites')).toBe('0 memories written');
    expect(tn(1, '{0} mémoire écrite', '{0} mémoires écrites')).toBe('1 memory written');
  });

  it('translates messages written elsewhere, their values too', () => {
    inLang('en');
    expect(tm('commande 0x04 interdite')).toBe('command 0x04 forbidden');
    expect(tm('Démo DSP 206 · ID 2')).toBe('Demo DSP 206 · ID 2');
    expect(tm('Ce fichier .prs est destiné à un DSP 408, pas à un DSP 206.')).toBe('This .prs file is for a DSP 408, not a DSP 206.');
    expect(tm('limite invalide')).toBe('invalid limit');
    inLang('de');
    expect(tm('Configuration invalide : modèle inconnu.')).toBe('Ungültige Konfiguration: unbekanntes Modell.');
    expect(tm('Salle des fêtes')).toBe('Salle des fêtes');
  });

  it('chooses the language from the browser or the system', () => {
    expect(pickLang(['de-AT', 'en-US'])).toBe('de');
    expect(pickLang(['es-ES', 'fr-CA'])).toBe('fr');
    expect(pickLang(['es-ES', undefined])).toBe('en');
    expect(locale('en')).toBe('en-GB');
  });
});
