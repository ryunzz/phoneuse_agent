"""Claude's phone actions on the stylus: the `stylus` backend of rig_agent.py.

The Mac that runs rig_agent.py sees the phone through iPhone Mirroring; the Linux machine wired to the printer moves
the stylus. rig_agent turns each action into screen fractions with `gesture()` and sends it, one JSON line at a time,
to this module's `serve` command on the printer machine, usually over SSH:

    STYLUS_COMMAND="ssh -o ServerAliveInterval=15 rig@printer-box 'cd phoneuse_agent && python3 -m controller.rig serve'" \\
        RIG_TOKEN=rig_... uv run rig_agent.py --backend stylus
    python3 -m controller.rig serve --dry-run     # print the G-code instead of opening the serial port

Keep one serve process running: reopening the serial port can reset the board, and a reset board refuses to move
until X/Y are homed again. Nothing here retries; after an error or timeout the outcome on the phone is unknown.
"""
import argparse
import json
import math
import os
import queue
import signal
import subprocess
import sys
import threading
import time

# The phone screen inside a Mirroring capture (left, top, right, bottom as fractions of the image), measured on the
# 636 x 1402 captures of this iPhone. Everything outside it is window chrome.
MIRRORING = (16 / 636, 76 / 1402, 620 / 636, 1386 / 1402)
MIRRORING_ASPECT = 636 / 1402
MIRRORING_SOURCE = 'iPhone Mirroring window'
SHORTEST_DRAG, LONGEST_DRAG = 0.1, 0.6   # screen heights; shorter drags read as taps on this rubber tip
EDGE_MARGIN = 0.05                        # screen fraction kept clear of the bezel
REACH_PAD_MM = 4.0                        # room for the swipe's lead-in and follow-through


def gesture(action, frame):
    """A validated rig action (episodes.action_payload) as a gesture in fractions of the phone screen."""
    kind = action['type']
    if kind == 'home':
        return {'gesture': 'home'}
    if kind == 'type':
        raise ValueError('The stylus rig cannot type yet (no keyboard map). Tap the on-screen keys one at a time.')
    if kind not in ('tap', 'scroll'):
        raise ValueError(f'Unsupported stylus action {kind}')
    if not frame or frame.get('source') != MIRRORING_SOURCE:
        raise ValueError('Stylus actions need an iPhone Mirroring frame; camera frames have no screen calibration yet')
    if abs(frame['width'] / frame['height'] - MIRRORING_ASPECT) > 0.02:
        raise ValueError(f"Mirroring frame is {frame['width']} x {frame['height']}; the screen rectangle was measured on "
                         'portrait 636 x 1402 captures. Re-measure MIRRORING in controller/rig.py for this window')
    left, top, right, bottom = MIRRORING
    fx, fy = (action['x'] - left) / (right - left), (action['y'] - top) / (bottom - top)
    if not (0 <= fx <= 1 and 0 <= fy <= 1):
        raise ValueError(f"({action['x']:.3f}, {action['y']:.3f}) is on the Mirroring window frame, not the phone screen")
    if kind == 'tap':
        return {'gesture': 'tap', 'x': fx, 'y': fy}
    # dy is in screenshot pixels, signed like the content's motion, so the finger moves the same way.
    return {'gesture': 'scroll', 'x': fx, 'y': fy, 'dy': action['dy'] / frame['height'] / (bottom - top)}


FIELDS = {'tap': {'x', 'y'}, 'scroll': {'x', 'y', 'dy'}, 'home': set(), 'status': set()}


def checked(message):
    if not isinstance(message, dict) or message.get('gesture') not in FIELDS:
        raise ValueError('Expected {"gesture": "tap" | "scroll" | "home" | "status", ...}')
    kind = message['gesture']
    if set(message) != FIELDS[kind] | {'gesture'}:
        raise ValueError(f'{kind} takes exactly {sorted(FIELDS[kind])}')
    for key in FIELDS[kind]:
        value = message[key]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError(f'{key} must be a finite number')
        if key in ('x', 'y') and not 0 <= value <= 1:
            raise ValueError(f'{key} must be a screen fraction between 0 and 1')
    if kind == 'scroll' and message['dy'] == 0:
        raise ValueError('scroll needs a nonzero dy')
    return message


