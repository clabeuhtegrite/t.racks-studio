#!/usr/bin/env python3
"""Effet des liaisons sur le vrai firmware (DSP 206) : quels canaux change chaque commande ?

    python3 emulator/tools/test_link.py emulator/firmware/dsp206-v0104p.bin

Out1 + Out2 and InA + InB are linked like the Windows editor does, then every set-command is sent
to the first channel of a group (and one to the second) and the changed regions are listed. The
results are the expectations of 'link groups behave like the firmware' in
packages/protocol/test/firmware-conformance.test.ts.
"""
import os, sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
from unit import Unit  # noqa: E402

OUT1, OUT2 = 0x128, 0x128 + 0x64
INA, INB = 0x10, 0x10 + 0x8c


def region(i):
    if INA <= i < INB: return 'InA+%02x' % (i - INA)
    if INB <= i < OUT1: return 'InB+%02x' % (i - INB)
    if OUT1 <= i < OUT2: return 'Out1+%02x' % (i - OUT1)
    if OUT2 <= i < OUT2 + 0x64: return 'Out2+%02x' % (i - OUT2)
    return 'G+%03x' % i


def main():
    u = Unit(sys.argv[1], None)
    if u.model != '206':
        raise SystemExit('ce relevé concerne le DSP 206')
    u.boot()
    u.request(0x10)
    u.request(0x20, b'\x00', limit=200_000_000)
    for data in ([2, 3], [3, 0], [0, 3], [1, 0]):   # link Out1+Out2 and InA+InB like the editor
        u.request(0x3b, bytes(data))
    snap = u.board.snapshot(extra=(u.eeprom, u.program))

    def dump():
        buf = bytearray()
        for p in range(19):
            f = [f for f in u.request(0x27, bytes([p])) if f[5] == 0x24][0]
            buf += f[7:7 + f[4] - 2]
        return bytes(buf)

    base = dump()
    tests = [('gain', 0x34, [2, 0x23, 0x01]), ('mute', 0x35, [2, 1]), ('phase', 0x36, [2, 1]), ('delay', 0x38, [2, 0x56, 0x04]),
             ('hpf', 0x32, [2, 0x89, 0, 0x0b]), ('lpf', 0x31, [2, 0x11, 1, 0x0c]), ('peq', 0x33, [2, 0, 0x55, 0, 7, 1, 0x33, 2, 1]),
             ('peqbyp', 0x3c, [2, 1]), ('name', 0x3d, [2] + list(b'ABCDEFGH')), ('comp', 0x30, [2, 5, 0, 0x21, 0, 0x22, 2, 7, 0, 0x77, 0]),
             ('limit', 0x3f, [2, 0x13, 0, 0x44, 1, 0, 0, 0x66, 0]), ('route', 0x3a, [2, 2]), ('mix', 0x41, [2, 1, 0x77, 1]),
             ('gate', 0x3e, [0, 0x15, 0, 0x55, 1, 0x66, 0, 0x44, 0]), ('geq', 0x48, [0, 3, 0x99, 0]), ('geqbyp', 0x49, [0, 1]),
             ('gain_slave', 0x34, [3, 0x23, 0x01]), ('copy', 0x2a, [2, 4])]
    for name, c, data in tests:
        u.board.restore(snap)
        u.out.clear()
        u.request(c, bytes(data))
        cfg = dump()
        print(name, sorted(set(region(i) for i in range(len(base)) if base[i] != cfg[i]))[:20], flush=True)


if __name__ == '__main__':
    main()
