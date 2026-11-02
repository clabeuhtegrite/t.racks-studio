# Protocole des DSP 206 et 408

Ce que t.racks Studio sait du dialogue avec les t.racks DSP 206 et DSP 408 (firmware v1.04). Tout ce qui
suit a été vérifié sur le vrai firmware, exécuté dans [l’émulateur](../emulator/README.md) ; les
plans de mémoire viennent de mesures (une commande, puis relecture de toute la configuration). Le
code de référence est dans `packages/protocol/src/`.

Les deux modèles ont le même jeu de commandes ; seuls changent le nombre de canaux et la taille de la
configuration.

## Liaisons

| Liaison | Détails |
| --- | --- |
| Ethernet | module intégré, TCP port **9761**, une seule connexion à la fois. Adresse d’origine 192.168.1.101. |
| Recherche Ethernet | diffusion UDP sur le port **30303** du texte `Discovery: Who is out there?` suivi d’un octet nul ; chaque module répond par des lignes `nom\r\nadresse MAC\r\n…`. |
| USB | périphérique HID, VID `0x0168`, PID `0x0821`, rapports de 64 octets (à l’écriture, l’identifiant de rapport `0x00` est ajouté devant : 65 octets). Les trames longues sont coupées en plusieurs rapports, complétées par des zéros. |
| RS-232 / RS-485 | 115 200 bauds, 8 bits, sans parité, 1 bit d’arrêt. Sur un bus RS-485, chaque appareil a son ID. |

Les mêmes trames passent sur toutes les liaisons.

## Trame

```
10 02 | src | dst | len | cmd | données… | 10 03 | chk
```

- ordinateur → DSP : `src = 00`, `dst = ID de l’appareil` (1 d’origine) ; DSP → ordinateur : `src = ID`, `dst = 00` ;
- `len` = 1 + nombre d’octets de données (compte `cmd`) ;
- `chk` = OU exclusif de tous les octets qui précèdent (de `10 02` à `10 03` compris) ;
- pas d’échappement des octets `10` : le découpage se fait par `len` ;
- au plus 254 octets de données ;
- les valeurs sur deux octets sont en petit-boutiste (octet faible d’abord), sauf mention contraire.

Exemple, demande de version : `10 02 00 01 01 13 10 03 12`.

Un appareil ne répond qu’aux trames qui portent son ID. Une commande inconnue reçoit `02` (NAK), une
commande de réglage reçoit `01` (ACK).

## Déroulement d’une session

1. `10` : passage en mode PC. Réponse `10 [19]`. Aucune autre commande ne répond avant (seul le
   protocole Extend, plus bas, fonctionne sans).
2. `13` : version, par exemple `DSP206 V0104P` ; `52` : version longue (`DSP206 V0104P 20221206A`).
3. `2C` : état du verrouillage. S’il est verrouillé, `2D` avec le mot de passe.
4. `22` : quelles mémoires U01 … U20 contiennent un preset de l’utilisateur ; `29` : leurs noms ;
   `14` : preset actif.
5. `27` page par page (19 pages sur le 206, 29 sur le 408) : la configuration en cours.
6. `19` : mémoire système (ID, verrouillage, PTS, adresse IP).
7. Ensuite : les réglages, et `40` (vumètres) plusieurs fois par seconde.
8. `11` : retour au mode façade (pas de réponse).

## Commandes

