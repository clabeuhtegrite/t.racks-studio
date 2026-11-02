"""One emulated DSP unit: the official firmware running on the virtual board, with its EEPROM.

    unit = Unit('emulator/firmware/dsp206-v0104p.bin', state_dir='emulator/state/dsp206-v0104p')
    unit.boot()
    print(unit.request(0x13))      # [b'\\x10\\x02\\x01\\x00\\x0e\\x13DSP206 V0104P\\x10\\x03M']

The settings memory (I2C EEPROM 0x57: device id, IP address, lock, the live settings and the 20
user presets) is kept in state_dir, so the unit remembers everything between runs like a real one
and restores its last settings at power on. A new unit (empty memory) initialises itself on its
first start, as the firmware does at the factory, then gets the IP address given in the manual
(192.168.1.101).
"""
import os, re
from nuc import Board, EEPROM

INSTR_PER_SECOND = 48_000_000   # the board's clock as seen by its timers
BOOT_LIMIT = 300_000_000        # instructions; the firmware is ready well before
NETWORK_MODULE_CMDS = (0xB8, 0xBE)  # frames the firmware sends to its Ethernet module at boot
FACTORY_IP = (192, 168, 1, 101)
EEPROM_IP = 0x13


def frame(cmd, data=b'', src=0, dst=1):
    """Host -> DSP frame: 10 02 src dst len cmd data 10 03 xor."""
    body = bytes([src, dst, 1 + len(data), cmd]) + bytes(data)
    chk = 1
    for b in body:
        chk ^= b
    return b'\x10\x02' + body + bytes([0x10, 0x03, chk])


class FrameReader:
    """Cuts the byte stream coming out of a UART into DSP frames and other bytes (for instance the
    9-byte RS-232 'extend' replies)."""
    def __init__(self):
        self.buf = bytearray()

    def push(self, data):
        self.buf += data
        out = []
        while self.buf:
            b = self.buf
            if b[0] != 0x10:
                i = b.find(0x10)
                i = len(b) if i < 0 else i
                out.append(('raw', bytes(b[:i])))
                del b[:i]
                continue
            if len(b) < 2:
                break
            if b[1] != 0x02:
                out.append(('raw', bytes(b[:1])))
                del b[:1]
                continue
            if len(b) < 5:
                break
            n = b[4] + 8
            if len(b) < n:
                break
            out.append(('frame', bytes(b[:n])))
            del b[:n]
        return out

    def flush(self):
        rest, self.buf = bytes(self.buf), bytearray()
        return [('raw', rest)] if rest else []


def dsp_program_words(image):
    """Length (32-bit words) of the DSP chip program this firmware expects in its 0x53 EEPROM. The
    firmware compares it right after `lsrs r1, r1, #18` (0x0C89) with a literal loaded in r2."""
    for a in range(0, len(image) - 4, 2):
        if image[a:a + 2] == b'\x89\x0c':
            ins = int.from_bytes(image[a + 2:a + 4], 'little')
            if ins >> 11 == 0b01001 and (ins >> 8) & 7 == 2:   # ldr r2, [pc, #imm]
                lit = ((a + 6) & ~3) + (ins & 0xFF) * 4
                return int.from_bytes(image[lit:lit + 4], 'little')
    return 0x180A


def firmware_info(image):
    m = re.search(rb'DSP(206|408) V(\d{4}P?)', image)
    if not m:
        raise ValueError("ce fichier n'est pas un firmware de DSP 206 / 408")
    return m.group(1).decode(), f'DSP{m.group(1).decode()} V{m.group(2).decode()}'


