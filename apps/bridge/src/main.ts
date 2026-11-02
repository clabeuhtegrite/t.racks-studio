#!/usr/bin/env node
// DSP Studio bridge: `node apps/bridge/src/main.ts [options]` (Node >= 22.18 runs the TypeScript
// sources directly). Serves the web app and drives the DSPs listed on the command line, plus the
// ones added from the web app (remembered in <data>/bridge.json).

import { existsSync } from 'node:fs';
import { readFile, writeFile, rename } from 'node:fs/promises';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSource, type ModelId } from '@dsp-studio/protocol';
import { Hub, specKey, type SourceSpec } from './hub.ts';
import { Library } from './library.ts';
import { BRIDGE_VERSION, startServer } from './server.ts';
import { DSP_TCP_PORT } from './transports.ts';

const HELP = `DSP Studio ${BRIDGE_VERSION} - pont réseau pour t.racks DSP 206 / DSP 408

Utilisation : node apps/bridge/src/main.ts [options]

Appareils (options répétables, les appareils ajoutés depuis l'interface sont mémorisés) :
  --demo [206|408]           DSP virtuel (sans valeur : un 206 et un 408)
  --tcp hôte[:port][#id]     module Ethernet ou émulateur (port ${DSP_TCP_PORT} par défaut)
  --usb [chemin][#id]        DSP branché en USB sur cet ordinateur
  --serial port[@débit][#id] RS-232 / RS-485 (115200 bauds par défaut), ex. /dev/ttyUSB0 ou COM3

Serveur :
  --port n                   port HTTP (8080 par défaut, ou variable PORT)
  --host adresse             adresse d'écoute (0.0.0.0 par défaut : tout le réseau local)
  --web dossier              interface web compilée (apps/web/dist par défaut)
  --data dossier             bibliothèque et réglages (~/.dsp-studio par défaut)
  --pin code                 code administrateur (sinon tout le monde est administrateur)
  --operator-pin code        code opérateur : volumes, mutes et rappel de presets seulement
  --cert fichier --key fichier  HTTPS (application installable, USB et série du navigateur hors localhost)
  --allow-origin url         autorise une interface hébergée ailleurs (répétable, * = toutes)
  --no-save                  ne mémorise pas les appareils
  --quiet                    moins de messages
  -h, --help                 cette aide
`;

interface Args {
  port: number; host: string; web: string | null; data: string; pin?: string; operatorPin?: string;
  cert?: string; key?: string; allowOrigins: string[]; save: boolean; quiet: boolean; specs: SourceSpec[];
}

function fail(msg: string): never {
  console.error(`Erreur : ${msg}\n(node apps/bridge/src/main.ts --help pour l'aide)`);
  process.exit(2);
}

/** "x#3" -> ["x", 3] */
function splitId(v: string): [string, number | undefined] {
  const i = v.lastIndexOf('#');
  if (i < 0) return [v, undefined];
  const id = Number(v.slice(i + 1));
  if (!Number.isInteger(id) || id < 1 || id > 250) fail(`ID d'appareil invalide dans "${v}" (1..250)`);
  return [v.slice(0, i), id];
}

const modelArg = (v: string): ModelId | null => {
  const s = v.toLowerCase().replace(/^dsp/, '');
  return s === '206' ? 'dsp206' : s === '408' ? 'dsp408' : null;
};

