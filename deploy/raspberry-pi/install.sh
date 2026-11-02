#!/usr/bin/env bash
# Installs t.racks Studio on a Raspberry Pi wired to the network by Ethernet: Node.js, the app, and a
# service that starts it at boot, so every phone, tablet and computer of the network can open it.
# Run it again to update. Guide: docs/raspberry-pi.md
#
#   sudo ./deploy/raspberry-pi/install.sh [--port 80] [--hostname tracks-studio] [--disable-wifi]
#   sudo ./deploy/raspberry-pi/install.sh --uninstall [--purge]
#
# or, without cloning first:
#   curl -fsSL https://raw.githubusercontent.com/clabeuhtegrite/t.racks-studio/main/deploy/raspberry-pi/install.sh | sudo bash

set -euo pipefail

REPO_URL=${REPO_URL:-https://github.com/clabeuhtegrite/t.racks-studio.git}
BRANCH=${BRANCH:-main}
APP_DIR=${APP_DIR:-/opt/t.racks-studio}
DATA_DIR=/var/lib/t.racks-studio
ENV_FILE=/etc/t.racks-studio.env
SERVICE=t.racks-studio
SVC_USER=tracks-studio
UDEV_RULE=/etc/udev/rules.d/60-t.racks-dsp.rules
AVAHI_FILE=/etc/avahi/services/t.racks-studio.service
NODE_MAJOR=22
NODE_DIR=/opt/nodejs

port=''
new_hostname=''
disable_wifi=0
action=install
purge=0

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Installs or updates t.racks Studio as a service on a Raspberry Pi (Raspberry Pi OS).

  sudo ./deploy/raspberry-pi/install.sh [options]

  --port n             HTTP port of the interface (80 by default: http://tracks-studio.local/)
  --hostname name      also renames the Raspberry Pi (address name.local on the network)
  --disable-wifi       turns the Wi-Fi of the Raspberry Pi off: it only uses its Ethernet port
  --branch name        branch of the repository to install (main by default)
  --uninstall          removes the service (keeps the app, the settings and the data)
  --purge              with --uninstall: also deletes the app, the settings and the data
  -h, --help           this help

Access codes and the port are in /etc/t.racks-studio.env.
EOF
}

while [[ $# -gt 0 ]]; do
  case $1 in
    --port) port=${2:-}; shift 2 ;;
    --hostname) new_hostname=${2:-}; shift 2 ;;
    --disable-wifi) disable_wifi=1; shift ;;
    --branch) BRANCH=${2:-}; shift 2 ;;
    --uninstall) action=uninstall; shift ;;
    --purge) purge=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

[[ $(uname -s) == Linux ]] || die "this script is for Raspberry Pi OS (Linux)"
[[ $EUID -eq 0 ]] || die "run it with sudo: sudo $0 $*"
command -v systemctl >/dev/null || die "systemd is needed (Raspberry Pi OS has it)"
if [[ -n $port ]] && ! [[ $port =~ ^[0-9]+$ && $port -ge 1 && $port -le 65535 ]]; then die "invalid port: $port"; fi
if [[ -n $new_hostname ]] && ! [[ $new_hostname =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]]; then
  die "invalid name: $new_hostname (lowercase letters, digits and dashes)"
fi
[[ -n $BRANCH ]] || die "--branch needs a name"

# --- removal ---------------------------------------------------------------------------------------

uninstall() {
  say "Removing the $SERVICE service"
  systemctl disable --now "$SERVICE" 2>/dev/null || true
  rm -f "/etc/systemd/system/$SERVICE.service" "$UDEV_RULE" "$AVAHI_FILE"
  systemctl daemon-reload
  udevadm control --reload-rules 2>/dev/null || true
  if [[ $purge -eq 1 ]]; then
    say "Deleting the app, the settings and the data"
    rm -rf "$APP_DIR" "$DATA_DIR" "$ENV_FILE"
    if id -u "$SVC_USER" >/dev/null 2>&1; then userdel "$SVC_USER" || true; fi
  else
    echo "Kept: $APP_DIR (app), $ENV_FILE (settings), $DATA_DIR (devices and library)."
    echo "Add --purge to delete them too. Node.js ($NODE_DIR) is left in place."
  fi
}

if [[ $action == uninstall ]]; then uninstall; exit 0; fi

# --- system packages and Node.js -----------------------------------------------------------------

