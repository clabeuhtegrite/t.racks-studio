#!/usr/bin/env python3
"""Ce que garde un preset sur le vrai firmware : générateur, unité de délai, bypass EQ, mutes.

    python3 emulator/tools/test_volatile.py emulator/firmware/dsp206-v0104p.bin   (ou dsp408)

The test tone, the delay unit, the PEQ / GEQ bypass and a mute are set, the preset is stored in
U01, then F00 and U01 are recalled. The result is the expectation of 'preset memory behaves like
the firmware' in packages/protocol/test/firmware-conformance.test.ts (identical on both models).
"""
import os, sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
from unit import Unit  # noqa: E402

NAMES = ['toneSrc', 'toneFreq', 'delayUnit', 'peqBypIn', 'peqBypOut', 'geqByp']


def main():
    u = Unit(sys.argv[1], None)
    u.boot()
    nin, pages, size = (2, 19, 928) if u.model == '206' else (4, 29, 1448)
    u.request(0x10)
    u.request(0x20, b'\x00', limit=200_000_000)

    def dump():
        buf = bytearray()
        for p in range(pages):
            f = [f for f in u.request(0x27, bytes([p])) if f[5] == 0x24][0]
            buf += f[7:7 + f[4] - 2]
        return bytes(buf[:size])

    def tail(b):
        return {n: b[size - 12 + 2 * i] | (b[size - 11 + 2 * i] << 8) for i, n in enumerate(NAMES)}

    mute_out = size - 14 - 2 * (nin + (6 if u.model == "206" else 8))   # output mute mask (G + 2)
    u.request(0x39, bytes([3, 5]))       # sine 63 Hz
    u.request(0x15, bytes([2]))          # delays in feet
    u.request(0x3c, bytes([0, 1]))       # PEQ bypass InA
    u.request(0x3c, bytes([nin, 1]))     # PEQ bypass Out1
    u.request(0x49, bytes([0, 1]))       # GEQ bypass InA
    u.request(0x35, bytes([nin, 1]))     # mute Out1
    live = dump()
    print('live      ', tail(live), 'muteOut', live[mute_out])
    u.request(0x26, b'VOLATILE TEST ')
    u.request(0x21, bytes([1]), limit=200_000_000)
    print('stored    ', tail(dump()))
    u.request(0x20, bytes([0]), limit=200_000_000)
    f00 = dump()
    print('F00       ', tail(f00), 'muteOut', f00[mute_out], 'header', f00[:2].hex())
    u.request(0x20, bytes([1]), limit=200_000_000)
    u01 = dump()
    print('U01       ', tail(u01), 'muteOut', u01[mute_out], 'header', u01[:2].hex())
    print('U01 vs live diff', [(hex(i), live[i], u01[i]) for i in range(size) if live[i] != u01[i] and not 2 <= i < 16])
    u.request(0x39, bytes([0, 0]))


if __name__ == '__main__':
    main()
