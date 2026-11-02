#!/usr/bin/env python3
"""Mesure sur le vrai firmware l'effet de chaque commande de réglage sur la configuration.

    python3 emulator/tools/mapper.py emulator/firmware/dsp206-v0104p.bin firmware-probes-206.json

Factory preset F00 loaded, then for every probe: the board is put back in that state (snapshot),
one command is sent and the configuration is read back with 0x27. The result is the fixture of the
conformance tests (packages/protocol/test/fixtures/firmware-probes-<model>.json):
diff = [offset, before, after] for every byte that changed.
"""
import json, os, sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
from unit import Unit  # noqa: E402

ABOUT = ('Measured on the real DSP {m} firmware v1.04 running in the emulator (emulator/tools/mapper.py): '
         'factory preset F00 loaded, then for each probe the snapshot is restored, one command is sent and the '
         'configuration is read back with 0x27. diff = [offset, before, after].')


def main():
    fw, out = sys.argv[1], sys.argv[2]
    u = Unit(fw, None)
    u.boot()
    nin, nout = (2, 6) if u.model == '206' else (4, 8)
    npages = 19 if u.model == '206' else 29
    u.request(0x10)
    u.request(0x13)
    u.request(0x20, b'\x00', limit=200_000_000)

    def snapshot():
        return u.board.snapshot(extra=(u.eeprom, u.program))

    snap = snapshot()

    def ask(cmd, data):
        try:
            return u.request(cmd, bytes(data), limit=3_000_000)
        except TimeoutError:
            return []

    def dump():
        buf = bytearray()
        for p in range(npages):
            r = [f for f in ask(0x27, [p]) if f[5] == 0x24]
            buf += r[0][7:7 + r[0][4] - 2] if r else b'\0' * 50
        return bytes(buf)

    base = dump()
    print('config', len(base), 'octets', flush=True)
    res = {'about': ABOUT.format(m=u.model), 'model': f'dsp{u.model}', 'size': len(base), 'base': base.hex(), 'probes': []}

    board = u.board

    def probe(name, cmd, data):
        u.board = board            # a probe that reset the chip left a new board behind
        board.reset_requested = False
        board.restore(snap)
        u.out.clear()
        resets = u.resets
        r = ask(cmd, data)
        entry = {'name': name, 'cmd': cmd, 'data': bytes(data).hex(), 'reply': r[0].hex() if r else None}
        if u.resets != resets:     # production opcodes (0x08 erases everything) restart the firmware
            entry.update(reset=True, diff=[])
            print(name, bytes(data).hex(), 'redémarrage du firmware', flush=True)
        else:
            cfg = dump()
            entry['diff'] = [[i, base[i], cfg[i]] for i in range(min(len(base), len(cfg))) if base[i] != cfg[i]]
            print(name, bytes(data).hex(), len(entry['diff']), 'octet(s)', flush=True)
        res['probes'].append(entry)

    ins = list(range(nin))
    outs = list(range(nin, nin + nout))
    for ch in ins + outs:
        probe('gain', 0x34, [ch, 0x23, 0x01])
        probe('mute', 0x35, [ch, 1])
        probe('phase', 0x36, [ch, 1])
        probe('delay', 0x38, [ch, 0x56, 0x04])
        probe('hpf', 0x32, [ch, 0x89, 0x00, 0x0b])
        probe('lpf', 0x31, [ch, 0x11, 0x01, 0x0c])
        probe('peqbyp', 0x3c, [ch, 1])
        probe('name', 0x3d, [ch] + list(b'ABCDEFGH'))
        probe('link', 0x3b, [ch, 0x05])
        probe('peq0', 0x33, [ch, 0, 0x55, 0x00, 0x07, 0x01, 0x33, 0x02, 0x01])
        probe('peq1', 0x33, [ch, 1, 0x56, 0x00, 0x08, 0x01, 0x34, 0x03, 0x00])
    for b in range(9):
        probe('peqband', 0x33, [nin, b, 0x57, 0x00, 0x09, 0x01, 0x35, 0x04, 0x01])
    for b in range(8):
        probe('peqband_in', 0x33, [0, b, 0x57, 0x00, 0x09, 0x01, 0x35, 0x04, 0x01])
    for ch in ins:
        probe('gate', 0x3e, [ch, 0x15, 0x00, 0x55, 0x01, 0x66, 0x00, 0x44, 0x00])
        probe('geq0', 0x48, [ch, 0, 0x99, 0x00])
        probe('geq30', 0x48, [ch, 30, 0x98, 0x00])
        probe('geqbyp', 0x49, [ch, 1])
    for ch in outs:
        probe('comp', 0x30, [ch, 0x05, 0x00, 0x21, 0x00, 0x22, 0x02, 0x07, 0x00, 0x77, 0x00])
        probe('limit', 0x3f, [ch, 0x13, 0x00, 0x44, 0x01, 0x00, 0x00, 0x66, 0x00])
        probe('route', 0x3a, [ch, 0x02])
        for i in range(nin):
            probe('mix%d' % i, 0x41, [ch, i, 0x77, 0x01])
    probe('tone', 0x39, [3, 7])
    probe('unit', 0x15, [2])
    probe('pname', 0x26, [0] + list(b'PRESETNAME1234'))
    probe('pname_noz', 0x26, list(b'PRESETNAME1234'))
    probe('copy_in', 0x2a, [0, 1])
    # lock, EEPROM and production opcodes (never sent by DSP Studio: see FORBIDDEN), preset slots
    probe('lock', 0x2f, list(b'1234'))
    probe('c08', 0x08, [1, 2, 3, 4])
    probe('c09', 0x09, [1, 2, 3, 4])
    probe('c0f', 0x0f, [1, 2, 3, 4])
    probe('c1a', 0x1a, [7, 2, 3, 4])
    probe('c2e', 0x2e, [1, 2, 3, 4, 5, 6, 7, 8, 9])
    probe('c24', 0x24, [1])
    probe('c21', 0x21, [1])
    with open(out, 'w') as f:
        json.dump(res, f)
    print('écrit :', out)


if __name__ == '__main__':
    main()
