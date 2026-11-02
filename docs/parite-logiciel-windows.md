# Correspondance avec le logiciel Windows

Chaque menu, dialogue et réglage du « the t.racks DSP 206 / 408 Processor Editor » v1.05, y compris
ceux que le logiciel cache (menus `Visible=False` de ses fenêtres), et où le retrouver dans DSP
Studio. L’inventaire vient des fenêtres de l’éditeur lui-même ; les plages et les pas de chaque
réglage sont repris de ses tables.

Colonne « Firmware » : ✓ = vérifié sur le vrai firmware v1.04 dans l’émulateur (tests de conformité,
tests d’intégration ou parcours dans le navigateur) ; « appareil » = à confirmer sur un boîtier réel
(voir [essais sur un vrai appareil](essais-materiel.md)).

## Fenêtre principale

| Logiciel Windows | t.racks Studio | Firmware |
| --- | --- | --- |
| Boutons InA … InD, Out1 … Out8 (page d’un canal) | **Canaux** (flèches ou liste pour changer de canal) ; toucher une tranche de la **Console** ouvre son canal | ✓ |
| Volume du canal (curseur et saisie) | Console et Canaux > Niveau, polarité et délai | ✓ |
| Mute | Console et Canaux | ✓ |
| Polarité (正向 / inverse) | Console et Canaux | ✓ |
| Vumètres en barres vertes, jaunes et rouges, témoin Clip, témoin Limit des sorties (allumé quand le compresseur ou le limiteur agit) | Console, **Vue globale** et Canaux > Niveau : mêmes seuils de couleur que le logiciel, témoin rouge d’écrêtage, témoin orange compresseur ou limiteur ; badges « Compresseur » et « Limiteur » dans la Vue globale, « compresse en ce moment » et « limite en ce moment » dans les éditeurs | ✓ trames ; niveaux : appareil |
| Passe-haut (低切) : fréquence, pente (20 choix BW / BL / LK de −6 à −48 dB/oct), bypass | Canaux > Filtres (crossover), aussi par glisser sur la courbe | ✓ |
| Passe-bas (高切) : fréquence, pente, bypass | Canaux > Filtres (crossover) | ✓ |
| Égaliseur paramétrique : 8 bandes (entrées) ou 9 (sorties), boutons 1 … 9 | Canaux > Égaliseur paramétrique : bandes sur la courbe et dans le tableau | ✓ |
| Par bande : fréquence, largeur (Q), gain, type, bypass | Éditeur de bande (curseurs, saisie, glisser sur la courbe ; Q à la molette ou en pinçant à deux doigts) | ✓ |
| Types de bande (cloche, plateaux grave et aigu, passe-bas et passe-haut 6 et 12 dB, passe-tout 1 et 2) | Liste « Type » de chaque bande | ✓ |
| Bypass de tout l’égaliseur du canal | Canaux > Égaliseur paramétrique > Bypass EQ | ✓ |
| Remise à zéro de l’EQ (« Are you sure to RESET EQ ? ») | Canaux > Égaliseur paramétrique > Réinitialiser (avec confirmation) ; idem pour l’EQ graphique | ✓ |
| Courbe de réponse du canal (édition à la souris) | Courbe de réponse tactile ; Console > Réponse des canaux pour les superposer | — (calcul) |
| Page Gain (tous les volumes) | **Console** | ✓ |
| Page Gate (seuil, attaque, maintien, relâchement des entrées) | **Dynamique** et Canaux > Noise gate | ✓ |
| Page Comp (ratio, attaque, relâchement, genou, seuil des sorties) | **Dynamique** et Canaux > Compresseur (avec courbe de transfert) | ✓ |
| Page Limit (seuil, attaque, relâchement des sorties) | **Dynamique** et Canaux > Limiteur | ✓ |
| Page Delay (délai de chaque canal, unité ms / m / ft) | **Délais** et Canaux ; unité au choix comme sur l’appareil | ✓ |
| Page Matrix (entrées vers sorties et niveaux de mélange) | **Matrice** et Canaux > Routage | ✓ |
| Page GEQ (31 bandes, bypass, entrées) | **EQ graphique** et Canaux | ✓ |
| Schéma bloc (menu caché 方塊圖) | **Vue globale** : traitements actifs de chaque canal, avec son niveau ; Canaux : chaîne du signal du canal | — |
| Zone preset : numéro et nom du preset en cours | En-tête de chaque écran (badge du preset) et **Presets** | ✓ |
| Bouton Recall (dialogue « Load Preset » F00, U01 … U20) | Presets > Rappeler | ✓ |
| Bouton Store (dialogues « Store Preset » et nom du preset, 14 caractères) | Presets > Enregistrer ici (nom de 14 caractères, accents retirés comme sur l’appareil) | ✓ |
| État de la connexion (未連機 / connecté) | Indicateur d’état dans l’en-tête ; écran **Connexion** | ✓ |
| « You Must Connect First !! » | Les réglages ne s’affichent qu’une fois connecté ; l’écran Connexion s’ouvre sinon | — |
| Barre de progression (fenêtre Process) | Indicateur de progression des opérations longues | — |

## Menu Fichier

