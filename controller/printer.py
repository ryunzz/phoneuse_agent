"""Direct serial link to the Prusa i3 MK2 (Marlin 1.0.2 fork) that carries the stylus.

After a power cycle, X and Y home on their switches, but Z has no endstop, so its height comes from a caliper reading:

    python3 -m controller.printer home-xy
    python3 -m controller.printer set-z 83.0      # measured bed-to-nozzle gap in mm
"""
import argparse
import re
import sys
import termios
import time

PORT = '/dev/serial/by-id/usb-Prusa_Research__prusa3d.com__Original_Prusa_i3_MK2_CZPX2617X003XC24904-if00'
# Z = bed-to-nozzle gap + this. Calipers read 83 mm from bed to nozzle at Z 80 (2026-10-24); every touch height in
# phone.json assumes it. A whole-mm reading leaves up to ~0.5 mm error, so check one tap after a power cycle.
Z_GAP_OFFSET = -3.0


class PrinterError(RuntimeError):
    pass


class Printer:
    """One long-lived connection. Opening the port can reset the board, which forgets homing."""

    def __init__(self, port=PORT, baud=115200, link=None, boot_wait=3.0):
        if link is None:
            import serial
            # exclusive: a second controller (e.g. one left behind by a dropped SSH session) fails instead of sharing.
            link = serial.Serial(port, baud, timeout=0.3, exclusive=True)
            # Keep DTR high on close so later opens don't reset the board (same as `stty -hupcl`).
            attrs = termios.tcgetattr(link.fileno())
            attrs[2] &= ~termios.HUPCL
            termios.tcsetattr(link.fileno(), termios.TCSANOW, attrs)
        self.link = link
        self.was_reset = self._wait_for_boot(boot_wait)
        # None: unknown (no reset seen, but this process didn't home); False: position lost; True: homed here.
        self.homed = False if self.was_reset else None

    def _wait_for_boot(self, seconds):
        # The bootloader can stay silent for over a second before `start`, so listen for the whole window.
        start, booted = time.time(), False
        while time.time() - start < seconds:
            line = self._readline()
            if line.startswith('start'):
                booted = True
            if booted and 'SD card' in line:
                break
        self.link.reset_input_buffer()
        return booted

    def _readline(self):
        return self.link.readline().decode(errors='replace').strip()

    def send(self, line, timeout=120):
        """Send one G-code line; return the reply lines before `ok`."""
        words = line.upper().split()
        # The PINDA probe is gone: any Z homing drives the head into the bed.
        if words and words[0] == 'G28' and (len(words) == 1 or any(w.startswith('Z') for w in words[1:])):
            raise PrinterError('Z homing disabled (no PINDA probe). Use home_xy() and calibrate Z with the camera.')
        self.link.write((line + '\n').encode())
        reply, deadline = [], time.time() + timeout
        while time.time() < deadline:
            text = self._readline()
            if not text:
                continue
            if text.startswith('start'):
                self.homed = False
                raise PrinterError(f'{line}: board reset mid-session; position lost, re-home X/Y')
            if text.startswith('Error') or text.startswith('!!'):
                raise PrinterError(f'{line}: {text}')
            if text.startswith('ok'):
                if len(text) > 2:
                    reply.append(text)
                return reply
            reply.append(text)
        raise PrinterError(f'{line}: no ok within {timeout}s; state unknown')

    def wait(self):
        self.send('M400')

    def position(self):
        self.wait()
        for text in self.send('M114'):
            if text.startswith('X:'):
                return parse_position(text)
        raise PrinterError('M114 returned no position')

    def endstops(self):
        return parse_endstops(self.send('M119'))

    def keep_motors_on(self):
        """Disable the idle timeout; unpowered steppers can be pushed and silently lose position."""
        self.send('M84 S0')

    def home_xy(self, lift=3):
        """Lift Z a little (relative) so the stylus clears the surface, then home X and Y on their switches."""
        if lift:
            self.send('G91')
            self.send(f'G1 Z{lift} F300')
            self.send('G90')
        self.send('G28 X Y', timeout=90)
        self.wait()
        self.homed = True

    def move(self, x=None, y=None, z=None, feed=3000, wait=True):
        if self.homed is False:
            raise PrinterError('Board was reset, so its coordinates are meaningless. Call home_xy() first.')
        axes = ''.join(f' {k}{v:.3f}' for k, v in (('X', x), ('Y', y), ('Z', z)) if v is not None)
        if axes:
            self.send('G90')
            self.send(f'G1{axes} F{feed}')
        if wait:
            self.wait()

    def set_z(self, z):
        """Declare the head's current height (G92) without moving it."""
        self.send(f'G92 Z{z:.3f}')

    def close(self):
        self.link.close()


def parse_position(text):
    values = re.findall(r'([XYZE]):\s*(-?[\d.]+)', text)[:4]
    return {axis: float(value) for axis, value in values}


def parse_endstops(lines):
    return {k.strip(): v.strip() for k, v in (l.split(':', 1) for l in lines if ':' in l and '_m' in l.split(':', 1)[0])}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('home-xy')
    s = sub.add_parser('set-z')
    s.add_argument('gap', type=float, help='bed-to-nozzle gap in mm, from calipers')
    sub.add_parser('where')
    args = parser.parse_args(argv)
    printer = Printer()
    printer.keep_motors_on()
    if args.command == 'home-xy':
        printer.home_xy()
    elif args.command == 'set-z':
        printer.set_z(args.gap + Z_GAP_OFFSET)
    print(printer.position())
    return 0


if __name__ == '__main__':
    sys.exit(main())
