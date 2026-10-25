"""Where the phone lies on the bed, so tasks can name screen points instead of printer mm.

Screen points are fractions of the phone's outline as the camera sees it, held upright: (0, 0) is the top-left
corner and (1, 1) the bottom-right. Printer X grows toward the phone's right and Y toward its top. Re-measure
whenever the phone or the stylus moves:

    python3 -m controller.phone survey                     # hover over the bed; save a top-down map with a mm grid
    python3 -m controller.phone set 62,230 135,230 62,70   # read the top-left, top-right, bottom-left corners off it
    python3 -m controller.phone where 0.5 0.5              # printer mm of a screen point
"""
import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

from controller.stylus import BOUNDS, PIXEL_TO_MM, TIP_PIXEL

CALIBRATION = Path(__file__).with_name('phone.json')


class Phone:
    """`touch` holds Stylus contact settings for this placement: {'z', 'slope', 'origin', 'hover_mm', 'press_mm', 'drag_press_mm'} (see Stylus)."""

    def __init__(self, top_left, top_right, bottom_left, touch=None):
        self.top_left, self.top_right, self.bottom_left = (tuple(map(float, c)) for c in (top_left, top_right, bottom_left))
        self.touch = touch or {}

    @classmethod
    def load(cls, path=CALIBRATION):
        data = json.loads(Path(path).read_text())
        return cls(data['top_left'], data['top_right'], data['bottom_left'], data.get('touch'))

    def save(self, path=CALIBRATION):
        data = {'top_left': self.top_left, 'top_right': self.top_right, 'bottom_left': self.bottom_left}
        if self.touch:
            data['touch'] = self.touch
        Path(path).write_text(json.dumps(data, indent=1) + '\n')

    def stylus(self, printer, **kwargs):
        from controller.stylus import Stylus
        t = self.touch
        settings = {'touch_z': t['z'], 'slope': tuple(t.get('slope', (0, 0))), 'origin': tuple(t.get('origin', (0, 0)))} if t else {}
        settings.update({k: t[k] for k in ('hover_mm', 'press_mm', 'drag_press_mm') if k in t})
        return Stylus(printer, **{**settings, **kwargs})

    def point(self, fx, fy):
        """Printer (x, y) in mm of the screen point fx of the way across and fy of the way down."""
        (x0, y0), (x1, y1), (x2, y2) = self.top_left, self.top_right, self.bottom_left
        return x0 + fx * (x1 - x0) + fy * (x2 - x0), y0 + fx * (y1 - y0) + fy * (y2 - y0)

    @property
    def size(self):
        (x0, y0), (x1, y1), (x2, y2) = self.top_left, self.top_right, self.bottom_left
        return float(np.hypot(x1 - x0, y1 - y0)), float(np.hypot(x2 - x0, y2 - y0))

    def reachable(self, fx, fy):
        x, y = self.point(fx, fy)
        return all(low <= v <= high for v, (low, high) in ((x, BOUNDS['X']), (y, BOUNDS['Y'])))


