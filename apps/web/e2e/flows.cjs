// Parcours de bout en bout dans un vrai navigateur : deux écrans (ordinateur et téléphone) sur le
// même pont, 26 vérifications (synchronisation, annuler / rétablir, égaliseur, noms, liaisons,
// presets, fichiers .prs, A/B, bibliothèque, générateur, verrouillage, second appareil).
//
//   npm start -- --demo                       # ou le pont relié à deux DSP émulés (9761 et 9762)
//   node apps/web/e2e/flows.cjs [adresse] [--appareil2 texte] [--lent n] [--captures dossier]
//
// --appareil2 : texte du second appareil dans le sélecteur (« DSP 408 » par défaut ; « 9762 »
// avec les émulateurs) ; --lent : multiplie les attentes (2 ou 3 avec l'émulateur).
// Il faut Playwright et son Chromium : npm i --no-save playwright && npx playwright install chromium
// Les parcours modifient l'appareil (U01, verrouillage) : jamais sur un DSP en service.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : def; };
const SECOND = opt('--appareil2', 'DSP 408');
const FACTOR = Number(opt('--lent', '1'));
const SHOTS = opt('--captures', '');
const BASE = args[0] || 'http://localhost:8080/';
const results = [];
const ok = (name, cond, extra = '') => { results.push(`${cond ? 'OK  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms * FACTOR));

(async () => {
  const browser = await chromium.launch();
  const ctxA = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
  const ctxB = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const A = await ctxA.newPage();
  const B = await ctxB.newPage();
  const errors = [];
  for (const [n, p] of [['A', A], ['B', B]]) {
    p.on('pageerror', (e) => errors.push(`${n}: ${e.message}`));
    p.on('console', (m) => { if (m.type() === 'error') errors.push(`${n}: ${m.text()}`); });
  }
  await A.goto(BASE + '#/console');
  await B.goto(BASE + '#/console');
  await wait(2500);

  // pick the 206 on both
  const field = (p, name) => p.getByRole('textbox', { name, exact: true });
  const setField = async (p, name, text) => { const f = field(p, name); await f.click(); await f.fill(text); await f.press('Enter'); };

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

  // 4. PEQ band gain from the band editor, seen in the other screen's table
  await A.evaluate(() => { location.hash = '#/canal/0'; });
  await B.evaluate(() => { location.hash = '#/canal/0'; });
  await wait(800);
  await setField(A, 'Gain', '6');
  await wait(600);
  ok('PEQ : gain de bande synchronisé', (await field(B, 'Gain bande 1').inputValue()) === '+6,0 dB', await field(B, 'Gain bande 1').inputValue());
  await setField(A, 'Fréquence bande 2', '1k');
  await wait(600);
  ok('PEQ : fréquence saisie « 1k »', (await field(B, 'Fréquence bande 2').inputValue()).includes('kHz'), await field(B, 'Fréquence bande 2').inputValue());
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
  await A.locator('.preset', { hasText: 'U01' }).getByRole('button', { name: 'Enregistrer ici' }).click();
  await A.getByRole('textbox', { name: 'Nom du preset (14 caractères)' }).fill('Concert test');
  await A.getByRole('button', { name: 'Enregistrer', exact: true }).click();
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
  await A.locator('.ab .btn-group').getByRole('button', { name: 'A+' }).click();
  await setField(A, 'Volume InB', '-10');
  await wait(400);
  await A.locator('.ab .btn-group').getByRole('button', { name: 'B+' }).click();
  await A.locator('.ab .btn-group').getByRole('button', { name: 'A', exact: true }).click();
  await wait(1500);
  ok('A/B : retour à la version A', (await field(A, 'Volume InB').inputValue()) === '0,0 dB', await field(A, 'Volume InB').inputValue());
  await A.locator('.ab .btn-group').getByRole('button', { name: 'B', exact: true }).click();
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
  await A.getByRole('button', { name: /Envoyer bruit rose/ }).click();
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

  // 15. add a demo device from the connection screen
  await A.evaluate(() => { location.hash = '#/connexion'; });
  await wait(500);
  await A.getByRole('tab', { name: /Démo/ }).click();
  await A.getByRole('button', { name: /Ajouter un DSP 408 de démonstration/ }).click();
  await wait(2500);
  ok('appareil ajouté depuis l’écran Connexion', (await A.locator('.devpick-label').innerText()).length > 0);

  console.log(results.join('\n'));
  console.log(errors.length ? 'ERREURS :\n' + errors.join('\n') : 'aucune erreur JavaScript');
  const failed = results.filter((r) => r.startsWith('FAIL')).length;
  console.log(`${results.length - failed} / ${results.length} réussis`);
  await browser.close();
  process.exit(failed || errors.length ? 1 : 0);
})().catch((e) => { console.log(results.join('\n')); console.error('ARRÊT :', e.message); process.exit(1); });