| Code | Données envoyées | Réponse | Rôle |
| --- | --- | --- | --- |
| `10` | — | `10 [19]` | mode PC (connexion) |
| `11` | — | aucune | retour au mode façade |
| `12` | — | ACK | présence |
| `13` | — | `13` texte | version |
| `52` | — | `52` texte | version longue |
| `14` | — | `14 [n]` | preset actif (0 = F00, 1 … 20 = U01 … U20) |
| `15` | unité | ACK | unité d’affichage des délais (0 ms, 1 m, 2 ft) |
| `19` | adresse (2), longueur | `19` octets | lecture de la mémoire système |
| `1A` | adresse (2), longueur, octets | ACK | écriture de la mémoire système |
| `20` | n | ACK | rappel d’un preset (0 = F00) |
| `24` | n | ACK | rappel, même effet que `20` |
| `21` | n (1 … 20) | ACK | enregistrement du réglage en cours (envoyer le nom avant, avec `26`) |
| `26` | nom (14) | ACK | nom du preset en cours |
| `22` | — | `22` 20 octets | `FF` = preset de l’utilisateur, `00` = contenu d’usine |
| `29` | k (0 … 19) | `29 [k, nom (14)]` | nom d’un preset |
| `23` | — | ACK | les 20 mémoires reviennent au réglage d’usine |
| `25` | page, mémoire − 1, 50 octets | `25 [page]` | écrit directement une page d’un preset enregistré, sans toucher au son |
| `27` | page | `24 [page, 50 octets]` | lecture d’une page de la configuration en cours |
| `28` | page | `28 [page, 50 octets]` | lecture d’une page (variante) |
| `2A` | source, destination | ACK | copie d’un canal |
| `2C` | — | `2C [PTS actif, limite (2), compteur (2), verrouillé]` | état du verrouillage (gros-boutiste) |
| `2D` | type, mot de passe (4) | `2D [type, ok]` | déverrouillage (type 0) ou mot de passe PTS (type 1) |
| `2E` | mot de passe (4), limite (2, gros-boutiste), actif | ACK | réglage du compteur d’allumages (PTS) |
| `2F` | mot de passe (4) | ACK | verrouillage |
| `30` | canal, ratio, attaque, relâchement, genou, seuil (2 octets chacun) | ACK | compresseur |
| `31` | canal, fréquence (2), pente | ACK | passe-bas |
| `32` | canal, fréquence (2), pente | ACK | passe-haut |
| `33` | canal, bande, gain (2), fréquence (2), Q, type, bypass | ACK | une bande de l’égaliseur paramétrique |
| `34` | canal, gain (2) | ACK | volume |
| `35` | canal, 0 / 1 | ACK | mute |
| `36` | canal, 0 / 1 | ACK | polarité |
| `38` | canal, échantillons (2) | ACK | délai |
| `39` | source, n° de sinus | ACK | générateur de test |
| `3A` | sortie, masque des entrées | ACK | routage |
| `3B` | canal, masque | ACK | liaison de canaux |
| `3C` | canal, 0 / 1 | ACK | bypass de tout l’égaliseur paramétrique |
| `3D` | canal, nom (8) | ACK | nom d’un canal |
| `3E` | canal, attaque, relâchement, maintien, seuil (2 octets chacun) | ACK | noise gate |
| `3F` | canal, attaque, relâchement, genou, seuil (2 octets chacun) | ACK | limiteur (le logiciel Windows n’affiche pas le genou) |
| `40` | — | `40` niveaux | vumètres |
| `41` | sortie, entrée, niveau (2) | ACK | niveau d’une entrée dans le mélange d’une sortie |
| `48` | canal, bande, niveau (2) | ACK | une bande de l’EQ graphique |
| `49` | canal, 0 / 1 | ACK | bypass de l’EQ graphique |

Les canaux sont numérotés entrées d’abord, puis sorties : sur le 206, 0 = InA, 1 = InB, 2 = Out1 …
7 = Out6 ; sur le 408, 0 … 3 = InA … InD, 4 … 11 = Out1 … Out8.

**À ne jamais envoyer** : `04`, `08`, `A2`, `A8`, réservées à la mise à jour du firmware et aux
outils de production. `08` efface la configuration puis redémarre l’appareil. t.racks Studio refuse de
les envoyer.

## Valeurs

| Réglage | Codage |
| --- | --- |
| Volume, niveau de mélange | 0 … 400 : −60 à −20 dB par pas de 0,5 dB (0 … 80), puis −20 à +12 dB par pas de 0,1 dB ; 280 = 0 dB. Mélange limité à 0 dB. |
| Gain d’une bande (paramétrique ou graphique) | 0 … 240 = −12 à +12 dB par pas de 0,1 dB ; 120 = 0 dB |
| Fréquence (égaliseur, filtres) | 0 … 300, logarithmique de 19,7 Hz à 20,16 kHz (1/30 d’octave) |
| Q | 0 … 100, index d’une table de 0,4 à 128 (copiée du firmware) |
| Type de bande | 0 cloche, 1 plateau grave, 2 plateau aigu, 3 passe-bas 6 dB, 4 passe-bas 12 dB, 5 passe-haut 6 dB, 6 passe-haut 12 dB, 7 passe-tout 1, 8 passe-tout 2 |
| Pente des filtres | 0 = filtre coupé, 1 … 20 = Butterworth, Bessel et Linkwitz-Riley de 6 à 48 dB/octave |
| Délai | échantillons à 96 kHz, 0 … 65 280 (680 ms) ; distances calculées avec 343,5 m/s |
| Seuils (gate, compresseur, limiteur) | 2 × dB + 180 : gate −90 à 0 dB, compresseur et limiteur −90 à +20 dB. Le firmware les transmet au DSP en dB sur l’échelle des vumètres : seuil moins 14 dB pour le gate, moins 17,8 dB pour le compresseur, moins 15 dB pour le limiteur (et à +20 dB le limiteur est coupé). |
| Attaque, relâchement, maintien | ms − 1 (attaque 1 … 999 ms, relâchement 10 … 3000 ms, maintien 10 … 999 ms) |
| Ratio | 0 … 14 : 1:1 à 1:20 (15 valeurs) ; 15 = limiteur |
| Genou | 0 … 12 dB |
| Générateur | source 0 entrées, 1 bruit rose, 2 bruit blanc, 3 sinus ; sinus = l’une des 31 fréquences de l’EQ graphique |
| Vumètres | 12 groupes de 3 octets (4 entrées puis 8 sorties sur les deux modèles ; le 206 laisse vides les groupes 2, 3, 10 et 11). Chaque groupe est le haut d’un flottant 32 bits (niveau linéaire, 1 = 0 dBFS), dans l’ordre bits 16 à 23, 24 à 31, 8 à 15. Puis un mot d’état de 2 octets, poids faible d’abord : bit j = compresseur de la sortie j en action, bit 8 + j = son limiteur. Le logiciel Windows n’en tient compte que si le ratio n’est pas 1:1 (compresseur) ou si le seuil est sous +20 dB (limiteur). |