apt_install() {
  local missing=()
  for p in "$@"; do dpkg -s "$p" >/dev/null 2>&1 || missing+=("$p"); done
  [[ ${#missing[@]} -eq 0 ]] && return 0
  say "Installing ${missing[*]}"
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${missing[@]}" >/dev/null
}

node_ok() {
  command -v node >/dev/null 2>&1 &&
    node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 18) ? 0 : 1)'
}

install_node() {
  if node_ok; then echo "Node.js $(node -v) is already installed."; return; fi
  local arch
  case $(uname -m) in
    aarch64|arm64) arch=arm64 ;;
    armv7l) arch=armv7l ;;
    x86_64) arch=x64 ;;
    *) die "Node.js $NODE_MAJOR does not run on this processor ($(uname -m)): use a Raspberry Pi 3, 4 or 5" ;;
  esac
  local base="https://nodejs.org/dist/latest-v$NODE_MAJOR.x" tmp file
  tmp=$(mktemp -d)
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  file=$(grep -oE "node-v[0-9.]+-linux-$arch\.tar\.xz" "$tmp/SHASUMS256.txt" | head -n 1)
  [[ -n $file ]] || die "no Node.js $NODE_MAJOR build for linux-$arch on nodejs.org"
  say "Installing Node.js (${file%.tar.xz})"
  curl -fsSL "$base/$file" -o "$tmp/$file"
  (cd "$tmp" && grep " $file\$" SHASUMS256.txt | sha256sum -c --quiet -) || die "the Node.js download is damaged"
  rm -rf "$NODE_DIR"
  mkdir -p "$NODE_DIR"
  tar -xJf "$tmp/$file" -C "$NODE_DIR" --strip-components=1 --no-same-owner
  for b in node npm npx; do ln -sf "$NODE_DIR/bin/$b" "/usr/local/bin/$b"; done
  rm -rf "$tmp"
  hash -r
  node_ok || die "Node.js was not installed correctly"
}

# --- the app ----------------------------------------------------------------------------------------

fetch_app() {
  if [[ -d $APP_DIR/.git ]]; then
    say "Updating $APP_DIR ($BRANCH)"
    if [[ -n $(git -C "$APP_DIR" status --porcelain --untracked-files=no) ]]; then
      die "files were changed by hand in $APP_DIR; settings belong in $ENV_FILE. Undo the changes (git -C $APP_DIR checkout .) and run this again."
    fi
    git -C "$APP_DIR" fetch -q --depth 1 origin "$BRANCH"
    git -C "$APP_DIR" reset -q --hard FETCH_HEAD
  elif [[ -e $APP_DIR ]]; then
    die "$APP_DIR already exists and is not a copy of the repository: move it away first"
  else
    say "Downloading t.racks Studio into $APP_DIR"
    git clone -q --depth 1 --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
  fi
  echo "Version: $(git -C "$APP_DIR" log -1 --format='%h %cs %s')"
}

native_ok() {
  (cd "$APP_DIR/apps/bridge" && node --input-type=module -e "await import('node-hid'); await import('serialport');") >/dev/null 2>&1
}

build_app() {
  cd "$APP_DIR"
  say "Installing the dependencies (a few minutes on a Raspberry Pi)"
  npm ci --no-audit --no-fund --loglevel=error
  if ! native_ok; then
    # USB and serial use compiled modules; build them when no ready-made binary fits
    say "Compiling the USB and serial modules"
    apt_install build-essential python3 libudev-dev libusb-1.0-0-dev
    npm ci --no-audit --no-fund --loglevel=error
    native_ok || warn "USB and serial connections will not be available (Ethernet works)."
  fi
  say "Building the web interface"
  npm run build --silent >/dev/null
}

# --- system integration -----------------------------------------------------------------------------

setup_user() {
  if ! id -u "$SVC_USER" >/dev/null 2>&1; then
    useradd --system --home-dir "$DATA_DIR" --no-create-home --shell /usr/sbin/nologin "$SVC_USER"
  fi
  # serial adapters (dialout) and the DSP on USB (plugdev, see the udev rule)
  for g in dialout plugdev; do
    getent group "$g" >/dev/null || groupadd --system "$g"
    usermod -aG "$g" "$SVC_USER"
  done
}

setup_settings() {
  if [[ ! -s $ENV_FILE ]]; then
    cat >"$ENV_FILE.new" <<EOF
# Settings of t.racks Studio. After a change: sudo systemctl restart $SERVICE

# HTTP port of the interface (80: the address needs no port number)
PORT=${port:-80}

# Access codes. Without them, everyone on the network can change every setting.
# Administrator: every setting. Operator: volumes, mutes and preset recall only.
#DSP_STUDIO_PIN=
#DSP_STUDIO_OPERATOR_PIN=
EOF
    mv "$ENV_FILE.new" "$ENV_FILE"
  elif [[ -n $port ]]; then
    if grep -q '^PORT=' "$ENV_FILE"; then sed -i "s/^PORT=.*/PORT=$port/" "$ENV_FILE"; else echo "PORT=$port" >>"$ENV_FILE"; fi
  fi
  chown "root:$SVC_USER" "$ENV_FILE"
  chmod 0640 "$ENV_FILE"
}

