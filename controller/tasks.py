"""Hard-coded phone tasks: fixed taps and swipes at screen fractions, with no camera or model in the loop.

Positions come from controller/phone.json (see controller.phone), so re-measuring the phone's corners after it
moves keeps every task working. Layout fractions are for an iPhone 16 Pro Max held upright.

    python3 -m controller.tasks list
    python3 -m controller.tasks run home
    python3 -m controller.tasks run scroll_down --check map.jpg   # survey the phone afterwards to see the result
"""
import argparse
import sys
import time

from controller.phone import Phone


class Screen:
    """The stylus, addressed in screen fractions. Each gesture waits `settle` seconds for the UI to animate."""

    def __init__(self, stylus, phone, settle=0.8, log=print):
        self.stylus, self.phone, self.settle, self.log = stylus, phone, settle, log

    def _at(self, fx, fy):
        if not self.phone.reachable(fx, fy):
            raise ValueError(f'screen point ({fx:.3f}, {fy:.3f}) is outside the printer\'s reach; move the phone')
        return self.phone.point(fx, fy)

    def tap(self, fx, fy, label=''):
        self.log(f'tap {label or ""} ({fx:.3f}, {fy:.3f})'.replace('  ', ' '))
        self.stylus.tap(*self._at(fx, fy))
        time.sleep(self.settle)

    def swipe(self, fx0, fy0, fx1, fy1, label=''):
        self.log(f'swipe {label or ""} ({fx0:.3f}, {fy0:.3f}) -> ({fx1:.3f}, {fy1:.3f})'.replace('  ', ' '))
        self.stylus.swipe(*self._at(fx0, fy0), *self._at(fx1, fy1))
        time.sleep(self.settle)

    def wait(self, seconds):
        time.sleep(seconds)


# Swiping up from the very bottom edge is the home gesture in any app.
def home(s):
    s.swipe(0.5, 0.985, 0.5, 0.6, 'home')


# Dragging content up shows what is further down the page.
def scroll_down(s):
    s.swipe(0.5, 0.75, 0.5, 0.35, 'scroll down')


def scroll_up(s):
    s.swipe(0.5, 0.35, 0.5, 0.75, 'scroll up')


def next_page(s):
    s.swipe(0.85, 0.55, 0.15, 0.55, 'next page')


def previous_page(s):
    s.swipe(0.15, 0.55, 0.85, 0.55, 'previous page')


# Pulling down in the middle of a home screen page opens Spotlight search with the keyboard up.
def spotlight(s):
    home(s)
    s.swipe(0.5, 0.35, 0.5, 0.65, 'spotlight')


TASKS = {f.__name__: f for f in (home, scroll_down, scroll_up, next_page, previous_page, spotlight)}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('list')
    r = sub.add_parser('run')
    r.add_argument('task', choices=sorted(TASKS))
    r.add_argument('--check', metavar='JPG', help='afterwards, survey the phone and save a top-down map')
    args = parser.parse_args(argv)

    if args.command == 'list':
        for name, f in TASKS.items():
            print(f'{name:16} {(f.__doc__ or "").strip()}')
        return 0

    from controller.printer import Printer
    from controller.stylus import Stylus
    printer = Printer()
    if printer.homed is False:
        print('Board reset on connect, so X/Y are unhomed. Home X/Y and re-check the touch height first.', file=sys.stderr)
        return 2
    printer.keep_motors_on()
    stylus = Stylus(printer)
    TASKS[args.task](Screen(stylus, Phone.load()))
    if args.check:
        import cv2
        from controller.camera import RAW_TOPIC, RosCamera
        from controller.phone import mosaic, survey
        stylus.hover(97.0, 55.0)
        frames = survey(printer, RosCamera(image_topic=RAW_TOPIC), [(97.0, y) for y in (55, 105, 150, 190)])
        cv2.imwrite(args.check, mosaic(frames))
        print(f'saved {args.check}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
