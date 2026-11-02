# t.racks Studio on a Raspberry Pi

*[Version française](raspberry-pi.fr.md)*

A Raspberry Pi wired to the venue network runs t.racks Studio for everyone: it drives the DSPs, and
every phone, tablet and computer of the network opens the interface in its browser, with nothing to
install. The Pi uses its Ethernet port only; it starts the app by itself when it is switched on.

## What you need

- A Raspberry Pi 3, 4 or 5 (a model with an Ethernet port) and its official power supply.
- A microSD card of 8 GB or more.
- An Ethernet cable from the Pi to the network (switch or router).
- The DSPs on the same network (Ethernet), or plugged into the Pi: USB, or RS-232 / RS-485 through
  a USB serial adapter.

## 1. Prepare the card

In [Raspberry Pi Imager](https://www.raspberrypi.com/software/), choose **Raspberry Pi OS Lite
(64-bit)**, then open the settings (*Edit settings*):

- hostname: `tracks-studio` (the interface will be at `http://tracks-studio.local/`);
- a user name and a password;
- *Services*: enable SSH.

Leave the Wi-Fi settings empty. Put the card in the Pi, plug in the Ethernet cable, then the power.

## 2. Install

From a computer on the same network, open a terminal (PowerShell on Windows) and log in to the Pi:

```sh
ssh your-user@tracks-studio.local
```

Then install t.racks Studio:

```sh
curl -fsSL https://raw.githubusercontent.com/clabeuhtegrite/t.racks-studio/main/deploy/raspberry-pi/install.sh | sudo bash
```

To read the script before running it:

```sh
sudo apt install -y git
git clone https://github.com/clabeuhtegrite/t.racks-studio.git
sudo ./t.racks-studio/deploy/raspberry-pi/install.sh
```

It takes 5 to 10 minutes. The [script](../deploy/raspberry-pi/install.sh):

- installs Node.js 22 when needed (the official build from nodejs.org, checksum verified);
- puts the app in `/opt/t.racks-studio` and builds the interface;
- installs the `t.racks-studio` service: started at boot, restarted if it stops, on port 80, under
  its own user without privileges (`tracks-studio`);
- gives that user access to the DSPs on USB ([udev rule](../deploy/raspberry-pi/60-t.racks-dsp.rules))
  and on serial adapters;
- announces the interface on the network (mDNS / Bonjour).

Options, after the script name, or after `sudo bash -s --` with the `curl` line:

| Option | |
|---|---|
| `--disable-wifi` | turns the Wi-Fi of the Pi off for good: Ethernet only |
| `--hostname name` | renames the Pi: the address becomes `http://name.local/` |
| `--port 8080` | another HTTP port than 80 |
| `--branch name` | installs another branch of the repository |

For example: `curl -fsSL …/install.sh | sudo bash -s -- --disable-wifi`

## 3. Open the interface

On any screen of the network: **http://tracks-studio.local/**, or `http://` followed by the IP
address of the Pi (the script shows both). Some Android phones do not know `.local` names: use the
IP address there, and give the Pi a fixed address (below). Add the page to the home screen to open
it like an app.

Then add the DSPs once, on the **Connection** screen: *Ethernet* (search the network, or type the IP
address of the DSP), *USB* (plugged into the Pi), or *RS-232 / RS-485* (`/dev/ttyUSB0` for most USB
serial adapters). The Pi remembers them; you connect to them and disconnect from them on that screen.

## A fixed address

The simplest is to reserve the Pi's address in the router (DHCP reservation). Otherwise, set it on
the Pi (Raspberry Pi OS uses NetworkManager):

```sh
nmcli -f NAME,DEVICE connection show          # the wired connection, e.g. "Wired connection 1"
sudo nmcli connection modify "Wired connection 1" ipv4.method manual \
  ipv4.addresses 192.168.1.20/24 ipv4.gateway 192.168.1.1 ipv4.dns 192.168.1.1
sudo nmcli connection up "Wired connection 1"
```

## Access codes

Without codes, everyone on the network can change every setting. To protect them:

```sh
sudo nano /etc/t.racks-studio.env
```

Fill in `DSP_STUDIO_PIN` (administrator: every setting) and, if you like, `DSP_STUDIO_OPERATOR_PIN`
(operator: volumes, mutes and preset recall), remove the `#` in front of them, then
`sudo systemctl restart t.racks-studio`. The port is set in the same file.

## Everyday commands

| | |
|---|---|
| State | `systemctl status t.racks-studio` |
| Messages | `journalctl -u t.racks-studio -f` |
| Restart | `sudo systemctl restart t.racks-studio` |
| Update | `sudo /opt/t.racks-studio/deploy/raspberry-pi/install.sh` |
| No start at boot | `sudo systemctl disable --now t.racks-studio` (back: `enable --now`) |
| Uninstall | `sudo /opt/t.racks-studio/deploy/raspberry-pi/install.sh --uninstall` (`--purge` also deletes the data) |
| Backup | copy `/var/lib/t.racks-studio`: remembered devices and library |
| Switch off | `sudo poweroff`, then unplug |

The messages are in the language of the system (`sudo raspi-config`, *Localisation Options*).

## Good to know

- **Power cuts.** t.racks Studio writes its files so that a power cut does not damage them, but the
  card prefers `sudo poweroff`. An unsuitable power supply causes random faults: use the official one.
- **Security.** The service runs without root rights (port 80 through a capability), and can only
  write to its data folder. Keep the DSP network away from the Internet, and set the access codes.
- **USB.** Plug the DSP in, then *Connection > USB > Refresh*. If it is missing, unplug it and
  plug it in again (`ls -l /dev/hidraw*` must show the `plugdev` group).
- **“port 80 needs extra permissions”.** This happens when you start the app yourself
  (`npm start -- --port 80`): Linux keeps the ports below 1024 for root. Use the service, or a port
  such as 8080.
- **Other Linux computers.** The script works on Debian and Ubuntu (x64 or ARM) with systemd too.
