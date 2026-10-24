import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from harness import Harness, operations, parse


class HarnessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.h = Harness(audit=Path(self.temp.name) / 'audit.jsonl')

    def test_parser_rejects_unbounded_or_injected_commands(self):
        for command in ['jog x 11', 'jog z nan', 'jog y inf', 'jog x 0', 'heat nozzle 200', 'cooldown', 'pause', 'temperatures', 'home x; M112', 'G28', 'status\nhome', '', 'resume now']:
            with self.subTest(command=command), self.assertRaises(ValueError):
                parse(command)

    def test_negative_jog_and_units(self):
        self.assertEqual(parse('Jog Z -2 mm'), {'action': 'jog', 'axis': 'z', 'mm': -2.0})
        self.assertEqual(parse('jog y 2.5 millimeters'), {'action': 'jog', 'axis': 'y', 'mm': 2.5})

    def test_preview_never_calls_transport(self):
        self.h.live = True
        with patch.object(self.h, 'request') as transport:
            self.assertEqual(self.h.run('home')['outcome'], 'preview')
            transport.assert_not_called()

    def test_simulation_receipt_and_audit(self):
        result = self.h.run('jog x 2', True)
        self.assertEqual(result['outcome'], 'simulated')
        events = [json.loads(line) for line in self.h.audit.read_text().splitlines()]
        self.assertEqual([e['outcome'] for e in events], ['dispatching', 'simulated'])

    def test_jog_requires_operator_readiness(self):
        self.h.live = True
        with patch.object(self.h, 'request') as transport:
            self.assertEqual(self.h.run('jog x 1', True)['outcome'], 'failed_or_unknown')
            transport.assert_not_called()

    def test_motion_blocked_while_printing(self):
        self.h.live = True
        self.h.motion_ready = True
        for command in ('home', 'jog x 1'):
            with patch.object(self.h, 'request', return_value={'state': {'flags': {'operational': True, 'ready': True, 'printing': True}}}) as transport:
                self.assertEqual(self.h.run(command, True)['outcome'], 'failed_or_unknown')
                self.assertEqual(transport.call_count, 1)

    def test_accepted_does_not_claim_physical_completion(self):
        self.h.live = True
        with patch.object(self.h, 'request', side_effect=[{'state': {'flags': {'ready': True, 'operational': True}}}, {'accepted': True}]) as transport:
            result = self.h.run('home x', True)
            self.assertEqual(result['outcome'], 'submitted')
            self.assertEqual(transport.call_args.args, ('POST', '/api/printer/printhead', {'command': 'home', 'axes': ['x']}))

    def test_jog_is_relative_bounded_octoprint_request(self):
        self.assertEqual(operations(parse('jog x -3')), [('POST', '/api/printer/printhead', {'command': 'jog', 'x': -3.0, 'absolute': False, 'speed': 300})])

    def test_transport_failure_reports_unknown(self):
        self.h.live = True
        self.h.motion_ready = True
        with patch.object(self.h, 'request', side_effect=[{'state': {'flags': {'ready': True, 'operational': True}}}, ValueError('connection failed')]):
            self.assertEqual(self.h.run('jog x 1', True)['outcome'], 'failed_or_unknown')

    def test_bridge_receives_validated_json_without_shell(self):
        self.h.live = True
        self.h.bridge = ['controller-bridge']
        with patch('harness.subprocess.run') as run:
            run.return_value.returncode = 0
            run.return_value.stdout = '{"ok":true}'
            self.assertEqual(self.h.run('home x', True)['outcome'], 'submitted')
            self.assertEqual(json.loads(run.call_args.kwargs['input']), {'action': 'home', 'axes': ['x']})
            self.assertNotIn('shell', run.call_args.kwargs)


if __name__ == '__main__':
    unittest.main()
