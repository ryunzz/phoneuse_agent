import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import rig_agent
from camera_stream import CameraStream

JPEG = b'\xff\xd8\xff\xe0fake-jpeg'


def write_frame(folder, number, captured_at=None):
    captured_at = captured_at or time.time()
    name = f'frame-{number}.jpg'
    (folder / name).write_bytes(JPEG + bytes([number]))
    (folder / 'latest.jpg').write_bytes(JPEG + bytes([number]))
    (folder / 'latest.json').write_text(json.dumps({
        'captured_at': captured_at, 'capture_started_at': captured_at - 0.01, 'frames': number,
        'width': 1920, 'height': 1080, 'image': name, 'source': 'camera',
        'device_id': 'cam-1', 'device_name': 'Test Camera'}))


class RunningProcess:
    def poll(self):
        return None


class CameraStreamTests(unittest.TestCase):
    def setUp(self):
        self.folder = Path(tempfile.mkdtemp())
        self.stream = CameraStream(self.folder)
        self.stream.process = RunningProcess()

    def test_snapshot_returns_paired_camera_frame(self):
        write_frame(self.folder, 3)
        metadata, data = self.stream.snapshot(timeout=0.2)
        self.assertEqual(metadata['source'], 'camera')
        self.assertEqual(metadata['device_name'], 'Test Camera')
        self.assertEqual(data, JPEG + bytes([3]))
        self.assertEqual(self.stream.frame(), JPEG + bytes([3]))

    def test_stale_or_missing_frames_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'No fresh camera frame'):
            self.stream.snapshot(timeout=0.1)
        write_frame(self.folder, 1, captured_at=time.time() - 10)
        with self.assertRaisesRegex(ValueError, 'No fresh camera frame'):
            self.stream.frame()

    def test_snapshot_after_waits_for_newer_frame(self):
        write_frame(self.folder, 1)
        with self.assertRaisesRegex(ValueError, 'No fresh camera frame'):
            self.stream.snapshot(after=time.time() + 5, timeout=0.1)

    def test_start_requires_built_binary(self):
        stream = CameraStream(self.folder, binary=self.folder / 'missing')
        with self.assertRaisesRegex(ValueError, 'swiftc -parse-as-library CameraCapture.swift'):
            stream.start()

    def test_start_passes_device_and_clears_old_frames(self):
        write_frame(self.folder, 1)
        binary = self.folder / 'camera-capture'
        binary.write_text('')
        stream = CameraStream(self.folder, device='Logitech', binary=binary)
        with mock.patch('camera_stream.subprocess.Popen') as popen, mock.patch('camera_stream.threading.Thread'):
            stream.start()
        self.assertEqual(popen.call_args.args[0], [str(binary), str(self.folder), '--device', 'Logitech'])
        self.assertFalse((self.folder / 'latest.json').exists())


class FakeScreen:
    def __init__(self, device=None):
        self.device, self.started, self.stopped = device, False, False

    def start(self):
        self.started = True

    def snapshot(self, after=None, timeout=5):
        return {'source': 'camera', 'image': 'frame-1.jpg'}, JPEG

    def frame(self):
        return JPEG

    def stop(self):
        self.stopped = True


