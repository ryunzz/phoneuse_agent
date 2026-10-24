"""Camera-only Z calibration against the MK42 bed's printed 50 mm grid.

The OAK sits on the print head, so its distance to the bed changes 1:1 with Z. Two estimates
of that distance (along the optical axis, at the principal point):
  scale    -- adjacent grid lines are 50 mm apart: D = fx * 50 / pixel spacing (one frame)
  parallax -- move X by `step` mm: lines shift fx * step / D pixels (works on any texture)

    python3 -m controller.zcal measure            # no motion; distance from the current frame
    python3 -m controller.zcal sweep --top 20     # Z up/down between current and current+20 mm
"""
import argparse
import json
import sys
import time

import cv2
import numpy as np

GRID_MM = 50.0
CARRIAGE_MASK = (slice(600, None), slice(None, 160))   # red carriage part fixed in the bottom-left of the view


def grid_lines(image, centre, votes=250, mask=CARRIAGE_MASK):
    """Grid lines as {'v': x at the centre row, 'h': y at the centre column}, sorted."""
    cx, cy = centre
    gray = cv2.GaussianBlur(cv2.cvtColor(image, cv2.COLOR_BGR2GRAY), (5, 5), 0)
    # Lines are thin and bright; top-hat removes glare and slow shading from the glossy bed.
    tophat = cv2.morphologyEx(gray, cv2.MORPH_TOPHAT, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (31, 31)))
    _, binary = cv2.threshold(tophat, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    if mask:
        binary[mask] = 0
    found = cv2.HoughLines(binary, 1, np.pi / 720, votes)
    lines = {'v': [], 'h': []}
    for rho, theta in ([] if found is None else found[:, 0]):
        c, s = np.cos(theta), np.sin(theta)
        if abs(c) > abs(s):
            lines['v'].append((rho - cy * s) / c)
        else:
            lines['h'].append((rho - cx * c) / s)
    return {k: merge(v) for k, v in lines.items()}


def merge(values, gap=25):
    """Collapse Hough hits within `gap` px (both edges of one thick line) to their mean."""
    groups = []
    for v in sorted(values):
        if groups and v - groups[-1][-1] < gap:
            groups[-1].append(v)
        else:
            groups.append([v])
    return [float(np.mean(g)) for g in groups]


def depth_at_centre(xs, depths, cx):
    """For a (possibly tilted) plane 1/D is affine in image x; interpolate it to the principal point."""
    if len(xs) == 1:
        return float(depths[0])
    a, b = np.polyfit(xs, 1 / np.asarray(depths, float), 1)
    return float(1 / (a * cx + b))


def scale_depth(xs, fx, cx, spacing=GRID_MM):
    xs = np.asarray(xs, float)
    if len(xs) < 2:
        return None
    gaps = np.diff(xs)
    return depth_at_centre((xs[:-1] + xs[1:]) / 2, fx * spacing / gaps, cx)


def parallax_depth(before, after, fx, cx, step, guess):
    """Pair each line with its shifted copy closest to the shift predicted by `guess` (mm)."""
    predicted, pairs = fx * step / guess, []
    for x in before:
        shift = min((x - y for y in after), key=lambda d: abs(d - predicted), default=None)
        if shift is not None and abs(shift - predicted) < 0.25 * abs(predicted):
            pairs.append((x - shift / 2, fx * step / shift))
    return depth_at_centre(*zip(*pairs), cx) if pairs else None


def fit(zs, depths):
    slope, intercept = np.polyfit(zs, depths, 1)
    residual = np.asarray(depths) - (slope * np.asarray(zs) + intercept)
    return {'slope': float(slope), 'intercept': float(intercept),
            'rms': float(np.sqrt((residual ** 2).mean())), 'max': float(abs(residual).max())}


def vertical_lines(camera, frames=2):
    sets = [grid_lines(camera.frame(), camera.principal_point)['v'] for _ in range(frames)]
    return [float(np.mean(c)) for c in zip(*sets)] if len({len(s) for s in sets}) == 1 else sets[0]


def measure(camera):
    """Camera-to-bed distance (mm) from the current frame, or None if fewer than two grid lines are visible."""
    return scale_depth(vertical_lines(camera), camera.fx, camera.principal_point[0])


def sweep(printer, camera, x, y, top=20.0, step=2.0, parallax_mm=10.0, log=print):
    """Visit current Z .. current Z + top and back. Never goes below the starting height."""
    if top <= 0 or step <= 0:
        raise ValueError('top and step must be positive')
    printer.move(x=x, y=y)
    if measure(camera) is None:
        raise RuntimeError(f'No pair of grid lines visible at X{x} Y{y}; X/Y may have lost position (re-home) or the view is blocked.')
    z0 = printer.position()['Z']
    ups = list(np.arange(0, top + 1e-9, step))
    rows = []
    for dz in ups + ups[-2::-1]:
        printer.move(z=z0 + dz, feed=300)
        time.sleep(0.2)   # let the head stop ringing
        before = vertical_lines(camera)
        printer.move(x=x + parallax_mm, y=y)
        time.sleep(0.2)
        after = vertical_lines(camera)
        printer.move(x=x, y=y)
        cx = camera.principal_point[0]
        scale = scale_depth(before, camera.fx, cx)
        parallax = parallax_depth(before, after, camera.fx, cx, parallax_mm, scale) if scale else None
        rows.append({'z': z0 + dz, 'dz': float(dz), 'scale': scale, 'parallax': parallax, 'lines': before})
        log(f'Z={z0 + dz:7.2f}  lines {np.round(before, 1)}  D_scale={scale}  D_parallax={parallax}')
    printer.move(z=z0, feed=300)
    summary = {}
    for key in ('scale', 'parallax'):
        good = [(r['z'], r[key]) for r in rows if r[key]]
        if len(good) >= 3:
            summary[key] = fit(*zip(*good))
    return {'rows': rows, 'fit': summary, 'fx': camera.fx}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='mode', required=True)
    sub.add_parser('measure', help='distance from the current frame; no motion')
    s = sub.add_parser('sweep', help='move Z up/down from the current height and fit distance vs Z')
    s.add_argument('--x', type=float, default=100)
    s.add_argument('--y', type=float, default=100)
    s.add_argument('--top', type=float, default=20)
    s.add_argument('--step', type=float, default=2)
    s.add_argument('--home', action='store_true', help='home X/Y first (required if the board was reset)')
    s.add_argument('--out', help='write rows and fit as JSON')
    args = parser.parse_args(argv)

    from controller.camera import RosCamera
    camera = RosCamera()
    if args.mode == 'measure':
        print(json.dumps({'distance_mm': measure(camera)}))
        return 0
    from controller.printer import Printer
    printer = Printer()
    if printer.homed is False and not args.home:
        print('Board reset on connect, so X/Y are unhomed. Re-run with --home.', file=sys.stderr)
        return 2
    printer.keep_motors_on()
    if args.home:
        printer.home_xy()
    result = sweep(printer, camera, args.x, args.y, args.top, args.step)
    for key, f in result['fit'].items():
        print(f"{key:8s}: D = {f['slope']:.4f} * Z + {f['intercept']:.2f} mm   rms {f['rms']:.3f}  max {f['max']:.3f}")
    if args.out:
        with open(args.out, 'w') as handle:
            json.dump(result, handle, indent=1)
    return 0


if __name__ == '__main__':
    sys.exit(main())
