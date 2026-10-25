"""Tap and swipe on the phone with the head-mounted stylus. Coordinates are printer mm; controller.phone maps
screen positions onto them.

    python3 -m controller.stylus hover 100 100
    python3 -m controller.stylus tap 100 100
    python3 -m controller.stylus swipe 100 85 100 135     # +Y drags toward the phone's top: page scrolls down
"""
import argparse
import math
import sys

import numpy as np

# Phone-in-case on the bed (2026-10-24): taps register from about Z 43.5 mid-screen (Y142). Probed thresholds were
# 42.69-42.99 at Y103 and 44.45-44.65 at Y205, so the glass rises 0.0167 mm per mm toward the phone's top, which
# matches the camera's parallax. A fast stroke already registers about 0.75 mm higher, at 44.25. The glass is ~15 mm
# above the bed. phone.json holds these per placement; re-measure after re-mounting the stylus or moving the phone.
TOUCH_Z = 43.5
HOVER_MM = 4.0   # hover at Z 47.5, the height PIXEL_TO_MM was measured at
# The glass point the tip lands on, as seen in the rectified OAK frame while hovering: just above the bottom edge,
# below the camera's view of the stylus itself. Measured 2026-10-24 by tapping AssistiveTouch's Create New Gesture
# canvas (which draws a dot at each touch) at six aimed points: offsets agreed to 0.3 mm.
TIP_PIXEL = (276, 688)
# Homography from a rectified-frame pixel (at hover height) to the head move that would put that glass point where
# the TIP_PIXEL point is now, measured by tracking a screen patch over a 5 x 6 grid of head moves (0.04 mm rms). The
# camera is pitched and rolled ~2.8 degrees, so the scale runs from 8.5 px/mm at the top of the frame to 8.2 at the
# bottom; a single px/mm figure is off by up to ~3 mm across the frame.
PIXEL_TO_MM = np.array([[-1.167258606e-01, -4.818091622e-03, 3.967328199e+01],
                        [-5.356585693e-03, 1.183895246e-01, -6.937498501e+01],
                        [-6.290784653e-06, -3.119881766e-05, 1.0]])
PX_PER_MM = 8.4   # rough average, for sizes only


def glass_offset(u, v):
    """Printer (dx, dy) mm from the tip's landing point to the glass point seen at pixel (u, v) at hover height."""
    def apply(point):
        x, y, w = PIXEL_TO_MM @ (point[0], point[1], 1.0)
        return np.array((x / w, y / w))
    return tuple(float(c) for c in apply(TIP_PIXEL) - apply((u, v)))


def glass_pixel(dx, dy):
    """Inverse of glass_offset: the pixel showing the glass point (dx, dy) mm from the tip's landing point."""
    tip = PIXEL_TO_MM @ (*TIP_PIXEL, 1.0)
    u, v, w = np.linalg.solve(PIXEL_TO_MM, (tip[0] / tip[2] - dx, tip[1] / tip[2] - dy, 1.0))
    return float(u / w), float(v / w)


BOUNDS = {'X': (0.0, 250.0), 'Y': (0.0, 210.0)}


class Stylus:
    """The rubber tip grips the glass, so a slow or deep stroke turns into a long-press. Swipes therefore touch
    down and lift off while already moving, and drag fast; taps go straight down, pause briefly and come up."""

    def __init__(self, printer, touch_z=TOUCH_Z, hover_mm=HOVER_MM, press_mm=0.3, dwell=0.1, drag_press_mm=0.0,
                 slope=(0.0, 0.0), origin=(0.0, 0.0), drag_feed=6000, contact_feed=1500, travel_feed=3000):
        """touch_z is the contact height at `origin`; `slope` (dZ/dX, dZ/dY) follows glass that isn't level.
        Hover stays at one height, touch_z + hover_mm, because the camera mapping holds only there."""
        self.printer, self.touch_z, self.hover_z = printer, touch_z, touch_z + hover_mm
        self.slope, self.origin = slope, origin
        self.press_mm, self.dwell, self.drag_press_mm = press_mm, dwell, drag_press_mm   # dwell well under iOS's ~0.5 s long-press
        self.drag_feed, self.contact_feed, self.travel_feed = drag_feed, contact_feed, travel_feed

    def contact_z(self, x, y):
        return self.touch_z + self.slope[0] * (x - self.origin[0]) + self.slope[1] * (y - self.origin[1])

    def hover(self, x, y):
        """Lift first, then travel, so the tip never drags across the screen between gestures."""
        check(x, y)
        if self.printer.position()['Z'] < self.hover_z:
            self.printer.move(z=self.hover_z, feed=self.contact_feed)
        self.printer.move(x=x, y=y, feed=self.travel_feed)
        self.printer.move(z=self.hover_z, feed=self.contact_feed)

    def tap(self, x, y):
        self.hover(x, y)
        self.printer.move(z=self.contact_z(x, y) - self.press_mm, feed=self.contact_feed, wait=False)
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
        drag = self.drag_press_mm
        move(x=x0, y=y0, z=self.contact_z(x0, y0) - drag, feed=self.contact_feed, wait=False)   # touch down moving
        move(x=x1, y=y1, z=self.contact_z(x1, y1) - drag, feed=self.drag_feed, wait=False)
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
