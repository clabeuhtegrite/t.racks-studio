# Architecture

t.racks Studio est écrit en TypeScript (sauf l’émulateur, en Python). Le même code de protocole tourne
dans le pont (Node.js) et dans le navigateur, si bien qu’un téléphone, l’ordinateur et le DSP
virtuel appliquent toujours les modifications de la même façon que le firmware.

```
 téléphone   tablette   ordinateur                 Chrome / Edge sans pont
     │          │           │                        (WebHID, Web Serial, démo)
     └──── WebSocket /ws ───┘                                 │
                │                                             │
        ┌───────┴────────────────────────┐          ┌─────────┴─────────┐
        │ pont (apps/bridge)             │          │ backend « local » │
        │  serveur web + WebSocket       │          │ (apps/web/client) │
        │  hub : une DeviceSession       │          │  une DeviceSession│
        │        par appareil            │          │  par appareil     │
        │  bibliothèque partagée         │          └─────────┬─────────┘
        └───────┬───────────┬────────────┘                    │
          TCP 9761    USB HID    RS-232 / RS-485         USB / série
                │           │           │                     │
          module Ethernet   └─── DSP 206 / 408 ───────────────┘
          du DSP, ou l’émulateur du firmware
```

## Les quatre parties

| Dossier | Rôle |
| --- | --- |
| `packages/protocol` | tout ce qui concerne le DSP, sans dépendance : trames, commandes, codage des valeurs, mémoire de configuration, liaisons, fichiers `.prs` / `.unt`, courbes de réponse, session, DSP virtuel |
| `apps/bridge` | le pont : liaisons avec les DSP, recherche sur le réseau, serveur web et WebSocket, codes d’accès, bibliothèque |
| `apps/web` | l’interface React : écrans, éditeurs, état local de chaque appareil, transports du navigateur |
| `emulator` | le vrai firmware v1.04 exécuté sur une carte virtuelle, pour les tests |

## Protocole (`packages/protocol`)

| Fichier | Contenu |
| --- | --- |
| `frame.ts` | trame `10 02 … 10 03 xor`, analyse d’un flux (resynchronisation, rembourrage USB) |
| `commands.ts` | les commandes du firmware et leur contenu, décodage des réponses (textes, verrouillage) |
| `meters.ts` | vumètres lus comme le logiciel Windows : niveaux, zones de couleur, compresseur et limiteur en action |
| `codecs.ts` | valeurs brutes ↔ unités (dB, Hz, Q, ms…), mêmes formats d’affichage que le logiciel Windows |
| `models.ts` | DSP 206 et 408 : nombre de canaux, taille et plan de la mémoire de configuration |
| `config.ts` | configuration complète ↔ image binaire de 928 / 1448 octets, aller-retour à l’octet près |
| `state.ts` | les « actions » d’édition, les commandes qu’elles envoient et leur effet sur la configuration (liaisons, copie) |
| `links.ts` | groupes de canaux liés, calculés comme le firmware |
| `session.ts` | `DeviceSession` : connexion, file d’attente des commandes, lecture complète, presets, sauvegarde et restauration, verrouillage, PTS, réseau, vumètres |
| `rpc.ts` | appels qu’un écran peut demander, avec vérification de chaque argument et des droits (administrateur, opérateur) |
| `files.ts` | fichiers du logiciel Windows (`.prs`, `.unt`) et format JSON de t.racks Studio |
| `filters.ts` | réponse en amplitude et en phase des égaliseurs et des filtres (courbes) |
| `sim.ts` | DSP virtuel : répond comme le firmware (mode démo et tests) |
| `devices.ts`, `probe.ts` | façons de joindre un DSP, recherche des ID qui répondent |
| `rs232.ts` | protocole « Extend » de la page Aide > RS-232 Code |
| `leveler.ts` | gain automatique : les décisions (`LevelerCore`, sans entrée ni sortie) et leur application à une session (`Leveler`) |

### La session

Une `DeviceSession` parle à un DSP à travers n’importe quel transport (un objet qui envoie des octets
et en reçoit). Elle n’a jamais qu’une commande en cours : la suivante part quand la réponse arrive.

- Les modifications répétées d’un même réglage (un curseur que l’on glisse) sont fusionnées : seule
  la dernière valeur en attente part.
- La lecture des vumètres est de basse priorité : abandonnée si une lecture attend déjà, et retardée
  quand des modifications attendent. Elle sert aussi de maintien de la liaison.
- Une réponse manquante ou un refus (NAK) rejette la commande ; la session ne se bloque pas.
- Les commandes réservées à l’usine (0x04, 0x08, 0xA2, 0xA8) sont refusées avant l’envoi.

À la connexion : `0x10` (mode PC), version, état du verrouillage, puis, si l’appareil n’est pas
verrouillé, la liste des presets, le preset actif, la configuration page par page et la mémoire
système (ID, adresse IP). Le détail est dans [le protocole](protocole.md).

### Les actions

Chaque modification est une « action » (`{ t: 'gain', ch, raw }`, `{ t: 'peq', … }`, `{ t: 'link', … }`…).
La même fonction applique l’action à la configuration en mémoire et produit les commandes à
envoyer. Elle reproduit ce que fait le firmware : une modification d’un canal lié s’applique à tout
son groupe, une copie de canal copie exactement ce que copie le firmware. Les tests de conformité
vérifient ce comportement contre les mesures faites sur le vrai firmware.

### Le gain automatique

Pour les sets vinyles, le niveau change d’un disque à l’autre. Le DSP ne sait pas le corriger : son
compresseur et son limiteur ne sont que sur les sorties, avec un relâchement de 3 s au plus. Le
gain automatique (`leveler.ts`) tourne donc dans le pont, même sans écran ouvert, et agit sur le
gain des entrées où arrive la table de mixage :