| Logiciel Windows | t.racks Studio | Firmware |
| --- | --- | --- |
| Ouvrir un preset du PC (.prs) | Presets > Ouvrir un fichier : écouter, écrire dans une mémoire, ajouter à la bibliothèque | ✓ format, octet pour octet |
| Enregistrer le preset sur le PC (.prs) | Presets > Enregistrer sur l’ordinateur (.prs ou .json) | ✓ |
| Envoyer tout l’appareil vers le PC (sauvegarde .unt) | Presets > Appareil complet > Sauvegarder l’appareil | ✓ |
| Charger tout l’appareil depuis le PC (.unt) | Presets > Appareil complet > Restaurer une sauvegarde (tout, ou une sélection de mémoires) | ✓ |
| Retour aux réglages d’usine (menu caché, avec confirmation) | Presets > Réglages d’usine, et Appareil > Général | ✓ |
| Quitter (avec confirmation) | Sans objet : on ferme l’onglet | — |

## Autres menus

| Logiciel Windows | t.racks Studio | Firmware |
| --- | --- | --- |
| Link (liaisons des entrées et des sorties) | Appareil > Liaisons et copie : choisir les canaux, Lier, Délier la sélection, Tout délier | ✓ |
| Copy (copie d’une entrée vers une entrée, d’une sortie vers une sortie) | Appareil > Liaisons et copie > Copier (une source vers une ou plusieurs destinations) | ✓ |
| Lock : mot de passe de verrouillage (4 caractères, 1234 d’origine) | Appareil > Verrouillage | ✓ |
| Déverrouillage (« UnLock Password ») | Écran de déverrouillage affiché sur tous les écrans tant que l’appareil est verrouillé | ✓ |
| Setting ID (menu caché) et Network Setup (ID 1 … 250, adresse IP) | Appareil > Général > Réseau (pris en compte au prochain allumage, comme sur l’appareil) | ✓ |
| Test Tone (bruit rose, bruit blanc, sinus 20 Hz … 20 kHz, retour aux entrées) | Appareil > Générateur | ✓ |
| Channel Name (nom d’un canal, 8 caractères) et liste des noms | Appareil > Noms des canaux ; Canaux > Renommer | ✓ |
| Langue (anglais, chinois simplifié ou traditionnel, menu caché) | Interface en français | — |
| Aide > Code RS-232 (table des commandes série) | Outils > Code RS-232, avec générateur de trames prêt à copier | ✓ |
| Aide > Memo Show (liste des messages, caché) | Outils > Journal (copie, effacement) | — |
| Aide > HidData (trames échangées, caché) | Outils > Trames (pause, filtre des vumètres, copie, téléchargement) | ✓ |
| Aide > PTS Setup (compteur d’allumages 次數鎖 : mot de passe, marche / arrêt, limite, valeur actuelle, caché) | Appareil > Verrouillage > Limite d’allumages (PTS) | ✓ |
| Mot de passe PTS (« PTS Password ») | Appareil > Verrouillage > Mot de passe PTS, aussi proposé sur l’écran de déverrouillage | ✓ |
| Aide > Lock Setup (操作鎖, caché) | Appareil > Verrouillage | ✓ |
| Connect / Disconnect / aide à la connexion (cachés) | Connexion : connecter, reconnecter, retirer un appareil, aide pour chaque type de liaison | ✓ Ethernet ; USB : appareil |
| Fenêtre de connexion : recherche des appareils, scan des ID, mode démo | Connexion : recherche Ethernet (même diffusion UDP 30303 que l’éditeur), bouton « Chercher les ID », DSP de démonstration | ✓ Ethernet |
| About | Outils > À propos | — |

## Différences voulues

- L’interface est en français.
- La copie de canal accepte plusieurs destinations d’un coup (le logiciel Windows : une à la fois).
- Les noms (canaux, presets) sont nettoyés comme l’appareil les stocke : sans accents, caractères
  ASCII seulement. Ce qui s’affiche est exactement ce que l’appareil garde.
- Le mot de passe de verrouillage accepte 4 caractères imprimables, comme le logiciel Windows. Pour
  pouvoir le saisir aussi sur la façade, utilisez des chiffres et des lettres majuscules (0000 à
  ZZZZ, voir le manuel).
- Les commandes réservées à l’usine (mise à jour du firmware, effacement complet) ne sont jamais
  envoyées.

## En plus du logiciel Windows

- Plusieurs appareils pilotés en même temps, et plusieurs écrans synchronisés en direct.
- Codes d’accès : administrateur (tout) et opérateur (volumes, mutes, rappel de presets).
- Annuler / rétablir, comparaison A/B de deux versions des réglages.
- Bibliothèque partagée par tous les écrans : presets, sauvegardes, scènes rappelées d’un geste sans
  occuper de mémoire de l’appareil, avec notes.
- « Couper les sorties » d’un geste, alignement des délais par distances, assistant de filtrage 2 ou
  3 voies, calculs de délai et de longueur d’onde.
- Fiche des réglages imprimable (ou en PDF).
- Gain automatique (page Gain auto) : le pont ajuste doucement le gain des entrées de la table de
  mixage pour garder le même niveau d’un disque à l’autre, et un écran DJ plein écran dit quand
  toucher au gain de la table. Le DSP n’a rien de tel : son compresseur et son limiteur ne sont que
  sur les sorties, avec un relâchement de 3 s au plus.
- Pilotage sans installation depuis Chrome ou Edge (USB et série), application installable sur
  téléphone (HTTPS).
