import unittest

import cv2
import numpy as np

from controller.printer import Printer, PrinterError, parse_endstops, parse_position
from controller.stylus import Stylus
from controller.zcal import depth_at_centre, fit, grid_lines, parallax_depth, scale_depth

FX, CENTRE = 761.4, (634.0, 364.7)


class FakeLink:
    """Serial stand-in: answers each written line with canned replies (default: ok)."""

    def __init__(self, boot=(), replies=None):
        self.lines, self.written, self.replies = list(boot), [], replies or {}

    def readline(self):
        return (self.lines.pop(0) + '\n').encode() if self.lines else b''

    def write(self, data):
        command = data.decode().strip()
        self.written.append(command)
        self.lines += self.replies.get(command.split()[0], []) + ['ok']

    def reset_input_buffer(self):
        pass


class PrinterTests(unittest.TestCase):
    def test_detects_board_reset_on_connect(self):
        self.assertTrue(Printer(boot_wait=0.2, link=FakeLink(['start', 'echo:SD card ok'])).was_reset)
        self.assertFalse(Printer(boot_wait=0.2, link=FakeLink()).was_reset)

    def test_z_homing_is_refused_without_touching_the_port(self):
        printer = Printer(boot_wait=0.2, link=FakeLink())
        for command in ('G28', 'g28 z', 'G28 X Y Z', 'G28 Z0'):
            with self.assertRaises(PrinterError):
                printer.send(command)
        self.assertEqual(printer.link.written, [])
        printer.home_xy()
        self.assertEqual(printer.link.written, ['G91', 'G1 Z3 F300', 'G90', 'G28 X Y', 'M400'])

    def test_position_and_endstops(self):
        link = FakeLink(replies={
            'M114': ['X:10.00 Y:-2.72 Z:5.00 E:0.00 Count X: 10.46 Y:10.52 Z:5.00'],
            'M119': ['Reporting endstop status', 'x_min: TRIGGERED', 'y_min: open', 'z_min: open'],
        })
        printer = Printer(boot_wait=0.2, link=link)
        self.assertEqual(printer.position(), {'X': 10.0, 'Y': -2.72, 'Z': 5.0, 'E': 0.0})
        self.assertEqual(printer.endstops(), {'x_min': 'TRIGGERED', 'y_min': 'open', 'z_min': 'open'})

    def test_reset_blocks_motion_until_rehomed(self):
        printer = Printer(boot_wait=0.2, link=FakeLink(['start', 'echo:SD card ok']))
        with self.assertRaises(PrinterError):
            printer.move(x=10)
        printer.home_xy()
        printer.move(x=10)
        self.assertIn('G1 X10.000 F3000', printer.link.written)

    def test_mid_session_reset_marks_position_lost(self):
        printer = Printer(boot_wait=0.2, link=FakeLink(replies={'G1': ['start', 'echo:SD card ok']}))
        self.assertIsNone(printer.homed)
        with self.assertRaises(PrinterError):
            printer.move(x=10)
        self.assertIs(printer.homed, False)
        with self.assertRaises(PrinterError):
            printer.move(x=20)

    def test_firmware_error_raises(self):
        printer = Printer(boot_wait=0.2, link=FakeLink(replies={'G1': ['Error:Printer halted. kill() called!']}))
        with self.assertRaises(PrinterError):
            printer.send('G1 X5')

    def test_set_z_declares_height_without_moving(self):
        printer = Printer(boot_wait=0.2, link=FakeLink())
        printer.set_z(60.25)
        self.assertEqual(printer.link.written[-1], 'G92 Z60.250')

    def test_parsers(self):
        self.assertEqual(parse_position('X:0.00 Y:0.00 Z:0.15 E:0.00 Count X: 0.00')['Z'], 0.15)
        self.assertEqual(parse_endstops(['z_max: open', 'echo: busy']), {'z_max': 'open'})


def stylus(z=80.0, homed=True):
    printer = Printer(boot_wait=0.2, link=FakeLink(replies={'M114': [f'X:100.00 Y:100.00 Z:{z:.2f} E:0.00']}))
    printer.homed = homed
    return printer, Stylus(printer, touch_z=39.3, hover_mm=3.0)


def moves(printer):
    return [line for line in printer.link.written if line.startswith('G1')]