- il lit les vumètres des entrées choisies (4 fois par seconde) et en déduit le niveau qu’aurait la
  musique sans sa correction ; il ne décide que sur des moyennes (15 à 60 s selon la vitesse), en
  laissant de côté le silence et les passages calmes ;
- il corrige par pas de 0,5 dB, hors d’une zone autour de la cible, entre les limites choisies ;
  une chute brutale du niveau (un break) suspend la remontée ;
- chaque pas passe par la session comme une modification ordinaire : tous les écrans la voient ;
  un gain changé par quelqu’un d’autre devient la nouvelle référence après une pause ;
- le firmware écrit chaque modification dans sa mémoire (EEPROM) aussitôt : le nombre de pas par
  heure est donc limité ;
- on ne sait pas encore si les vumètres d’entrée du boîtier mesurent avant ou après le gain
  d’entrée. Tant que ce n’est pas vérifié, il suppose « avant », le cas sans danger (au pire, la
  correction ne va qu’à moitié) ; la vérification baisse le gain de 6 dB pendant 2 s et regarde si
  les vumètres suivent.

L’écran DJ (`#/dj`) montre le niveau par rapport à la zone et ne conseille de toucher au gain de la
table que quand le gain automatique ne peut pas le faire lui-même.

## Le pont (`apps/bridge`)

| Fichier | Rôle |
| --- | --- |
| `main.ts` | ligne de commande, appareils mémorisés (`<data>/bridge.json`) |
| `transports.ts` | TCP, USB HID (`node-hid`, optionnel), série (`serialport`, optionnel), DSP virtuel |
| `hub.ts` | une session par appareil, reconnexion automatique (2 s, puis jusqu’à 30 s entre deux essais) |
| `server.ts` | HTTP (interface compilée) et WebSocket : abonnements, actions, appels, bibliothèque, codes |
| `discovery.ts` | recherche Ethernet (diffusion UDP 30303 comme le logiciel Windows, puis essai du port 9761 sur le réseau local) |
| `library.ts` | bibliothèque partagée : presets, sauvegardes d’appareil, scènes (fichiers JSON dans `<data>/library`) |
| `leveler.ts` | un gain automatique par appareil, branché sur sa session tant qu’il est en ligne ; réglages et gains de référence dans `<data>/leveler.json` |

Tous les écrans abonnés à un appareil partagent sa session. Quand un écran envoie une action, le
pont l’applique, puis la diffuse aux autres écrans, qui la rejouent sur leur copie : tout le monde
voit la même chose, sans relire l’appareil.

Sécurité :

- sans code, tout le monde est administrateur ; avec `--pin` et `--operator-pin`, un écran sans code
  est en lecture seule, un opérateur ne peut que régler les volumes, les mutes et rappeler un
  preset ;
- cinq codes faux depuis une même adresse bloquent cette adresse une minute ;
- le WebSocket n’accepte que les pages servies par le pont lui-même (ou les origines données avec
  `--allow-origin`), pour qu’un autre site ouvert dans le navigateur ne puisse pas piloter le DSP ;
- chaque argument reçu est vérifié (`rpc.ts`) avant d’atteindre la session.

## L’interface (`apps/web`)

| Dossier | Contenu |
| --- | --- |
| `client/` | les deux « backends » (pont par WebSocket, ou navigateur seul), les transports WebHID et Web Serial, et `mirror.ts`, la copie locale de chaque appareil |
| `state/` | état global (appareil choisi, rôle, messages, dialogues) et navigation par adresse (`#/canal/3`, `#/appareil/liaisons`…) |
| `views/` | les écrans : Vue globale, Console, Canaux, pages de tous les canaux (EQ graphique, Dynamique, Délais, Matrice), Presets, Bibliothèque, Appareil, Outils, Connexion, Gain auto et écran DJ, fiche imprimable |
| `editors/` | éditeurs d’un canal : égaliseur paramétrique, filtres, dynamique, routage, EQ graphique |
| `ui/` | composants : curseurs, champs de saisie, courbe de réponse tactile, vumètres, icônes |

La copie locale (`mirror.ts`) applique chaque modification tout de suite à l’écran et l’envoie ; les
modifications venues d’ailleurs sont appliquées aussi, et celles de cet écran encore en route sont
rejouées par-dessus, de sorte que l’écran finit toujours exactement comme l’appareil. Elle gère aussi
annuler / rétablir et les mémoires A / B. Chaque modification ne recrée que les canaux touchés, ce
qui garde l’interface fluide sur un téléphone.

L’application est installable (manifeste et service worker dans `apps/web/public`) quand elle est
servie en HTTPS, ou depuis `localhost`.

## Tests

| Commande | Ce qui est vérifié |
| --- | --- |
| `npm test` | trames, codage des valeurs, fichiers `.prs` / `.unt` octet pour octet, courbes, session (sur le DSP virtuel), pont, et **conformité au firmware** : chaque commande mesurée sur le vrai firmware (fichiers `packages/protocol/test/fixtures/`) doit modifier les mêmes octets dans le DSP virtuel |
| `npm run test:emulator` | 12 essais de la session sur le vrai firmware dans l’émulateur (voir [emulator/](../emulator/README.md)) |
| `node apps/web/e2e/flows.cjs` | 26 parcours dans un vrai navigateur, sur deux écrans à la fois (Playwright) |
| `python3 emulator/selftest.py 206` | l’émulateur lui-même : premier allumage, réglages, preset, rallumage |

Les mesures de conformité se refont avec `emulator/tools/mapper.py` ; les autres relevés du dossier
`emulator/tools/` (liaisons, copie, mémoire des presets, protocole Extend) sont cités dans les tests
qu’ils justifient.
