// Parcours de bout en bout dans un vrai navigateur : deux écrans (ordinateur et téléphone) sur le
// même pont. Les appareils s'ajoutent depuis l'écran Connexion, puis 36 vérifications
// (connexion et déconnexion, synchronisation, annuler / rétablir, égaliseur, noms, liaisons,
// presets, fichiers .prs, A/B, bibliothèque, générateur, verrouillage, second appareil, vue globale,
// gain automatique et écran DJ).
//
//   npm start -- --data "$(mktemp -d)"        # un pont neuf, sans appareil mémorisé
//   node apps/web/e2e/flows.cjs [adresse] [--appareils liste] [--lent n] [--captures dossier]
//
// --appareils : appareils à ajouter, « demo206,demo408 » par défaut, ou
// « tcp:localhost:9761,tcp:localhost:9762 » pour deux DSP émulés (le premier doit être un 206) ;
// --lent : multiplie les attentes (2 ou 3 avec l'émulateur).
// Il faut Playwright et son Chromium : npm i --no-save playwright && npx playwright install chromium
// Les parcours modifient l'appareil (U01, verrouillage) : jamais sur un DSP en service.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : def; };
const DEVICES = opt('--appareils', 'demo206,demo408').split(',');
const SECOND = DEVICES[1].startsWith('demo') ? `DSP ${DEVICES[1].slice(4)}` : DEVICES[1].split(':').pop();
const FACTOR = Number(opt('--lent', '1'));
const SHOTS = opt('--captures', '');
const BASE = args[0] || 'http://localhost:8080/';
const results = [];
const ok = (name, cond, extra = '') => { results.push(`${cond ? 'OK  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms * FACTOR));

(async () => {
  const browser = await chromium.launch();
  const ctxA = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true, locale: 'fr-FR' });
  const ctxB = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'fr-FR' });
  const A = await ctxA.newPage();
  const B = await ctxB.newPage();
  const errors = [];
  for (const [n, p] of [['A', A], ['B', B]]) {
    p.on('pageerror', (e) => errors.push(`${n}: ${e.message}`));
    p.on('console', (m) => { if (m.type() === 'error') errors.push(`${n}: ${m.text()}`); });
  }
  await A.goto(BASE + '#/connexion');
  await B.goto(BASE + '#/console');
  await wait(1500);

  const field = (p, name) => p.getByRole('textbox', { name, exact: true });
  const setField = async (p, name, text) => { const f = field(p, name); await f.click(); await f.fill(text); await f.press('Enter'); };

  // 0. devices are added from the connection screen (never from the command line)
  for (const d of DEVICES) {
    await A.evaluate(() => { location.hash = '#/connexion'; });
    await wait(400);
    if (d.startsWith('demo')) {
      await A.getByRole('tab', { name: /Démo/ }).click();
      await A.getByRole('radio', { name: new RegExp(`DSP ${d.slice(4)}`) }).click();
      await A.getByRole('button', { name: new RegExp(`Ajouter un DSP ${d.slice(4)} de démonstration`) }).click();
    } else {
      const [, host, port] = d.split(':');
      await A.getByRole('tab', { name: /Ethernet/ }).click();
      await field(A, 'Adresse IP du DSP').fill(host);
      await field(A, 'Port TCP').fill(port);
      await A.locator('form').getByRole('button', { name: 'Ajouter', exact: true }).click();
    }
    await wait(2500);
  }
  ok('appareils ajoutés depuis l’écran Connexion', (await A.locator('.devpick-label').innerText()).length > 0);
  // the first one (206) on the computer; the phone took the first device that appeared
  await A.locator('.devpick-btn').click();
  await A.locator('.pop-item').first().click();
  await A.evaluate(() => { location.hash = '#/console'; });
  await wait(1500);
  ok('le téléphone voit l’appareil ajouté sur l’ordinateur', (await B.locator('.strip').count()) === 8, String(await B.locator('.strip').count()));

  // 0b. disconnect, then connect again from the interface
  await A.evaluate(() => { location.hash = '#/connexion'; });
  await wait(500);
  await A.locator('.dev').first().getByRole('button', { name: 'Se déconnecter' }).click();
  await wait(1200);
  ok('se déconnecter : l’autre écran le voit', await B.getByText('Appareil non connecté').isVisible());
  await A.locator('.dev').first().getByRole('button', { name: 'Se connecter' }).click();
  await wait(2500 + 1000 * (FACTOR - 1));
  ok('se connecter : l’appareil repasse en ligne', (await A.locator('.dev').first().innerText()).includes('en ligne'));
  await A.evaluate(() => { location.hash = '#/console'; });
  await wait(600);
  ok('se connecter depuis l’interface : la console revient', (await B.locator('.strip').count()) === 8 && (await A.locator('.strip').count()) === 8);

  // 1. gain sync between screens
  await setField(A, 'Volume InA', '-6');
  await wait(600);
  ok('volume envoyé et affiché sur un autre écran', (await field(B, 'Volume InA').inputValue()) === '−6,0 dB', await field(B, 'Volume InA').inputValue());

  // 2. mute sync
  await A.locator('.strip').first().getByRole('button', { name: 'Mute' }).click();
  await wait(500);
  ok('mute synchronisé', (await B.locator('.strip').first().getByRole('button', { name: 'Mute' }).getAttribute('aria-pressed')) === 'true');

  // 3. undo
  await A.locator('body').click({ position: { x: 700, y: 700 } });
  await A.keyboard.press('Control+z');
  await wait(500);
  ok('annuler (Ctrl+Z) défait le mute', (await B.locator('.strip').first().getByRole('button', { name: 'Mute' }).getAttribute('aria-pressed')) === 'false');
  await A.keyboard.press('Control+z');
  await wait(500);
  ok('annuler deux fois rétablit le volume', (await field(B, 'Volume InA').inputValue()) === '0,0 dB', await field(B, 'Volume InA').inputValue());
  await A.keyboard.press('Control+Shift+z');
  await wait(500);
  ok('rétablir (Ctrl+Maj+Z)', (await field(B, 'Volume InA').inputValue()) === '−6,0 dB', await field(B, 'Volume InA').inputValue());

  // 4. PEQ band gain from the computer's band table, seen in the phone's band editor
  await A.evaluate(() => { location.hash = '#/canal/0'; });
  await B.evaluate(() => { location.hash = '#/canal/0'; });
  await wait(800);
  const peqB = B.locator('.card-eq');
  await setField(A, 'Gain bande 1', '6');
  await wait(600);
  ok('PEQ : gain de bande synchronisé', (await field(peqB, 'Gain').inputValue()) === '+6,0 dB', await field(peqB, 'Gain').inputValue());
  await setField(A, 'Fréquence bande 2', '1k');
  await wait(600);
  await peqB.getByRole('tab', { name: '2', exact: true }).click();
  ok('PEQ : fréquence saisie « 1k »', (await field(peqB, 'Fréquence').inputValue()).includes('kHz'), await field(peqB, 'Fréquence').inputValue());
  if (SHOTS) await A.screenshot({ path: `${SHOTS}/flow-peq.png` });

  // 5. rename a channel from the channel page
  await A.getByRole('button', { name: 'Renommer' }).first().click();
  await A.getByRole('textbox', { name: 'Nom (8 caractères)' }).fill('Voix é');
  await A.getByRole('button', { name: 'Renommer' }).last().click();
  await wait(600);
  const chipB = await B.locator('.chip').first().innerText();
  ok('nom de canal (accents retirés comme sur l’appareil)', chipB.includes('Voix e'), chipB.replace(/\n/g, ' | '));

  // 6. links: link Out1 + Out2 then change Out1 gain
  await A.evaluate(() => { location.hash = '#/appareil/liaisons'; });
  await wait(600);
  const linkCard = A.locator('.card', { hasText: 'Liaisons' }).first();
  await linkCard.locator('.link-ch', { hasText: 'Out1' }).click();
  await linkCard.locator('.link-ch', { hasText: 'Out2' }).click();
  await linkCard.getByRole('button', { name: 'Lier', exact: true }).click();
  await wait(600);
  ok('liaison Out1 + Out2 affichée', (await linkCard.locator('.group-line').count()) === 1);
  await A.evaluate(() => { location.hash = '#/console'; });
  await B.evaluate(() => { location.hash = '#/console'; });
  await wait(600);
  await setField(A, 'Volume Out1', '-3');
  await wait(700);
  ok('canaux liés : Out2 suit Out1', (await field(B, 'Volume Out2').inputValue()) === '−3,0 dB', await field(B, 'Volume Out2').inputValue());

  // 7. store a preset in U01, recall F00 then U01
  await A.evaluate(() => { location.hash = '#/presets'; });
  await wait(600);
  await A.getByRole('button', { name: 'Enregistrer dans une mémoire…' }).click();
  await A.locator('.modal').getByRole('combobox', { name: 'Mémoire' }).selectOption('1');
  await A.getByRole('textbox', { name: 'Nom du preset (14 caractères)' }).fill('Concert test');
  await A.locator('.modal').getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await wait(1500);
  ok('preset enregistré dans U01', (await A.locator('.preset', { hasText: 'U01' }).innerText()).includes('Concert test'));
  await A.locator('.preset', { hasText: 'F00' }).getByRole('button', { name: 'Rappeler' }).click();
  await wait(2500);
  await A.evaluate(() => { location.hash = '#/console'; });
  await wait(500);
  ok('rappel F00 : volume revenu à 0 dB', (await field(A, 'Volume Out1').inputValue()) === '0,0 dB', await field(A, 'Volume Out1').inputValue());
  await A.evaluate(() => { location.hash = '#/presets'; });
  await wait(400);
  await A.locator('.preset', { hasText: 'U01' }).getByRole('button', { name: 'Rappeler' }).click();
  await wait(2500);
  ok('rappel U01 : nom du preset en haut', (await A.locator('.preset-badge').innerText()).includes('Concert test'));
  await A.evaluate(() => { location.hash = '#/console'; });
  await wait(500);
  ok('rappel U01 : volume Out1 −3 dB', (await field(A, 'Volume Out1').inputValue()) === '−3,0 dB', await field(A, 'Volume Out1').inputValue());

  // 8. save .prs and .json
  await A.evaluate(() => { location.hash = '#/presets'; });
  await wait(400);
  await A.getByRole('button', { name: 'Enregistrer sur l’ordinateur' }).click();
  const [dl] = await Promise.all([A.waitForEvent('download'), A.getByRole('button', { name: /\.prs/ }).click()]);
  const prsPath = path.join(SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'dsp-e2e-')), 'test.prs');
  await dl.saveAs(prsPath);
  const size = fs.statSync(prsPath).size;
  ok('export .prs (taille du format du logiciel Windows)', size > 800, `${size} octets`);

  // 9. reopen the .prs and listen to it
  const chooser = A.waitForEvent('filechooser');
  await A.getByRole('button', { name: 'Ouvrir un fichier' }).click();
  await (await chooser).setFiles(prsPath);
  await wait(500);
  ok('fichier .prs rouvert', await A.getByText('Fichier .prs du logiciel Windows').isVisible());
  await A.getByRole('button', { name: /Écouter maintenant/ }).click();
  await wait(2000);

  // 10. A/B compare
  await A.evaluate(() => { location.hash = '#/console'; });
  await wait(400);
  const storeAB = async (n) => {
    await A.locator('.ab-open').click();
    await A.locator('.modal .ab-slot').nth(n).getByRole('button', { name: 'Mémoriser ici' }).click();
    await A.keyboard.press('Escape');
  };
  await storeAB(0);
  await setField(A, 'Volume InB', '-10');
  await wait(400);
  await storeAB(1);
  await A.locator('.ab-quick').getByRole('button', { name: 'A', exact: true }).click();
  await wait(1500);
  ok('A/B : retour à la version A', (await field(A, 'Volume InB').inputValue()) === '0,0 dB', await field(A, 'Volume InB').inputValue());
  await A.locator('.ab-quick').getByRole('button', { name: 'B', exact: true }).click();
  await wait(1500);
  ok('A/B : version B', (await field(A, 'Volume InB').inputValue()) === '−10,0 dB', await field(A, 'Volume InB').inputValue());

  // 11. scene in the library
  await A.evaluate(() => { location.hash = '#/bibliotheque'; });
  await wait(600);
  await A.getByRole('button', { name: 'Nouvelle scène' }).click();
  await A.getByRole('textbox', { name: 'Nom de la scène' }).fill('Scène B');
  await A.getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await wait(1000);
  ok('scène ajoutée à la bibliothèque', (await A.locator('.lib-item').count()) >= 1);
  await B.evaluate(() => { location.hash = '#/bibliotheque'; });
  await wait(1000);
  ok('bibliothèque partagée vue sur l’autre écran', (await B.locator('.lib-item', { hasText: 'Scène B' }).count()) === 1);

  // 12. test tone
  await A.evaluate(() => { location.hash = '#/appareil/generateur'; });
  await wait(500);
  await A.getByRole('radio', { name: 'Bruit rose' }).click();
  await A.getByRole('button', { name: /Envoyer le bruit rose/ }).click();
  await wait(600);
  ok('générateur : bruit rose actif', await A.getByText('Générateur actif : bruit rose').isVisible());
  await A.getByRole('button', { name: /Arrêter/ }).click();
  await wait(500);

  // 13. lock / unlock
  await A.evaluate(() => { location.hash = '#/appareil/securite'; });
  await wait(500);
  await A.getByRole('textbox', { name: 'Mot de passe', exact: true }).fill('1234');
  await A.getByRole('textbox', { name: 'Confirmation du mot de passe' }).fill('1234');
  await A.getByRole('button', { name: 'Verrouiller', exact: true }).click();
  await A.locator('.modal').getByRole('button', { name: 'Verrouiller' }).click();
  await wait(1500);
  await B.evaluate(() => { location.hash = '#/console'; });
  await wait(800);
  ok('verrouillage : l’autre écran voit l’appareil verrouillé', await B.getByText('Appareil verrouillé').isVisible());
  if (SHOTS) await B.screenshot({ path: `${SHOTS}/flow-locked-phone.png` });
  await A.getByRole('textbox', { name: 'Mot de passe', exact: true }).fill('9999');
  await A.getByRole('button', { name: 'Déverrouiller' }).click();
  await wait(1200);
  ok('mot de passe faux refusé', await A.getByText('Mot de passe incorrect').isVisible());
  await A.getByRole('textbox', { name: 'Mot de passe', exact: true }).fill('1234');
  await A.getByRole('button', { name: 'Déverrouiller' }).click();
  await wait(3000);
  await B.waitForTimeout(500);
  ok('déverrouillé : la console revient sur l’autre écran', await B.locator('.strip').first().isVisible());

  // 14. switch device (408) and check 4 inputs / 8 outputs
  await A.locator('.devpick-btn').click();
  await A.locator('.pop-item', { hasText: SECOND }).first().click();
  await A.evaluate(() => { location.hash = '#/console'; });
  await wait(2500);
  ok('DSP 408 : 12 tranches', (await A.locator('.strip').count()) === 12, String(await A.locator('.strip').count()));

  // 15. overview: every connected device, live, current one first
  await A.evaluate(() => { location.hash = '#/vue'; });
  await wait(1500);
  const devs = await A.locator('.gv-dev').count(), tiles = await A.locator('.gv-ch').count();
  ok('vue globale : les deux appareils et tous leurs canaux', devs === 2 && tiles === 20, `${devs} appareils, ${tiles} canaux`);
  const tile = A.locator('.gv-dev').first().locator('.gv-ch').first();
  await tile.getByRole('button', { name: 'Mute' }).click();
  await wait(800);
  ok('vue globale : mute d’un canal depuis sa tuile', (await tile.getAttribute('class')).includes('is-muted'));
  await tile.getByRole('button', { name: 'Mute' }).click();
  await wait(500);

  // 16. automatic gain: turned on from the computer, followed by the phone's DJ screen, badge in the overview
  await A.evaluate(() => { location.hash = '#/niveau'; });
  await wait(1500);
  await A.getByRole('button', { name: 'Gain automatique désactivé' }).click();
  await wait(800);
  ok('gain auto : activé depuis la page Gain auto', await A.getByRole('button', { name: 'Gain automatique activé' }).isVisible());
  await setField(A, 'Niveau cible', '-10');
  await wait(1000);
  ok('gain auto : niveau cible enregistré', (await field(A, 'Niveau cible').inputValue()) === '−10,0 dBFS', await field(A, 'Niveau cible').inputValue());
  const key = await A.evaluate(() => JSON.parse(localStorage.getItem('dsp-studio.prefs') || '{}').lastDevice);
  await B.evaluate((k) => { location.hash = '#/dj/' + encodeURIComponent(k); }, key);
  await wait(3000);
  const djLine = await B.locator('.dj-foot').innerText().catch(() => '');
  ok('écran DJ : le téléphone suit le gain auto de cet appareil', (await B.locator('.dj-main').isVisible()) && /Gain automatique\s:\s[+−]?\d/.test(djLine), djLine.split('\n')[0]);
  if (SHOTS) await B.screenshot({ path: `${SHOTS}/flow-dj-phone.png` });
  await A.evaluate(() => { location.hash = '#/vue'; });
  await wait(1200);
  ok('vue globale : badge du gain auto', (await A.locator('.lv-badge', { hasText: 'Gain auto' }).count()) === 1);
  await A.evaluate(() => { location.hash = '#/niveau'; });
  await wait(1000);
  await A.getByRole('button', { name: 'Gain automatique activé' }).click();
  await wait(600);

  console.log(results.join('\n'));
  console.log(errors.length ? 'ERREURS :\n' + errors.join('\n') : 'aucune erreur JavaScript');
  const failed = results.filter((r) => r.startsWith('FAIL')).length;
  console.log(`${results.length - failed} / ${results.length} réussis`);
  await browser.close();
  process.exit(failed || errors.length ? 1 : 0);
})().catch((e) => { console.log(results.join('\n')); console.error('ARRÊT :', e.message); process.exit(1); });