class StylusTests(unittest.TestCase):
    def test_tap_travels_high_then_presses_briefly(self):
        printer, s = stylus(z=39.5)
        s.tap(110, 90)
        self.assertEqual(moves(printer), ['G1 Z42.300 F1500', 'G1 X110.000 Y90.000 F3000', 'G1 Z42.300 F1500',
                                          'G1 Z39.000 F1500', 'G1 Z42.300 F1500'])
        written = printer.link.written
        press = written[written.index('G1 Z39.000 F1500'):]
        self.assertIn('G4 P100', press)
        self.assertNotIn('M400', press[:press.index('G1 Z42.300 F1500')])

    def test_swipe_touches_down_and_lifts_while_moving(self):
        printer, s = stylus()
        s.swipe(100, 87, 100, 135)
        self.assertEqual(moves(printer), [
            'G1 X100.000 Y85.000 F3000', 'G1 Z42.300 F1500',    # hover before the lead-in
            'G1 X100.000 Y87.000 Z39.300 F1500',                  # descend and move together
            'G1 X100.000 Y135.000 Z39.300 F6000',
            'G1 X100.000 Y138.000 Z42.300 F1500',                 # lift and move together
        ])
        drag = printer.link.written[printer.link.written.index('G1 X100.000 Y87.000 Z39.300 F1500'):]
        self.assertEqual(drag.count('M400'), 1)                   # only after the lift

    def test_swipe_direction_is_general(self):
        printer, s = stylus()
        s.swipe(120, 100, 80, 100)
        self.assertEqual(moves(printer)[0], 'G1 X122.000 Y100.000 F3000')
        self.assertEqual(moves(printer)[-1], 'G1 X77.000 Y100.000 Z42.300 F1500')

    def test_refuses_unsafe_gestures(self):
        printer, s = stylus(homed=False)
        with self.assertRaises(PrinterError):
            s.tap(100, 100)
        printer, s = stylus()
        with self.assertRaises(ValueError):
            s.swipe(100, 100, 100, 100.5)
        with self.assertRaises(ValueError):
            s.swipe(100, 190, 100, 209)      # follow-through would leave the bed
        self.assertEqual(moves(printer), [])

    def test_contact_height_follows_slope(self):
        printer = Printer(boot_wait=0.2, link=FakeLink(replies={'M114': ['X:100.00 Y:100.00 Z:80.00 E:0.00']}))
        s = Stylus(printer, touch_z=44.0, hover_mm=3.5, slope=(0.0, 0.02), origin=(100, 140))
        s.swipe(100, 90, 100, 190, lead_in=1, follow_through=1)
        self.assertEqual(moves(printer)[2:4], ['G1 X100.000 Y90.000 Z43.000 F1500', 'G1 X100.000 Y190.000 Z45.000 F6000'])
        self.assertEqual(moves(printer)[-1], 'G1 X100.000 Y191.000 Z47.500 F1500')     # hover height stays fixed
        s.tap(100, 40)
        self.assertEqual(moves(printer)[-2], 'G1 Z41.700 F1500')


class ZCalibrationTests(unittest.TestCase):
    def grid_image(self, xs, ys=(300,)):
        image = np.full((720, 1280, 3), 40, np.uint8)
        for x in xs:
            cv2.line(image, (int(x), 0), (int(x), 719), (210, 210, 210), 6)
        for y in ys:
            cv2.line(image, (0, int(y)), (1279, int(y)), (210, 210, 210), 6)
        return image

    def test_finds_grid_lines(self):
        lines = grid_lines(self.grid_image([480, 1140]), CENTRE)
        np.testing.assert_allclose(lines['v'], [480, 1140], atol=2)
        np.testing.assert_allclose(lines['h'], [300], atol=2)

    def test_scale_depth_from_50mm_spacing(self):
        spacing = FX * 50 / 60.0
        self.assertAlmostEqual(scale_depth([300, 300 + spacing], FX, CENTRE[0]), 60.0, places=6)
        self.assertIsNone(scale_depth([300], FX, CENTRE[0]))

    def test_tilted_plane_interpolates_to_principal_point(self):
        inverse = lambda x: 1 / 60 + 2e-6 * (x - CENTRE[0])
        xs = [200, 1000]
        self.assertAlmostEqual(depth_at_centre(xs, [1 / inverse(x) for x in xs], CENTRE[0]), 60.0, places=6)

    def test_parallax_pairs_each_line_with_its_shifted_copy(self):
        shift = FX * 10 / 60.0
        before, after = [480, 1140], [480 - shift, 1140 - shift, 20]
        self.assertAlmostEqual(parallax_depth(before, after, FX, CENTRE[0], 10, guess=57), 60.0, places=6)
        self.assertIsNone(parallax_depth(before, [900], FX, CENTRE[0], 10, guess=60))

    def test_fit_recovers_slope(self):
        result = fit([0, 10, 20], [57.4, 67.4, 77.4])
        self.assertAlmostEqual(result['slope'], 1.0)
        self.assertAlmostEqual(result['intercept'], 57.4)
        self.assertLess(result['rms'], 1e-9)


if __name__ == '__main__':
    unittest.main()
