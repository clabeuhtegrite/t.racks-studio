#!/usr/bin/env python3
"""Télécharge les mises à jour officielles Thomann des DSP 206 / 408 et en extrait le firmware.

Le firmware n'est jamais redistribué avec t.racks Studio : ce script le récupère sur le site de Thomann
et l'extrait sur votre machine, dans emulator/firmware/ (dossier ignoré par git).

    python3 emulator/fetch_firmware.py            # les deux modèles
    python3 emulator/fetch_firmware.py 408        # un seul modèle
    python3 emulator/fetch_firmware.py --exe ~/Téléchargements/435194_update_dsp_408_v1_04_netstartverdet.exe
    python3 emulator/fetch_firmware.py --out /data/firmware   # ailleurs que dans emulator/firmware/

How it works: the updater (a Windows program) carries the firmware as Intel HEX records, each one a
NUL-terminated ASCII string. They are collected, checked (record checksums, reset vector, the
"PowerDsp" signature) and written as flat binary images. The .exe is only read, never run.
"""
import argparse, hashlib, os, re, sys, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'firmware')
BASE = 'https://fast-images.static-thomann.de/pics/atg/atgdata/file/misc/'
UPDATERS = {
    '206': '435192_update_dsp_206_v1_04_netstartverdet.exe',
    '408': '435194_update_dsp_408_v1_04_netstartverdet.exe',
}
# Images extracted from the v1.04 updaters on 2026-11-01, the ones t.racks Studio was tested with.
KNOWN = {
    'dsp206-v0104.bin': 'd6c11de4cc6d72a6dc4d3e34b984ab97a72e2b31e0a6bbfcd4c47f29f39ab849',
    'dsp206-v0104p.bin': '7ab38c7f29bd5f89f56ac68d8f66675844a3953dd96a786baf5c6407b7f2d4e4',
    'dsp408-v0104.bin': 'edaf4ffa42a00f0cb3583389471ecaf835c5ba716b7a60a33b3fdbafc2e0f8ca',
    'dsp408-v0104p.bin': '364141c37ad6382115eafc5a33512ff9b3bf1bd0edcf1e37b52750d2ea0e527c',
}
MAX_DOWNLOAD = 32 * 1024 * 1024
FLASH_SIZE = 0x20000


def download(name):
    os.makedirs(os.path.join(OUT, 'download'), exist_ok=True)
    path = os.path.join(OUT, 'download', name)
    if os.path.exists(path):
        print(f'  déjà téléchargé : {path}')
        return path
    url = BASE + name
    print(f'  téléchargement de {url}')
    req = urllib.request.Request(url, headers={'User-Agent': 'dsp-studio-fetch/1.0'})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read(MAX_DOWNLOAD + 1)
    if len(data) > MAX_DOWNLOAD:
        raise SystemExit('Erreur : fichier inattendu (trop gros).')
    if not data.startswith(b'MZ'):
        raise SystemExit("Erreur : le fichier reçu n'est pas un programme Windows (lien changé ?).")
    with open(path + '.part', 'wb') as f:
        f.write(data)
    os.replace(path + '.part', path)
    return path


def hex_images(blob):
    """Intel HEX records (':' + hex digits + NUL) -> list of {address: byte} images."""
    images, cur, base = [], None, 0
    for m in re.finditer(rb':([0-9A-Fa-f]{10,520})\x00', blob):
        rec = bytes.fromhex(m.group(1).decode())
        n, addr, typ = rec[0], (rec[1] << 8) | rec[2], rec[3]
        if len(rec) != n + 5 or sum(rec) & 0xFF:
            continue  # not a record (or a damaged one)
        if cur is None:
            cur, base = {}, 0
        payload = rec[4:4 + n]
        if typ == 0:
            for i, b in enumerate(payload):
                cur[base + addr + i] = b
        elif typ == 1:
            images.append(cur)
            cur = None
        elif typ == 2:
            base = ((payload[0] << 8) | payload[1]) << 4
        elif typ == 4:
            base = ((payload[0] << 8) | payload[1]) << 16
    if cur:
        images.append(cur)
    return images


def flatten(mem):
    lo, hi = min(mem), max(mem)
    if lo != 0 or hi >= FLASH_SIZE:
        return None
    out = bytearray([0xFF] * (hi + 1))
    for a, b in mem.items():
        out[a] = b
    return bytes(out)


def identify(img):
    """'dsp206-v0104p.bin' for a plausible firmware image, else None."""
    sp, reset = int.from_bytes(img[0:4], 'little'), int.from_bytes(img[4:8], 'little')
    if not (0x20000000 <= sp <= 0x20010000 and reset & 1 and reset < len(img)):
        return None
    if img[0x10DF8:0x10E00] != b'ewoPpsDr':  # "PowerDsp", stored as byte-swapped half words
        return None
    m = re.search(rb'DSP(206|408) V(\d{4})(P?)', img)
    if not m:
        return None
    return f'dsp{m.group(1).decode()}-v{m.group(2).decode()}{m.group(3).decode().lower()}.bin'


def extract(exe_path, want=None):
    blob = open(exe_path, 'rb').read()
    found = []
    for mem in hex_images(blob):
        img = flatten(mem)
        name = img and identify(img)
        if not name or (want and not name.startswith(f'dsp{want}-')):
            continue
        os.makedirs(OUT, exist_ok=True)
        path = os.path.join(OUT, name)
        with open(path + '.part', 'wb') as f:  # never half a file under the final name
            f.write(img)
        os.replace(path + '.part', path)
        digest = hashlib.sha256(img).hexdigest()
        note = 'identique à la version testée' if KNOWN.get(name) == digest else 'VERSION NON TESTÉE avec t.racks Studio'
        print(f'  {name} ({len(img)} octets) : {note}')
        found.append(name)
    return found


def main():
    ap = argparse.ArgumentParser(description="Récupère le firmware officiel des DSP 206 / 408 pour l'émulateur.")
    ap.add_argument('models', nargs='*', choices=['206', '408'], help='modèles (les deux par défaut)')
    ap.add_argument('--exe', help='utiliser un fichier de mise à jour déjà téléchargé au lieu de le télécharger')
    ap.add_argument('--out', help='dossier où ranger le firmware (emulator/firmware/ par défaut)')
    a = ap.parse_args()
    if a.out:
        global OUT
        OUT = os.path.abspath(a.out)
    if a.exe:
        print(f'Extraction depuis {a.exe}')
        found = extract(a.exe)
        if not found:
            raise SystemExit("Aucun firmware de DSP 206 / 408 trouvé dans ce fichier.")
    else:
        for model in a.models or ['206', '408']:
            print(f'DSP {model}')
            try:
                exe = download(UPDATERS[model])
            except OSError as e:
                raise SystemExit(f'Erreur de téléchargement : {e}\n'
                                 f'Téléchargez la mise à jour depuis la page du produit sur thomann.de, puis :\n'
                                 f'  python3 emulator/fetch_firmware.py --exe chemin/vers/{UPDATERS[model]}')
            if not extract(exe, model):
                raise SystemExit("Aucun firmware trouvé dans la mise à jour (format changé ?).")
    print(f'Firmware prêt dans {OUT}')
    print('Lancez ensuite : python3 emulator/server.py 206   (ou 408)')


if __name__ == '__main__':
    sys.exit(main())