## Mémoire de configuration

Une configuration (un preset) occupe 928 octets sur le 206 et 1448 sur le 408, lus par pages de
50 octets. Le même contenu est enregistré dans les presets et, presque entier, dans les fichiers
`.prs`.

| Position | Taille | Contenu |
| --- | --- | --- |
| 0 | 2 | origine : `FF 00` = F00, `FF FF` = preset de l’utilisateur |
| 2 | 14 | nom du preset |
| 0x10 + 0x8C × i | 0x8C | entrée i |
| début des sorties + (96 + 2 × entrées) × j | 96 + 2 × entrées | sortie j |
| G | 16 + 2 × canaux | bloc commun |

Sur le 206 : entrées à 0x10 et 0x9C, sorties à partir de 0x128 tous les 0x64 octets, bloc commun
à 0x380. Sur le 408 : entrées tous les 0x8C octets à partir de 0x10, sorties à partir de 0x240 tous
les 0x68 octets, bloc commun à 0x580.

Entrée (0x8C octets) :

| Position | Contenu |
| --- | --- |
| 0x00 | nom (8) |
| 0x08 … 0x0F | gate : attaque, relâchement, maintien, seuil |
| 0x10 | EQ graphique : 31 bandes de 2 octets |
| 0x4E | égaliseur paramétrique : 8 bandes de 6 octets (gain 2, fréquence 2, Q, type) |
| 0x7E, 0x80 | fréquences du passe-haut et du passe-bas |
| 0x82, 0x83 | pentes du passe-haut et du passe-bas |
| 0x84, 0x86, 0x88, 0x8A | volume, polarité, délai, liaison |

Sortie (M = 2 × nombre d’entrées) :

| Position | Contenu |
| --- | --- |
| 0 | nom (8) |
| 8 | routage (masque des entrées) |
| 10 | niveaux de mélange (2 octets par entrée) |
| 10 + M … 15 + M | filtres : fréquences puis pentes |
| 16 + M | égaliseur paramétrique : 9 bandes de 6 octets |
| 70 + M … 79 + M | compresseur : ratio, attaque, relâchement, genou, seuil |
| 80 + M … 87 + M | limiteur : attaque, relâchement, genou, seuil |
| 88 + M, 90 + M, 92 + M, 94 + M | volume, polarité, délai, liaison |

Bloc commun : masques des mutes (entrées, sorties), masque des bandes en bypass de chaque canal,
source et fréquence du générateur, unité des délais, masques de bypass de l’égaliseur
paramétrique (entrées, sorties) et de l’EQ graphique.

## Liaisons de canaux

Entrées et sorties forment deux familles séparées. Dans chaque famille, le canal dont le bit est
présent dans son propre masque « mène » le groupe décrit par ce masque ; les autres membres ont un
masque nul. Toute commande de réglage envoyée à un membre est appliquée par le firmware au groupe
entier, et le rappel d’un preset aussi. La copie de canal (`2A`) copie tous les réglages, mute et
bypass compris, sauf le nom et la liaison, et, pour une sortie, ni le routage ni le mélange.

## Presets

- F00 est le réglage d’usine, en lecture seule ; U01 … U20 sont les mémoires de l’utilisateur.
- Enregistrer : `26` (nom) puis `21 [n]`. Rappeler : `20 [n]`.
- Un rappel arrête le générateur de test et remet à zéro les bypass des égaliseurs ; l’unité des
  délais ne change pas ; les mutes font partie du preset.
- `25` écrit un preset enregistré page par page, sans toucher au son en cours : c’est ainsi que le
  logiciel Windows restaure une sauvegarde complète.
- À l’allumage, l’appareil reprend ses derniers réglages et le preset actif.

## Mémoire système

Lue avec `19`, écrite avec `1A` :

