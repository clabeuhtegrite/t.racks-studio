# Essais sur un vrai appareil

t.racks Studio a été vérifié sur le vrai firmware v1.04, exécuté dans [l’émulateur](../emulator/README.md) :
commandes, presets, fichiers, verrouillage, compteur PTS, mémoire système, et 32 vérifications de bout
en bout dans le navigateur. Quelques points ne peuvent se vérifier qu’avec un boîtier : le son et les
vumètres, l’USB, le module Ethernet lui-même, un bus RS-485 avec plusieurs appareils, la façade et
les vrais redémarrages. Cette page dit quoi essayer, et comment enregistrer les échanges si quelque
chose ne se passe pas comme prévu.

## Avant de commencer

1. **Sauvegardez l’appareil** : Presets > Appareil complet > Sauvegarder l’appareil (ou « Send all
   to PC » dans le logiciel Windows). Gardez le fichier `.unt` : il permet de tout remettre comme
   avant à la fin (Presets > Appareil complet > Restaurer une sauvegarde).
2. **Baissez les amplis** : le générateur de test et le rappel d’un preset peuvent changer fortement
   les niveaux.
3. Notez l’ID, l’adresse IP et les mots de passe de l’appareil.
4. Fermez le logiciel Windows : le module Ethernet n’accepte qu’une connexion à la fois, et l’USB ne
   s’ouvre que dans un programme à la fois.

## Se connecter

Lancez le pont (`npm start`), ouvrez http://localhost:8080 puis ajoutez l’appareil dans l’écran Connexion ;
le pont s’en souvient aux lancements suivants.

| Liaison | Comment |
| --- | --- |
| Ethernet | l’ordinateur sur le même réseau que le DSP (192.168.1.101 d’origine, par exemple un ordinateur en 192.168.1.10 / 255.255.255.0). Connexion > Ethernet > Rechercher sur le réseau, ou l’adresse IP du DSP |
| USB | Connexion > USB (sous Linux, la [règle udev](../deploy/raspberry-pi/60-t.racks-dsp.rules)), ou Chrome / Edge en mode navigateur |
| RS-232 / RS-485 | Connexion > RS-232 / RS-485 : `/dev/ttyUSB0` (ou `COM3` sous Windows), 115 200 bauds |

## Ce qu’il faut vérifier

« Émulateur » indique ce qui a déjà été vérifié sur le vrai firmware ; le reste ne peut l’être que
sur l’appareil.

