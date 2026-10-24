import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import Mock

from phone_stream import PhoneStream


class PhoneStreamTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        self.phone = PhoneStream(self.folder)

    def frame(self, age=0):
        (self.folder / 'latest.jpg').write_bytes(b'jpeg-test-frame')
        (self.folder / 'latest.json').write_text(json.dumps({'captured_at': time.time() - age, 'frames': 3, 'width': 400, 'height': 800}))

    def test_no_device_has_no_image(self):
        self.assertFalse(self.phone.status()['fresh'])
        with self.assertRaises(ValueError):
            self.phone.frame()

    def test_stale_or_dead_capture_never_appears_live(self):
        self.phone.process = Mock()
        self.phone.process.poll.return_value = None
        self.frame(age=10)
        with self.assertRaises(ValueError):
            self.phone.frame()
        self.frame()
        self.phone.process.poll.return_value = 1
        with self.assertRaises(ValueError):
            self.phone.frame()

    def test_fresh_capture_is_available_with_age(self):
        self.phone.process = Mock()
        self.phone.process.poll.return_value = None
        self.frame()
        self.assertEqual(self.phone.frame(), b'jpeg-test-frame')
        self.assertEqual(self.phone.status()['frames'], 3)
        self.assertLess(self.phone.status()['age_s'], 1)

    def test_snapshot_uses_named_image_not_latest(self):
        self.phone.process = Mock()
        self.phone.process.poll.return_value = None
        self.frame()
        metadata = json.loads((self.folder / 'latest.json').read_text())
        metadata.update(image='frame-3.jpg', capture_started_at=time.time())
        (self.folder / 'latest.json').write_text(json.dumps(metadata))
        (self.folder / 'frame-3.jpg').write_bytes(b'paired-image')
        meta, data = self.phone.snapshot(timeout=0)
        self.assertEqual(data, b'paired-image')
        self.assertEqual(meta['frames'], 3)
        with self.assertRaises(ValueError):
            self.phone.snapshot(after=time.time() + 1, timeout=0)

    def test_snapshot_rejects_old_capture_protocol(self):
        self.phone.process = Mock()
        self.phone.process.poll.return_value = None
        self.frame()
        with self.assertRaisesRegex(ValueError, 'Rebuild'):
            self.phone.snapshot(timeout=0)


if __name__ == '__main__':
    unittest.main()
