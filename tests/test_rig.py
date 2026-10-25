import io
import json
import math
import sys
import time
import unittest
from pathlib import Path

from controller.rig import MIRRORING, DryPrinter, Rig, StylusLink, gesture, serve

ROOT = Path(__file__).resolve().parent.parent
# A 636 x 1402 Mirroring capture; the phone screen spans x 16..620 and y 76..1386 inside the window chrome.
FRAME = {'source': 'iPhone Mirroring window', 'width': 636, 'height': 1402}


def image_point(fx, fy):
    left, top, right, bottom = MIRRORING
    return left + fx * (right - left), top + fy * (bottom - top)


class GestureTests(unittest.TestCase):
    def test_tap_maps_the_screenshot_to_screen_fractions(self):
        x, y = image_point(0.5, 0.25)
        result = gesture({'type': 'tap', 'x': x, 'y': y}, FRAME)
        self.assertEqual(result['gesture'], 'tap')
        self.assertAlmostEqual(result['x'], 0.5)
        self.assertAlmostEqual(result['y'], 0.25)

    def test_screen_edges_land_on_the_measured_rectangle(self):
        self.assertAlmostEqual(gesture({'type': 'tap', 'x': 16 / 636, 'y': 76 / 1402}, FRAME)['x'], 0.0, places=2)
        self.assertAlmostEqual(gesture({'type': 'tap', 'x': 620 / 636, 'y': 1386 / 1402}, FRAME)['y'], 1.0, places=2)

    def test_tap_on_the_window_chrome_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'window frame'):
            gesture({'type': 'tap', 'x': 0.5, 'y': 0.02}, FRAME)

    def test_scroll_converts_screenshot_pixels_to_a_screen_fraction(self):
        x, y = image_point(0.5, 0.7)
        result = gesture({'type': 'scroll', 'x': x, 'y': y, 'dy': -655}, FRAME)
        self.assertEqual(result['gesture'], 'scroll')
        self.assertAlmostEqual(result['y'], 0.7)
        self.assertAlmostEqual(result['dy'], -655 / 1310, places=2)   # the screen is 1310 px tall in this capture

    def test_home_needs_no_frame(self):
        self.assertEqual(gesture({'type': 'home'}, None), {'gesture': 'home'})

    def test_typing_and_camera_frames_are_refused(self):
        with self.assertRaisesRegex(ValueError, 'keyboard'):
            gesture({'type': 'type', 'text': 'hi'}, FRAME)
        with self.assertRaisesRegex(ValueError, 'calibrat'):
            gesture({'type': 'tap', 'x': 0.5, 'y': 0.5}, {'source': 'camera', 'width': 1280, 'height': 720})
        with self.assertRaisesRegex(ValueError, 'calibrat'):
            gesture({'type': 'tap', 'x': 0.5, 'y': 0.5}, None)

    def test_a_differently_shaped_mirroring_window_is_refused(self):
        with self.assertRaisesRegex(ValueError, 'Re-measure'):
            gesture({'type': 'tap', 'x': 0.5, 'y': 0.5}, {**FRAME, 'width': 1402, 'height': 636})
        self.assertEqual(gesture({'type': 'home'}, {**FRAME, 'width': 1402, 'height': 636}), {'gesture': 'home'})


def rig():
    from controller.phone import Phone
    from controller.stylus import Stylus
    from controller.tasks import Screen
    printer = DryPrinter()
    phone = Phone((62.5, 230.0), (137.5, 230.0), (63.5, 71.0))   # controller/phone.json, 2026-10-24
    return printer, Rig(Screen(Stylus(printer), phone, settle=0, log=lambda message: None), printer)


def g1(gcode):
    """(X, Y) of every G1 line that moves in the plane."""
    points = []
    for line in gcode:
        words = dict((w[0], float(w[1:])) for w in line.split()[1:] if w[0] in 'XY')
        if line.startswith('G1') and words:
            points.append((words.get('X'), words.get('Y')))
    return points


