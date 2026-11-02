#!/usr/bin/env python3
"""Un DSP 206 / 408 émulé, joignable par Ethernet comme un vrai boîtier (TCP 9761).

    python3 emulator/server.py 206                 # DSP 206 émulé sur le port 9761
    python3 emulator/server.py 408 --port 9762     # un DSP 408 en même temps
    npm start                                      # puis Connexion > Ethernet : localhost, port 9761 ou 9762
    python3 emulator/server.py 206 --pause-when-idle   # au repos tant que personne n'est connecté

Le vrai firmware Thomann tourne dans l'émulateur (voir README.md). Ce programme joue le rôle du
module Ethernet du boîtier : il relaie les octets entre la connexion TCP et le port série du
firmware, au débit réel de 115 200 bauds, et répond à la recherche d'appareils (UDP 30303) quand
il écoute sur le réseau local. La mémoire de l'appareil (presets, réglages, ID, IP, verrouillage)
est conservée dans emulator/state/ d'un lancement à l'autre.
"""
import argparse, os, select, shutil, signal, socket, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from unit import INSTR_PER_SECOND, NETWORK_MODULE_CMDS, FrameReader, Unit  # noqa: E402

TCP_PORT = 9761
DISCOVERY_PORT = 30303
BYTE_TIME = INSTR_PER_SECOND * 10 / 115200   # one byte at 115200 bauds 8N1, in instructions
FIFO = 16          # UART1 receive FIFO of the NUC1xx
CHUNK = 20_000     # instructions between two looks at the network (0.4 ms of device time)
IDLE_GRACE = 3.0   # seconds the firmware keeps running once the last client has left (pending writes)


def hexs(b):
    return ' '.join(f'{x:02x}' for x in b)


