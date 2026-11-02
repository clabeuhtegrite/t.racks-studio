# t.racks Studio sur un Raspberry Pi

*[English version](raspberry-pi.md)*

Un Raspberry Pi branché au réseau de la salle fait tourner t.racks Studio pour tout le monde : il
pilote les DSP, et chaque téléphone, tablette ou ordinateur du réseau ouvre l’interface dans son
navigateur, sans rien installer. Le Pi n’utilise que sa prise Ethernet ; il lance l’application tout
seul à l’allumage.

## Matériel

- Un Raspberry Pi 3, 4 ou 5 (un modèle avec prise Ethernet) et son alimentation officielle.
- Une carte microSD de 8 Go ou plus.
- Un câble Ethernet entre le Pi et le réseau (switch ou routeur).
- Les DSP sur le même réseau (Ethernet), ou branchés au Pi : USB, ou RS-232 / RS-485 par un
  adaptateur série USB.

## 1. Préparer la carte

Dans [Raspberry Pi Imager](https://www.raspberrypi.com/software/), choisissez **Raspberry Pi OS Lite
(64-bit)**, puis ouvrez les réglages (*Edit settings*) :

- nom d’hôte : `tracks-studio` (l’interface sera à l’adresse `http://tracks-studio.local/`) ;
- un nom d’utilisateur et un mot de passe ;
- *Services* : activez SSH.

Laissez le Wi-Fi vide. Mettez la carte dans le Pi, branchez le câble Ethernet, puis l’alimentation.

## 2. Installer

Depuis un ordinateur du même réseau, ouvrez un terminal (PowerShell sous Windows) et connectez-vous
au Pi :

```sh
ssh votre-utilisateur@tracks-studio.local
```

Puis installez t.racks Studio :

```sh
curl -fsSL https://raw.githubusercontent.com/clabeuhtegrite/t.racks-studio/main/deploy/raspberry-pi/install.sh | sudo bash
```

Pour lire le script avant de le lancer :

```sh
sudo apt install -y git
git clone https://github.com/clabeuhtegrite/t.racks-studio.git
sudo ./t.racks-studio/deploy/raspberry-pi/install.sh
```

Comptez 5 à 10 minutes. Le [script](../deploy/raspberry-pi/install.sh) :

- installe Node.js 22 si besoin (la version officielle de nodejs.org, somme de contrôle vérifiée) ;
- place l’application dans `/opt/t.racks-studio` et compile l’interface ;
- installe le service `t.racks-studio` : lancé à l’allumage, relancé s’il s’arrête, sur le port 80,
  sous un utilisateur à lui, sans privilèges (`tracks-studio`) ;
- donne à cet utilisateur l’accès aux DSP en USB ([règle udev](../deploy/raspberry-pi/60-t.racks-dsp.rules))
  et aux adaptateurs série ;
- annonce l’interface sur le réseau (mDNS / Bonjour).

Options, après le nom du script, ou après `sudo bash -s --` avec la ligne `curl` :

| Option | |
|---|---|
| `--disable-wifi` | coupe définitivement le Wi-Fi du Pi : Ethernet uniquement |
| `--hostname nom` | renomme le Pi : l’adresse devient `http://nom.local/` |
| `--port 8080` | un autre port HTTP que 80 |
| `--branch nom` | installe une autre branche du dépôt |

Par exemple : `curl -fsSL …/install.sh | sudo bash -s -- --disable-wifi`

## 3. Ouvrir l’interface

Sur n’importe quel écran du réseau : **http://tracks-studio.local/**, ou `http://` suivi de
l’adresse IP du Pi (le script affiche les deux). Certains téléphones Android ne connaissent pas les
noms en `.local` : utilisez-y l’adresse IP, et donnez au Pi une adresse fixe (ci-dessous). Ajoutez
la page à l’écran d’accueil pour l’ouvrir comme une application.

Ajoutez ensuite les DSP une fois pour toutes, dans l’écran **Connexion** : *Ethernet* (recherche
sur le réseau, ou adresse IP du DSP), *USB* (branché au Pi) ou *RS-232 / RS-485* (`/dev/ttyUSB0`
pour la plupart des adaptateurs série USB). Le Pi s’en souvient ; on s’y connecte et on s’en
déconnecte depuis cet écran.

## Une adresse fixe

Le plus simple : réserver l’adresse du Pi dans le routeur (réservation DHCP). Sinon, réglez-la sur le
Pi (Raspberry Pi OS utilise NetworkManager) :

```sh
nmcli -f NAME,DEVICE connection show          # la connexion filaire, par exemple « Wired connection 1 »
sudo nmcli connection modify "Wired connection 1" ipv4.method manual \
  ipv4.addresses 192.168.1.20/24 ipv4.gateway 192.168.1.1 ipv4.dns 192.168.1.1
sudo nmcli connection up "Wired connection 1"
```

## Codes d’accès

Sans code, toute personne du réseau peut tout régler. Pour protéger les réglages :

```sh
sudo nano /etc/t.racks-studio.env
```

Renseignez `DSP_STUDIO_PIN` (administrateur : tous les réglages) et, si vous voulez,
`DSP_STUDIO_OPERATOR_PIN` (opérateur : volumes, mutes et rappel de presets), retirez le `#` devant,
puis `sudo systemctl restart t.racks-studio`. Le port se règle dans le même fichier.

## Commandes utiles

| | |
|---|---|
| État | `systemctl status t.racks-studio` |
| Messages | `journalctl -u t.racks-studio -f` |
| Redémarrer | `sudo systemctl restart t.racks-studio` |
| Mettre à jour | `sudo /opt/t.racks-studio/deploy/raspberry-pi/install.sh` |
| Ne plus lancer à l’allumage | `sudo systemctl disable --now t.racks-studio` (retour : `enable --now`) |
| Désinstaller | `sudo /opt/t.racks-studio/deploy/raspberry-pi/install.sh --uninstall` (`--purge` efface aussi les données) |
| Sauvegarder | copiez `/var/lib/t.racks-studio` : appareils mémorisés et bibliothèque |
| Éteindre | `sudo poweroff`, puis débranchez |

Les messages sont dans la langue du système (`sudo raspi-config`, *Localisation Options*).

## Bon à savoir

- **Coupures de courant.** t.racks Studio écrit ses fichiers de façon à ce qu’une coupure ne les
  abîme pas, mais la carte préfère `sudo poweroff`. Une alimentation inadaptée cause des pannes au
  hasard : prenez l’officielle.
- **Sécurité.** Le service tourne sans droits root (port 80 par une capacité) et ne peut écrire que
  dans son dossier de données. Gardez le réseau des DSP à l’écart d’Internet, et posez des codes
  d’accès.
- **USB.** Branchez le DSP, puis *Connexion > USB > Actualiser*. S’il n’apparaît pas, débranchez-le
  et rebranchez-le (`ls -l /dev/hidraw*` doit montrer le groupe `plugdev`).
- **« le port 80 demande des droits supplémentaires ».** Cela arrive quand vous lancez l’application
  vous-même (`npm start -- --port 80`) : Linux réserve les ports sous 1024 à root. Passez par le
  service, ou prenez un port comme 8080.
- **Autres ordinateurs Linux.** Le script fonctionne aussi sous Debian et Ubuntu (x64 ou ARM) avec
  systemd.