class Unit:
    def __init__(self, firmware_path, state_dir=None):
        image = open(firmware_path, 'rb').read()
        self.model, self.version = firmware_info(image)
        self.program_words = dsp_program_words(image)
        self.eeprom = EEPROM(65536, 2, 64)    # 24C512 on I2C0, address 0x57: settings and presets
        self.program = EEPROM(65536, 2, 64)   # 0x53: the DSP chip program (header only)
        self.state_dir = state_dir
        self.eeprom_path = os.path.join(state_dir, 'eeprom.bin') if state_dir else None
        self.fresh = not (self.eeprom_path and os.path.exists(self.eeprom_path))
        if not self.fresh:
            self.eeprom.load(self.eeprom_path)
        self.out = bytearray()   # bytes sent by the firmware on UART1 (Ethernet module / RS-232)
        self.total = 0           # instructions run since power on, across resets
        self.resets = 0
        self.power_on(image)

    def power_on(self, flash):
        self.board = Board(flash)
        self.board.i2c0.slaves[0x57] = self.eeprom
        self.board.i2c0.slaves[0x53] = self.program
        self.board.provision(self.eeprom, self.program, serial=f'TRK0{self.model}E'.encode(),
                             program_words=self.program_words)
        self.board.uart_listeners.append(lambda u, x: self.out.append(x) if u is self.board.uart1 else None)

    # ------------------------------------------------------------------ time
    @property
    def instructions(self):
        return self.total

    def run(self, n, slice_=1000):
        start = self.board.cycles
        self.board.run(n, slice_)
        self.total += self.board.cycles - start
        if self.board.reset_requested:   # the firmware reset the chip: same flash, same EEPROMs
            self.resets += 1
            self.power_on(bytes(self.board.fw[:0x20000]))

    # ------------------------------------------------------------------ start
    def boot(self, progress=None):
        """Power on. Returns once the firmware has configured its Ethernet module and answers.
        A new unit initialises its memory itself on the first start, then resets."""
        reader, seen, start, resets = FrameReader(), False, self.total, self.resets
        while self.total - start < BOOT_LIMIT * (1 + self.resets - resets) and not seen:
            self.run(2_000_000, 5000)
            for kind, f in reader.push(self.out):
                seen = seen or (kind == 'frame' and f[5] == 0xBE)
            self.out.clear()
            if progress:
                progress(min((self.total - start) / BOOT_LIMIT, 1))
        if not seen:
            raise RuntimeError("le firmware n'a pas terminé son démarrage")
        self.request(0x10, limit=BOOT_LIMIT)   # answers once the start-up mute is over
        if self.fresh:
            self.leave_factory()
        self.send(0x11)                        # back to front-panel mode
        self.run(5_000_000)
        self.out.clear()

    def leave_factory(self):
        """What a unit has when it leaves the factory, beyond the firmware's own initialisation:
        the IP address given in the manual."""
        if bytes(self.eeprom.mem[EEPROM_IP:EEPROM_IP + 4]) == b'\xff' * 4:
            self.request(0x1A, bytes([EEPROM_IP, 0, 4, *FACTORY_IP]))
        self.fresh = False
        self.save()

    def save(self):
        if self.eeprom_path and self.eeprom.dirty:
            os.makedirs(self.state_dir, exist_ok=True)
            self.eeprom.save(self.eeprom_path)

    # ------------------------------------------------------------------ frames
    def send(self, cmd, data=b'', dst=1):
        self.board.uart1.rx.extend(frame(cmd, data, dst=dst))

    def request(self, cmd, data=b'', dst=1, limit=100_000_000):
        """Sends one frame and runs the firmware until it answers (frames for the Ethernet module
        are skipped). Returns the reply frames; raises TimeoutError if the firmware stays silent."""
        self.out.clear()
        self.send(cmd, data, dst)
        reader, start, replies = FrameReader(), self.instructions, []
        while self.instructions - start < limit:
            self.run(100_000)
            replies += [f for kind, f in reader.push(self.out) if kind == 'frame' and f[5] not in NETWORK_MODULE_CMDS]
            self.out.clear()
            if replies:
                self.run(200_000)  # a reply may come in several frames
                replies += [f for kind, f in reader.push(self.out) if kind == 'frame' and f[5] not in NETWORK_MODULE_CMDS]
                self.out.clear()
                return replies
        raise TimeoutError(f'pas de réponse du firmware à la commande 0x{cmd:02x}')

    def ip(self):
        ip = bytes(self.eeprom.mem[EEPROM_IP:EEPROM_IP + 4])
        return '.'.join(str(b) for b in ip)
