# DSP Studio

Interface web complète pour les processeurs **the t.racks DSP 206** (2 entrées, 6 sorties) et
**DSP 408** (4 entrées, 8 sorties) de Thomann. Elle remplace le « Processor Editor », qui n’existe
que sous Windows, par une application qui fonctionne sur téléphone, tablette et ordinateur, avec
toutes ses fonctions : chaque menu, dialogue et réglage du logiciel Windows a sa place dans DSP
Studio (voir [la correspondance complète](docs/parite-logiciel-windows.md)).

Le protocole a été vérifié sur le vrai firmware des appareils, qui tourne dans un émulateur fourni
avec le projet ([emulator/](emulator/README.md)).

## Ce qu’on peut faire

- **Console** : volumes, mutes, polarité et vumètres de toutes les entrées et sorties, mute général
  des sorties, annuler / rétablir, comparaison A/B.
- **Canaux** : égaliseur paramétrique (8 bandes par entrée, 9 par sortie, 9 types de filtres) avec
  courbe tactile, passe-haut et passe-bas (20 pentes Butterworth, Bessel, Linkwitz-Riley), délai,
  gate (entrées), compresseur et limiteur (sorties), routage et mélange des entrées, égaliseur
  graphique 31 bandes (entrées).
- **Vues d’ensemble** : EQ graphique, dynamique, délais (avec alignement par distances), matrice.
- **Presets** : rappel et enregistrement des 20 mémoires et du réglage d’usine F00, fichiers `.prs`
  et sauvegardes complètes `.unt` compatibles avec le logiciel Windows, retour aux réglages d’usine.
- **Appareil** : liaisons de canaux, copie de canal, noms des canaux, verrouillage par mot de passe,
  compteur d’allumages (PTS), ID et adresse IP, générateur de test (bruits rose et blanc, 31 sinus).
- **Outils** : assistant de filtrage 2 ou 3 voies, calculs de délai et de longueur d’onde, codes de
  commande RS-232 (avec générateur de trames), console des trames échangées, journal des messages.
- **En plus du logiciel Windows** : plusieurs appareils à la fois, plusieurs écrans synchronisés en
  direct, codes d’accès administrateur / opérateur, bibliothèque partagée de presets et de scènes,
  fiche des réglages imprimable, thème clair ou sombre, application installable sur téléphone.

## Démarrage rapide

Il faut [Node.js](https://nodejs.org) 22.18 ou plus récent.

```sh
npm install
npm run build        # compile l’interface web
npm start -- --demo  # sans appareil : un DSP 206 et un DSP 408 virtuels
```

Ouvrez ensuite l’adresse affichée (par exemple http://localhost:8080) : sur cet ordinateur, ou sur
n’importe quel téléphone ou tablette du même réseau Wi-Fi avec l’adresse en `http://192.168…:8080`.

### Avec un vrai DSP

Le **pont** est le petit programme lancé par `npm start`. Il tourne sur un ordinateur (ou un
Raspberry Pi) relié au DSP et sert l’interface à tous les écrans du réseau.

```sh
npm start -- --tcp 192.168.1.101       # par Ethernet (adresse IP du DSP, 192.168.1.101 d’origine)
npm start -- --usb                     # par USB
npm start -- --serial /dev/ttyUSB0     # par RS-232 / RS-485 (COM3 sous Windows)
npm start -- --tcp 192.168.1.101 --usb # plusieurs appareils à la fois
```

Les appareils peuvent aussi être ajoutés depuis l’écran **Connexion**, qui sait chercher les DSP
sur le réseau. Plusieurs DSP sur un même bus RS-485 se distinguent par leur ID : `--serial COM3#2`.

`npm start -- --help` liste toutes les options :

| Option | Rôle |
| --- | --- |
| `--pin code` | code administrateur (sinon toute personne du réseau peut tout régler) |
| `--operator-pin code` | code opérateur : volumes, mutes et rappel de presets seulement |
| `--port n` | port de l’interface (8080 par défaut) |
| `--cert fichier --key fichier` | HTTPS : application installable, USB et série du navigateur depuis un autre appareil |
| `--data dossier` | bibliothèque et appareils mémorisés (`~/.dsp-studio` par défaut) |
| `--demo [206\|408]` | DSP virtuel |

### Sans rien installer (Chrome ou Edge sur ordinateur)

L’interface peut aussi piloter un DSP branché **en USB ou en série directement depuis le
navigateur** (WebHID / Web Serial) : écran Connexion, mode navigateur. L’Ethernet passe toujours par
le pont, car un navigateur ne peut pas ouvrir de connexion TCP directe.

### Linux : accès à l’USB

Pour que le pont (ou Chrome) puisse ouvrir le DSP en USB sans être administrateur :

```sh
echo 'SUBSYSTEM=="hidraw", ATTRS{idVendor}=="0168", ATTRS{idProduct}=="0821", MODE="0660", TAG+="uaccess"' \
  | sudo tee /etc/udev/rules.d/70-tracks-dsp.rules
sudo udevadm control --reload-rules   # puis débranchez et rebranchez le DSP
```

## Sécurité

Sans code, toute personne du réseau peut tout régler : définissez `--pin` dès que le réseau n’est
pas le vôtre. Le pont refuse les pages d’autres sites (contrôle de l’origine), bloque un code après
plusieurs erreurs et n’envoie jamais au DSP les commandes réservées à l’usine (mise à jour du
firmware, effacement).

## Documentation

- [Correspondance avec le logiciel Windows](docs/parite-logiciel-windows.md) : chaque fonction et où
  la trouver.
- [Essais sur un vrai appareil](docs/essais-materiel.md) : quoi vérifier, et comment enregistrer les
  échanges si quelque chose diffère.
- [Architecture](docs/architecture.md) et [protocole des DSP](docs/protocole.md).
- [Émulateur du firmware](emulator/README.md).

## Développement

```sh
npm test               # tests (protocole, conformité au firmware, pont)
npm run typecheck
node apps/web/e2e/flows.cjs   # 26 parcours dans un navigateur (avec Playwright, pont lancé)
npm run dev:bridge     # pont avec appareils virtuels, puis dans un autre terminal :
npm run dev            # interface avec rechargement à chaud (http://localhost:5173)
```

| Dossier | Contenu |
| --- | --- |
| `packages/protocol` | trames, réglages, commandes, presets, fichiers .prs/.unt, DSP virtuel (TypeScript, sans dépendance) |
| `apps/bridge` | le pont : USB, Ethernet, série, découverte, serveur web et WebSocket, bibliothèque |
| `apps/web` | l’interface (React) |
| `emulator` | émulateur du firmware (Python) et tests sur le vrai firmware |

## Remerciements et mentions

Le protocole a d’abord été décrit par d’autres passionnés, dont les travaux ont servi de point de
départ : dxtrzlb/z3r0-dsp206, gr4per/dsp206, FlexiFlizz/t.racks-DSP-control,
Aeternitaas/dsp-408-ui et DoctorRemoteControl/dsp408-protocol. Aucun code n’en est repris : tout a
été réécrit et vérifié sur le firmware.

DSP Studio n’est ni développé ni soutenu par Thomann. « the t.racks » est une marque de Thomann GmbH.
Le firmware des appareils n’est pas fourni avec ce projet. Licence MIT.
