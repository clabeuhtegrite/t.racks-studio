#!/usr/bin/env python3
"""Protocole « Extend » (Aide > RS-232 Code du logiciel Windows) sur le vrai firmware.

    python3 emulator/tools/test_ext.py emulator/firmware/dsp206-v0104p.bin

Frames of 9 bytes, 7B 7D id cmd d1 d2 d3 7D 7B, no checksum. Every command of the help page is
sent, the normal protocol is checked after each one (ping 0x12), then frames for another id and
malformed ones, which the firmware never consumes: 128 bytes 0x00 bring its receiver back. The
results are the notes of packages/protocol/src/rs232.ts.
"""
import os, sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
from unit import Unit, frame  # noqa: E402

TESTS = [
    ('InA volume -1.0 dB (0x44)', '7B7D014400010E7D7B'),
    ('Out2 volume -3.0 dB (0x45)', '7B7D01450100FA7D7B'),
    ('InA +0.5 dB (0x41 00 00 00)', '7B7D01410000007D7B'),
    ('InA +0.5 dB again', '7B7D01410000007D7B'),
    ('InB -0.5 dB (0x41 00 01 01)', '7B7D01410001017D7B'),
    ('Out1 +0.5 dB (0x41 01 00 00)', '7B7D01410100007D7B'),
    ('Out1 mute (0x42 01 00 01)', '7B7D01420100017D7B'),
    ('InB mute (0x42 00 01 01)', '7B7D01420001017D7B'),
    ('read InA volume (0x48)', '7B7D01480000007D7B'),
    ('read InB volume', '7B7D01480001007D7B'),
    ('read Out1 volume', '7B7D01480100007D7B'),
    ('read InB mute (0x49 00 01)', '7B7D01490001007D7B'),
    ('active preset (0x4A)', '7B7D014A0000007D7B'),
    ('recall U03 (0x43 01 02 00)', '7B7D01430102007D7B'),
    ('active preset (0x4A)', '7B7D014A0000007D7B'),
    ('recall F00 (0x43 00 00 00)', '7B7D01430000007D7B'),
    ('active preset (0x4A)', '7B7D014A0000007D7B'),
    ('recall 0x43 01 14 00 (U21: ignored)', '7B7D01430114007D7B'),
]
FOREIGN = [
    ('frame for id 02', '7B7D02450100C87D7B'),
    ('frame for id 00', '7B7D00450100C87D7B'),
    ('0x4A in 8 bytes (example of the help)', '7B7D014A00007D7B'),
]


def main():
    u = Unit(sys.argv[1], None)
    if u.model != '206':
        raise SystemExit('ce relevé concerne le DSP 206 (même firmware sur le 408)')
    u.boot()
    u.request(0x10)
    for slot in (1, 2, 3):   # three user presets, so that recalls can be told apart
        u.request(0x26, ('EXTEND U%02d    ' % slot).encode())
        u.request(0x21, bytes([slot]), limit=200_000_000)
    u.request(0x20, b'\x00', limit=200_000_000)

    def raw(data, millions=8):
        u.out.clear()
        u.board.uart1.rx.extend(data)
        u.run(millions * 1_000_000)
        return bytes(u.out).hex(' ')

    def ping():
        return 'ping ok' if raw(frame(0x12), 4) else 'PING SANS RÉPONSE'

    for name, h in TESTS:
        print('%-40s %s -> %-10s %s' % (name, h, raw(bytes.fromhex(h), 80 if '0x43' in name else 8), ping()), flush=True)
    for name, h in FOREIGN:
        print('%-40s %s -> %-10s %s' % (name, h, raw(bytes.fromhex(h), 4), ping()), flush=True)
        raw(bytes(128), 4)
        print('%-40s %s' % ('  then 128 bytes 00:', ping()), flush=True)


if __name__ == '__main__':
    main()
