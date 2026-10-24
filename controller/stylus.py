"""Tap and swipe on the phone with the head-mounted stylus. Coordinates are printer mm (no screen mapping yet).

    python3 -m controller.stylus hover 100 100
    python3 -m controller.stylus tap 100 100
    python3 -m controller.stylus swipe 100 85 100 135     # +Y drags toward the phone's top: page scrolls down
"""
import argparse
import math
import sys

# Mount-specific (2026-10-24, second mount, phone taped at the bed centre): no contact at 39.8;
# at 39.3 slow strokes stick (long-press) but fast ones scroll.
TOUCH_Z = 39.3
# Where the tip lands in the rectified OAK frame when hovering at TOUCH_Z + HOVER_MM: the bottom edge, below the
# camera's view of the stylus itself. To hit something seen at pixel (u, v), move the head by about
# X += (u - 315) / 8.65 and Y += (710 - v) / 8.65 mm (8.65 px/mm on the glass at this height).
TIP_PIXEL = (315, 710)
HOVER_MM = 3.0
BOUNDS = {'X': (0.0, 250.0), 'Y': (0.0, 210.0)}


class Stylus:
    """The rubber tip grips the glass, so a slow or deep stroke turns into a long-press. Swipes therefore touch
    down and lift off while already moving, and drag fast; taps go straight down, pause briefly and come up."""

    def __init__(self, printer, touch_z=TOUCH_Z, hover_mm=HOVER_MM, press_mm=0.3, dwell=0.1,
                 drag_feed=6000, contact_feed=1500, travel_feed=3000):
        self.printer, self.touch_z, self.hover_z = printer, touch_z, touch_z + hover_mm
        self.press_z, self.dwell = touch_z - press_mm, dwell   # dwell well under iOS's ~0.5 s long-press
        self.drag_feed, self.contact_feed, self.travel_feed = drag_feed, contact_feed, travel_feed

    def hover(self, x, y):
        """Lift first, then travel, so the tip never drags across the screen between gestures."""
        check(x, y)
        if self.printer.position()['Z'] < self.hover_z:
            self.printer.move(z=self.hover_z, feed=self.contact_feed)
        self.printer.move(x=x, y=y, feed=self.travel_feed)
        self.printer.move(z=self.hover_z, feed=self.contact_feed)

    def tap(self, x, y):
        self.hover(x, y)
        self.printer.move(z=self.press_z, feed=self.contact_feed, wait=False)
        if self.dwell:
            self.printer.send(f'G4 P{int(self.dwell * 1000)}')
        self.printer.move(z=self.hover_z, feed=self.contact_feed)

    def swipe(self, x0, y0, x1, y1, lead_in=2.0, follow_through=3.0):
        length = math.hypot(x1 - x0, y1 - y0)
        if length < 1:
            raise ValueError('swipe shorter than 1 mm; use tap()')
        ux, uy = (x1 - x0) / length, (y1 - y0) / length
        start = (x0 - ux * lead_in, y0 - uy * lead_in)
        end = (x1 + ux * follow_through, y1 + uy * follow_through)
        check(*start)
        check(*end)
        self.hover(*start)
        move = self.printer.move
        move(x=x0, y=y0, z=self.touch_z, feed=self.contact_feed, wait=False)    # touch down while moving
        move(x=x1, y=y1, feed=self.drag_feed, wait=False)
        move(x=end[0], y=end[1], z=self.hover_z, feed=self.contact_feed)        # lift while moving


def check(x, y):
    for axis, value in (('X', x), ('Y', y)):
        low, high = BOUNDS[axis]
        if not low <= value <= high:
            raise ValueError(f'{axis}{value:.1f} outside {low}..{high} mm')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--touch-z', type=float, default=TOUCH_Z)
    sub = parser.add_subparsers(dest='gesture', required=True)
    for name, coords in (('hover', 'x y'), ('tap', 'x y'), ('swipe', 'x0 y0 x1 y1')):
        s = sub.add_parser(name)
        for c in coords.split():
            s.add_argument(c, type=float)
    args = parser.parse_args(argv)

    from controller.printer import Printer
    printer = Printer()
    if printer.homed is False:
        print('Board reset on connect, so X/Y are unhomed. Home X/Y and re-check the touch height first.', file=sys.stderr)
        return 2
    printer.keep_motors_on()
    stylus = Stylus(printer, touch_z=args.touch_z)
    if args.gesture == 'swipe':
        stylus.swipe(args.x0, args.y0, args.x1, args.y1)
    else:
        getattr(stylus, args.gesture)(args.x, args.y)
    print(printer.position())
    return 0


if __name__ == '__main__':
    sys.exit(main())