current_port() {
  local p
  p=$(sed -n 's/^PORT=\([0-9]*\).*/\1/p' "$ENV_FILE" | tail -n 1)
  echo "${p:-80}"
}

setup_service() {
  say "Installing the $SERVICE service (starts at boot)"
  sed -e "s#@APP_DIR@#$APP_DIR#g" -e "s#@NODE@#$(command -v node)#g" \
    "$APP_DIR/deploy/raspberry-pi/t.racks-studio.service" >"/etc/systemd/system/$SERVICE.service"
  install -m 0644 "$APP_DIR/deploy/raspberry-pi/60-t.racks-dsp.rules" "$UDEV_RULE"
  udevadm control --reload-rules || true
  udevadm trigger --subsystem-match=hidraw --subsystem-match=usb || true
  if [[ -d /etc/avahi/services ]]; then
    # announces the interface on the network (Bonjour / zeroconf browsers)
    cat >"$AVAHI_FILE" <<EOF
<?xml version="1.0" standalone='no'?>
<!DOCTYPE service-group SYSTEM "avahi-service.dtd">
<service-group>
  <name replace-wildcards="yes">t.racks Studio on %h</name>
  <service>
    <type>_http._tcp</type>
    <port>$(current_port)</port>
  </service>
</service-group>
EOF
  fi
  systemctl daemon-reload
  systemctl enable -q "$SERVICE"
  systemctl restart "$SERVICE"
}

set_hostname() {
  [[ -n $new_hostname ]] || return 0
  say "Renaming the Raspberry Pi: $new_hostname"
  if command -v raspi-config >/dev/null; then
    raspi-config nonint do_hostname "$new_hostname"
  else
    local old
    old=$(hostname)
    hostnamectl set-hostname "$new_hostname"
    sed -i "s/^127\.0\.1\.1\s.*/127.0.1.1\t$new_hostname/" /etc/hosts
    grep -q "^127\.0\.1\.1" /etc/hosts || printf '127.0.1.1\t%s\n' "$new_hostname" >>/etc/hosts
    echo "(was $old)"
  fi
  systemctl restart avahi-daemon 2>/dev/null || true
}

turn_wifi_off() {
  [[ $disable_wifi -eq 1 ]] || return 0
  if ip route get 1.1.1.1 2>/dev/null | grep -q ' dev wl'; then
    die "this Raspberry Pi reaches the network over Wi-Fi: plug in the Ethernet cable, then run this again"
  fi
  say "Turning the Wi-Fi off (Ethernet only)"
  if command -v nmcli >/dev/null; then nmcli radio wifi off || true; fi
  if command -v rfkill >/dev/null; then rfkill block wifi || true; fi
  local cfg=/boot/firmware/config.txt
  [[ -f $cfg ]] || cfg=/boot/config.txt
  if [[ -f $cfg ]] && ! grep -q '^dtoverlay=disable-wifi' "$cfg"; then
    printf '\n[all]\n# t.racks Studio: Ethernet only\ndtoverlay=disable-wifi\n' >>"$cfg"
    echo "The Wi-Fi chip is switched off from the next boot ($cfg)."
  fi
}

wait_ready() {
  local p
  p=$(current_port)
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$p/api/health" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  warn "the interface does not answer yet; see: journalctl -u $SERVICE -e"
  return 1
}

show_addresses() {
  local p suffix='' name
  p=$(current_port)
  [[ $p == 80 ]] || suffix=":$p"
  name=$(hostname)
  say "t.racks Studio is running"
  echo "Open it from any phone, tablet or computer of the network:"
  echo "  http://$name.local$suffix/"
  for ip in $(hostname -I 2>/dev/null); do
    [[ $ip == *:* ]] || echo "  http://$ip$suffix/"
  done
  cat <<EOF

Add the DSPs from the Connection screen (Ethernet, USB or RS-232 / RS-485).
Access codes and port: sudo nano $ENV_FILE, then sudo systemctl restart $SERVICE
Messages: journalctl -u $SERVICE -f        Update: run this script again
EOF
}

apt_install git curl ca-certificates xz-utils
install_node
fetch_app
build_app
setup_user
setup_settings
turn_wifi_off
set_hostname
setup_service
wait_ready && show_addresses
