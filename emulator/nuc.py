"""Virtual Nuvoton NUC1xx board (ARM Cortex-M0) that runs the official t.racks DSP 206 / 408 firmware.

Written from scratch for t.racks Studio (MIT). Only what the firmware touches is modelled: system and
clock control, GPIO (the DSP chip is bit-banged on PB6-PB8), timers, the three UARTs (UART1 = the
Ethernet module and RS-232 connector, UART0 = RS-485), I2C0 with the preset EEPROM (0x57), SPI,
the flash controller (FMC) and the Cortex-M0 system block (NVIC, SysTick).

The firmware itself is never part of this repository: fetch_firmware.py downloads the official
Thomann updater and extracts it on your machine.
"""
import collections, copy, os, struct
from unicorn import *
from unicorn.arm_const import *

HCLK = 48_000_000
EXC_RETURN_PAGE = 0xFFFFF000

class Periph:
    def __init__(self, emu, base, name):
        self.emu, self.base, self.name = emu, base, name
        self.r = collections.defaultdict(int)
    def read(self, off, size): return self.r[off]
    def write(self, off, size, val): self.r[off] = val
    def tick(self, cycles): pass
    def irq_pending(self): return False

class GCR(Periph):
    def __init__(s, emu):
        super().__init__(emu, 0x50000000, 'GCR'); s.seq = []; s.unlocked = 0
        s.r[0x00] = 0x00012005  # PDID (NUC120RD2BN-ish)
        s.r[0x04] = 0x00000001  # RSTSRC POR
    def read(s, off, size):
        if off == 0x100: return s.unlocked
        return s.r[off]
    def write(s, off, size, val):
        if off == 0x100:
            s.seq = (s.seq + [val])[-3:]
            if s.seq == [0x59, 0x16, 0x88]: s.unlocked = 1
            elif val == 0: s.unlocked = 0
            return
        if off == 0x08 and val & 3 and s.unlocked:  # IPRSTC1: CHIP_RST / CPU_RST
            s.emu.reset_requested = True
        s.r[off] = val

class CLK(Periph):
    def __init__(s, emu): super().__init__(emu, 0x50000200, 'CLK')
    def read(s, off, size):
        if off == 0x0C: return 0x1F
        return s.r[off]

