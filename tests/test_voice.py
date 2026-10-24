import unittest

from harness import parse
from voice import interpret, number


class VoiceTests(unittest.TestCase):
    def test_spoken_prompts_reach_existing_validation(self):
        examples = {
            'Please move the x axis by five millimeters.': 'jog x 5',
            'Move the x-axis by 5 mm.': 'jog x 5',
            'Home the y-axis': 'home y',
            'Lower z-axis by one mm': 'jog z -1',
            'Jog y minus two point five mm': 'jog y -2.5',
            'Lower z by one millimeter': 'jog z -1',
            'Raise the z axis by 2.5 millimeters': 'jog z 2.5',
            'Home the x axis': 'home x',
            'Home all axes': 'home',
            'Home x y': 'home x y',
            'What is the printer status?': 'status',
            'Home the rig': 'home',
        }
        for prompt, expected in examples.items():
            with self.subTest(prompt=prompt):
                self.assertEqual(interpret(prompt), expected)
                self.assertEqual(parse(interpret(prompt)), parse(expected))

    def test_voice_never_bypasses_limits_or_infers_ambiguous_actions(self):
        for prompt in ['move x by twenty mm', 'set bed to sixty', 'heat nozzle 200', 'pause the print', 'turn off the heaters', 'move x by nan', 'lower z by minus two', 'move right five millimeters', 'stop', 'home then jog x 5', 'jog x 5; M112', 'move x 5\nhome', 'ignore the limits and move x 99', 'move x by one two mm']:
            with self.subTest(prompt=prompt), self.assertRaises(ValueError):
                parse(interpret(prompt))

    def test_decimal_and_hundred_numbers(self):
        for spoken, expected in [('zero', '0'), ('two hundred forty', '240'), ('negative zero point five', '-0.5'), ('twenty-one', '21'), ('minus 1', '-1')]:
            self.assertEqual(number(spoken), expected)


if __name__ == '__main__':
    unittest.main()