def main():
    ap = argparse.ArgumentParser(description='DSP 206 / 408 émulé (vrai firmware) joignable en TCP comme un boîtier.')
    ap.add_argument('model', nargs='?', choices=['206', '408'], default='206', help='modèle (206 par défaut)')
    ap.add_argument('--port', type=int, default=TCP_PORT, help=f'port TCP ({TCP_PORT} par défaut, comme le boîtier)')
    ap.add_argument('--host', default='127.0.0.1',
                    help="adresse d'écoute (127.0.0.1 par défaut ; 0.0.0.0 pour le réseau local, avec la recherche d'appareils)")
    ap.add_argument('--variant', choices=['P', 'standard'], default='P',
                    help='firmware V0104P (par défaut) ou V0104 : la mise à jour Thomann contient les deux')
    ap.add_argument('--firmware', help='image du firmware à utiliser (sinon emulator/firmware/)')
    ap.add_argument('--state', help='dossier de la mémoire de l’appareil (sinon emulator/state/<firmware>)')
    ap.add_argument('--reset', action='store_true', help='repartir d’un appareil neuf (efface la mémoire)')
    ap.add_argument('--trace', action='store_true', help='affiche chaque trame échangée')
    ap.add_argument('--pause-when-idle', action='store_true',
                    help='met le firmware en pause tant qu’aucun client n’est connecté : le processeur se repose '
                         '(l’horloge de l’appareil s’arrête pendant ce temps)')
    a = ap.parse_args()

    fw = a.firmware or os.path.join(HERE, 'firmware', f'dsp{a.model}-v0104{"p" if a.variant == "P" else ""}.bin')
    if not os.path.exists(fw):
        raise SystemExit(f'Firmware absent : {fw}\nRécupérez-le d’abord avec : python3 emulator/fetch_firmware.py')
    state = a.state or os.path.join(HERE, 'state', os.path.splitext(os.path.basename(fw))[0])
    if a.reset and os.path.isdir(state):
        shutil.rmtree(state)
        print('Mémoire effacée : appareil neuf.')

    try:
        srv = socket.create_server((a.host, a.port))
    except OSError as e:
        raise SystemExit(f'Impossible d’écouter sur {a.host}:{a.port} ({e.strerror}). Essayez --port {a.port + 1}.')
    srv.setblocking(False)

    unit = Unit(fw, state)
    t = time.monotonic()
    print(f'{unit.version} : démarrage du firmware'
          f'{" (premier allumage : il initialise sa mémoire puis redémarre)" if unit.fresh else ""}…', flush=True)
    unit.boot()
    print(f'Prêt en {time.monotonic() - t:.0f} s : {a.host}:{a.port}, ID {unit.eeprom.mem[0]}, '
          f'IP du boîtier {unit.ip()}, mémoire dans {state}', flush=True)
    host = 'localhost' if a.host in ('127.0.0.1', '::1', 'localhost') else a.host
    print(f'Dans t.racks Studio : Connexion > Ethernet, adresse {host}, port {a.port}', flush=True)

    udp = None
    if a.port == TCP_PORT and a.host not in ('127.0.0.1', '::1', 'localhost'):
        try:
            udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            udp.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            udp.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
            udp.bind(('', DISCOVERY_PORT))
            udp.setblocking(False)
        except OSError as e:
            print(f'Recherche d’appareils indisponible (UDP {DISCOVERY_PORT} : {e.strerror})')
            udp = None
    announce = f'DSP{unit.model} emulateur\r\n02-44-53-50-0{unit.model[0]}-{unit.model[1:]}\r\n'.encode()

    def stop(*_):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, stop)

    client, inbuf, credit, reader = None, bytearray(), 0.0, FrameReader()
    t0, i0, saved_at = time.monotonic(), unit.instructions, time.monotonic()
    idle_since, paused = time.monotonic(), False
    try:
        while True:
            socks = [srv] + ([client] if client else []) + ([udp] if udp else [])
            # nobody connected for a while: the firmware waits, and so does the processor
            sleeping = a.pause_when_idle and client is None and time.monotonic() - idle_since > IDLE_GRACE
            if sleeping and not paused:
                unit.save()
                paused = True
                print('Aucun client : firmware en pause.', flush=True)
            for s in select.select(socks, [], [], 1.0 if sleeping else 0)[0]:
                if s is srv:
                    conn, addr = srv.accept()
                    conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                    if client:
                        print('Nouvelle connexion : la précédente est fermée (le boîtier n’en accepte qu’une).')
                        client.close()
                    client, inbuf = conn, bytearray()
                    if paused:
                        paused = False
                        print('Le firmware reprend.', flush=True)
                    print(f'Connecté : {addr[0]}', flush=True)
                elif s is client:
                    try:
                        data = client.recv(4096)
                    except OSError:
                        data = b''
                    if not data:
                        print('Déconnecté.', flush=True)
                        client.close()
                        client, inbuf = None, bytearray()
                        idle_since = time.monotonic()
                    else:
                        if a.trace:
                            print(f'  PC → DSP  {hexs(data)}')
                        inbuf += data
                elif s is udp:
                    try:
                        msg, addr = udp.recvfrom(512)
                        if msg.startswith(b'Discovery'):
                            udp.sendto(announce, addr)
                    except OSError:
                        pass

            if sleeping and client is None:
                t0, i0 = time.monotonic(), unit.instructions   # a pause is no delay to catch up
                continue

            # host -> firmware at the line rate, never more than the UART FIFO holds
            credit = min(credit + CHUNK / BYTE_TIME, FIFO)
            if inbuf:
                rx = unit.board.uart1.rx
                n = min(int(credit), FIFO - len(rx), len(inbuf))
                if n > 0:
                    rx.extend(inbuf[:n])
                    del inbuf[:n]
                    credit -= n
            unit.run(CHUNK)

            # firmware -> host; what the firmware tells its Ethernet module stays here
            if unit.out:
                for kind, f in reader.push(unit.out):
                    if kind == 'frame' and f[5] in NETWORK_MODULE_CMDS:
                        if f[5] == 0xB8:
                            print(f'Module Ethernet : adresse IP {".".join(str(x) for x in f[6:10])}')
                        continue
                    if a.trace:
                        print(f'  DSP → PC  {hexs(f)}')
                    if client:
                        try:
                            client.sendall(f)
                        except OSError:
                            pass
                unit.out.clear()

            # never faster than the real unit; forget the delay when the emulator is the slower one
            ahead = (unit.instructions - i0) / INSTR_PER_SECOND - (time.monotonic() - t0)
            if ahead > 0.005:
                time.sleep(ahead)
            elif ahead < -0.5:
                t0, i0 = time.monotonic(), unit.instructions

            if time.monotonic() - saved_at > 2:
                unit.save()
                saved_at = time.monotonic()
    except KeyboardInterrupt:
        pass
    finally:
        unit.save()
        print('Arrêt : mémoire de l’appareil enregistrée.')


if __name__ == '__main__':
    main()