def mosaic(frames, scale=4.0, x_range=(0.0, 250.0), y_range=(0.0, 300.0), grid=10):
    """Paste frames taken at hover height with the head at known (x, y) into one top-down map of the glass plane,
    `scale` px/mm, phone upright (printer +Y up). Each frame is feathered toward its edges so seams take the
    sharper middle."""
    import cv2
    (xmin, xmax), (ymin, ymax) = x_range, y_range
    size = (int((xmax - xmin) * scale), int((ymax - ymin) * scale))
    acc = np.zeros((size[1], size[0], 3), np.float32)
    weight = np.zeros((size[1], size[0]), np.float32)
    # A pixel shows the glass point at head + glass_offset(pixel) = head + A(tip) - A(pixel), A = PIXEL_TO_MM.
    tip = PIXEL_TO_MM @ (*TIP_PIXEL, 1.0)
    tx, ty = tip[:2] / tip[2]
    for (x, y), image in frames:
        h, w = image.shape[:2]
        M = np.array([[-scale, 0, scale * (x + tx - xmin)], [0, scale, scale * (ymax - y - ty)], [0, 0, 1]]) @ PIXEL_TO_MM
        ramp = np.minimum.outer(np.minimum(np.arange(h), np.arange(h)[::-1]), np.minimum(np.arange(w), np.arange(w)[::-1]))
        feather = np.clip(ramp / 60.0, 1e-3, 1).astype(np.float32)
        wt = cv2.warpPerspective(feather, M, size)
        acc += cv2.warpPerspective(image.astype(np.float32), M, size) * wt[..., None]
        weight += wt
    out = (acc / np.maximum(weight, 1e-6)[..., None]).astype(np.uint8)
    for mm in range(int(xmin), int(xmax) + 1, grid):
        u = int((mm - xmin) * scale)
        cv2.line(out, (u, 0), (u, size[1]), (0, 0, 255) if mm % 50 == 0 else (0, 160, 255), 1)
        cv2.putText(out, str(mm), (u + 2, 14), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 0, 255), 1)
    for mm in range(int(ymin), int(ymax) + 1, grid):
        v = int((ymax - mm) * scale)
        cv2.line(out, (0, v), (size[0], v), (0, 0, 255) if mm % 50 == 0 else (0, 160, 255), 1)
        cv2.putText(out, str(mm), (2, v - 2), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 0, 255), 1)
    return out


def survey(printer, camera, positions, settle=0.8):
    """Hover at each head position (Z must already be at a safe height) and return [((x, y), frame)]."""
    frames = []
    for x, y in positions:
        printer.move(x=x, y=y, feed=3000)
        time.sleep(settle)
        frames.append(((x, y), camera.frame()))
    return frames


def pair(text):
    x, y = (float(v) for v in text.split(','))
    return x, y


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    s = sub.add_parser('survey')
    s.add_argument('--out', default='phone_map.jpg')
    s.add_argument('--x', type=float, default=97.0, help='one column of frames covers about X-36..X+111 mm')
    s.add_argument('--ys', default='55,105,150,190')
    s = sub.add_parser('set')
    for corner in ('top_left', 'top_right', 'bottom_left'):
        s.add_argument(corner, type=pair, help='X,Y in printer mm')
    s = sub.add_parser('where')
    s.add_argument('fx', type=float)
    s.add_argument('fy', type=float)
    args = parser.parse_args(argv)

    if args.command == 'set':
        touch = Phone.load().touch if CALIBRATION.exists() else None
        phone = Phone(args.top_left, args.top_right, args.bottom_left, touch)
        phone.save()
        print(f'saved {CALIBRATION}; phone is {phone.size[0]:.1f} x {phone.size[1]:.1f} mm')
        return 0
    if args.command == 'where':
        phone = Phone.load()
        x, y = phone.point(args.fx, args.fy)
        print(f'X{x:.1f} Y{y:.1f}' + ('' if phone.reachable(args.fx, args.fy) else '  (out of reach)'))
        return 0

    import cv2
    from controller.camera import RAW_TOPIC, RosCamera
    from controller.printer import Printer
    from controller.stylus import TOUCH_Z, HOVER_MM
    printer = Printer()
    if printer.homed is False:
        print('Board reset on connect, so X/Y are unhomed.', file=sys.stderr)
        return 2
    printer.keep_motors_on()
    printer.move(z=TOUCH_Z + HOVER_MM, feed=1500)   # PIXEL_TO_MM holds at hover height only
    frames = survey(printer, RosCamera(image_topic=RAW_TOPIC), [(args.x, float(y)) for y in args.ys.split(',')])
    cv2.imwrite(args.out, mosaic(frames))
    print(f'saved {args.out}: 4 px/mm, grid every 10 mm (printer X across, Y up)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