class RigTests(unittest.TestCase):
    def test_tap_goes_to_the_calibrated_printer_point(self):
        printer, r = rig()
        receipt = r.run({'gesture': 'tap', 'x': 0.5, 'y': 0.5})
        self.assertEqual(receipt['printer_mm'], [100.5, 150.5])
        self.assertIn('G1 X100.500 Y150.500 F3000', receipt['gcode'])
        self.assertFalse(receipt['physical_outcome_verified'])

    def test_negative_scroll_drags_toward_the_phone_top(self):
        printer, r = rig()
        receipt = r.run({'gesture': 'scroll', 'x': 0.5, 'y': 0.7, 'dy': -0.4})
        start, end = receipt['screen'][0], receipt['screen'][1]
        self.assertAlmostEqual(start[1] - end[1], 0.4)
        ys = [y for _, y in g1(receipt['gcode']) if y is not None]
        self.assertGreater(ys[-1], ys[0])                     # printer +Y is the phone's top

    def test_scroll_slides_into_reach_near_the_top(self):
        printer, r = rig()
        receipt = r.run({'gesture': 'scroll', 'x': 0.5, 'y': 0.02, 'dy': 0.3})
        (_, y0), (_, y1) = receipt['screen']
        self.assertAlmostEqual(y1 - y0, 0.3)
        self.assertGreater(min(y0, y1), 0.126)                # the top ~13% is past the printer's Y travel
        self.assertTrue(all(y <= 210 for _, y in g1(receipt['gcode']) if y is not None))

    def test_tiny_and_huge_scrolls_are_clamped(self):
        printer, r = rig()
        (_, a), (_, b) = r.run({'gesture': 'scroll', 'x': 0.5, 'y': 0.5, 'dy': 0.01})['screen']
        self.assertAlmostEqual(b - a, 0.1)
        (_, a), (_, b) = r.run({'gesture': 'scroll', 'x': 0.5, 'y': 0.5, 'dy': -5})['screen']
        self.assertAlmostEqual(a - b, 0.6)

    def test_tap_out_of_reach_is_refused_before_moving(self):
        printer, r = rig()
        with self.assertRaisesRegex(ValueError, 'reach'):
            r.run({'gesture': 'tap', 'x': 0.5, 'y': 0.05})
        self.assertEqual(printer.written, [])

    def test_home_uses_assistive_touch(self):
        printer, r = rig()
        receipt = r.run({'gesture': 'home'})
        presses = [line for line in receipt['gcode'] if line.startswith('G4')]
        self.assertEqual(len(presses), 2)                     # the floating button, then Home in its menu

    def test_status_and_bad_gestures(self):
        printer, r = rig()
        self.assertEqual(r.run({'gesture': 'status'})['dry_run'], True)
        for bad in ({'gesture': 'tap', 'x': 1.5, 'y': 0.5}, {'gesture': 'tap', 'x': math.nan, 'y': 0.5},
                    {'gesture': 'tap', 'x': '0.5', 'y': 0.5}, {'gesture': 'jump'}, {'gesture': 'scroll', 'x': 0.5, 'y': 0.5},
                    {'gesture': 'tap', 'x': 0.5, 'y': 0.5, 'z': 1}, {'gesture': 'scroll', 'x': 0.5, 'y': 0.5, 'dy': 0}, []):
            with self.assertRaises(ValueError, msg=bad):
                r.run(bad)
        self.assertEqual(printer.written, [])

    def test_serve_answers_every_line(self):
        printer, r = rig()
        out = io.StringIO()
        serve(r, io.StringIO('{"gesture": "status", "id": 7}\nnot json\n{"gesture": "tap", "x": 0.5, "y": 0.5, "id": 8}\n'), out)
        replies = [json.loads(line) for line in out.getvalue().splitlines()]
        self.assertEqual([reply['ok'] for reply in replies], [True, False, True])
        self.assertEqual([reply['id'] for reply in replies], [7, None, 8])
        self.assertIn('error', replies[1])


class LinkTests(unittest.TestCase):
    def test_dry_run_controller_end_to_end(self):
        command = [sys.executable, '-m', 'controller.rig', 'serve', '--dry-run', '--settle', '0']
        link = StylusLink.start(command, cwd=ROOT)
        try:
            x, y = image_point(0.5, 0.5)
            receipt = link.act({'type': 'tap', 'x': x, 'y': y}, FRAME)
            self.assertEqual(receipt['printer_mm'], [100.5, 150.5])
            self.assertEqual(link.act({'type': 'wait', 'seconds': 0}, None), {'status': 'wait_completed'})
            with self.assertRaisesRegex(ValueError, 'keyboard'):
                link.act({'type': 'type', 'text': 'hi'}, FRAME)
            with self.assertRaisesRegex(ValueError, 'reach'):
                link.act({'type': 'tap', 'x': x, 'y': image_point(0.5, 0.02)[1]}, FRAME)
            self.assertEqual(link.act({'type': 'home'}, None)['gesture'], 'home')   # still usable after an error
        finally:
            link.close()

    def test_controller_that_exits_is_a_clear_error(self):
        with self.assertRaisesRegex(ValueError, 'exited'):
            StylusLink.start([sys.executable, '-c', 'import sys; sys.stdin.readline()'])

    def test_silent_controller_times_out_as_unknown(self):
        link = StylusLink([sys.executable, '-c', 'import time; time.sleep(30)'], timeout=0.5)
        try:
            with self.assertRaisesRegex(ValueError, 'outcome unknown'):
                link.request({'gesture': 'home'})
            with self.assertRaisesRegex(ValueError, 'exited'):
                link.request({'gesture': 'home'})       # no silent reconnect after an unknown outcome
        finally:
            link.close()

    def test_timeout_also_stops_what_a_wrapper_started(self):
        link = StylusLink(['sh', '-c', 'sleep 30; true'], timeout=0.5)   # the sleep holds stdout open
        started = time.time()
        try:
            with self.assertRaisesRegex(ValueError, 'outcome unknown'):
                link.request({'gesture': 'home'})
        finally:
            link.close()
        self.assertLess(time.time() - started, 5)

    def test_stray_or_mismatched_replies_stop_the_link(self):
        for reply in ('noise', '{"id": 99, "ok": true, "receipt": {}}'):
            script = f'import sys; sys.stdin.readline(); print({reply!r}, flush=True); sys.stdin.readline()'
            link = StylusLink([sys.executable, '-c', script], timeout=5)
            try:
                with self.assertRaisesRegex(ValueError, 'Unexpected reply'):
                    link.request({'gesture': 'home'})
                with self.assertRaisesRegex(ValueError, 'exited'):
                    link.request({'gesture': 'home'})
            finally:
                link.close()

    def test_missing_command_is_a_clear_error(self):
        with self.assertRaisesRegex(ValueError, 'Could not start'):
            StylusLink(['/nonexistent/stylus-controller'])


if __name__ == '__main__':
    unittest.main()
