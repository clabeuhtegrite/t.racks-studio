// Hash navigation (#/canal/3, #/appareil/liaisons...), so every screen has its own address and the
// back button works on phones.

import { useSyncExternalStore } from 'react';

export type ViewId =
  | 'vue' | 'console' | 'canal' | 'geq' | 'dynamique' | 'delais' | 'matrice' | 'presets' | 'appareil' | 'outils'
  | 'connexion' | 'bibliotheque' | 'fiche' | 'niveau' | 'dj';

export interface Route { view: ViewId; arg: string; sub: string }

const VIEWS: ViewId[] = ['vue', 'console', 'canal', 'geq', 'dynamique', 'delais', 'matrice', 'presets', 'appareil', 'outils', 'connexion', 'bibliotheque', 'fiche', 'niveau', 'dj'];

function parse(): Route {
  const parts = window.location.hash.replace(/^#\/?/, '').split('/');
  // no address (or an unknown one): the overview of every device
  const view = (VIEWS as string[]).includes(parts[0]) ? (parts[0] as ViewId) : 'vue';
  return { view, arg: decodeURIComponent(parts[1] ?? ''), sub: decodeURIComponent(parts[2] ?? '') };
}

let current = parse();
const subs = new Set<() => void>();
window.addEventListener('hashchange', () => { current = parse(); for (const f of subs) f(); });

export function useRoute(): Route {
  return useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => current);
}
export function go(view: ViewId, arg?: string | number, sub?: string): void {
  const h = `#/${view}${arg !== undefined && arg !== '' ? '/' + encodeURIComponent(String(arg)) : ''}${sub ? '/' + encodeURIComponent(sub) : ''}`;
  if (window.location.hash !== h) window.location.hash = h;
}
export const href = (view: ViewId, arg?: string | number, sub?: string): string =>
  `#/${view}${arg !== undefined && arg !== '' ? '/' + encodeURIComponent(String(arg)) : ''}${sub ? '/' + encodeURIComponent(sub) : ''}`;
