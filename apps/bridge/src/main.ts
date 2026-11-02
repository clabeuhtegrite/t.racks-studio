#!/usr/bin/env node
// t.racks Studio bridge: `node apps/bridge/src/main.ts [options]` (Node >= 22.18 runs the TypeScript
// sources directly). Serves the web app and drives the DSPs. Devices are added, connected and
// disconnected from the interface, never from the command line; the bridge remembers them in
// <data>/bridge.json and lists them, not connected, at the next start.

import { existsSync } from 'node:fs';
import { readFile, writeFile, rename } from 'node:fs/promises';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSource } from '@dsp-studio/protocol';
import { locale, pickLang, setLang, t, tm } from '@dsp-studio/i18n';
import { Hub, type SourceSpec } from './hub.ts';
import { Levelers } from './leveler.ts';
import { Library } from './library.ts';
import { BRIDGE_VERSION, startServer } from './server.ts';

// messages in the language of the system (LANG=de_DE.UTF-8...), English by default
setLang(pickLang([process.env.LC_ALL, process.env.LC_MESSAGES, process.env.LANG, Intl.DateTimeFormat().resolvedOptions().locale]));

const help = (): string => t(`t.racks Studio {0} : interface web pour les t.racks DSP 206 et DSP 408

Utilisation : npm start -- [options]   (ou node apps/bridge/src/main.ts [options])

Les DSP s’ajoutent et se connectent depuis l’interface ; le pont les mémorise.

Options :
  --port n                    port HTTP (8080 par défaut, ou variable PORT)
  --host adresse              adresse d’écoute (0.0.0.0 par défaut : tout le réseau local)
  --pin code                  code administrateur (sinon tout le monde est administrateur),
                              ou variable DSP_STUDIO_PIN
  --operator-pin code         code opérateur : volumes, mutes et rappel de presets seulement,
                              ou variable DSP_STUDIO_OPERATOR_PIN
  --data dossier              appareils mémorisés et bibliothèque (~/.dsp-studio par défaut,
                              ou variable DSP_STUDIO_DATA)
  --web dossier               interface web compilée (apps/web/dist par défaut)
  --cert fichier --key fichier
                              HTTPS (application installable, USB et série du navigateur)
  --allow-origin url          autorise une interface hébergée ailleurs (répétable, * = toutes)
  --quiet                     moins de messages
  -h, --help                  cette aide`, BRIDGE_VERSION);

interface Args {
  port: number; host: string; web: string | null; data: string; pin?: string; operatorPin?: string;
  cert?: string; key?: string; allowOrigins: string[]; quiet: boolean;
}

function fail(msg: string): never {
  console.error(t('Erreur : {0}\n(npm start -- --help pour l’aide)', msg));
  process.exit(2);
}

export function parseArgs(argv: string[]): Args {
  const here = dirname(fileURLToPath(import.meta.url));
  const defWeb = resolve(here, '../../web/dist');
  const a: Args = {
    port: Number(process.env.PORT) || 8080, host: '0.0.0.0', web: existsSync(defWeb) ? defWeb : null,
    data: process.env.DSP_STUDIO_DATA || join(os.homedir(), '.dsp-studio'), allowOrigins: [], quiet: false,
    pin: process.env.DSP_STUDIO_PIN || undefined, operatorPin: process.env.DSP_STUDIO_OPERATOR_PIN || undefined,
  };
  const value = (i: number, name: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) fail(t('{0} attend une valeur', name));
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    switch (k) {
      case '-h': case '--help': console.log(help()); process.exit(0);
      // falls through (process.exit never returns)
      case '--port': a.port = Number(value(i, k)); i++; if (!(Number.isInteger(a.port) && a.port > 0 && a.port < 65536)) fail(t('port invalide')); break;
      case '--host': a.host = value(i, k); i++; break;
      case '--web': a.web = resolve(value(i, k)); i++; break;
      case '--data': a.data = resolve(value(i, k)); i++; break;
      case '--pin': a.pin = value(i, k); i++; break;
      case '--operator-pin': a.operatorPin = value(i, k); i++; break;
      case '--cert': a.cert = value(i, k); i++; break;
      case '--key': a.key = value(i, k); i++; break;
      case '--allow-origin': a.allowOrigins.push(value(i, k).replace(/\/+$/, '')); i++; break;
      case '--quiet': a.quiet = true; break;
      case '--demo': case '--tcp': case '--usb': case '--serial':
        fail(t('{0} n’existe plus : les DSP s’ajoutent et se connectent depuis l’interface (Connexion).', k));
      // falls through
      default: fail(t('option inconnue « {0} »', k));
    }
  }
  if ((a.cert && !a.key) || (!a.cert && a.key)) fail(t('--cert et --key vont ensemble'));
  if (a.pin && a.operatorPin && a.pin === a.operatorPin) fail(t('les codes administrateur et opérateur doivent être différents'));
  return a;
}

