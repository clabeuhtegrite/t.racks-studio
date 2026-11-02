#!/usr/bin/env python3
"""Copie de canal (0x2a) sur le vrai firmware (DSP 206) : qu'est-ce qui est copié ?

    python3 emulator/tools/test_copy.py emulator/firmware/dsp206-v0104p.bin

Out1 and InA get settings of every kind, then Out1 is copied to Out4 and InA to InB. The offsets
that changed are the expectations of 'copy' in packages/protocol/test/firmware-conformance.test.ts.
"""
import os, sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
from unit import Unit  # noqa: E402

OUT1, INB = 0x128, 0x10 + 0x8c
OUT4 = OUT1 + 3 * 0x64

EDITS = [(0x34, [2, 0x23, 1]), (0x3a, [2, 3]), (0x41, [2, 1, 0x77, 1]), (0x3d, [2] + list(b'SRCNAME!')),
         (0x33, [2, 1, 0x55, 0, 7, 1, 0x33, 2, 1]), (0x35, [2, 1]), (0x36, [2, 1]), (0x3c, [2, 1]),
         (0x30, [2, 5, 0, 0x21, 0, 0x22, 2, 7, 0, 0x77, 0]), (0x38, [2, 0x56, 4]), (0x34, [0, 0x45, 1]),
         (0x3e, [0, 0x15, 0, 0x55, 1, 0x66, 0, 0x44, 0]), (0x48, [0, 3, 0x99, 0]), (0x49, [0, 1]),
         (0x3d, [0] + list(b'INSRC!!!'))]


def main():
    u = Unit(sys.argv[1], None)
    if u.model != '206':
        raise SystemExit('ce relevé concerne le DSP 206')
    u.boot()
    u.request(0x10)
    u.request(0x20, b'\x00', limit=200_000_000)

    def dump():
        buf = bytearray()
        for p in range(19):
            f = [f for f in u.request(0x27, bytes([p])) if f[5] == 0x24][0]
            buf += f[7:7 + f[4] - 2]
        return bytes(buf)

    for c, data in EDITS:
        u.request(c, bytes(data))
    base = dump()
    u.request(0x2a, bytes([2, 5]))   # Out1 -> Out4
    u.request(0x2a, bytes([0, 1]))   # InA -> InB
    cfg = dump()
    print('Out4 changed offsets', [hex(i - OUT4) for i in range(OUT4, OUT4 + 0x64) if base[i] != cfg[i]])
    print('InB changed offsets', [hex(i - INB) for i in range(INB, INB + 0x8c) if base[i] != cfg[i]])
    print('globals changed', [(hex(i), base[i], cfg[i]) for i in range(0x380, 0x3a0) if base[i] != cfg[i]])
    print('Out4 == Out1 except', [hex(i) for i in range(0x64) if cfg[OUT4 + i] != cfg[OUT1 + i]])


if __name__ == '__main__':
    main()