class Rig:
    """Runs gestures on the printer through controller.tasks.Screen (calibrated by controller/phone.json)."""

    def __init__(self, screen, printer):
        self.screen, self.printer = screen, printer
        self.dry_run = isinstance(printer, DryPrinter)

    def run(self, message):
        kind = checked(message)['gesture']
        if kind == 'status':
            width, height = self.screen.phone.size
            return {'dry_run': self.dry_run, 'homed': self.printer.homed, 'phone_mm': [round(width, 1), round(height, 1)]}
        start = len(self.printer.written) if self.dry_run else 0
        if kind == 'tap':
            x, y = message['x'], message['y']
            self.screen.tap(x, y, 'claude')
            receipt = {'gesture': 'tap', 'screen': [x, y], 'printer_mm': [round(v, 3) for v in self.screen.phone.point(x, y)]}
        elif kind == 'scroll':
            x, (y0, y1) = message['x'], self.fit_drag(message['x'], message['y'], message['dy'])
            self.screen.swipe(x, y0, x, y1, 'scroll')
            receipt = {'gesture': 'scroll', 'screen': [[x, y0], [x, y1]]}
        else:
            from controller.tasks import ASSISTIVE_TOUCH, MENU
            # Two blind taps: if the menu was already open, the first closes it and the second lands in the app.
            self.screen.tap(*ASSISTIVE_TOUCH, 'assistive touch')
            try:
                self.screen.tap(*MENU['home'], 'home')
            except Exception as error:
                raise type(error)(f'{error} (after opening the AssistiveTouch menu; it may still be open)') from error
            receipt = {'gesture': 'home', 'via': 'AssistiveTouch menu'}
        receipt['physical_outcome_verified'] = False
        if self.dry_run:
            receipt['gcode'] = self.printer.written[start:]
        return receipt

    def fit_drag(self, x, y, dy):
        """Vertical drag of a clamped length, slid along the screen until both ends are on the glass and in reach.
        For a scroll the distance matters more than exactly where the finger starts."""
        phone = self.screen.phone
        length = math.copysign(min(max(abs(dy), SHORTEST_DRAG), LONGEST_DRAG), dy)
        reach = [i / 200 for i in range(201) if phone.reachable(x, i / 200)]
        if not reach:
            raise ValueError(f'column x={x:.3f} of the screen is outside the printer\'s reach; move the phone')
        pad = REACH_PAD_MM / phone.size[1]
        low, high = max(EDGE_MARGIN, reach[0] + pad), min(1 - EDGE_MARGIN, reach[-1] - pad)
        if high - low < abs(length):
            raise ValueError(f'a {abs(length):.2f}-screen drag does not fit in the printer\'s reach at x={x:.3f}')
        y0, y1 = y, y + length
        shift = max(low - min(y0, y1), 0) - max(max(y0, y1) - high, 0)
        return y0 + shift, y1 + shift


class DryPrinter:
    """controller.printer.Printer's interface without a serial port: records the G-code a gesture would send."""
    homed = True

    def __init__(self, position=(100.0, 100.0, 50.0)):
        self.pos = dict(zip('XYZ', position))
        self.written = []

    def send(self, line, timeout=120):
        self.written.append(line)
        return []

    def wait(self):
        pass

    def position(self):
        return dict(self.pos)

    def keep_motors_on(self):
        pass   # nothing to hold; leaves `written` to the gestures

    def move(self, x=None, y=None, z=None, feed=3000, wait=True):
        axes = {k: v for k, v in (('X', x), ('Y', y), ('Z', z)) if v is not None}
        if axes:
            self.pos.update(axes)
            self.send('G1' + ''.join(f' {k}{v:.3f}' for k, v in axes.items()) + f' F{feed}')


def serve(rig, lines, out):
    """One JSON reply per JSON line, echoing the request's "id":
    {"id": ..., "ok": true, "receipt": ...} or {"id": ..., "ok": false, "error": ...}."""
    for line in iter(lines.readline, ''):
        request_id = None
        try:
            message = json.loads(line)
            if isinstance(message, dict):
                request_id = message.pop('id', None)
            reply = {'ok': True, 'receipt': rig.run(message)}
        except Exception as error:   # Report every failure; the caller decides, nothing retries.
            reply = {'ok': False, 'error': str(error)[:2000] or f'{type(error).__name__}; outcome unknown'}
        out.write(json.dumps({'id': request_id, **reply}) + '\n')
        out.flush()


