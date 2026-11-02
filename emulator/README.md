# Émulateur du firmware DSP 206 / 408

Pour tester DSP Studio sur du « vrai » sans boîtier : le firmware officiel Thomann v1.04 tourne
instruction par instruction sur une carte Nuvoton NUC1xx (ARM Cortex-M0) virtuelle. Ce n’est pas une
imitation : c’est le code du DSP lui-même qui répond aux trames, gère ses presets, son verrouillage et
sa mémoire.

Le firmware appartient à Thomann et n’est **jamais** inclus dans ce dépôt. Le script ci-dessous le
télécharge depuis le site officiel et l’extrait sur votre machine, dans `emulator/firmware/` (ignoré
par git). Ne le republiez pas.

## Installation

Python 3.10 ou plus récent, puis :

```sh
pip install -r emulator/requirements.txt      # moteur d’émulation Unicorn
python3 emulator/fetch_firmware.py            # télécharge et extrait le firmware des deux modèles
```

Sans accès direct au site, téléchargez la mise à jour depuis la page du produit sur thomann.de
(« Update DSP 206 v1.04 » ou « Update DSP 408 v1.04 »), puis :

```sh
python3 emulator/fetch_firmware.py --exe chemin/vers/435194_update_dsp_408_v1_04_netstartverdet.exe
```

Le programme de mise à jour n’est jamais exécuté : il est seulement lu pour en extraire le firmware.
Chaque mise à jour contient deux versions, `V0104P` et `V0104` ; les deux fonctionnent dans
l’émulateur.

## Vérifier l’émulateur

```sh
python3 emulator/selftest.py 206              # ou 408 ; 1 à 2 minutes
```

Le test allume un appareil neuf, le laisse s’initialiser, change des réglages, enregistre un preset,
le rallume et vérifie que tout est retrouvé (réglages, preset actif, nom, adresse IP, verrouillage).

## Lancer un DSP émulé

```sh
python3 emulator/server.py 206                # répond sur le port TCP 9761, comme le boîtier
node apps/bridge/src/main.ts --tcp localhost:9761
```

puis ouvrez http://localhost:8080. Deux appareils à la fois :

```sh
python3 emulator/server.py 206
python3 emulator/server.py 408 --port 9762
node apps/bridge/src/main.ts --tcp localhost:9761 --tcp localhost:9762
```

| Option | Rôle |
| --- | --- |
| `--port n` | port TCP (9761 par défaut) |
| `--host 0.0.0.0` | écoute sur le réseau local ; l’appareil répond alors aussi à la recherche d’appareils (UDP 30303) |
| `--variant standard` | firmware `V0104` au lieu de `V0104P` |
| `--firmware fichier.bin` | une autre image de firmware |
| `--state dossier` | où garder la mémoire de l’appareil (par défaut `emulator/state/<firmware>/`) |
| `--reset` | repartir d’un appareil neuf |
| `--trace` | affiche chaque trame échangée |

Le premier lancement d’un appareil neuf dure environ 35 s (le firmware initialise sa mémoire puis
redémarre, comme en usine), les suivants environ 20 s. La mémoire (presets, réglages en cours, ID,
IP, mots de passe) est gardée d’un lancement à l’autre et enregistrée à l’arrêt (Ctrl+C).

Le serveur joue le rôle du module Ethernet du boîtier : il relaie les octets vers le port série du
firmware au débit réel (115 200 bauds), n’accepte qu’une connexion à la fois et garde pour lui les
messages que le firmware adresse au module (son adresse IP au démarrage).

## Tests d’intégration

Avec les deux appareils émulés lancés :

```sh
DSP_EMULATOR=localhost:9761,localhost:9762 npm run test:emulator
```

12 essais sur le vrai firmware : lecture complète, réglages, écriture directe d’un preset, rappel,
sauvegarde et restauration complètes (.unt) avec retour aux réglages d’usine, verrouillage, compteur
PTS, ID et IP, copie de canal. Sans `DSP_EMULATOR`, ces tests sont ignorés.

## Ce qui est émulé

- le processeur (moteur Unicorn), la mémoire, les interruptions, les timers et l’horloge ;
- les ports série : UART1 (module Ethernet et prise RS-232), UART0 (RS-485) ;
- le bus I2C et ses deux mémoires : 0x57 (réglages, presets, verrouillage) et 0x53 (programme de la
  puce DSP, dont seul l’en-tête est fourni) ;
- le bus SPI1 vers la puce audio : elle accepte programme et paramètres et répond aux lectures des
  vumètres par du silence ;
- le contrôleur de flash et les données d’usine que le firmware vérifie au démarrage (un bloc lié à
  l’identifiant unique de la puce, généré pour la puce virtuelle) ;
- le redémarrage demandé par le firmware (premier allumage, retour usine).

Non émulés : le son (les vumètres restent à zéro), l’USB (utilisez l’Ethernet émulé), la façade
(écran, boutons, molette).

## Ce que l’émulateur a permis d’établir

- l’emplacement de chaque réglage dans la mémoire de configuration (928 octets sur le 206, 1448 sur
  le 408) et l’effet exact de chaque commande, y compris sur les canaux liés : ce sont les fichiers
  de `packages/protocol/test/fixtures/`, rejoués par les tests de conformité ;
- l’écriture directe d’un preset (0x25), le format des fichiers .prs / .unt, le verrouillage, le
  compteur PTS, l’ID et l’IP ;
- le comportement à l’allumage : réglages et preset actif restaurés depuis la mémoire, comme indiqué
  dans le manuel.

## Outils

- `tools/mapper.py` : refait les mesures des tests de conformité (`firmware-probes-206.json`, `-408.json`).
- `tools/test_link.py`, `tools/test_copy.py` : effet des liaisons et de la copie de canal (DSP 206).
- `tools/test_volatile.py` : ce que garde ou remet à zéro le rappel d’un preset.
- `tools/test_ext.py` : protocole RS-232 « Extend », y compris les trames pour un autre ID.
- `unit.py` : un appareil émulé (firmware, mémoires, trames) utilisable depuis Python.
- `nuc.py` : la carte NUC1xx virtuelle.