interface Saved { devices: { spec: SourceSpec; label?: string }[] }

async function loadSaved(file: string): Promise<Saved> {
  try {
    const j = JSON.parse(await readFile(file, 'utf8')) as Partial<Saved>;
    const devices: Saved['devices'] = [];
    for (const d of Array.isArray(j.devices) ? j.devices : []) {
      try { devices.push({ spec: validateSource(d?.spec), label: typeof d?.label === 'string' ? d.label : undefined }); } catch { /* skip */ }
    }
    return { devices };
  } catch { return { devices: [] }; }
}

function localUrls(port: number, host: string, secure: boolean): string[] {
  const scheme = secure ? 'https' : 'http';
  if (host !== '0.0.0.0' && host !== '::') return [`${scheme}://${host}:${port}/`];
  const out = [`${scheme}://localhost:${port}/`];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) out.push(`${scheme}://${i.address}:${port}/`);
  }
  return out;
}

const STATE_TEXT: Record<string, string> = {
  idle: 'non connecté', connecting: 'connexion…', online: 'en ligne', offline: 'hors ligne', locked: 'verrouillé',
};

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const log = (m: string): void => { if (!args.quiet) console.log(`[${new Date().toLocaleTimeString(locale())}] ${tm(m)}`); };
  const library = new Library(join(args.data, 'library'));
  await library.init();
  const stateFile = join(args.data, 'bridge.json');
  const hub = new Hub();

  // the remembered devices are listed, not connected: connections are opened from the interface
  const saved = await loadSaved(stateFile);
  for (const d of saved.devices) hub.add(d.spec, d.label, false);
  // automatic gain of each device, running even with no screen open
  const levelers = new Levelers(hub, join(args.data, 'leveler.json'), log);
  await levelers.init();

  let lastSaved = JSON.stringify(saved.devices);
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const persist = (): void => {
    if (saveTimer) return;
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      const devices = [...hub.devices.values()].map((d) => ({ spec: d.spec, label: d.label }));
      const text = JSON.stringify(devices);
      if (text === lastSaved) return;
      lastSaved = text;
      try {
        await writeFile(stateFile + '.tmp', JSON.stringify({ devices }, null, 1));
        await rename(stateFile + '.tmp', stateFile);
      } catch (e) { log(t('impossible d’enregistrer {0} : {1}', stateFile, tm((e as Error).message))); }
    }, 500);
  };

  const tls = args.cert && args.key ? { cert: await readFile(args.cert), key: await readFile(args.key) } : undefined;
  const server = await startServer({
    port: args.port, host: args.host, webDir: args.web, library, hub, levelers, tls, allowOrigins: args.allowOrigins,
    pins: { admin: args.pin, operator: args.operatorPin }, onDevicesChanged: persist, log,
  }).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE') fail(t('le port {0} est déjà utilisé (essayez --port 8081)', args.port));
    if (e.code === 'EACCES') fail(t('le port {0} demande des droits supplémentaires (voir docs/raspberry-pi.md)', args.port));
    throw e;
  });

  const states = new Map<string, string>();
  hub.on('devices', (list: ReturnType<Hub['list']>) => {
    for (const d of list) {
      const st = t(STATE_TEXT[d.state] ?? d.state) + (d.error ? ` (${tm(d.error)})` : '');
      if (states.get(d.key) !== st) { states.set(d.key, st); log(`${d.label} : ${st}`); }
    }
  });

  console.log('\n' + t('t.racks Studio {0} prêt. Ouvrez l’interface sur :', BRIDGE_VERSION));
  for (const u of localUrls(args.port, args.host, !!tls)) console.log(`  ${u}`);
  if (!args.web) console.log('  ' + t('(interface web non compilée : lancez « npm run build », l’API reste disponible)'));
  if (!args.pin && !args.operatorPin) console.log('  ' + t('Aucun code défini : toute personne du réseau peut tout régler (--pin pour protéger).'));
  console.log('  ' + t('Données : {0}', args.data));
  if (hub.devices.size === 0) console.log('  ' + t('Aucun appareil mémorisé : ajoutez-en depuis l’interface (Connexion).'));
  else {
    console.log('  ' + t('Appareils mémorisés, à connecter depuis l’interface :'));
    for (const d of hub.devices.values()) console.log(`    ${d.label}`);
  }
  console.log('');

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) process.exit(1);
    stopping = true;
    log(t('arrêt…'));
    const force = setTimeout(() => process.exit(0), 3000);
    force.unref();
    server.close();
    await hub.close();
    levelers.close();
    await levelers.flush();
    process.exit(0);
  };
  process.on('SIGINT', () => { void stop(); });
  process.on('SIGTERM', () => { void stop(); });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e: Error) => { console.error(e); process.exit(1); });
}