class StylusLink:
    """rig_agent's side: a long-lived `controller.rig serve` process, local or over SSH."""

    def __init__(self, command, cwd=None, timeout=60):
        self.timeout, self.sent = timeout, 0
        try:
            # Own process group, so close() also stops anything a wrapper (sh -c, ssh) started.
            # stderr passes through: the controller's log shows in ours.
            self.process = subprocess.Popen(command, cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                            text=True, bufsize=1, start_new_session=True)
        except OSError as error:
            raise ValueError(f'Could not start the stylus controller ({command[0]}): {error}') from None
        self.replies = queue.Queue()
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

    @classmethod
    def start(cls, command, cwd=None, timeout=60):
        """Start the controller and check it answers (opening the port can take a few seconds)."""
        link = cls(command, cwd, timeout)
        try:
            link.status = link.request({'gesture': 'status'})
        except ValueError:
            link.close()
            raise
        return link

    def _read(self):
        for line in self.process.stdout:
            self.replies.put(line)
        self.replies.put(None)

    def request(self, message):
        if self.process.poll() is not None:
            raise ValueError(f'Stylus controller exited (code {self.process.returncode}); see its log above')
        self.sent += 1
        try:
            self.process.stdin.write(json.dumps({**message, 'id': self.sent}) + '\n')
            self.process.stdin.flush()
            line = self.replies.get(timeout=self.timeout)
        except (BrokenPipeError, OSError):
            raise ValueError('Stylus controller exited; see its log above') from None
        except queue.Empty:
            # Stop it: a late reply must never be matched to the next request.
            self.close()
            raise ValueError(f'No reply from the stylus controller in {self.timeout:g}s; outcome unknown, and the tip '
                             'may still be on the glass. Check the printer and phone before restarting the rig') from None
        if line is None:
            self.process.wait()
            raise ValueError(f'Stylus controller exited (code {self.process.returncode}) mid-gesture; outcome unknown')
        try:
            reply = json.loads(line)
            if not isinstance(reply, dict) or reply.get('id') != self.sent:
                raise ValueError
        except ValueError:
            # Out of step with the controller: later replies could belong to other requests.
            self.close()
            raise ValueError(f'Unexpected reply from the stylus controller ({line.strip()[:200]!r}); stopped it, '
                             'outcome unknown') from None
        if not reply.get('ok'):
            raise ValueError(reply.get('error') or 'Stylus gesture failed; outcome unknown')
        return reply['receipt']

    def act(self, action, frame):
        if action['type'] == 'wait':
            time.sleep(action['seconds'])
            return {'status': 'wait_completed'}
        return self.request(gesture(action, frame))

    def close(self):
        try:
            os.killpg(self.process.pid, signal.SIGKILL)   # the group outlives its leader while a child holds a pipe
        except (ProcessLookupError, PermissionError):
            pass
        self.process.wait()
        # The reader stops at EOF. If it hasn't, leave stdout open: closing it would block on the reader's read.
        self.reader.join(timeout=2)
        for pipe in (self.process.stdin,) + (() if self.reader.is_alive() else (self.process.stdout,)):
            try:
                pipe.close()
            except OSError:   # stdin's buffered write fails once the process is gone
                pass


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    s = sub.add_parser('serve', help='read gestures as JSON lines on stdin, answer on stdout')
    s.add_argument('--dry-run', action='store_true', help='record the G-code instead of opening the serial port')
    s.add_argument('--settle', type=float, default=0.8, help='seconds to let the UI animate after each gesture')
    args = parser.parse_args(argv)

    from controller.phone import Phone
    from controller.stylus import Stylus
    from controller.tasks import Screen
    if args.dry_run:
        printer = DryPrinter()
    else:
        from controller.printer import Printer
        printer = Printer()
    if printer.homed is False:
        print('Board reset on connect, so X/Y are unhomed. Home X/Y and re-check the touch height first.', file=sys.stderr)
        return 2
    printer.keep_motors_on()
    screen = Screen(Stylus(printer), Phone.load(), settle=args.settle, log=lambda message: print(message, file=sys.stderr))
    print(f'stylus controller ready ({"dry run" if args.dry_run else "printer"})', file=sys.stderr)
    serve(Rig(screen, printer), sys.stdin, sys.stdout)
    return 0


if __name__ == '__main__':
    sys.exit(main())
