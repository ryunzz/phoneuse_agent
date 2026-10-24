"""Supervise a camera pointed at a device (CP2); same frame contract as PhoneStream."""
import json
from pathlib import Path
import subprocess
import threading

from phone_stream import PhoneStream

ROOT = Path(__file__).resolve().parent
BUILD_HINT = 'Build camera capture first: mkdir -p .build && swiftc -parse-as-library CameraCapture.swift -o .build/camera-capture'


class CameraStream(PhoneStream):
    """Frames come from .build/camera-capture; status, snapshot and freshness rules are PhoneStream's."""

    def __init__(self, folder=None, device=None, binary=None):
        super().__init__(folder or ROOT / '.camera-stream')
        self.device = device
        self.binary = Path(binary or ROOT / '.build' / 'camera-capture')
        self.message = {'state': 'stopped', 'message': 'Camera capture has not started.'}

    def start(self):
        if not self.binary.exists():
            raise ValueError(BUILD_HINT)
        self.folder.mkdir(mode=0o700, parents=True, exist_ok=True)
        for filename in ('latest.jpg', 'latest.json'):
            (self.folder / filename).unlink(missing_ok=True)
        self.message = {'state': 'starting', 'message': 'Waiting for camera permission and the first frame.'}
        argv = [str(self.binary), str(self.folder)] + (['--device', self.device] if self.device else [])
        self.process = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        threading.Thread(target=self.read_status, daemon=True).start()

    def snapshot(self, after=None, timeout=5):
        try:
            return super().snapshot(after, timeout)
        except ValueError:
            raise ValueError(f'No fresh camera frame ({self.message.get("message", "check the camera")})') from None

    def frame(self):
        try:
            return super().frame()
        except ValueError:
            raise ValueError(f'No fresh camera frame ({self.message.get("message", "check the camera")})') from None


def list_devices(binary=None):
    """Return [{'id', 'name', 'model'}] from camera-capture --list."""
    binary = Path(binary or ROOT / '.build' / 'camera-capture')
    if not binary.exists():
        raise ValueError(BUILD_HINT)
    output = subprocess.run([str(binary), '--list'], capture_output=True, text=True, timeout=15).stdout
    return [json.loads(line) for line in output.splitlines() if line.strip()]