class BuildBackendTests(unittest.TestCase):
    def setUp(self):
        self.created = []

        def factory(device=None):
            screen = FakeScreen(device)
            self.created.append(screen)
            return screen
        self.screens = {'mirroring': factory, 'camera': factory}
        self.calls = []

        def recording_actuator():
            def act(action, frame):
                self.calls.append((action, frame))
                return {'ok': True}
            return act
        self.actuators = {**rig_agent.ACTUATORS, 'mirroring': recording_actuator, 'stylus': recording_actuator}

    def build(self, *args, **kwargs):
        return rig_agent.build_backend(*args, screens=self.screens, actuators=self.actuators, **kwargs)

    def test_camera_with_mirroring_actuation_is_rejected_before_capture(self):
        with self.assertRaisesRegex(ValueError, 'cannot act on camera frames'):
            self.build('mirroring', 'camera')
        self.assertEqual(self.created, [])

    def test_sim_rejects_screen_options(self):
        with self.assertRaisesRegex(ValueError, 'bundled frames'):
            self.build('sim', 'camera')
        self.assertEqual(self.build('sim').name, 'sim')

    def test_camera_device_requires_camera_screen(self):
        with self.assertRaisesRegex(ValueError, '--camera-device needs --screen camera'):
            self.build('stylus', 'mirroring', 'cam-1')

    def test_defaults_pick_screen_per_backend(self):
        self.assertEqual(self.build('mirroring').name, 'mirroring+mirroring')
        self.assertEqual(self.build('stylus').name, 'stylus+mirroring')
        self.assertEqual(self.build('none').name, 'none+camera')
        self.assertTrue(all(screen.started for screen in self.created))

    def test_view_only_camera_streams_but_rejects_every_action(self):
        backend = self.build('none', 'camera', 'cam-1')
        self.assertEqual(backend.frame(), JPEG)
        self.assertEqual(self.created[0].device, 'cam-1')
        for action in ({'type': 'tap', 'x': 0.5, 'y': 0.5}, {'type': 'home'}, {'type': 'wait', 'seconds': 0}):
            with self.assertRaisesRegex(ValueError, 'view-only camera; no actuator'):
                backend.execute(action)
        backend.stop()
        self.assertTrue(self.created[0].stopped)

    def test_stylus_on_camera_receives_frame_metadata(self):
        backend = self.build('stylus', 'camera')
        self.assertEqual(backend.execute({'type': 'tap', 'x': 0.2, 'y': 0.3}), {'ok': True})
        self.assertEqual(self.calls, [({'type': 'tap', 'x': 0.2, 'y': 0.3}, {'source': 'camera', 'image': 'frame-1.jpg'})])

    def test_real_stylus_actuator_starts_the_controller_and_passes_the_frame(self):
        link = mock.Mock(act=mock.Mock(return_value={'moved': True}))
        with mock.patch('controller.rig.StylusLink.start', return_value=link) as start, \
                mock.patch.dict(os.environ, {'STYLUS_COMMAND': "ssh rig@printer 'python3 -m controller.rig serve'"}):
            act = rig_agent.stylus_actuator()
        start.assert_called_once_with(['ssh', 'rig@printer', 'python3 -m controller.rig serve'], cwd=rig_agent.ROOT)
        self.assertEqual(act({'type': 'home'}, {'source': 'camera'}), {'moved': True})
        link.act.assert_called_once_with({'type': 'home'}, {'source': 'camera'})
        act.close()
        link.close.assert_called_once_with()

    def test_stylus_controller_defaults_to_this_machine(self):
        with mock.patch('controller.rig.StylusLink.start') as start, mock.patch.dict(os.environ, {'STYLUS_COMMAND': ''}):
            rig_agent.stylus_actuator()
        start.assert_called_once_with([sys.executable, '-m', 'controller.rig', 'serve'], cwd=rig_agent.ROOT)

    def test_failed_capture_start_closes_the_actuator(self):
        close = mock.Mock()

        def actuator():
            act = mock.Mock()
            act.close = close
            return act

        def broken_screen(device=None):
            raise ValueError('no capture permission')
        with self.assertRaisesRegex(ValueError, 'no capture permission'):
            rig_agent.build_backend('stylus', screens={'mirroring': broken_screen}, actuators={'stylus': actuator})
        close.assert_called_once_with()

    def test_stopping_the_backend_closes_the_actuator(self):
        backend = self.build('stylus')
        backend.act.close = mock.Mock()
        backend.stop()
        backend.act.close.assert_called_once_with()

    def test_handle_reports_view_only_error_to_gateway(self):
        backend = self.build('none', 'camera')
        gateway = mock.Mock()
        with mock.patch('rig_agent.log'):
            rig_agent.handle(gateway, backend, {'id': 'c1', 'action': {'type': 'tap', 'x': 0.1, 'y': 0.1}})
        gateway.call.assert_called_once_with('POST', '/rig/v1/results', {'id': 'c1', 'ok': False, 'error': 'view-only camera; no actuator'})


if __name__ == '__main__':
    unittest.main()