class GPIO(Periph):
    def __init__(s, emu):
        super().__init__(emu, 0x50004000, 'GPIO')
        s.inputs = [0xFFFF]*5  # external levels (pull-ups)
    def port_pin(s, p):
        dout = s.r[p*0x40+0x08] if (p*0x40+0x08) in s.r else 0xFFFF
        pmd = s.r[p*0x40+0x00]
        val = 0
        for b in range(16):
            mode = (pmd >> (2*b)) & 3
            bit = (dout >> b) & 1 if mode in (1, 3) else (s.inputs[p] >> b) & 1
            val |= bit << b
        return val
    def read(s, off, size):
        if off < 0x140 and (off & 0x3F) == 0x10:
            return s.port_pin(off // 0x40)
        if 0x200 <= off < 0x340:  # bit band PIN data
            p, b = (off - 0x200) // 0x40, ((off - 0x200) % 0x40) // 4
            return (s.port_pin(p) >> b) & 1
        if off < 0x140 and (off & 0x3F) == 0x08 and off not in s.r: return 0xFFFF
        return s.r[off]
    def write(s, off, size, val):
        if 0x200 <= off < 0x340:
            p, b = (off - 0x200) // 0x40, ((off - 0x200) % 0x40) // 4
            k = p*0x40+0x08
            cur = s.r[k] if k in s.r else 0xFFFF
            cur = (cur & ~(1 << b)) | ((val & 1) << b)
            s.r[k] = cur
            s.emu.on_gpio(p, b, val & 1)
            return
        if off < 0x140 and (off & 0x3F) == 0x08:
            old = s.r[off] if off in s.r else 0xFFFF
            s.r[off] = val
            for b in range(16):
                if ((old ^ val) >> b) & 1: s.emu.on_gpio(off//0x40, b, (val >> b) & 1)
            return
        s.r[off] = val

class Timer(Periph):
    # TMR0 base+0x00, TMR1 base+0x20
    def __init__(s, emu, base, name, irqs):
        super().__init__(emu, base, name); s.irqs = irqs; s.acc = [0, 0]; s.cnt = [0, 0]
    def read(s, off, size):
        t, o = off // 0x20, off % 0x20
        if o == 0x0C: return s.cnt[t]
        return s.r[off]
    def write(s, off, size, val):
        t, o = off // 0x20, off % 0x20
        if o == 0x08:  # TISR write-1-clear
            s.r[off] &= ~val; return
        if o == 0x00 and (val >> 26) & 1: s.cnt[t] = 0; val &= ~(1 << 26)
        s.r[off] = val
    def tick(s, cycles):
        for t in range(2):
            csr = s.r[t*0x20]
            if not (csr >> 30) & 1: continue
            cmp_ = s.r[t*0x20+4] or 1
            pre = (csr & 0xFF) + 1
            # assume timer clock 12 MHz external crystal
            ticks = cycles * 12_000_000 / HCLK / pre
            s.acc[t] += ticks
            while s.acc[t] >= 1:
                n = int(s.acc[t]); s.acc[t] -= n
                s.cnt[t] += n
                if s.cnt[t] >= cmp_:
                    s.r[t*0x20+8] |= 1
                    mode = (csr >> 27) & 3
                    s.cnt[t] = 0 if mode != 3 else s.cnt[t]
                    if mode == 0: s.r[t*0x20] &= ~(1 << 30)
    def irq_lines(s):
        out = []
        for t in range(2):
            if (s.r[t*0x20+8] & 1) and (s.r[t*0x20] >> 29) & 1: out.append(s.irqs[t])
        return out

class UART(Periph):
    def __init__(s, emu, base, name, irq):
        super().__init__(emu, base, name); s.irq = irq; s.rx = collections.deque(); s.tx = bytearray(); s.name = name
        s.tout = 0
    def fsr(s):
        n = len(s.rx)
        v = (min(n, 63) << 8) | (1 << 22) | (1 << 28)
        if n == 0: v |= 1 << 14
        if n >= 64: v |= 1 << 15
        return v
    def isr(s):
        ier = s.r[0x04]
        rda = 1 if s.rx else 0
        thre = 1
        tout = 1 if (s.rx and s.tout > 0) else 0
        v = rda | (thre << 1) | (tout << 4)
        if rda and ier & 1: v |= 1 << 8
        if thre and ier & 2: v |= 1 << 9
        if tout and ier & (1 << 4): v |= 1 << 12
        return v
    def read(s, off, size):
        if off == 0x00:
            if s.rx:
                b = s.rx.popleft(); return b
            return 0
        if off == 0x18: return s.fsr()
        if off == 0x1C: return s.isr()
        return s.r[off]
    def write(s, off, size, val):
        if off == 0x00:
            s.tx.append(val & 0xFF); s.emu.on_uart_tx(s, val & 0xFF); return
        if off == 0x08:  # FCR: reset bits
            if val & 2: s.rx.clear()
            s.r[off] = val & ~6; return
        if off == 0x18: s.r[off] = 0; return
        s.r[off] = val
    def tick(s, cycles):
        if s.rx: s.tout += cycles
        else: s.tout = 0
    def irq_lines(s):
        return [s.irq] if (s.isr() & 0x3F00) else []

class I2C(Periph):
    """Nuvoton I2C master; actions start when SI is cleared (or STA on an idle bus) and complete
    after the firmware polls I2CON twice, mimicking the real bus latency."""
    SI, AA, STO, STA, EI = 1 << 3, 1 << 2, 1 << 4, 1 << 5, 1 << 7
    def __init__(s, emu, base, name, irq):
        super().__init__(emu, base, name); s.irq = irq; s.status = 0xF8; s.slaves = {}
        s.cur = None; s.rw = 0; s.started = False; s.first = False; s.log = []
        s.si = 0; s.pend = False; s.reads = 0
    def read(s, off, size):
        if off == 0x00:
            if s.pend:
                s.reads += 1
                if s.reads >= 2: s.si = 1; s.pend = False
            return (s.r[0] & ~s.SI) | (s.SI if s.si else 0)
        if off == 0x0C: return s.status
        return s.r[off]
    def write(s, off, size, val):
        if off != 0x00:
            s.r[off] = val; return
        sta, sto, siw, aa = val & s.STA, val & s.STO, val & s.SI, val & s.AA
        s.r[0] = val & ~(s.SI | s.STO)
        trigger = (s.si and siw) or (sta and not s.started)
        if not trigger: return
        s.si = 0; s.reads = 0; s.pend = True
        if sto:
            if s.cur is not None: s.cur.stop()
            s.cur = None; s.started = False; s.status = 0xF8
            if not sta:
                s.pend = False; return
        if sta:
            s.status = 0x10 if s.started else 0x08
            s.started = True; s.first = True
            return
        if s.first:
            s.first = False
            d = s.r[0x08]; addr, s.rw = d >> 1, d & 1
            sl = s.slaves.get(addr)
            s.log.append(('addr', hex(addr), s.rw))
            if sl is None:
                s.status = 0x48 if s.rw else 0x20; s.cur = None
            else:
                s.cur = sl; sl.start(s.rw); s.status = 0x40 if s.rw else 0x18
        elif s.rw == 0:
            if s.cur is not None: s.cur.write(s.r[0x08] & 0xFF); s.status = 0x28
            else: s.status = 0x30
        else:
            s.r[0x08] = (s.cur.read() & 0xFF) if s.cur is not None else 0xFF
            s.status = 0x50 if aa else 0x58
    def irq_lines(s):
        return [s.irq] if s.si and (s.r[0] & s.EI) else []

class EEPROM:
    """I2C serial EEPROM (24C512 style: 2 address bytes, 64-byte pages). Writes are instantaneous;
    `dirty` tells the owner that the content changed since the last save()."""
    def __init__(s, size=32768, addr_bytes=2, page=64):
        s.mem = bytearray([0xFF]*size); s.size = size; s.ab = addr_bytes; s.ptr = 0; s.page = page
        s.wcount = 0; s.dirty = False; s.rw = 0
    def load(s, path):
        data = open(path, 'rb').read()
        s.mem[:] = data[:s.size].ljust(s.size, b'\xff'); s.dirty = False
    def save(s, path):
        tmp = path + '.tmp'
        with open(tmp, 'wb') as f: f.write(s.mem)
        os.replace(tmp, path); s.dirty = False
    def start(s, rw):
        s.rw = rw; s.wcount = 0
    def write(s, b):
        if s.wcount < s.ab:
            s.ptr = (((s.ptr << 8) | b) & ((1 << (8 * s.ab)) - 1)) if s.wcount else b
            s.wcount += 1
        else:
            s.mem[s.ptr % s.size] = b; s.dirty = True
            s.ptr = (s.ptr & ~(s.page-1)) | ((s.ptr + 1) & (s.page-1))
    def read(s):
        v = s.mem[s.ptr % s.size]; s.ptr = (s.ptr + 1) % s.size; return v
    def stop(s): pass

class SPI(Periph):
    def __init__(s, emu, base, name, irq):
        super().__init__(emu, base, name); s.irq = irq; s.dev = None; s.log = collections.deque(maxlen=200000)
    def read(s, off, size):
        if off == 0x00: return s.r[0] & ~1
        return s.r[off]
    def write(s, off, size, val):
        s.r[off] = val
        if off == 0x00 and (val & 1):
            # transfer: TX0 -> RX0
            bits = (val >> 3) & 0x1F or 32
            tx = s.r[0x20]
            rx = s.dev(tx, bits, s.r[0x08]) if s.dev else 0
            s.r[0x10] = rx
            s.log.append((s.r[0x08], bits, tx))
            s.r[0] = (val & ~1) | (1 << 16)  # IF
            s.emu.on_spi(s, tx, bits)
        elif off == 0x08:
            s.emu.on_spi_ss(s, val)
    def irq_lines(s):
        return [s.irq] if (s.r[0] & (1 << 16)) and (s.r[0] & (1 << 17)) else []

class DspChip:
    """The audio DSP on SPI1, as far as the firmware needs it. It takes the program streamed at
    boot and the parameter words without answering, and answers a level read-out (command word
    0xC837xxxx, then dummy words) with the sync word 0xC93636C9 followed by levels at zero
    (silence): the firmware polls for that sync word before reading the meters."""
    SYNC = 0xC93636C9
    def __init__(s):
        s.mode = 'idle'; s.queue = collections.deque()
    def __call__(s, tx, bits, ssr):
        if tx == 0:
            if s.mode == 'cmd':
                s.mode = 'data'; s.queue = collections.deque([s.SYNC] + [0] * 64)
            if s.mode == 'data':
                return s.queue.popleft() if s.queue else 0
            return 0
        if (tx >> 16) == 0xC837: s.mode = 'cmd'
        elif s.mode == 'data': s.mode = 'idle'
        return 0

class FMC(Periph):
    def __init__(s, emu):
        super().__init__(emu, 0x5000C000, 'FMC'); s.flash = emu  # access emu flash
    def write(s, off, size, val):
        s.r[off] = val
        if off == 0x10 and (val & 1):
            cmd, adr = s.r[0x0C], s.r[0x04]
            e = s.emu
            if cmd == 0x00: s.r[0x08] = e.flash_read32(adr)
            elif cmd == 0x21: e.flash_write32(adr, s.r[0x08])
            elif cmd == 0x22: e.flash_erase(adr)
            elif cmd == 0x0B: s.r[0x08] = 0x000000DA  # CID Nuvoton
            elif cmd == 0x0C: s.r[0x08] = 0x00012005
            elif cmd == 0x04: s.r[0x08] = e.uid[(adr >> 2) % 3]  # unique ID
            s.r[0x10] = 0
            e.log_fmc(cmd, adr, s.r[0x08])

class USBD(Periph):
    def __init__(s, emu): super().__init__(emu, 0x40060000, 'USBD')

class SCS(Periph):
    def __init__(s, emu):
        super().__init__(emu, 0xE000E000, 'SCS'); s.iser = 0; s.ispr = 0; s.st_acc = 0
        s.r[0xD00] = 0x410CC200
    def read(s, off, size):
        if off == 0x100: return s.iser
        if off == 0x180: return s.iser
        if off == 0x200 or off == 0x280: return s.ispr
        if off == 0x010:
            v = s.r[0x10]; s.r[0x10] &= ~(1 << 16); return v
        return s.r[off]
    def write(s, off, size, val):
        if off == 0x100: s.iser |= val; return
        if off == 0x180: s.iser &= ~val; return
        if off == 0x200: s.ispr |= val; return
        if off == 0x280: s.ispr &= ~val; return
        if off == 0xD04:  # ICSR
            if val & (1 << 26): s.emu.pend_exc(15)
            if val & (1 << 28): s.emu.pend_exc(14)
            return
        if off == 0xD0C and (val >> 16) == 0x05FA and (val & 4):
            s.emu.reset_requested = True
        if off == 0x018: s.r[0x18] = 0; return
        s.r[off] = val
    def tick(s, cycles):
        csr = s.r[0x10]
        if csr & 1:
            rvr = (s.r[0x14] & 0xFFFFFF) + 1
            div = 1 if csr & 4 else 4  # external ref clock assumed HCLK/4? approximate
            s.st_acc += cycles / div
            while s.st_acc >= rvr:
                s.st_acc -= rvr
                s.r[0x10] |= 1 << 16
                if csr & 2: s.emu.pend_exc(15)

IRQ_NAMES = {0:'BOD',1:'WDT',2:'EINT0',3:'EINT1',4:'GPAB',5:'GPCDE',6:'PWMA',7:'PWMB',8:'TMR0',9:'TMR1',10:'TMR2',11:'TMR3',12:'UART02',13:'UART1',14:'SPI0',15:'SPI1',16:'SPI2',17:'SPI3',18:'I2C0',19:'I2C1',23:'USBD',26:'PDMA',27:'I2S',29:'ADC',31:'RTC'}

class Board:
    def __init__(s, fw, verbose=False, unknown_log=True):
        s.fw = bytearray(fw.ljust(0x20000, b'\xff'))
        s.verbose = verbose
        s.uc = uc = Uc(UC_ARCH_ARM, UC_MODE_THUMB | UC_MODE_MCLASS)
        uc.ctl_set_cpu_model(UC_CPU_ARM_CORTEX_M0) if hasattr(uc, 'ctl_set_cpu_model') else None
        uc.mem_map(0, 0x20000); uc.mem_write(0, bytes(s.fw))
        uc.mem_map(0x20000000, 0x10000)
        uc.mem_map(EXC_RETURN_PAGE, 0x1000)
        uc.hook_add(UC_HOOK_CODE, s._exc_ret_hook, begin=EXC_RETURN_PAGE, end=EXC_RETURN_PAGE+0xFFF)
        s.reset_requested = False
        s.gcr = GCR(s); s.clk = CLK(s); s.gpio = GPIO(s)
        s.tmr01 = Timer(s, 0x40010000, 'TMR01', (8, 9)); s.tmr23 = Timer(s, 0x40110000, 'TMR23', (10, 11))
        s.uart0 = UART(s, 0x40050000, 'UART0', 12); s.uart1 = UART(s, 0x40150000, 'UART1', 13); s.uart2 = UART(s, 0x40154000, 'UART2', 12)
        s.i2c0 = I2C(s, 0x40020000, 'I2C0', 18); s.i2c1 = I2C(s, 0x40120000, 'I2C1', 19)
        s.spi = [SPI(s, b, n, i) for b, n, i in ((0x40030000,'SPI0',14),(0x40034000,'SPI1',15),(0x40130000,'SPI2',16),(0x40134000,'SPI3',17))]
        s.spi[1].dev = DspChip()
        s.fmc = FMC(s); s.usbd = USBD(s); s.scs = SCS(s)
        s.periphs = [s.gcr, s.clk, s.gpio, s.tmr01, s.tmr23, s.uart0, s.uart1, s.uart2, s.i2c0, s.i2c1, *s.spi, s.fmc, s.usbd, s.scs]
        s.cache = {}
        s.gcr.size = 0x200; s.clk.size = 0x100
        s.unknown = collections.Counter()
        s.mmio_log = collections.deque(maxlen=400)
        s.uc.mmio_map(0x40000000, 0x200000, s._rd, 0x40000000, s._wr, 0x40000000)
        s.uc.mmio_map(0x50000000, 0x20000, s._rd, 0x50000000, s._wr, 0x50000000)
        s.uc.mmio_map(0xE0000000, 0x100000, s._rd, 0xE0000000, s._wr, 0xE0000000)
        s.pending_exc = set(); s.active = []
        s.cycles = 0
        sp, rst = struct.unpack_from('<II', s.fw, 0)
        uc.reg_write(UC_ARM_REG_SP, sp); s.pc = rst
        s.uart_listeners = []
        s.gpio_listeners = []
        s.spi_listeners = []
        s.fmc_log = []
        s.uid = (0x4A1B2C3D, 0x5E6F7081, 0x92A3B4C5)
    def provision(s, ee57, ee53=None, serial=b'TRK0408E', program_words=0x180A):
        """Virtual factory data, what the firmware checks before starting:
        - a block keyed to the chip's unique id at flash 0x10E00, and the matching serial in the
          0x57 EEPROM at 0x7FF7;
        - the header of the DSP chip program in the 0x53 EEPROM (address 0x40): its length in
          words, XOR the key derived from the unique id. The firmware streams the program to the
          DSP chip over SPI1 and only then restores the last settings (the live config mirrored
          in the 0x57 EEPROM). The program body itself is not needed: the audio chip is not
          emulated."""
        w0, w1, w2 = s.uid
        K = struct.pack('>II', w1, w2 ^ w0); E = bytes(serial[:8]).ljust(8, b'\0')
        blk = bytearray(0x200); blk[0] = blk[1] = blk[2] = 0
        for i in range(31):
            for j in range(8):
                blk[5 + i*16 + j] = K[j] ^ i
                blk[0xD + i*16 + j] = E[j] ^ i
        cs = sum(blk[5:0x1F5]) & 0xFFFF
        blk[3], blk[4] = cs >> 8, cs & 0xFF
        s.fw[0x10E00:0x11000] = blk; s.uc.mem_write(0x10E00, bytes(blk))
        ee57.mem[0x7FF7:0x7FFF] = E
        if ee53 is not None:
            key = w0 ^ w1 ^ w2
            ee53.mem[0x40:0x44] = (key ^ (program_words << 18)).to_bytes(4, 'big')

    # ---- snapshot / restore (in-memory) ----
    _SKIP = ('emu', 'flash', 'dev', 'slaves', 'cur')
    def snapshot(s, extra=()):

        snap = {'ctx': s.uc.context_save(), 'ram': bytes(s.uc.mem_read(0x20000000, 0x10000)), 'fw': bytes(s.fw),
                'pc': s.pc, 'pending': set(s.pending_exc), 'active': list(s.active), 'cycles': s.cycles, 'per': {}, 'extra': []}
        for p in s.periphs:
            snap['per'][id(p)] = {k: copy.deepcopy(v) for k, v in p.__dict__.items() if k not in s._SKIP}
            if hasattr(p, 'cur'): snap['per'][id(p)]['cur'] = p.cur
        for o in extra:
            snap['extra'].append((o, copy.deepcopy(o.__dict__)))
        return snap
    def restore(s, snap):

        s.uc.context_restore(snap['ctx'])
        s.uc.mem_write(0x20000000, snap['ram'])
        s.fw[:] = snap['fw']; s.uc.mem_write(0, bytes(s.fw[:0x20000]))
        s.pc = snap['pc']; s.pending_exc = set(snap['pending']); s.active = list(snap['active']); s.cycles = snap['cycles']
        for p in s.periphs:
            for k, v in snap['per'][id(p)].items(): setattr(p, k, copy.deepcopy(v) if k != 'cur' else v)
        for o, d in snap['extra']:
            o.__dict__.update(copy.deepcopy(d))
    # flash helpers
    def flash_read32(s, a): return struct.unpack_from('<I', s.fw, a % 0x20000)[0]
    def flash_write32(s, a, v):
        a %= 0x20000; old = s.flash_read32(a); v &= old
        struct.pack_into('<I', s.fw, a, v); s.uc.mem_write(a, struct.pack('<I', v))
    def flash_erase(s, a):
        a = (a % 0x20000) & ~0x1FF
        s.fw[a:a+512] = b'\xff'*512; s.uc.mem_write(a, b'\xff'*512)
    def log_fmc(s, cmd, adr, dat): s.fmc_log.append((hex(cmd), hex(adr), hex(dat)))
    def _find(s, addr):
        p = s.cache.get(addr)
        if p is not None or addr in s.cache: return p
        best = None
        for q in s.periphs:
            if q.base <= addr < q.base + getattr(q, 'size', 0x1000):
                if best is None or q.base > best.base: best = q
        s.cache[addr] = best
        return best
    def _rd(s, uc, off, size, base):
        a = base + off
        p = s._find(a)
        if p is None:
            s.unknown[('R', hex(a))] += 1; return 0
        v = p.read(a - p.base, size)
        if s.verbose: s.mmio_log.append(('R', p.name, hex(a - p.base), hex(v), hex(uc.reg_read(UC_ARM_REG_PC))))
        return v & 0xFFFFFFFF
    def _wr(s, uc, off, size, val, base):
        a = base + off
        p = s._find(a)
        if p is None:
            s.unknown[('W', hex(a))] += 1; return
        if s.verbose: s.mmio_log.append(('W', p.name, hex(a - p.base), hex(val), hex(uc.reg_read(UC_ARM_REG_PC))))
        p.write(a - p.base, size, val)
    # events
    def on_uart_tx(s, u, b):
        for f in s.uart_listeners: f(u, b)
    def on_gpio(s, port, pin, val):
        for f in s.gpio_listeners: f(port, pin, val)
    def on_spi(s, spi, tx, bits):
        for f in s.spi_listeners: f(spi, tx, bits)
    def on_spi_ss(s, spi, val): pass
    # exceptions
    def pend_exc(s, n): s.pending_exc.add(n)
    def _prio(s, n):
        if n == 15: return (s.scs.r[0xD20] >> 30) & 3
        if n == 14: return (s.scs.r[0xD20] >> 22) & 3
        if n >= 16:
            irq = n - 16; w = s.scs.r[0x400 + (irq // 4) * 4]
            return (w >> (8 * (irq % 4) + 6)) & 3
        return -1
    def _collect(s):
        for p in (s.tmr01, s.tmr23, s.uart0, s.uart1, s.uart2, s.i2c0, s.i2c1, *s.spi):
            for irq in p.irq_lines():
                s.scs.ispr |= 1 << irq
        for irq in range(32):
            if (s.scs.ispr >> irq) & 1 and (s.scs.iser >> irq) & 1:
                s.pending_exc.add(16 + irq)
    def _exc_ret_hook(s, uc, addr, size, ud):
        uc.emu_stop()
    def _take(s, n):
        uc = s.uc
        sp = uc.reg_read(UC_ARM_REG_SP)
        xpsr = uc.reg_read(UC_ARM_REG_XPSR)
        pc = s.pc
        frame_align = sp & 4
        sp = (sp - 32 - frame_align) & 0xFFFFFFFF
        regs = [uc.reg_read(r) for r in (UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3, UC_ARM_REG_R12, UC_ARM_REG_LR)]
        xpsr_saved = (xpsr & ~0x3FF & ~(1 << 9)) | (1 << 24) | ((1 << 9) if frame_align else 0) | (s.active[-1] if s.active else 0)
        uc.mem_write(sp, struct.pack('<8I', *regs, pc & ~1, xpsr_saved))
        uc.reg_write(UC_ARM_REG_SP, sp)
        uc.reg_write(UC_ARM_REG_LR, 0xFFFFFFF9)
        vec = s.flash_read32(n * 4)
        s.active.append(n)
        s.pc = vec | 1
        if n >= 16:
            s.scs.ispr &= ~(1 << (n - 16))
    def _return(s):
        uc = s.uc
        sp = uc.reg_read(UC_ARM_REG_SP)
        r0, r1, r2, r3, r12, lr, pc, xpsr = struct.unpack('<8I', uc.mem_read(sp, 32))
        sp += 32
        if xpsr & (1 << 9): sp += 4
        for r, v in zip((UC_ARM_REG_R0, UC_ARM_REG_R1, UC_ARM_REG_R2, UC_ARM_REG_R3, UC_ARM_REG_R12, UC_ARM_REG_LR), (r0, r1, r2, r3, r12, lr)):
            uc.reg_write(r, v)
        uc.reg_write(UC_ARM_REG_SP, sp)
        uc.reg_write(UC_ARM_REG_XPSR, (xpsr & 0xF8000000) | (1 << 24))
        s.active.pop()
        s.pc = pc | 1
    def step(s, n=2000):
        uc = s.uc
        try:
            uc.emu_start(s.pc, 0xFFFFFFFF, count=n)
        except UcError as e:
            pc = uc.reg_read(UC_ARM_REG_PC)
            if (pc & 0xFFFFF000) != EXC_RETURN_PAGE:
                raise RuntimeError(f'CPU error {e} at pc={pc:#x}')
        pc = uc.reg_read(UC_ARM_REG_PC)
        s.cycles += n
        if (pc & 0xFFFFF000) == EXC_RETURN_PAGE:
            s.pc = pc
            s._return()
        else:
            s.pc = pc | 1
        for p in s.periphs: p.tick(n)
        s._collect()
        if s.pending_exc and not (uc.reg_read(UC_ARM_REG_PRIMASK) & 1):
            cur = s._prio(s.active[-1]) if s.active else 99
            best = min(s.pending_exc, key=lambda e: (s._prio(e), e))
            if s._prio(best) < cur:
                s.pending_exc.discard(best)
                s._take(best)
    def run(s, cycles, slice_=1000):
        """Runs `cycles` instructions, or until the firmware asks for a reset (reset_requested:
        the owner then powers a new Board on with the same flash and EEPROMs)."""
        end = s.cycles + cycles
        while s.cycles < end and not s.reset_requested:
            s.step(slice_)