| Domaine | Essai | Résultat attendu | Émulateur |
| --- | --- | --- | --- |
| Connexion | se connecter, ouvrir Appareil > Général | version, noms des presets et preset actif identiques à ceux de la façade | ✓ |
| Vumètres | passer de la musique | les vumètres de la Console et de la Vue globale bougent comme ceux de la façade et du logiciel Windows (mêmes zones verte, jaune et rouge) ; témoin rouge sur une entrée saturée ; témoin orange sur une sortie quand son compresseur ou son limiteur agit | ✓ trames ; niveaux : — |
| Vumètres d’entrée | un signal constant sur InA, puis baisser le volume de InA de 6 dB | noter si le vumètre de InA baisse de 6 dB (mesure après le volume d’entrée) ou ne bouge pas (avant) ; le DSP virtuel suppose « après » | — |
| Réglages en direct | volume, mute, bande d’égaliseur, passe-haut, délai, polarité | le changement s’entend tout de suite ; la façade affiche la même valeur | ✓ (sans le son) |
| Façade | changer un réglage sur la façade pendant que t.racks Studio est connecté, puis Appareil > Général > Relire | la nouvelle valeur apparaît | — |
| Presets | enregistrer U20 depuis t.racks Studio, le rappeler depuis la façade, puis F00 et U20 depuis t.racks Studio | même son, même nom sur la façade | ✓ (sans la façade) |
| Fichiers | ouvrir dans le logiciel Windows un `.prs` enregistré par t.racks Studio, et l’inverse | même contenu | ✓ format, octet pour octet |
| Sauvegarde complète | sauvegarder, réglages d’usine, restaurer | les 20 mémoires et leurs noms reviennent | ✓ |
| Verrouillage | verrouiller avec un mot de passe en chiffres et majuscules | la façade demande le mot de passe ; t.racks Studio le demande aussi ; déverrouillage accepté | ✓ (sans la façade) |
| Compteur d’allumages (PTS) | limite de 2, puis éteindre et rallumer 2 ou 3 fois | l’appareil demande le mot de passe PTS ; il l’accepte ; désactiver ensuite la limite | ✓ réglage et mot de passe ; comptage aux allumages : — |
| Réseau | changer l’adresse IP, éteindre et rallumer | l’appareil répond à la nouvelle adresse (l’USB reste disponible pour corriger une erreur) | ✓ enregistrement ; module : — |
| ID et RS-485 | deux appareils d’ID différents sur une même ligne RS-485, Connexion > RS-232 / RS-485 > Chercher les ID | les deux ID sont trouvés ; chacun se règle sans toucher à l’autre | — |
| USB | Connexion > USB avec le pont sous Linux, Windows ou macOS, puis Chrome en mode navigateur | connexion, réglages et vumètres comme en Ethernet | — |
| Recherche Ethernet | Connexion > Ethernet > Rechercher sur le réseau | l’appareil apparaît avec son adresse | réponse imitée par l’émulateur |
| Générateur | bruit rose à bas niveau, puis un sinus, puis Arrêter | le signal remplace les entrées, puis la musique revient | ✓ (sans le son) |
| Protocole Extend | Outils > Code RS-232 : préparer une trame, l’envoyer avec un terminal série | « OK » et effet immédiat ; lecture du volume et du mute | ✓ |
| Plusieurs écrans | un téléphone et un ordinateur sur le même appareil | chaque modification apparaît aussitôt sur l’autre écran | ✓ |
| Gain auto : vumètres | Gain auto > Réglages avancés > Vérifier, pendant la musique | « avant le gain » ou « après le gain », le même résultat deux fois de suite (noter lequel) | — |
| Gain auto : correction | cible −14 dBFS, gain auto activé, puis un disque nettement plus faible (ou baisser la sortie de la table de 6 dB) | le gain des entrées remonte par pas de 0,5 dB jusqu’à la zone, sans dépasser la remontée maximale ; l’écran DJ passe de « Correction en cours » à « Bon niveau » | — |
| Gain auto : break et silence | un break de 20 s, puis lever le diamant | le gain ne remonte pas pendant le break ; « Silence : en pause » quand le diamant est levé | — |

À la fin, restaurez la sauvegarde du début si besoin.

## Si quelque chose diffère

1. **Dans t.racks Studio** : ouvrez Outils > Trames, refaites l’opération, puis Pause et Télécharger
   (fichier `trames_….txt`). Copiez aussi Outils > Journal.
2. **Le même essai avec le logiciel Windows**, pour comparer, en enregistrant ses échanges :
   - Ethernet : [Wireshark](https://www.wireshark.org) avec le filtre `tcp.port == 9761`, puis
     enregistrez la capture (`.pcapng`) ;
   - USB sous Windows : USBPcap (proposé à l’installation de Wireshark), sur le port USB du DSP ;
   - RS-232 : un moniteur de port série.
3. **À joindre** : le modèle et la version (Appareil > Général > Informations), ce que vous avez
   fait, ce que vous attendiez et ce qui s’est passé, le fichier des trames, et si possible la capture
   du logiciel Windows faisant la même chose.

Attention : les mots de passe de verrouillage et PTS passent en clair dans les trames `2D`, `2E` et
`2F` (4 caractères). Changez-les ou masquez-les avant de publier une capture.

t.racks Studio n’envoie jamais les commandes réservées à l’usine (mise à jour du firmware, effacement) ;
n’essayez pas de les envoyer à la main.

## Particularités à confirmer

Vues dans l’émulateur, à vérifier sur un boîtier :

- après une trame Extend destinée à un autre ID, l’appareil n’entend plus rien jusqu’à avoir reçu
  128 octets de plus ; 128 octets `00` le débloquent toujours (voir
  [le protocole](protocole.md#protocole--extend--rs-232)) ;
- l’ID et l’adresse IP modifiés ne servent qu’après un redémarrage ;
- le premier allumage d’un appareil vierge (mémoire effacée) l’initialise puis le redémarre seul.
