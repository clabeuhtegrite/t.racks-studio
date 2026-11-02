#!/usr/bin/env python3
"""Vérifie que l'émulateur fait tourner le firmware comme un vrai boîtier.

    python3 emulator/selftest.py 206          (ou 408, ou --firmware fichier.bin)

Allume un appareil neuf (mémoire vierge), le prépare comme en sortie d'usine, modifie un réglage,
le rallume, puis vérifie que le réglage, le preset actif et l'adresse IP ont survécu, comme sur un
vrai DSP. Compter 1 à 2 minutes : le firmware tourne instruction par instruction.
"""
import argparse, os, sys, tempfile, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from unit import Unit  # noqa: E402

PAGES = {'206': 19, '408': 29}
HERE = os.path.dirname(os.path.abspath(__file__))


def config(u):
    out = bytearray()
    for p in range(PAGES[u.model]):
        f = [f for f in u.request(0x27, bytes([p])) if f[5] == 0x24][0]
        out += f[7:7 + f[4] - 2]
    return bytes(out)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('model', nargs='?', choices=['206', '408'], default='206')
    ap.add_argument('--firmware', help='image du firmware (par défaut emulator/firmware/dspXXX-v0104p.bin)')
    a = ap.parse_args()
    fw = a.firmware or os.path.join(HERE, 'firmware', f'dsp{a.model}-v0104p.bin')
    if not os.path.exists(fw):
        raise SystemExit(f'Firmware absent : {fw}\nLancez d\'abord : python3 emulator/fetch_firmware.py')
    ok = True

    def check(cond, text):
        nonlocal ok
        ok = ok and cond
        print(('  OK     ' if cond else '  ÉCHEC  ') + text)

    with tempfile.TemporaryDirectory() as state:
        t = time.time()
        u = Unit(fw, state)
        print(f'{u.version} : premier allumage (mémoire vierge)…')
        u.boot()
        print(f'  prêt en {time.time() - t:.0f} s')
        u.request(0x10)
        version = u.request(0x13)[0][6:-3].decode('ascii', 'replace')
        check(version.startswith(u.version), f'version annoncée « {version} »')
        f00 = config(u)
        check(f00[2:16].rstrip(b'\0 ') == b'Default Preset', 'preset d’usine F00 chargé')
        check(u.request(0x22)[0][6:26] == bytes(20), '20 mémoires utilisateur initialisées')
        # change one setting, store U03, change another one (live only)
        out1 = 2 if u.model == '206' else 4
        u.request(0x26, b'SELFTEST U03  ')
        u.request(0x34, bytes([out1, 0xC8, 0x00]))       # Out1 volume -> raw 200
        u.request(0x21, b'\x03', limit=200_000_000)      # store U03 (becomes active)
        u.request(0x35, bytes([0, 1]))                   # mute InA (not stored in a preset)
        before = config(u)
        check(before != f00, 'réglages modifiés')
        u.send(0x11)
        u.run(20_000_000)
        u.save()

        t = time.time()
        u = Unit(fw, state)
        print('Rallumage…')
        u.boot()
        print(f'  prêt en {time.time() - t:.0f} s')
        u.request(0x10)
        after = config(u)
        check(after == before, 'tous les réglages retrouvés après rallumage')
        check(u.request(0x14)[0][6] == 3, 'preset actif U03 retrouvé')
        name = u.request(0x29, b'\x02')[0][7:21]
        check(name == b'SELFTEST U03  ', f'nom de U03 « {name.decode().rstrip()} »')
        check(u.ip() == '192.168.1.101', f'adresse IP {u.ip()}')
        lock = u.request(0x2c)[0]   # [ptsOn, limit(2), count(2), locked]
        check(lock[6] == 0 and lock[11] == 0, 'appareil déverrouillé, compteur PTS inactif')
    print('Émulateur conforme.' if ok else 'Des vérifications ont échoué.')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