| Adresse | Contenu |
| --- | --- |
| 0x00 | ID de l’appareil |
| 0x01 | preset actif |
| 0x03 … 0x06 | mot de passe PTS (« 0000 » d’origine) |
| 0x07 … 0x08 | compteur d’allumages (gros-boutiste) |
| 0x09 … 0x0A | limite d’allumages (gros-boutiste) |
| 0x0B | PTS actif |
| 0x0C | verrouillé |
| 0x0D … 0x10 | mot de passe de verrouillage (« 1234 » d’origine) |
| 0x13 … 0x16 | adresse IP |

L’ID et l’adresse IP sont pris en compte au prochain allumage : c’est au démarrage que le firmware
transmet l’adresse à son module Ethernet (trames `B8` et `BE`, adressées au module et que t.racks Studio
ignore).

## Fichiers du logiciel Windows

- `.prs` (un preset) : `***DSP206V010***` ou `***DSP408V010***` (16 octets), la configuration du nom
  jusqu’aux masques de bypass des bandes, puis `\r\n`. Les réglages du générateur, l’unité des délais
  et les bypass globaux des égaliseurs n’y sont pas : le logiciel garde ses valeurs en cours. Le
  logiciel refuse un fichier dont la taille n’est pas exacte (932 octets pour le 206, 1452 pour le
  408).
- `.unt` (tout l’appareil) : la même signature, 18 octets de mémoire système, puis 20 fois
  `[n° de mémoire, configuration sans ses 2 derniers octets]` ou une suite d’octets `64` pour une
  mémoire au contenu d’usine, chacun suivi de `\r\n`. Pour restaurer, le logiciel envoie `23`,
  réécrit la mémoire système (sauf l’ID) et écrit chaque preset avec `25`.

## Protocole « Extend » (RS-232)

Protocole simple pour les automates (Crestron, AMX, domotique), décrit dans la page Aide > RS-232
Code du logiciel Windows et dans t.racks Studio (Outils > Code RS-232) :

```
7B 7D | id | cmd | d1 | d2 | d3 | 7D 7B        toujours 9 octets, sans somme de contrôle
```

| Code | d1 d2 d3 | Réponse | Rôle |
| --- | --- | --- | --- |
| `41` | type (0 entrée, 1 sortie), canal, sens (0 monter, 1 baisser) | `OK` | volume ± 0,5 dB |
| `42` | type, canal, état (1 = coupé) | `OK` | mute |
| `43` | `00 00 00` pour F00 ; `01`, n − 1, `00` pour Un | `OK` | rappel d’un preset |
| `44` | canal, volume (2 octets, gros-boutiste, 0 … 400, 280 = 0 dB) | `OK` | volume d’une entrée |
| `45` | canal, volume (2 octets, gros-boutiste) | `OK` | volume d’une sortie |
| `48` | type, canal, `00` | volume (2 octets, gros-boutiste) | lecture d’un volume |
| `49` | type, canal, `00` | type, canal, état | lecture d’un mute |
| `4A` | `00 00 00` | 1 octet : 0 = F00, 1 … 20 = U01 … U20 | preset actif |

`OK` = `4F 4B`. Les canaux sont comptés à partir de 0 dans chaque famille (0 = InA ou Out1).

- L’appareil répond sur les prises RS-232 et RS-485, qu’un logiciel soit connecté ou non, et
  seulement aux trames qui portent son ID.
- Rappel des presets : `7B 7D 01 43 01 00 00 7D 7B` rappelle U01, `… 43 01 01 00 …` U02,
  `… 43 01 13 00 …` U20 (lu dans le code du firmware, puis vérifié). Toute autre valeur est ignorée.
- Une trame qui commence par `7B 7D` sans être exactement une trame de 9 octets pour cet appareil
  (autre ID, ou l’exemple en 8 octets donné pour `4A` dans l’aide de Thomann) n’est jamais
  consommée : l’appareil n’entend plus rien, protocole normal compris, jusqu’à ce que son tampon de
  128 octets déborde. Sur une ligne RS-485 partagée par plusieurs appareils, faites suivre chaque
  trame Extend de 128 octets `00` : ils remettent la réception à zéro et ne gênent personne. Les
  trames du protocole normal destinées à un autre ID ne posent pas ce problème.

## Sources

Le protocole a d’abord été décrit par dxtrzlb/z3r0-dsp206, gr4per/dsp206,
FlexiFlizz/t.racks-DSP-control, Aeternitaas/dsp-408-ui et DoctorRemoteControl/dsp408-protocol. DSP
Studio a tout revérifié et complété sur le firmware v1.04 : plan complet de la mémoire, liaisons,
copie, écriture directe des presets, fichiers, verrouillage, compteur PTS, mémoire système,
protocole Extend.
