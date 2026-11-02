// Lists the texts to translate, read from the sources:
// - t('…'), tx('…') and tn(n, '…', '…') in the web app and the bridge;
// - the French messages of the protocol and the bridge that reach the screens: errors, progress
//   labels, device names, the RS-232 command table, the bridge's log lines.
//
//   node packages/i18n/scripts/keys.ts          texts missing from en.json / de.json
//   node packages/i18n/scripts/keys.ts --all    every text, with where it comes from

import ts from 'typescript';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
export interface Key { key: string; where: string }

/** Texts built elsewhere that no rule below can see, and internal codes that are never shown. */
const EXTRA = ['Module Ethernet', 'Envoi', 'Série', 'USB', 'limite', 'adresse IP'];
const IGNORE = new Set(['dropped']);

function sources(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(f) && !f.endsWith('.d.ts')) out.push(p);
    }
  };
  walk(join(ROOT, dir));
  return out;
}

/** 'texte' -> texte, `a ${x} b ${y}` -> "a {0} b {1}" */
function keyOf(n: ts.Node): string | null {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isTemplateExpression(n)) return n.head.text + n.templateSpans.map((s, i) => `{${i}}${s.literal.text}`).join('');
  return null;
}
/** has words, or French punctuation that other languages write differently ('{0} : {1}', « ») */
const hasWords = (k: string): boolean => /[A-Za-zÀ-ÿ]{2,}/.test(k.replace(/\{\d+\}/g, '')) || /\s[:;!?]|«/.test(k);
const nameOf = (e: ts.Expression): string => (ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : '');
const inFunction = (n: ts.Node, name: string): boolean => {
  for (let p = n.parent; p; p = p.parent) if (ts.isFunctionDeclaration(p) && p.name?.text === name) return true;
  return false;
};

export function collectKeys(): Key[] {
  const out: Key[] = EXTRA.map((key) => ({ key, where: 'packages/i18n/scripts/keys.ts' }));
  const scan = (dir: string, rule: (n: ts.Node, add: (n: ts.Node | undefined) => void) => void): void => {
    for (const file of sources(dir)) {
      const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const rel = relative(ROOT, file);
      const add = (n: ts.Node | undefined): void => {
        const k = n && keyOf(n);
        if (k && hasWords(k) && !IGNORE.has(k)) out.push({ key: k, where: `${rel}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}` });
      };
      const visit = (n: ts.Node): void => { rule(n, add); ts.forEachChild(n, visit); };
      visit(sf);
    }
  };

  // translation calls
  const calls = (n: ts.Node, add: (n: ts.Node | undefined) => void): void => {
    if (!ts.isCallExpression(n) || !ts.isIdentifier(n.expression)) return;
    const f = n.expression.text;
    if (f === 't' || f === 'tx') add(n.arguments[0]);
    else if (f === 'tn') { add(n.arguments[1]); add(n.arguments[2]); }
  };
  scan('apps/web/src', calls);
  scan('apps/bridge/src', calls);

  // messages written in French by the protocol and the bridge
  const messages = (n: ts.Node, add: (n: ts.Node | undefined) => void): void => {
    if (ts.isNewExpression(n) && /Error$/.test(nameOf(n.expression))) add(n.arguments?.[0]);
    else if (ts.isCallExpression(n)) {
      const f = nameOf(n.expression);
      if (f === 'prog' || f === 'log' || f === 'fail') add(n.arguments[0]);
      else if (f === 'setState') add(n.arguments[1]);
    } else if (ts.isPropertyAssignment(n) && ['label', 'name', 'description', 'data', 'reply'].includes(n.name.getText())) {
      // progress labels, RS-232 command table
      const file = n.getSourceFile().fileName;
      if (/(session|rs232)\.ts$/.test(file)) add(n.initializer);
    } else if (ts.isReturnStatement(n) && n.expression && inFunction(n, 'describeSource')) add(n.expression);
    else if (ts.isParameter(n) && n.initializer && n.name.getText() === 'label') add(n.initializer);
  };
  scan('packages/protocol/src', messages);
  scan('apps/bridge/src', messages);
  return out;
}

/** Unique texts, in the order of the sources. */
export function uniqueKeys(keys = collectKeys()): string[] {
  return [...new Set(keys.map((k) => k.key))];
}

export const placeholders = (s: string): string => [...s.matchAll(/\{(\d+)\}/g)].map((m) => m[1]).sort().join(',');

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const all = collectKeys();
  if (process.argv.includes('--all')) {
    for (const k of all) console.log(`${k.where}\t${JSON.stringify(k.key)}`);
  } else {
    const keys = uniqueKeys(all);
    let missing = 0;
    for (const lang of ['en', 'de']) {
      const dict = JSON.parse(readFileSync(join(ROOT, `packages/i18n/src/${lang}.json`), 'utf8')) as Record<string, string>;
      const lack = keys.filter((k) => !(k in dict));
      missing += lack.length;
      console.log(`${lang}.json : ${keys.length - lack.length} / ${keys.length}`);
      for (const k of lack) console.log(`  ${JSON.stringify(k)}`);
    }
    process.exitCode = missing ? 1 : 0;
  }
}