export function parseArgs(argv: string[]): Args {
  const here = dirname(fileURLToPath(import.meta.url));
  const defWeb = resolve(here, '../../web/dist');
  const a: Args = {
    port: Number(process.env.PORT) || 8080, host: '0.0.0.0', web: existsSync(defWeb) ? defWeb : null,
    data: process.env.DSP_STUDIO_DATA ?? join(os.homedir(), '.dsp-studio'), allowOrigins: [], save: true, quiet: false, specs: [],
  };
  const value = (i: number, name: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) fail(`${name} attend une valeur`);
    return v;
  };
  const optional = (i: number): string | undefined => {
    const v = argv[i + 1];
    return v !== undefined && !v.startsWith('-') ? v : undefined;
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    switch (k) {
      case '-h': case '--help': console.log(HELP); process.exit(0);
      // falls through (process.exit never returns)
      case '--port': a.port = Number(value(i, k)); i++; if (!(a.port > 0 && a.port < 65536)) fail('port invalide'); break;
      case '--host': a.host = value(i, k); i++; break;
      case '--web': a.web = resolve(value(i, k)); i++; break;
      case '--data': a.data = resolve(value(i, k)); i++; break;
      case '--pin': a.pin = value(i, k); i++; break;
      case '--operator-pin': a.operatorPin = value(i, k); i++; break;
      case '--cert': a.cert = value(i, k); i++; break;
      case '--key': a.key = value(i, k); i++; break;
      case '--allow-origin': a.allowOrigins.push(value(i, k).replace(/\/+$/, '')); i++; break;
      case '--no-save': a.save = false; break;
      case '--quiet': a.quiet = true; break;
      case '--demo': {
        const v = optional(i);
        const [m, id] = v ? splitId(v) : ['', undefined];
        const model = v ? modelArg(m) : null;
        if (v && !model) fail(`modèle inconnu "${v}" (206 ou 408)`);
        if (v) i++;
        if (model) a.specs.push({ kind: 'demo', model, deviceId: id });
        else a.specs.push({ kind: 'demo', model: 'dsp206' }, { kind: 'demo', model: 'dsp408' });
        break;
      }
      case '--tcp': {
        const [hp, id] = splitId(value(i, k)); i++;
        const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(hp);
        if (!m) fail(`adresse invalide "${hp}"`);
        a.specs.push({ kind: 'tcp', host: m[1].replace(/^\[|\]$/g, ''), port: m[2] ? Number(m[2]) : undefined, deviceId: id });
        break;
      }
      case '--usb': {
        const v = optional(i);
        if (v) i++;
        const [path, id] = v ? splitId(v) : ['', undefined];
        a.specs.push({ kind: 'usb', path: path || undefined, deviceId: id });
        break;
      }
      case '--serial': {
        const [pb, id] = splitId(value(i, k)); i++;
        const at = pb.lastIndexOf('@');
        const path = at > 0 ? pb.slice(0, at) : pb;
        const baud = at > 0 ? Number(pb.slice(at + 1)) : undefined;
        if (baud !== undefined && !(baud > 0)) fail(`débit invalide dans "${pb}"`);
        a.specs.push({ kind: 'serial', path, baud, deviceId: id });
        break;
      }
      default: fail(`option inconnue "${k}"`);
    }
  }
  if ((a.cert && !a.key) || (!a.cert && a.key)) fail('--cert et --key vont ensemble');
  if (a.pin && a.operatorPin && a.pin === a.operatorPin) fail('les codes administrateur et opérateur doivent être différents');
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

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const log = (m: string): void => { if (!args.quiet) console.log(`[${new Date().toLocaleTimeString('fr-FR')}] ${m}`); };
  const library = new Library(join(args.data, 'library'));
  await library.init();
  const stateFile = join(args.data, 'bridge.json');
  const hub = new Hub();

  // devices: remembered ones first, then the command line (duplicates are ignored by the hub)
  const saved = args.save ? await loadSaved(stateFile) : { devices: [] };
  for (const d of saved.devices) hub.add(d.spec, d.label);
  for (const spec of args.specs) hub.add(spec);

  let lastSaved = JSON.stringify(saved.devices);
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const persist = (): void => {
    if (!args.save || saveTimer) return;
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      const devices = [...hub.devices.values()].map((d) => ({ spec: d.spec, label: d.label }));
      const text = JSON.stringify(devices);
      if (text === lastSaved) return;
      lastSaved = text;
      try {
        await writeFile(stateFile + '.tmp', JSON.stringify({ devices }, null, 1));
        await rename(stateFile + '.tmp', stateFile);
      } catch (e) { log(`impossible d'enregistrer ${stateFile} : ${(e as Error).message}`); }
    }, 500);
  };

  const tls = args.cert && args.key ? { cert: await readFile(args.cert), key: await readFile(args.key) } : undefined;
  const server = await startServer({
    port: args.port, host: args.host, webDir: args.web, library, hub, tls, allowOrigins: args.allowOrigins,
    pins: { admin: args.pin, operator: args.operatorPin }, onDevicesChanged: persist, log,
  }).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE') fail(`le port ${args.port} est déjà utilisé (essayez --port 8081)`);
    throw e;
  });

  const states = new Map<string, string>();
  hub.on('devices', (list: ReturnType<Hub['list']>) => {
    for (const d of list) {
      const st = `${d.state}${d.error ? ' (' + d.error + ')' : ''}`;
      if (states.get(d.key) !== st) { states.set(d.key, st); log(`${d.label} : ${st}`); }
    }
  });

  console.log(`\nDSP Studio ${BRIDGE_VERSION} prêt. Ouvrez l'interface sur :`);
  for (const u of localUrls(args.port, args.host, !!tls)) console.log(`  ${u}`);
  if (!args.web) console.log("  (interface web non compilée : lancez « npm run build », l'API reste disponible)");
  if (!args.pin && !args.operatorPin) console.log('  Aucun code défini : toute personne du réseau peut tout régler (--pin pour protéger).');
  console.log(`  Données : ${args.data}`);
  if (hub.devices.size === 0) console.log('  Aucun appareil : ajoutez-en depuis l’interface, ou relancez avec --demo, --usb, --tcp ou --serial.');
  for (const d of hub.devices.values()) console.log(`  Appareil : ${d.label} (${specKey(d.spec)})`);
  console.log('');

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) process.exit(1);
    stopping = true;
    log('arrêt…');
    const force = setTimeout(() => process.exit(0), 3000);
    force.unref();
    server.close();
    await hub.close();
    process.exit(0);
  };
  process.on('SIGINT', () => { void stop(); });
  process.on('SIGTERM', () => { void stop(); });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e: Error) => { console.error(e); process.exit(1); });
}
